/**
 * Local-socket client used by `loopsy shell` and (later) `loopsy attach`.
 *
 * Connects to the daemon's Unix-domain socket, negotiates a session,
 * and pipes the current terminal: stdin → daemon → PTY → daemon → stdout.
 * On the configured detach key (default Ctrl-A D) the client drops the
 * connection and restores the terminal mode; the PTY keeps running on
 * the daemon side so the user (or a phone) can attach again.
 */

import * as net from 'node:net';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { CONFIG_DIR } from '@loopsy/protocol';

const FRAME_TYPE_JSON = 0x01;
const FRAME_TYPE_BINARY = 0x02;
const HEADER_BYTES = 5;

const CTRL_A = 0x01;
const CTRL_D = 0x04;
const D_UPPER = 0x44;
const D_LOWER = 0x64;

export interface OpenSessionOptions {
  /** Socket path. Defaults to `~/.loopsy/loopsyd.sock`. */
  socketPath?: string;
  /** Either create a new session… */
  spawn?: {
    agent: string;
    cwd?: string;
    extraArgs?: string[];
    customCommandId?: string;
    name?: string;
  };
  /** …or attach an existing one (by uuid or name). Exactly one of spawn / attach must be set. */
  attach?: { idOrName: string };
  /**
   * Override the detach trigger. Pass `null` to disable (only way to
   * detach is to close the host terminal, which keeps the PTY alive
   * but there's no graceful "back to your shell" UX). The default
   * matches screen/tmux conventions.
   */
  detachKey?: 'ctrl-a-d' | null;
}

export function defaultSocketPath(): string {
  return join(homedir(), CONFIG_DIR, 'loopsyd.sock');
}

/**
 * Run an interactive session against the daemon. Resolves to the PTY
 * exit code when the daemon reports one, or `null` if the user
 * detached. Throws if the socket can't be reached.
 */
export async function runInteractive(opts: OpenSessionOptions): Promise<number | null> {
  const socketPath = opts.socketPath ?? defaultSocketPath();
  if (!existsSync(socketPath)) {
    throw new Error(
      `Loopsy daemon socket not found at ${socketPath}.\n` +
      `Make sure the daemon is running: 'loopsy start'.`,
    );
  }

  const sock = await connect(socketPath);
  const { cols, rows } = currentSize();

  // Frame parser state
  let inboundBuffer = Buffer.alloc(0);
  let exitCode: number | null = null;
  let detached = false;
  let restoredTerminal = false;

  const stdin = process.stdin;
  const stdout = process.stdout;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;

  const restoreTerminal = () => {
    if (restoredTerminal) return;
    restoredTerminal = true;
    if (stdin.isTTY && !wasRaw) {
      try { stdin.setRawMode(false); } catch { /* ignore */ }
    }
    try { stdin.pause(); } catch { /* ignore */ }
  };

  // ─── outbound framing ───────────────────────────────────────────────
  const writeFrame = (type: number, payload: Buffer): void => {
    if (sock.destroyed) return;
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32BE(payload.length + 1, 0);
    header.writeUInt8(type, 4);
    try {
      sock.write(header);
      sock.write(payload);
    } catch {
      /* socket dying; close handler will run */
    }
  };
  const sendJson = (obj: object): void => {
    writeFrame(FRAME_TYPE_JSON, Buffer.from(JSON.stringify(obj), 'utf-8'));
  };
  const sendBinary = (buf: Buffer): void => {
    writeFrame(FRAME_TYPE_BINARY, buf);
  };

  // ─── inbound framing ────────────────────────────────────────────────
  sock.on('data', (chunk) => {
    inboundBuffer = Buffer.concat([inboundBuffer, chunk]);
    while (inboundBuffer.length >= HEADER_BYTES) {
      const len = inboundBuffer.readUInt32BE(0);
      if (inboundBuffer.length < 4 + len) break;
      const type = inboundBuffer[4];
      const payload = inboundBuffer.subarray(HEADER_BYTES, 4 + len);
      inboundBuffer = inboundBuffer.subarray(4 + len);
      if (type === FRAME_TYPE_BINARY) {
        try { stdout.write(payload); } catch { /* ignore */ }
      } else if (type === FRAME_TYPE_JSON) {
        try {
          const msg = JSON.parse(payload.toString('utf-8'));
          if (msg?.type === 'session-exit') {
            exitCode = typeof msg.exitCode === 'number' ? msg.exitCode : 0;
            try { sock.end(); } catch { /* ignore */ }
          } else if (msg?.type === 'session-error') {
            // Surface the daemon's error message on stderr — the user
            // is already in raw mode, so a plain newline is fine.
            process.stderr.write(`\r\nloopsy: ${msg.message ?? msg.code ?? 'session error'}\r\n`);
            try { sock.end(); } catch { /* ignore */ }
          }
          // session-created / session-list ignored at this layer; the
          // caller of runInteractive doesn't need them in v1.
        } catch {
          /* malformed JSON; ignore */
        }
      }
    }
  });

  sock.on('close', () => {
    restoreTerminal();
  });
  sock.on('error', (err) => {
    if (!detached) {
      process.stderr.write(`\r\nloopsy: socket error: ${err.message}\r\n`);
    }
  });

  // ─── send initial command ──────────────────────────────────────────
  if (opts.spawn) {
    sendJson({
      type: 'session-create',
      agent: opts.spawn.agent,
      cwd: opts.spawn.cwd,
      cols,
      rows,
      extraArgs: opts.spawn.extraArgs,
      customCommandId: opts.spawn.customCommandId,
      name: opts.spawn.name,
    });
  } else if (opts.attach) {
    sendJson({ type: 'session-attach', idOrName: opts.attach.idOrName });
  } else {
    throw new Error('runInteractive requires either spawn or attach');
  }

  // ─── stdin → daemon, with detach-key state machine ─────────────────
  if (stdin.isTTY) {
    try { stdin.setRawMode(true); } catch { /* not all TTYs allow it */ }
  }
  stdin.resume();

  const detachEnabled = opts.detachKey !== null && opts.detachKey !== undefined
    ? opts.detachKey === 'ctrl-a-d'
    : true;

  // Single-byte buffer: when Ctrl-A is seen we hold it pending the
  // next byte. If that byte is D/d, detach. Anything else flushes
  // both bytes verbatim (so emacs Ctrl-A still works as long as the
  // next keystroke isn't D — and Ctrl-A Ctrl-A sends a literal Ctrl-A).
  let armed = false;

  const triggerDetach = () => {
    if (detached) return;
    detached = true;
    sendJson({ type: 'session-detach' });
    restoreTerminal();
    process.stderr.write('\r\n[detached — session running on machine]\r\n');
    try { sock.end(); } catch { /* ignore */ }
  };

  stdin.on('data', (chunk: Buffer) => {
    if (!detachEnabled) {
      sendBinary(chunk);
      return;
    }
    // Walk the chunk byte-by-byte. Most chunks are 1–2 bytes (one keystroke
    // or one CSI sequence) so this is cheap.
    const out: number[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      if (armed) {
        armed = false;
        if (b === D_UPPER || b === D_LOWER) {
          if (out.length > 0) sendBinary(Buffer.from(out));
          triggerDetach();
          return;
        }
        if (b === CTRL_A) {
          // Ctrl-A Ctrl-A -> literal Ctrl-A; stay disarmed.
          out.push(CTRL_A);
          continue;
        }
        // Not detach — emit the held Ctrl-A then this byte.
        out.push(CTRL_A, b);
        continue;
      }
      if (b === CTRL_A) {
        armed = true;
        continue;
      }
      out.push(b);
    }
    if (out.length > 0) sendBinary(Buffer.from(out));
  });

  // ─── window resize → daemon ────────────────────────────────────────
  const onResize = () => {
    const s = currentSize();
    sendJson({ type: 'resize', cols: s.cols, rows: s.rows });
  };
  if (stdout.isTTY) stdout.on('resize', onResize);

  // ─── wait for socket close ─────────────────────────────────────────
  await new Promise<void>((resolve) => {
    sock.once('close', resolve);
  });

  if (stdout.isTTY) stdout.removeListener('resize', onResize);
  restoreTerminal();
  return detached ? null : exitCode;
}

