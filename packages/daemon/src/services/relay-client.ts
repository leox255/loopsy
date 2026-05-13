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
import { ChatEventStream, type ChatEvent } from './chat-event-stream.js';
import { getClaudeSessionForLoopsy } from './claude-session-tracker.js';

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_MS = 25_000;
/**
 * Per-session backpressure threshold for chat-event forwarding. If the
 * outbound WS buffer is above this size, we assume the client is too slow
 * (cellular network, app backgrounded, etc.) and rather than letting Node
 * pile chat events into RAM indefinitely we drop the chat stream for that
 * session with a `tail-gap` error. The client can resubscribe when ready.
 * 4 MiB picked as a "few hundred typical assistant blocks" headroom.
 */
const CHAT_BACKPRESSURE_BYTES = 4 * 1024 * 1024;

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

export interface RelayClientStatus {
  /** True iff the underlying WebSocket is OPEN and we haven't been stopped. */
  connected: boolean;
  /** Configured URL we're connecting to (or were last connected to). */
  url: string;
  /** Last connect/socket error surfaced from the WebSocket; null after a successful reconnect. */
  lastError: string | null;
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
  /**
   * sessionId → live ChatEventStream. Chat is piggy-backed on an attached
   * PTY session — the phone subscribes by the same sessionId it's using
   * for the terminal view, and the daemon resolves the cwd from the PTY.
   * Capped at one chat stream per session in v1 (the relay only ever has
   * one client per sessionId anyway).
   */
  private chats = new Map<string, ChatEventStream>();
  /** Daemon-side custom command list. Mutated in-place and persisted. */
  private customCommands: CustomCommand[];
  private saveCustomCommands: (commands: CustomCommand[]) => Promise<void>;
  /** Last error observed on the socket; cleared on successful (re)connect. */
  private lastError: string | null = null;

  constructor(cfg: RelayClientConfig) {
    this.cfg = cfg.relay;
    this.pty = cfg.pty;
    this.log = cfg.logger ?? noopLogger;
    this.customCommands = (cfg.customCommands ?? []).map(c => ({ ...c }));
    this.saveCustomCommands = cfg.saveCustomCommands ?? (async () => {});
  }

