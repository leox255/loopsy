/**
 * LocalSocketServer — IPC for `loopsy shell` / `loopsy attach`.
 *
 * A Unix-domain-socket server wired into the same PtySessionManager the
 * relay client uses, so a phone connected over WAN and a local terminal
 * connected over the local socket can share the same long-lived PTY.
 * Auth is filesystem-permission-based: the socket is created mode 0600,
 * owned by whoever launched the daemon.
 *
 * Wire protocol — length-prefix framed, no WebSocket:
 *   4 bytes BE: payload+type length (everything after these 4 bytes)
 *   1 byte:     frame type
 *                 0x01 = JSON control (utf-8)
 *                 0x02 = binary PTY data
 *   N bytes:    payload
 *
 * The session id is implicit per connection — once a client attaches to
 * a session, all binary frames on that connection target it. This is the
 * key difference from the relay protocol, which prefixes every binary
 * frame with a 16-byte session UUID because it multiplexes many sessions
 * over one device WS.
 */

import * as net from 'node:net';
import { unlink, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PtySessionManager, AgentKind } from './pty-session-manager.js';
import type { CustomCommand } from '@loopsy/protocol';

const FRAME_TYPE_JSON = 0x01;
const FRAME_TYPE_BINARY = 0x02;
const HEADER_BYTES = 5; // 4-byte length + 1-byte type

interface ClientLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

export interface LocalSocketServerConfig {
  socketPath: string;
  pty: PtySessionManager;
  logger?: ClientLogger;
  /** Returns the daemon's current trusted custom-command list. */
  customCommands?: () => CustomCommand[];
}

export class LocalSocketServer {
  private server: net.Server;
  private pty: PtySessionManager;
  private socketPath: string;
  private log: ClientLogger;
  private getCustomCommands: () => CustomCommand[];
  private clients = new Set<LocalClient>();

  constructor(cfg: LocalSocketServerConfig) {
    this.pty = cfg.pty;
    this.socketPath = cfg.socketPath;
    this.log = cfg.logger ?? { info: () => {}, warn: () => {}, error: () => {} };
    this.getCustomCommands = cfg.customCommands ?? (() => []);
    this.server = net.createServer((sock) => this.handleConnection(sock));
  }

  async start(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true });
    if (existsSync(this.socketPath)) {
      // A stale socket from a previous daemon. If a daemon is actually
      // running, listen() below will fail loudly with EADDRINUSE on
      // platforms that report it for unix sockets — surfaces the real
      // conflict instead of two daemons silently colliding.
      try { await unlink(this.socketPath); } catch { /* ignore */ }
    }
    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error) => { this.server.removeListener('listening', onListen); reject(err); };
      const onListen = () => { this.server.removeListener('error', onErr); resolve(); };
      this.server.once('error', onErr);
      this.server.once('listening', onListen);
      this.server.listen(this.socketPath);
    });
    try { await chmod(this.socketPath, 0o600); } catch { /* not fatal */ }
    this.log.info('local socket listening', { path: this.socketPath });
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    try { await unlink(this.socketPath); } catch { /* ignore */ }
  }

  private handleConnection(sock: net.Socket): void {
    const client = new LocalClient(sock, this.pty, this.log, this.getCustomCommands);
    this.clients.add(client);
    sock.on('close', () => this.clients.delete(client));
  }
}

/**
 * One live `loopsy shell|attach` connection. Owns the frame parser, the
 * attached session id (or null), and the detach handle returned by
 * PtySessionManager.attach.
 */
class LocalClient {
  private sock: net.Socket;
  private pty: PtySessionManager;
  private log: ClientLogger;
  private getCustomCommands: () => CustomCommand[];
  private attached: { sessionId: string; detach: () => void } | null = null;
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(
    sock: net.Socket,
    pty: PtySessionManager,
    log: ClientLogger,
    getCustomCommands: () => CustomCommand[],
  ) {
    this.sock = sock;
    this.pty = pty;
    this.log = log;
    this.getCustomCommands = getCustomCommands;
    sock.on('data', (chunk) => this.onData(chunk));
    sock.on('close', () => this.cleanup());
    sock.on('error', () => this.cleanup());
  }

  close(): void {
    this.cleanup();
    try { this.sock.destroy(); } catch { /* ignore */ }
  }

