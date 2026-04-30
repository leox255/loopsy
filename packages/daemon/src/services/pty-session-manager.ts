/**
 * PtySessionManager — interactive PTY sessions for mobile relay clients.
 *
 * Each session wraps a single node-pty process running an agent (claude,
 * gemini, codex) or a plain shell. Sessions persist across phone disconnects:
 * the PTY keeps running, output is buffered into a ring scrollback, and a
 * reconnecting phone can re-attach and replay scrollback before tailing.
 *
 * Distinct from AiTaskManager (which models one-shot tasks); this manager
 * is built for long-lived, bidirectional terminal streams.
 */

import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import * as pty from 'node-pty';

export type AgentKind = 'shell' | 'claude' | 'gemini' | 'codex';

export interface SpawnOptions {
  agent: AgentKind;
  cwd?: string;
  cols?: number;
  rows?: number;
  /** Optional initial prompt sent as stdin once the PTY is ready. */
  initialInput?: string;
  /** Optional extra args appended to the agent command (e.g. ['--model', 'claude-opus-4-7']). */
  extraArgs?: string[];
  /** Optional explicit session id (e.g. provided by the relay client so phone-chosen UUIDs match the routing tag). */
  id?: string;
}

export interface SessionInfo {
  id: string;
  agent: AgentKind;
  cwd: string;
  cols: number;
  rows: number;
  pid?: number;
  createdAt: number;
  lastActivityAt: number;
  alive: boolean;
  exitCode?: number;
  exitSignal?: string;
}

interface RingBuffer {
  chunks: Buffer[];
  totalBytes: number;
  capacity: number;
}

interface InternalSession extends SessionInfo {
  pty: pty.IPty | null;
  buffer: RingBuffer;
  listeners: Set<(data: Buffer) => void>;
  exitListeners: Set<(info: { exitCode: number; signal?: string }) => void>;
  detachTimer?: ReturnType<typeof setTimeout>;
}

export interface PtySessionManagerConfig {
  /** Bytes per session's scrollback ring buffer. Default 64 KiB. */
  scrollbackBytes?: number;
  /** Idle seconds with no listeners before killing the PTY. Default 1 hour. */
  idleTimeoutSec?: number;
  /** Optional environment merged into the PTY env. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_SCROLLBACK = 64 * 1024;
const DEFAULT_IDLE_SEC = 3600;

export class PtySessionManager {
  private sessions = new Map<string, InternalSession>();
  private scrollbackBytes: number;
  private idleTimeoutMs: number;
  private extraEnv: NodeJS.ProcessEnv;

  constructor(cfg: PtySessionManagerConfig = {}) {
    this.scrollbackBytes = cfg.scrollbackBytes ?? DEFAULT_SCROLLBACK;
    this.idleTimeoutMs = (cfg.idleTimeoutSec ?? DEFAULT_IDLE_SEC) * 1000;
    this.extraEnv = cfg.env ?? {};
  }

  /** Spawn a new session and return its id. */
  spawn(opts: SpawnOptions): string {
    const id = opts.id ?? randomUUID();
    const cwd = opts.cwd ?? process.cwd();
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 40;

    const { command, args } = this.resolveCommand(opts.agent, opts.extraArgs ?? []);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.extraEnv,
      // Strip Claude Code nesting-prevention vars so a Claude session can be
      // spawned from inside a Claude-launched daemon.
      CLAUDECODE: undefined,
      CLAUDE_CODE_ENTRY_POINT: undefined,
      // Color-friendly terminal type so agent TUIs render as expected.
      TERM: process.env.TERM || 'xterm-256color',
    } as NodeJS.ProcessEnv;

