/**
 * PtySessionManager — interactive PTY sessions for mobile relay clients.
 *
 * Each session wraps a single node-pty process running an agent (claude,
 * gemini, codex, opencode) or a plain shell. Sessions persist across phone
 * disconnects: the PTY keeps running, output is fed through a headless
 * xterm emulator that mirrors the live screen state, and a reconnecting
 * phone gets a serialized snapshot (escape sequences that recreate the
 * exact grid + alt-screen + cursor + scrollback) instead of a raw byte
 * tail.
 *
 * Why headless emulation: full-screen TUIs (opencode, htop, vim) draw
 * with absolute cursor moves and overpaint regions. Replaying the last
 * 64 KiB of bytes gives the phone an incoherent stream that often starts
 * mid-frame and mid-escape — symptom is a half-painted UI on reattach.
 * Feeding the same bytes through a headless terminal and serializing the
 * resulting grid solves that for any TUI, the same way tmux/mosh do.
 *
 * Distinct from AiTaskManager (which models one-shot tasks); this manager
 * is built for long-lived, bidirectional terminal streams.
 */

import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import * as pty from 'node-pty';
import xtermHeadlessPkg from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';
const { Terminal: HeadlessTerminal } = xtermHeadlessPkg;
const { SerializeAddon } = serializePkg;
type HeadlessTerminalInstance = InstanceType<typeof HeadlessTerminal>;
type SerializeAddonInstance = InstanceType<typeof SerializeAddon>;

export type AgentKind = 'shell' | 'claude' | 'gemini' | 'codex' | 'opencode' | 'custom';

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
  /** Optional human-readable label so users can `loopsy attach <name>` instead of memorising a UUID. */
  name?: string;
  /**
   * For `agent: 'custom'`: the binary to spawn. The relay-client
   * resolves a phone-supplied customCommandId against the daemon's
   * trusted list and copies the result here, so the user never sends
   * raw argv across the wire.
   */
  command?: string;
}

export interface SessionInfo {
  id: string;
  agent: AgentKind;
  cwd: string;
  cols: number;
  rows: number;
  pid?: number;
  /** Optional user-supplied label. Unique across alive sessions when present (enforced at spawn). */
  name?: string;
  createdAt: number;
  lastActivityAt: number;
  alive: boolean;
  exitCode?: number;
  exitSignal?: string;
  /** How many local/relay clients are currently subscribed to this PTY's output. */
  attachedClientCount: number;
}

interface InternalSession extends SessionInfo {
  pty: pty.IPty | null;
  /**
   * Headless xterm emulator mirroring everything the PTY has written.
   * On reattach we ask SerializeAddon for the current screen state as
   * escape sequences and ship that to the phone, so the reconnecting
   * client renders the exact grid the user would see if they were live.
   */
  term: HeadlessTerminalInstance;
  serialize: SerializeAddonInstance;
  listeners: Set<(data: Buffer) => void>;
  exitListeners: Set<(info: { exitCode: number; signal?: string }) => void>;
  detachTimer?: ReturnType<typeof setTimeout>;
}

export interface PtySessionManagerConfig {
  /** Lines of scrollback retained per session. Default 1000 (xterm default). */
  scrollbackLines?: number;
  /** Idle seconds with no listeners before killing the PTY. Default 1 hour. */
  idleTimeoutSec?: number;
  /** Optional environment merged into the PTY env. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_SCROLLBACK_LINES = 1000;
const DEFAULT_IDLE_SEC = 3600;

export class PtySessionManager {
  private sessions = new Map<string, InternalSession>();
  private scrollbackLines: number;
  private idleTimeoutMs: number;
  private extraEnv: NodeJS.ProcessEnv;

  constructor(cfg: PtySessionManagerConfig = {}) {
    this.scrollbackLines = cfg.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES;
    this.idleTimeoutMs = (cfg.idleTimeoutSec ?? DEFAULT_IDLE_SEC) * 1000;
    this.extraEnv = cfg.env ?? {};
  }

  /** Spawn a new session and return its id. */
  spawn(opts: SpawnOptions): string {
    const id = opts.id ?? randomUUID();
    const cwd = opts.cwd ?? process.cwd();
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 40;
    const name = opts.name?.trim() || undefined;
    if (name) {
      // Names need to be unique among alive sessions or `loopsy attach
      // <name>` becomes ambiguous. Dead sessions can keep their old name
      // until the user prunes them.
      for (const s of this.sessions.values()) {
        if (s.alive && s.name === name) {
          throw new Error(`A session named '${name}' is already running (id ${s.id}).`);
        }
      }
    }

    const { command, args } = this.resolveCommand(opts.agent, opts.extraArgs ?? [], opts.command);
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

    const term = new HeadlessTerminal({
      cols,
      rows,
      scrollback: this.scrollbackLines,
      allowProposedApi: true,
    });
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);

    const session: InternalSession = {
      id,
      agent: opts.agent,
      cwd,
      cols,
      rows,
      pid: ptyProcess.pid,
      name,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      alive: true,
      attachedClientCount: 0,
      pty: ptyProcess,
      term,
      serialize,
      listeners: new Set(),
      exitListeners: new Set(),
    };
    this.sessions.set(id, session);

