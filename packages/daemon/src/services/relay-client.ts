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

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { CustomCommand, RelayConfig } from '@loopsy/protocol';
import { PtySessionManager } from './pty-session-manager.js';
import type { AgentKind } from './pty-session-manager.js';
import { checkAutoApprove, grantAutoApprove, verifyMacPassword } from './auto-approve.js';

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
    case 'opencode':
      // sst.dev/opencode does not currently expose a single "skip all
      // confirmations" flag that we trust. We launch it in normal mode
      // and let the user respond to its prompts inside the terminal.
      return [];
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
  /**
   * The current custom-command list and a setter that persists changes
   * back to ~/.loopsy/config.yaml. Daemon-side ownership of this list is
   * what lets every paired phone (and the web client) see the same
   * shortcuts. RelayClient mutates the list in response to phone
   * control frames and broadcasts the new list to all listeners.
   */
  customCommands?: CustomCommand[];
  saveCustomCommands?: (commands: CustomCommand[]) => Promise<void>;
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
  /** Daemon-side custom command list. Mutated in-place and persisted. */
  private customCommands: CustomCommand[];
  private saveCustomCommands: (commands: CustomCommand[]) => Promise<void>;

  constructor(cfg: RelayClientConfig) {
    this.cfg = cfg.relay;
    this.pty = cfg.pty;
    this.log = cfg.logger ?? noopLogger;
    this.customCommands = (cfg.customCommands ?? []).map(c => ({ ...c }));
    this.saveCustomCommands = cfg.saveCustomCommands ?? (async () => {});
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
      case 'device-info-request':
        // Phone wants to know what this daemon's host can do (platform +
        // installed agents + custom commands). Used to drive the agent
        // picker and to hide the macOS-only auto-approve flow on
        // Linux/Windows daemons.
        this.sendDeviceInfo(sessionId);
        break;
      case 'custom-command-add':
      case 'custom-command-update':
      case 'custom-command-remove':
        // Mutate the daemon-side list, persist, then push the new list
        // back to the originating session. The relay drops device→phone
        // JSON without a sessionId, so we reply on the requester's
        // session — other paired phones will refresh on next picker open.
        void this.applyCustomCommandMutation(msg).then(() => this.broadcastCustomCommands(sessionId));
        break;
      case 'session-open':
        if (!sessionId) return;
        // Reattach fast-path: if a PTY already exists for this id we
        // skip the agent/custom validation entirely. The phone may be
        // attaching to a session it didn't spawn (e.g. a `loopsy shell`
        // started from a terminal) so it has no way to satisfy the
        // custom-command lookup that fresh spawns require.
        if (this.pty.get(sessionId)) {
          this.handleSessionOpen(sessionId, msg);
          break;
        }
        // For built-in agents: block early on a missing binary so we
        // don't open a PTY that immediately exits with "command not
        // found". For `agent:'custom'`: resolve the customCommandId
        // server-side instead of trusting argv from the phone, then
        // surface a clean session-error if the id is unknown (e.g.
        // another phone deleted the command between picker render and
        // tap).
        if (msg.agent === 'custom') {
          const id = (msg as { customCommandId?: string }).customCommandId;
          const cmd = id ? this.customCommands.find(c => c.id === id) : undefined;
          if (!cmd) {
            this.sendText({
              type: 'session-error',
              sessionId,
              code: 'custom-command-not-found',
              message: 'This custom command was deleted on the laptop. Pull-to-refresh to update the picker.',
            });
            return;
          }
          msg.command = cmd.command;
          msg.extraArgs = cmd.args;
          if (cmd.cwd && !msg.cwd) msg.cwd = cmd.cwd;
        } else if (msg.agent && msg.agent !== 'shell') {
          const installed = PtySessionManager.availableAgents();
          if (!installed.includes(msg.agent)) {
            this.sendText({
              type: 'session-error',
              sessionId,
              code: 'agent-not-installed',
              agent: msg.agent,
              message:
                `${msg.agent} is not installed on this laptop. Install it on the host running 'loopsy daemon start' and try again.`,
            });
            return;
          }
        }
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
    msg: {
      agent?: AgentKind;
      cols?: number;
      rows?: number;
      cwd?: string;
      initialInput?: string;
      auto?: boolean;
      extraArgs?: string[];
      // Phone-supplied authentication for auto-approve. Either:
      //   - sudoPassword: macOS user password (first time, mints a token)
      //   - approveToken: token previously minted (subsequent calls)
      // phoneId scopes the token to a specific paired phone so revocation
      // works through `loopsy phone revoke`.
      phoneId?: string;
      sudoPassword?: string;
      approveToken?: string;
      label?: string;
    },
  ): Promise<void> {
    if (this.sessions.has(sessionId)) return;
    if (!this.pty.get(sessionId)) {
      const agent: AgentKind = msg.agent ?? 'shell';
      // CSO #4 (revised 2026-04-27): auto-approve is the most-dangerous
      // primitive (the agent runs file edits, shell commands, deletes
      // without prompting). Original gate was a macOS dialog requiring
      // physical presence at the laptop — but that defeats remote use.
      // Replace with phone-proven knowledge of the macOS user password,
      // verified non-interactively via `dscl . -authonly`. Per-phone token
      // is minted on first success and used for subsequent sessions.
      let auto = !!msg.auto;
      if (auto) {
        const phoneId = msg.phoneId;
        if (!phoneId) {
          this.sendText({
            type: 'auto-approve-denied',
            sessionId,
            reason: 'missing-phone-id',
            message: 'Phone did not identify itself. Re-pair and try again.',
          });
          return;
        }
        let granted = false;
        let mintedToken: string | undefined;
        if (msg.approveToken && (await checkAutoApprove(phoneId, msg.approveToken))) {
          granted = true;
        } else if (msg.sudoPassword) {
          const ok = await verifyMacPassword(msg.sudoPassword);
          if (ok) {
            mintedToken = await grantAutoApprove(phoneId, msg.label);
            granted = true;
          }
        }
        if (!granted) {
          this.sendText({
            type: 'auto-approve-denied',
            sessionId,
            reason: msg.sudoPassword ? 'wrong-password' : 'no-credentials',
            message: msg.sudoPassword
              ? 'Wrong macOS password. Try again, or turn off auto-approve for this session.'
              : 'Enter your macOS password on the phone to enable auto-approve.',
          });
          return;
        }
        if (mintedToken) {
          // Send the freshly-minted token back to the phone exactly once.
          // The phone caches it in secure storage and uses it on every
          // subsequent auto-approve session-open until revoked.
          this.sendText({
            type: 'auto-approve-granted',
            sessionId,
            phoneId,
            token: mintedToken,
          });
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
        // Set by the case 'session-open' handler when agent === 'custom'
        // — copied from the trusted customCommands entry, never raw from
        // the phone.
        command: (msg as { command?: string }).command,
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

  /**
   * Tell the phone what host this daemon is running on + which agents are
   * actually installed. The phone hides unavailable agents from the
   * picker and skips the macOS-password auto-approve flow on non-darwin
   * hosts (where dscl-based verification can't run anyway).
   */
  private sendDeviceInfo(sessionId?: string): void {
    // Trim PtySessionManager.list() to the public RunningSession shape.
    // The full SessionInfo includes cwd + cols/rows which the phone has
    // no need for — keep the wire payload tight and the surface narrow.
    const runningSessions = this.pty.list()
      .filter(s => s.alive)
      .map(s => ({
        id: s.id,
        agent: s.agent,
        name: s.name,
        attachedClientCount: s.attachedClientCount,
        lastActivityAt: s.lastActivityAt,
      }));
    this.sendText({
      type: 'device-info',
      sessionId,
      platform: process.platform,
      hostname: (() => {
        try { return require('node:os').hostname() as string; } catch { return null; }
      })(),
      agents: PtySessionManager.availableAgents(),
      // Auto-approve uses /usr/bin/dscl; only meaningful on darwin.
      autoApproveSupported: process.platform === 'darwin',
      customCommands: this.customCommands,
      sessions: runningSessions,
    });
  }

  /**
   * Reply with the latest custom-command list. The relay only forwards
   * device→phone JSON when a sessionId is present, so we always echo the
   * sessionId of whichever phone session triggered the mutation.
   */
  private broadcastCustomCommands(sessionId?: string): void {
    this.sendText({
      type: 'custom-commands',
      sessionId,
      customCommands: this.customCommands,
    });
  }

  /**
   * Mutate the daemon-side custom-command list in response to a phone
   * control frame and persist the result. Returns the updated list so we
   * can include it in any response, alongside the broadcast.
   */
  private async applyCustomCommandMutation(
    msg: { type: string; command?: Partial<CustomCommand>; id?: string },
  ): Promise<CustomCommand[]> {
    if (msg.type === 'custom-command-add' && msg.command) {
      // The daemon owns id assignment so two phones racing the same
      // submission don't collide. label/command are required; everything
      // else is a passthrough optional.
      const c = msg.command;
      if (!c.label || !c.command) return this.customCommands;
      const entry: CustomCommand = {
        id: randomUUID(),
        label: String(c.label).slice(0, 80),
        command: String(c.command).slice(0, 200),
        args: Array.isArray(c.args) ? c.args.map(String).slice(0, 32) : undefined,
        cwd: typeof c.cwd === 'string' ? c.cwd : undefined,
        icon: typeof c.icon === 'string' ? c.icon : undefined,
        createdAt: new Date().toISOString(),
      };
      this.customCommands = [...this.customCommands, entry];
    } else if (msg.type === 'custom-command-update' && msg.command?.id) {
      const id = String(msg.command.id);
      this.customCommands = this.customCommands.map(c =>
        c.id === id
          ? {
              ...c,
              label: msg.command!.label ?? c.label,
              command: msg.command!.command ?? c.command,
              args: msg.command!.args !== undefined
                ? (Array.isArray(msg.command!.args) ? msg.command!.args.map(String).slice(0, 32) : c.args)
                : c.args,
              cwd: msg.command!.cwd !== undefined ? msg.command!.cwd : c.cwd,
              icon: msg.command!.icon !== undefined ? msg.command!.icon : c.icon,
            }
          : c,
      );
    } else if (msg.type === 'custom-command-remove' && msg.id) {
      this.customCommands = this.customCommands.filter(c => c.id !== msg.id);
    }
    try {
      await this.saveCustomCommands(this.customCommands);
    } catch (err) {
      this.log.warn('failed to persist customCommands', { err: String(err) });
    }
    return this.customCommands;
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

}