  /**
   * Snapshot of the relay link state. Used by /api/v1/relay/status so the
   * CLI can poll until a freshly-reconfigured RelayClient has actually
   * established its WebSocket before issuing a pair QR.
   */
  getStatus(): RelayClientStatus {
    const connected = !!this.ws && !this.stopped && this.ws.readyState === WebSocket.OPEN;
    return { connected, url: this.cfg.url, lastError: this.lastError };
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
    for (const c of this.chats.values()) c.stop();
    this.chats.clear();
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
      this.lastError = null;
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
      this.lastError = err.message;
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
        this.handleSessionAttach(sessionId, msg as { cols?: number; rows?: number });
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
        // Closing the PTY tears down the chat stream too — there's nothing
        // to keep tailing once the underlying session is gone.
        this.stopChatStream(sessionId);
        break;
      case 'chat-subscribe':
        if (!sessionId) return;
        this.handleChatSubscribe(sessionId, msg as { fromOffset?: number });
        break;
      case 'chat-unsubscribe':
        if (!sessionId) return;
        this.stopChatStream(sessionId);
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
    // Reattach path: PTY already exists. Resize it to the phone's current
    // viewport BEFORE attach() serializes the snapshot — otherwise the
    // snapshot is laid out at the old cols (often 120 from the original
    // spawn) and renders into the phone's narrower viewport with every
    // line wrapping at the wrong column. Showed up as visibly squished
    // text and TUI borders running through prompt content.
    if (this.pty.get(sessionId) && msg.cols && msg.rows) {
      this.pty.resize(sessionId, msg.cols, msg.rows);
    }
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
      // Resume the prior agent session if we've seen this loopsy session
      // before. Without this, every PTY respawn (idle reap, daemon
      // restart) creates a fresh conversation — the user loses the
      // thread they were on. We only know how to resume agents that
      // expose a stable resume CLI surface:
      //   - claude: `--resume <session-id>`
      //   - codex:  CLI exposes `codex resume`, but it's a sub-command
      //     not a flag, so it requires different spawn plumbing —
      //     deferred. Tracked at session-tracker level for future use.
      //   - gemini, opencode: no resume mechanism in their CLIs today.
      const resumeArgs = await this.resumeArgsForAgent(agent, sessionId);

      const args = [
        ...resumeArgs,
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

  private handleSessionAttach(sessionId: string, msg: { cols?: number; rows?: number } = {}): void {
    if (this.sessions.has(sessionId)) return;
    const info = this.pty.get(sessionId);
    if (!info) {
      // No existing PTY — wait for phone to send session-open.
      return;
    }
    // Match the headless mirror to the new client's viewport before
    // serializing, so the snapshot wraps at the same column the client
    // will render at. Same reasoning as in handleSessionOpen.
    if (msg.cols && msg.rows) {
      this.pty.resize(sessionId, msg.cols, msg.rows);
    }
    const prefix = uuidToBytes(sessionId);
    const onData = (data: Buffer) => this.sendBinary(prefix, data);
    const handle = this.pty.attach(sessionId, onData);
    if (!handle) return;
    if (handle.replay.length > 0) this.sendBinary(prefix, handle.replay);
    this.sessions.set(sessionId, { sessionId, detach: handle.detach });
  }

  /**
   * Build the CLI argv prefix needed to resume a prior session for this
   * agent, if any. Falls back to `[]` (fresh session) when:
   *   - This is the first time we've seen the loopsy sessionId
   *   - The agent doesn't expose a resume mechanism
   *   - The stored session-id refers to a file that's been deleted
   *
   * The actual mapping is owned by ClaudeSessionTracker for now since
   * Claude is the only agent we know how to resume via a flag. Codex's
   * `codex resume` sub-command pattern needs different plumbing — track
   * but don't act yet.
   */
  private async resumeArgsForAgent(agent: AgentKind, loopsySessionId: string): Promise<string[]> {
    if (agent !== 'claude') return [];
    const prior = await getClaudeSessionForLoopsy(loopsySessionId).catch(() => null);
    return prior ? ['--resume', prior] : [];
  }

  private handleSessionDetach(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.detach();
    this.sessions.delete(sessionId);
    // Detach also tears down the chat stream so we're not tailing the
    // JSONL for a client that has nowhere to send frames. The client
    // re-subscribes on reattach.
    this.stopChatStream(sessionId);
  }

  /**
   * Start tailing the Claude JSONL for `sessionId` and forward each
   * translated ChatEvent back over the relay tagged with the same
   * sessionId. The phone uses the same routing key for terminal and chat
   * frames — that keeps the relay's session-routing logic untouched.
   *
   * If a chat stream is already running for this session, replace it so
   * a reconnecting client can pass a fresh `fromOffset` for partial
   * replay.
   */
  private handleChatSubscribe(sessionId: string, msg: { fromOffset?: number }): void {
    this.stopChatStream(sessionId);
    const info = this.pty.get(sessionId);
    if (!info) {
      this.sendText({
        type: 'chat-event',
        sessionId,
        event: { v: 1, kind: 'capability', chat: 'unavailable', reason: 'no PTY session' } satisfies ChatEvent,
      });
      return;
    }
    // If we've previously discovered the Claude session-id bound to this
    // loopsy session, pin to that JSONL directly. This is more precise
    // than birthtime correlation and survives Claude rotating its files
    // (the stored id is the source of truth across daemon restarts).
    // We Promise-resolve before constructing the stream so the start()
    // call below sees the resolved sessionId.
    void getClaudeSessionForLoopsy(sessionId).catch(() => null).then((priorClaudeId) => {
      if (this.chats.has(sessionId)) return; // a newer subscribe already raced ahead
      const stream = new ChatEventStream({
        cwd: info.cwd,
        startByteOffset: msg.fromOffset,
        sessionId: priorClaudeId ?? undefined,
        // Birthtime correlation is the fallback when no Claude id is
        // stored yet (first-time spawn racing chat-subscribe).
        ptySpawnedAtMs: info.createdAt,
      });
      stream.on('event', (event: ChatEvent) => {
        const buffered = this.ws?.bufferedAmount ?? 0;
        if (buffered > CHAT_BACKPRESSURE_BYTES) {
          this.sendText({
            type: 'chat-event',
            sessionId,
            event: {
              v: 1,
              kind: 'error',
              code: 'tail-gap',
              message: `client too slow (${Math.round(buffered / 1024 / 1024)} MiB buffered); chat stream dropped`,
            } satisfies ChatEvent,
          });
          this.stopChatStream(sessionId);
          return;
        }
        this.sendText({ type: 'chat-event', sessionId, event });
      });
      this.chats.set(sessionId, stream);
      void stream.start();
    });
  }

  private stopChatStream(sessionId: string): void {
    const existing = this.chats.get(sessionId);
    if (!existing) return;
    existing.stop();
    this.chats.delete(sessionId);
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