    ptyProcess.onData((data: string) => {
      session.lastActivityAt = Date.now();
      // Mirror into the headless terminal so future reattach can serialize
      // the up-to-date grid. xterm.js parses sequences asynchronously but
      // the buffered state is consistent enough for our reattach use.
      try {
        session.term.write(data);
      } catch {
        /* defensive — emulator should never throw on user output */
      }
      const buf = Buffer.from(data, 'utf-8');
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
      // Keep the headless mirror in sync so the serialized snapshot
      // matches what the live PTY is now drawing into.
      try { s.term.resize(cols, rows); } catch { /* ignore */ }
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
    try { s.term.dispose(); } catch { /* ignore */ }
    this.sessions.delete(id);
  }

  /**
   * Hand a reconnecting listener a snapshot of the current screen state
   * (as ANSI escape sequences) and start streaming new PTY output to it.
   * The phone's xterm.js consumes the snapshot like any other byte
   * stream — alt-screen, cursor, attributes, and visible scrollback are
   * recreated faithfully because the daemon kept a parallel headless
   * terminal in sync with every PTY write.
   */
  attach(id: string, onData: (data: Buffer) => void): { detach(): void; replay: Buffer } | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.listeners.add(onData);
    s.attachedClientCount = s.listeners.size;
    if (s.detachTimer) {
      clearTimeout(s.detachTimer);
      s.detachTimer = undefined;
    }
    let snapshot = '';
    try {
      // Include scrollback so a reattaching shell session shows recent
      // output, not just whatever happens to fit on screen. excludeModes
      // is left at its default — we want mode state restored too.
      snapshot = s.serialize.serialize({ scrollback: this.scrollbackLines });
    } catch {
      /* fall through with empty replay */
    }
    return {
      replay: Buffer.from(snapshot, 'utf-8'),
      detach: () => this.detach(id, onData),
    };
  }

  /** Detach a listener; if last listener leaves, start the idle timer. */
  detach(id: string, onData: (data: Buffer) => void): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.listeners.delete(onData);
    s.attachedClientCount = s.listeners.size;
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
    return Array.from(this.sessions.values()).map((s) => this.toPublic(s));
  }

  get(id: string): SessionInfo | null {
    const s = this.sessions.get(id);
    return s ? this.toPublic(s) : null;
  }

  /**
   * Resolve a user-supplied identifier to a session id. Accepts:
   *   - a full UUID
   *   - a unique id prefix (so `loopsy attach 4fa7b7` works against the
   *     8-char preview shown by `loopsy list`)
   *   - a name that uniquely matches a single alive session
   * Returns null when nothing matches or the input is ambiguous; the
   * caller surfaces a friendly "no such session" error.
   */
  resolve(idOrName: string): string | null {
    if (this.sessions.has(idOrName)) return idOrName;
    const alive = Array.from(this.sessions.values()).filter(s => s.alive);
    const byName = alive.filter(s => s.name === idOrName);
    if (byName.length === 1) return byName[0].id;
    // Treat anything ≥4 chars as a candidate prefix; below that the
    // probability of an unintentional collision is too high.
    if (idOrName.length >= 4) {
      const byPrefix = alive.filter(s => s.id.startsWith(idOrName));
      if (byPrefix.length === 1) return byPrefix[0].id;
    }
    return null;
  }

  private toPublic(s: InternalSession): SessionInfo {
    const { pty: _pty, term: _t1, serialize: _t2, listeners: _l, exitListeners: _e, detachTimer: _t, ...info } = s;
    return info;
  }

  /** Tear down everything (called on daemon shutdown). */
  shutdown(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.close(id, 'SIGTERM');
    }
  }

  // ─── helpers ─────────────────────────────────────────────────────────

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
    for (const a of ['claude', 'gemini', 'codex', 'opencode'] as const) {
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

  private resolveCommand(
    agent: AgentKind,
    extraArgs: string[],
    customCommand?: string,
  ): { command: string; args: string[] } {
    if (agent === 'shell') {
      const sh = process.env.SHELL || (process.platform === 'win32' ? 'pwsh.exe' : '/bin/sh');
      const loginArgs = process.platform === 'win32' ? extraArgs : ['-l', ...extraArgs];
      return { command: sh, args: loginArgs };
    }
    if (agent === 'custom') {
      // Daemon already validated that the customCommandId resolves to a
      // trusted entry in this.customCommands and copied `command` over.
      // Same security profile as `shell`: once paired, the phone can
      // already run anything via the bash session, so a labeled tile
      // doesn't change the threat model. Resolve via PATH for symmetry
      // with the built-in agents (gives an absolute path) but fall back
      // to the literal command if `command -v` fails — the user might
      // be referencing a script via absolute path.
      const cmd = (customCommand ?? '').trim();
      if (!cmd) return { command: '/bin/sh', args: ['-l', ...extraArgs] };
      try {
        const which = process.platform === 'win32' ? 'where' : 'command -v';
        const out = execSync(`${which} ${cmd}`, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim().split('\n')[0];
        if (out) return { command: out, args: extraArgs };
      } catch {/* fall through */}
      return { command: cmd, args: extraArgs };
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