    const ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: env as { [key: string]: string },
    });

    const session: InternalSession = {
      id,
      agent: opts.agent,
      cwd,
      cols,
      rows,
      pid: ptyProcess.pid,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      alive: true,
      pty: ptyProcess,
      buffer: { chunks: [], totalBytes: 0, capacity: this.scrollbackBytes },
      listeners: new Set(),
      exitListeners: new Set(),
    };
    this.sessions.set(id, session);

    ptyProcess.onData((data: string) => {
      const buf = Buffer.from(data, 'utf-8');
      session.lastActivityAt = Date.now();
      this.appendToBuffer(session.buffer, buf);
      for (const cb of session.listeners) {
        try {
          cb(buf);
        } catch {
          /* ignore listener errors */
        }
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      session.alive = false;
      session.exitCode = exitCode;
      session.exitSignal = signal !== undefined ? String(signal) : undefined;
      for (const cb of session.exitListeners) {
        try {
          cb({ exitCode, signal: session.exitSignal });
        } catch {
          /* ignore */
        }
      }
      session.pty = null;
    });

    if (opts.initialInput) {
      // Tiny delay so agent CLIs that read stdin lazily are ready.
      setTimeout(() => {
        try {
          ptyProcess.write(opts.initialInput!);
        } catch {
          /* ignore */
        }
      }, 250);
    }

    return id;
  }

  write(id: string, data: Buffer | string): boolean {
    const s = this.sessions.get(id);
    if (!s || !s.pty) return false;
    s.lastActivityAt = Date.now();
    try {
      s.pty.write(typeof data === 'string' ? data : data.toString('utf-8'));
      return true;
    } catch {
      return false;
    }
  }

  resize(id: string, cols: number, rows: number): boolean {
    const s = this.sessions.get(id);
    if (!s || !s.pty) return false;
    s.cols = cols;
    s.rows = rows;
    try {
      s.pty.resize(cols, rows);
      return true;
    } catch {
      return false;
    }
  }

  signal(id: string, signal: NodeJS.Signals = 'SIGINT'): boolean {
    const s = this.sessions.get(id);
    if (!s || !s.pty) return false;
    try {
      s.pty.kill(signal);
      return true;
    } catch {
      return false;
    }
  }

  /** Hard close: kill the PTY and forget the session. */
  close(id: string, signal: NodeJS.Signals = 'SIGTERM'): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.detachTimer) clearTimeout(s.detachTimer);
    if (s.pty) {
      try {
        s.pty.kill(signal);
      } catch {
        /* ignore */
      }
    }
    this.sessions.delete(id);
  }

  /** Replay scrollback to the given listener, then stream future data to it. */
  attach(id: string, onData: (data: Buffer) => void): { detach(): void; replay: Buffer } | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.listeners.add(onData);
    if (s.detachTimer) {
      clearTimeout(s.detachTimer);
      s.detachTimer = undefined;
    }
    const replay = Buffer.concat(s.buffer.chunks);
    return {
      replay,
      detach: () => this.detach(id, onData),
    };
  }

  /** Detach a listener; if last listener leaves, start the idle timer. */
  detach(id: string, onData: (data: Buffer) => void): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.listeners.delete(onData);
    if (s.listeners.size === 0 && this.idleTimeoutMs > 0 && s.alive) {
      s.detachTimer = setTimeout(() => {
        // Re-check; another listener may have attached during the wait.
        const cur = this.sessions.get(id);
        if (cur && cur.listeners.size === 0 && cur.alive) {
          this.close(id);
        }
      }, this.idleTimeoutMs);
    }
  }

  onExit(id: string, cb: (info: { exitCode: number; signal?: string }) => void): () => void {
    const s = this.sessions.get(id);
    if (!s) return () => undefined;
    s.exitListeners.add(cb);
    return () => s.exitListeners.delete(cb);
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(({ pty: _pty, buffer: _b, listeners: _l, exitListeners: _e, detachTimer: _t, ...info }) => info);
  }

  get(id: string): SessionInfo | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const { pty: _pty, buffer: _b, listeners: _l, exitListeners: _e, detachTimer: _t, ...info } = s;
    return info;
  }

  /** Tear down everything (called on daemon shutdown). */
  shutdown(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.close(id, 'SIGTERM');
    }
  }

  // ─── helpers ─────────────────────────────────────────────────────────

  private appendToBuffer(buf: RingBuffer, chunk: Buffer): void {
    buf.chunks.push(chunk);
    buf.totalBytes += chunk.length;
    while (buf.totalBytes > buf.capacity && buf.chunks.length > 0) {
      const first = buf.chunks[0];
      if (buf.totalBytes - first.length >= buf.capacity) {
        buf.chunks.shift();
        buf.totalBytes -= first.length;
      } else {
        // Trim the head chunk in place.
        const overflow = buf.totalBytes - buf.capacity;
        buf.chunks[0] = first.subarray(overflow);
        buf.totalBytes -= overflow;
      }
    }
  }

  /**
   * CSO #15: resolve agent commands to absolute paths once, cached. Letting
   * `node-pty` look up `claude` via `$PATH` at spawn time means an attacker
   * who can influence the daemon's environment (env-injection in spawned
   * children, shell rc tampering) can shadow the real binary. Resolving at
   * startup with `command -v` pins the path to whatever was on disk when
   * the daemon launched.
   */
  private static readonly _absPathCache = new Map<string, string>();

  /**
   * List the agents this daemon can actually launch — `shell` is always
   * available; the AI agents (claude, gemini, codex) only count if the
   * binary resolves on PATH at the time we ask. Result is cached per agent
   * inside `_absPathCache` (the same cache resolveCommand uses).
   *
   * Phones use this to grey out unavailable agents in the picker so a
   * reviewer (or anyone) doesn't pick `claude`, hit a black terminal that
   * shuts down because /usr/local/bin/claude isn't installed on this host,
   * and then have to back out manually.
   */
  static availableAgents(): AgentKind[] {
    const out: AgentKind[] = ['shell'];
    const which = process.platform === 'win32' ? 'where' : 'command -v';
    for (const a of ['claude', 'gemini', 'codex'] as const) {
      const cached = PtySessionManager._absPathCache.get(a);
      if (cached) {
        out.push(a);
        continue;
      }
      try {
        const got = execSync(`${which} ${a}`, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim().split('\n')[0];
        if (got) {
          PtySessionManager._absPathCache.set(a, got);
          out.push(a);
        }
      } catch {
        // Not on PATH — skip.
      }
    }
    return out;
  }

  private resolveCommand(agent: AgentKind, extraArgs: string[]): { command: string; args: string[] } {
    if (agent === 'shell') {
      const sh = process.env.SHELL || (process.platform === 'win32' ? 'pwsh.exe' : '/bin/sh');
      const loginArgs = process.platform === 'win32' ? extraArgs : ['-l', ...extraArgs];
      return { command: sh, args: loginArgs };
    }
    const cached = PtySessionManager._absPathCache.get(agent);
    if (cached) return { command: cached, args: extraArgs };
    try {
      const which = process.platform === 'win32' ? 'where' : 'command -v';
      const out = execSync(`${which} ${agent}`, { encoding: 'utf-8' }).trim().split('\n')[0];
      if (out) {
        PtySessionManager._absPathCache.set(agent, out);
        return { command: out, args: extraArgs };
      }
    } catch {
      // Binary not on PATH; node-pty.spawn will fail with a clear error and
      // the relay client surfaces it back to the phone.
    }
    return { command: agent, args: extraArgs };
  }
}