function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    sock.once('connect', () => {
      sock.removeListener('error', reject);
      resolve(sock);
    });
    sock.once('error', reject);
  });
}

function currentSize(): { cols: number; rows: number } {
  const cols = (process.stdout as any).columns ?? 120;
  const rows = (process.stdout as any).rows ?? 40;
  return { cols, rows };
}

/**
 * Send a single JSON command to the daemon and resolve to the first JSON
 * response. Used by `loopsy list`, `loopsy kill`, etc. — anything that
 * doesn't need a long-lived attachment. Throws if the socket can't be
 * reached, the daemon disconnects without replying, or the reply is a
 * `session-error`.
 */
export async function oneShotQuery(
  request: object,
  opts: { socketPath?: string; timeoutMs?: number } = {},
): Promise<any> {
  const socketPath = opts.socketPath ?? defaultSocketPath();
  const timeoutMs = opts.timeoutMs ?? 4000;
  if (!existsSync(socketPath)) {
    throw new Error(
      `Loopsy daemon socket not found at ${socketPath}. Run 'loopsy start'.`,
    );
  }
  const sock = await connect(socketPath);
  const header = Buffer.alloc(HEADER_BYTES);
  const payload = Buffer.from(JSON.stringify(request), 'utf-8');
  header.writeUInt32BE(payload.length + 1, 0);
  header.writeUInt8(FRAME_TYPE_JSON, 4);
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      try { sock.destroy(); } catch { /* ignore */ }
      reject(new Error('daemon did not reply within timeout'));
    }, timeoutMs);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= HEADER_BYTES) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        const type = buf[4];
        const payload = buf.subarray(HEADER_BYTES, 4 + len);
        buf = buf.subarray(4 + len);
        if (type !== FRAME_TYPE_JSON) continue;
        try {
          const msg = JSON.parse(payload.toString('utf-8'));
          clearTimeout(timer);
          try { sock.end(); } catch { /* ignore */ }
          if (msg?.type === 'session-error') {
            reject(new Error(msg.message ?? msg.code ?? 'session error'));
          } else {
            resolve(msg);
          }
          return;
        } catch (err) {
          clearTimeout(timer);
          reject(err as Error);
          return;
        }
      }
    });
    sock.on('error', (err) => { clearTimeout(timer); reject(err); });
    sock.on('close', () => { clearTimeout(timer); });
    sock.write(header);
    sock.write(payload);
  });
}
