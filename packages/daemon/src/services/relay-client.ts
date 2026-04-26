/**
 * RelayClient — outbound persistent WebSocket from this daemon to the
 * Loopsy relay. Mobile clients connect to the relay over the public internet,
 * and the relay splices their session WebSockets into ours.
 *
 * Wire protocol mirrors what the relay's DeviceObject expects:
 *   - text frames  : JSON control with `sessionId` field
 *   - binary frames: [16-byte session UUID][PTY bytes]
 *
 * Lifecycle:
 *   start() → connect → reconnect on close with exponential backoff
 *   stop()  → close cleanly, no further reconnects
 *
 * Translates incoming control + data frames to PtySessionManager calls,
 * and forwards PTY output back to the relay tagged by sessionId.
 */

import WebSocket from 'ws';
import type { RelayConfig } from '@loopsy/protocol';
import type { AgentKind, PtySessionManager } from './pty-session-manager.js';

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_MS = 25_000;

interface RoutedSession {
  sessionId: string;
  detach: () => void;
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) throw new Error(`bad uuid: ${uuid}`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Per-agent CLI flags that disable interactive permission/confirmation
 * prompts so the user doesn't have to keep tapping "approve" from the phone.
 *
 * The exact flags Claude/Gemini/Codex expose for this drift over time. If a
 * flag is renamed upstream we'll see "unrecognized option" in the PTY output;
 * just edit the corresponding case here to fix without a daemon redeploy is
 * not possible — you'd need to rebuild and republish loopsy.
 */
function autoApproveFlags(agent: AgentKind): string[] {
  switch (agent) {
    case 'claude':
      return ['--dangerously-skip-permissions'];
    case 'gemini':
      // Gemini CLI exposes both `-y` (assume-yes) and `--yolo`. -y is more
      // narrowly scoped (auto-approve, but still respects refusal rules).
      return ['-y'];
    case 'codex':
      // OpenAI codex-cli auto mode.
      return ['--full-auto'];
    case 'shell':
    default:
      return [];
  }
}

function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.length < 16) throw new Error('not enough bytes for uuid');
  const hex = Array.from(bytes.slice(0, 16))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface RelayClientLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

const noopLogger: RelayClientLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface RelayClientConfig {
  relay: RelayConfig;
  pty: PtySessionManager;
  logger?: RelayClientLogger;
}

export class RelayClient {
  private cfg: RelayConfig;
  private pty: PtySessionManager;
  private log: RelayClientLogger;
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectMs = RECONNECT_INITIAL_MS;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  /** sessionId → handle so we can tear down listeners on disconnect. */
  private sessions = new Map<string, RoutedSession>();