  private cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.attached) {
      this.attached.detach();
      this.attached = null;
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= HEADER_BYTES) {
      const len = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + len) break;
      const type = this.buffer[4];
      const payload = this.buffer.subarray(HEADER_BYTES, 4 + len);
      this.buffer = this.buffer.subarray(4 + len);
      try {
        if (type === FRAME_TYPE_JSON) {
          this.handleJson(payload.toString('utf-8'));
        } else if (type === FRAME_TYPE_BINARY) {
          this.handleBinary(payload);
        }
      } catch (err) {
        this.log.warn('local-socket frame error', { err: String(err) });
      }
    }
  }

  private handleJson(text: string): void {
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }
    switch (msg?.type) {
      case 'session-create': {
        try {
          const agent: AgentKind = msg.agent ?? 'shell';
          const opts: Parameters<PtySessionManager['spawn']>[0] = {
            agent,
            cwd: typeof msg.cwd === 'string' ? msg.cwd : undefined,
            cols: typeof msg.cols === 'number' ? msg.cols : 120,
            rows: typeof msg.rows === 'number' ? msg.rows : 40,
            extraArgs: Array.isArray(msg.extraArgs) ? msg.extraArgs.map(String) : undefined,
            name: typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim() : undefined,
          };
          // For agent='custom', resolve the trusted command server-side
          // so a malicious local user (if they somehow bypassed the
          // 0600 socket permission) can't smuggle arbitrary argv.
          if (agent === 'custom') {
            const id = String(msg.customCommandId ?? '');
            const cmd = this.getCustomCommands().find(c => c.id === id);
            if (!cmd) {
              this.sendJson({ type: 'session-error', code: 'custom-command-not-found', message: 'Unknown customCommandId' });
              return;
            }
            opts.command = cmd.command;
            opts.extraArgs = cmd.args;
            if (cmd.cwd && !opts.cwd) opts.cwd = cmd.cwd;
          }
          const id = this.pty.spawn(opts);
          this.sendJson({ type: 'session-created', sessionId: id });
          this.attachToSession(id);
        } catch (err) {
          this.sendJson({ type: 'session-error', code: 'spawn-failed', message: String(err) });
        }
        break;
      }
      case 'session-attach': {
        // Accept either a uuid or a name. Resolution is server-side so a
        // racing rename never leaves the client attached to the wrong PTY.
        const lookup = String(msg.sessionId ?? msg.idOrName ?? '');
        if (!lookup) return;
        const resolved = this.pty.resolve(lookup);
        if (!resolved) {
          this.sendJson({ type: 'session-error', code: 'not-found', message: `No session matches '${lookup}'` });
          return;
        }
        this.attachToSession(resolved);
        break;
      }
      case 'session-list': {
        this.sendJson({ type: 'session-list', sessions: this.pty.list() });
        break;
      }
      case 'session-detach': {
        if (this.attached) { this.attached.detach(); this.attached = null; }
        try { this.sock.end(); } catch { /* ignore */ }
        break;
      }
      case 'session-kill': {
        const lookup = String(msg.sessionId ?? msg.idOrName ?? '');
        const resolved = lookup ? this.pty.resolve(lookup) : null;
        if (resolved) {
          this.pty.close(resolved, 'SIGTERM');
          this.sendJson({ type: 'session-killed', sessionId: resolved });
        } else {
          this.sendJson({ type: 'session-error', code: 'not-found', message: `No session matches '${lookup}'` });
        }
        break;
      }
      case 'resize': {
        if (this.attached) {
          this.pty.resize(this.attached.sessionId, Number(msg.cols) || 120, Number(msg.rows) || 40);
        }
        break;
      }
      default:
        // Ignore unknown — forward compatibility.
        break;
    }
  }

  private handleBinary(payload: Buffer): void {
    if (!this.attached) return;
    this.pty.write(this.attached.sessionId, payload);
  }

  private attachToSession(sessionId: string): void {
    if (this.attached) { this.attached.detach(); this.attached = null; }
    const handle = this.pty.attach(sessionId, (data: Buffer) => this.sendBinary(data));
    if (!handle) {
      this.sendJson({ type: 'session-error', code: 'attach-failed', message: 'Could not attach to session' });
      return;
    }
    if (handle.replay.length > 0) this.sendBinary(handle.replay);
    this.attached = { sessionId, detach: handle.detach };
    this.pty.onExit(sessionId, ({ exitCode, signal }) => {
      this.sendJson({ type: 'session-exit', sessionId, exitCode, signal });
    });
  }

  private sendJson(obj: object): void {
    this.sendFrame(FRAME_TYPE_JSON, Buffer.from(JSON.stringify(obj), 'utf-8'));
  }

  private sendBinary(buf: Buffer): void {
    this.sendFrame(FRAME_TYPE_BINARY, buf);
  }

  private sendFrame(type: number, payload: Buffer): void {
    if (this.closed || this.sock.destroyed) return;
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32BE(payload.length + 1, 0);
    header.writeUInt8(type, 4);
    try {
      this.sock.write(header);
      this.sock.write(payload);
    } catch {
      // Mid-write death; cleanup() handles state.
    }
  }
}