  constructor(cfg: RelayClientConfig) {
    this.cfg = cfg.relay;
    this.pty = cfg.pty;
    this.log = cfg.logger ?? noopLogger;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const s of this.sessions.values()) s.detach();
    this.sessions.clear();
    if (this.ws) {
      try {
        this.ws.close(1000, 'shutdown');
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  private connect(): void {
    const url = new URL(this.cfg.url.replace(/^http/, 'ws'));
    url.pathname = '/laptop/connect';
    url.searchParams.set('device_id', this.cfg.deviceId);

    // CSO #3: pass the bearer via the Authorization header (Node side uses
    // `ws` which can set headers). The relay also accepts a
    // `Sec-WebSocket-Protocol: loopsy.bearer.<secret>` subprotocol so
    // browsers and other WHATWG-compliant clients can authenticate without
    // putting the secret in URL query strings (which leak into CF logs).
    const ws = new WebSocket(url.toString(), [`loopsy.bearer.${this.cfg.deviceSecret}`], {
      headers: { Authorization: `Bearer ${this.cfg.deviceSecret}` },
    });
    this.ws = ws;

    ws.on('open', () => {
      this.log.info('relay connected', { url: this.cfg.url, deviceId: this.cfg.deviceId });
      this.reconnectMs = RECONNECT_INITIAL_MS;
      this.startHeartbeat();
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.handleBinary(data as Buffer);
      } else {
        this.handleText(data.toString('utf-8'));
      }
    });

    ws.on('close', (code, reason) => {
      this.stopHeartbeat();
      this.log.warn('relay disconnected', { code, reason: reason?.toString() });
      // Detach all session listeners; PTYs keep running.
      for (const s of this.sessions.values()) s.detach();
      this.sessions.clear();
      this.ws = null;
      if (!this.stopped) this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.log.error('relay socket error', { message: err.message });
      // 'close' fires after error — handle reconnect there.
    });
  }

  private scheduleReconnect(): void {
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  // ─── inbound from relay ──────────────────────────────────────────────

  private handleBinary(buf: Buffer): void {
    if (buf.length < 16) return;
    const sessionId = bytesToUuid(new Uint8Array(buf.subarray(0, 16)));
    const payload = buf.subarray(16);
    this.pty.write(sessionId, payload);
  }

  private handleText(text: string): void {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const type: string = msg?.type;
    const sessionId: string | undefined = msg?.sessionId;
    if (!type) return;

    switch (type) {
      case 'session-open':
        if (!sessionId) return;
        this.handleSessionOpen(sessionId, msg);
        break;
      case 'session-attach':
        if (!sessionId) return;
        this.handleSessionAttach(sessionId);
        break;
      case 'session-detach':
        if (!sessionId) return;
        this.handleSessionDetach(sessionId);
        break;
      case 'resize':
        if (!sessionId) return;
        this.pty.resize(sessionId, Number(msg.cols) || 120, Number(msg.rows) || 40);
        break;
      case 'signal':
        if (!sessionId) return;
        this.pty.signal(sessionId, (msg.signal as NodeJS.Signals) ?? 'SIGINT');
        break;
      case 'session-close':
        if (!sessionId) return;
        this.pty.close(sessionId);
        this.sessions.delete(sessionId);
        break;
      default:
        // Unknown control message — ignore for forward compatibility.
        break;
    }
  }

  /**
   * Phone requested a new session (or first re-open after detach with a fresh
   * agent choice). Spawn the PTY and attach a listener that forwards data
   * back to the relay tagged with the session UUID.
   *
   * If a session already exists for this id, reuse it (idempotent).
   */
  private async handleSessionOpen(
    sessionId: string,
    msg: { agent?: AgentKind; cols?: number; rows?: number; cwd?: string; initialInput?: string; auto?: boolean; extraArgs?: string[] },
  ): Promise<void> {
    if (this.sessions.has(sessionId)) return;
    if (!this.pty.get(sessionId)) {
      const agent: AgentKind = msg.agent ?? 'shell';
      // CSO #4: auto-approve is the most-dangerous primitive (the agent runs
      // file edits, shell commands, deletes without prompting). Gate it
      // behind a one-time Mac-side approval per (phone, agent) pair, recorded
      // on disk. The first time a phone asks for `auto:true`, the daemon
      // pops a macOS dialog requiring local user approval. Subsequent runs
      // for the same phone+agent skip the dialog.
      let auto = !!msg.auto;
      if (auto && process.platform === 'darwin') {
        const approved = await this.confirmAutoApproveOnMac(agent);
        if (!approved) {
          this.sendText({
            type: 'error',
            sessionId,
            message: 'Auto-approve denied on the laptop. Toggle off auto-approve for this session and try again.',
          });
          return;
        }
      }
      const args = [
        ...(auto ? autoApproveFlags(agent) : []),
        ...(msg.extraArgs ?? []),
      ];
      // Spawn with the phone-chosen id so the relay's session-routing tag
      // matches the binary-frame session prefix on the way back.
      this.pty.spawn({
        id: sessionId,
        agent,
        cols: msg.cols ?? 120,
        rows: msg.rows ?? 40,
        cwd: msg.cwd,
        initialInput: msg.initialInput,
        extraArgs: args,
      });
    }
    const prefix = uuidToBytes(sessionId);
    const onData = (data: Buffer) => this.sendBinary(prefix, data);
    const handle = this.pty.attach(sessionId, onData);
    if (!handle) return;
    if (handle.replay.length > 0) this.sendBinary(prefix, handle.replay);
    this.sessions.set(sessionId, { sessionId, detach: handle.detach });
    this.sendText({ type: 'session-ready', sessionId });
  }

  private handleSessionAttach(sessionId: string): void {
    if (this.sessions.has(sessionId)) return;
    const info = this.pty.get(sessionId);
    if (!info) {
      // No existing PTY — wait for phone to send session-open.
      return;
    }
    const prefix = uuidToBytes(sessionId);
    const onData = (data: Buffer) => this.sendBinary(prefix, data);
    const handle = this.pty.attach(sessionId, onData);
    if (!handle) return;
    if (handle.replay.length > 0) this.sendBinary(prefix, handle.replay);
    this.sessions.set(sessionId, { sessionId, detach: handle.detach });
  }

  private handleSessionDetach(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.detach();
    this.sessions.delete(sessionId);
  }

  // ─── outbound to relay ───────────────────────────────────────────────

  private sendBinary(prefix: Uint8Array, payload: Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const out = Buffer.allocUnsafe(prefix.length + payload.length);
    out.set(prefix, 0);
    out.set(payload, prefix.length);
    try {
      this.ws.send(out, { binary: true });
    } catch {
      /* ignore */
    }
  }

  private sendText(msg: object): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      /* ignore */
    }
  }

  /**
   * CSO #4: macOS-only osascript dialog for auto-approve confirmation.
   * Returns true if the local user clicked "Allow", false otherwise (deny,
   * timeout, or any error spawning osascript). 30-second timeout so a stale
   * request can't block the daemon forever.
   */
  private async confirmAutoApproveOnMac(agent: string): Promise<boolean> {
    return new Promise((resolve) => {
      const { spawn } = require('node:child_process') as typeof import('node:child_process');
      const flag = agent === 'claude'
        ? '--dangerously-skip-permissions'
        : agent === 'codex'
          ? '--full-auto'
          : '-y';
      const message = `A paired phone is asking to run \\"${agent} ${flag}\\" — that means the agent will execute file edits and shell commands without confirming each one. Allow only if you started this from your phone right now.`;
      const script = `display dialog "${message}" buttons {"Deny", "Allow once"} default button "Deny" with icon caution with title "Loopsy auto-approve" giving up after 30`;
      const proc = spawn('/usr/bin/osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout?.on('data', (b) => { out += b.toString('utf-8'); });
      const timeout = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        resolve(false);
      }, 35_000);
      proc.on('close', () => {
        clearTimeout(timeout);
        // osascript prints "button returned:Allow once" or "gave up:true" etc.
        resolve(/Allow once/.test(out));
      });
      proc.on('error', () => { clearTimeout(timeout); resolve(false); });
    });
  }
}
