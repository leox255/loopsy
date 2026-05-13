/**
 * Per-session chat event stream — tails an agent's transcript file and
 * emits a stable `ChatEvent` shape the mobile chat panel renders.
 *
 * The agent-specific bits (where the file lives, how to translate
 * records into ChatEvents) live in transcript-adapters.ts. This module
 * owns the generic tail loop: byte-offset replay, fs.watch + polling
 * fallback, size-delta gap detection, per-session backpressure
 * coordination.
 *
 * Wire shape is co-located here so the relay client can `satisfies
 * ChatEvent` against the emitted payloads without an extra dep. The
 * shape is intentionally NOT exported to `@loopsy/protocol` yet — once
 * we trust it across all four adapters, the version gets carved out.
 */

import { EventEmitter } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import * as fs from 'node:fs';
import {
  encodeCwdToClaudeProjectDir,
  type RecordTranslator,
  type TranscriptAdapter,
} from './transcript-adapters.js';

export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: unknown; isError: boolean; truncated?: boolean };

export type ChatErrorCode =
  | 'tail-gap'           // file shrank or rotated — we cannot guarantee we saw everything
  | 'jsonl-missing'      // expected file vanished
  | 'schema-unknown'     // a record had a shape we don't know how to translate
  | 'session-ended'      // session exited cleanly
  | 'project-dir-missing';

export type ChatEvent =
  | { v: 1; kind: 'capability'; chat: 'available' | 'unavailable'; reason?: string }
  | { v: 1; kind: 'turn-start'; turnId: string; role: 'user' | 'assistant'; ts?: string; messageId?: string }
  | { v: 1; kind: 'block'; turnId: string; messageId: string; index: number; block: ChatBlock }
  | { v: 1; kind: 'turn-end'; turnId: string; stopReason?: string }
  | { v: 1; kind: 'error'; code: ChatErrorCode; message: string };

export interface ChatEventStreamOptions {
  /** Agent-specific adapter (knows where the transcript file lives + how to translate). */
  adapter: TranscriptAdapter;
  /** The cwd the PTY was launched from. */
  cwd: string;
  /** Optional sessionId hint — used by adapters that support exact lookup. */
  sessionId?: string;
  /**
   * Loopsy session id. Adapters use this to re-check tracker maps on
   * every poll iteration, so a tracker entry that gets persisted by
   * the async discovery service mid-poll is picked up immediately.
   */
  loopsySessionId?: string;
  /**
   * Epoch-ms when the owning PTY was spawned. Used to bind to the right
   * file when multiple sessions share a directory.
   */
  ptySpawnedAtMs?: number;
  /** Polling interval used as fs.watch backup. Default 500ms. */
  pollMs?: number;
  /** Byte offset to start tailing from. Default 0 (full replay). */
  startByteOffset?: number;
}

const DEFAULT_POLL_MS = 500;

/** Back-compat re-export so external callers don't have to learn the new module. */
export function encodeCwdToProjectDir(cwd: string): string {
  return encodeCwdToClaudeProjectDir(cwd);
}

export class ChatEventStream extends EventEmitter {
  private adapter: TranscriptAdapter;
  private cwd: string;
  private sessionId?: string;
  private loopsySessionId?: string;
  private ptySpawnedAtMs?: number;
  private pollMs: number;
  private startByteOffset?: number;

  private filePath: string | null = null;
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private nextByteOffset = 0;
  private pendingBuffer = '';
  private translator: RecordTranslator;
  private stopped = false;
  private reading = false;

  constructor(options: ChatEventStreamOptions) {
    super();
    this.adapter = options.adapter;
    this.cwd = options.cwd;
    this.sessionId = options.sessionId;
    this.loopsySessionId = options.loopsySessionId;
    this.ptySpawnedAtMs = options.ptySpawnedAtMs;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.startByteOffset = options.startByteOffset;
    this.nextByteOffset = options.startByteOffset ?? 0;
    this.translator = this.adapter.createTranslator();
  }

  async start(): Promise<void> {
    const resolveOpts = () => ({
      cwd: this.cwd,
      spawnedAtMs: this.ptySpawnedAtMs ?? 0,
      sessionId: this.sessionId,
      loopsySessionId: this.loopsySessionId,
    });

    let path = await this.adapter.resolveFile(resolveOpts());

    // Indefinite poll: the agent's transcript file appears the first time
    // the user sends a prompt. If the user lingers in the chat tab for
    // a couple of minutes before typing anything, we still need to find
    // the file the moment it shows up. The earlier 30s deadline made
    // chat "die" silently in that case — users had to back out and
    // re-enter the session.
    //
    // Backoff: 500ms for the first 30s (catches the fresh-spawn race),
    // then 2s steady-state. Daemon-side cost is negligible (one stat()
    // per file-listing per agent dir per tick); stopChatStream() on
    // session-detach/close tears down the timer cleanly so we don't leak.
    if (!path && this.ptySpawnedAtMs !== undefined) {
      // Emit an interim capability so the UI can show "waiting for
      // transcript" if it wants, rather than blank. The composer is
      // explicitly NOT gated on this — the user's first message goes
      // through the PTY (terminal input), which is what makes the
      // transcript appear in the first place.
      this.emit('event', {
        v: 1,
        kind: 'capability',
        chat: 'unavailable',
        reason: 'waiting for first message — send a prompt to start',
      } satisfies ChatEvent);

      const startedAt = Date.now();
      while (!path && !this.stopped) {
        const elapsed = Date.now() - startedAt;
        const interval = elapsed < 30_000 ? 500 : 2000;
        await new Promise((r) => setTimeout(r, interval));
        path = await this.adapter.resolveFile(resolveOpts());
      }
    }

    if (this.stopped) return;
    if (!path) {
      // Reached only when no spawn-time hint was provided AND initial
      // resolve found nothing — e.g., a manual chat-tail invocation
      // against a missing project dir.
      this.emit('event', {
        v: 1,
        kind: 'capability',
        chat: 'unavailable',
        reason: this.sessionId
          ? `no transcript file for sessionId=${this.sessionId} in ${this.cwd}`
          : `no transcript found for this session`,
      } satisfies ChatEvent);
      return;
    }
    this.filePath = path;
    this.emit('event', { v: 1, kind: 'capability', chat: 'available' } satisfies ChatEvent);

    await this.readNew();

    if (this.stopped) return;
    try {
      this.watcher = fs.watch(this.filePath, () => { void this.readNew(); });
    } catch { /* polling-only fallback */ }
    this.pollTimer = setInterval(() => { void this.readNew(); }, this.pollMs);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* ignore */ }
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.emit('end');
  }

  private async readNew(): Promise<void> {
    if (this.stopped || !this.filePath || this.reading) return;
    this.reading = true;
    try {
      let st: fs.Stats;
      try {
        st = await stat(this.filePath);
      } catch {
        this.emitEvent({ v: 1, kind: 'error', code: 'jsonl-missing', message: `file vanished: ${this.filePath}` });
        this.stop();
        return;
      }
      if (st.size < this.nextByteOffset) {
        this.emitEvent({ v: 1, kind: 'error', code: 'tail-gap', message: 'file shrank — possible rotation' });
        this.stop();
        return;
      }
      if (st.size === this.nextByteOffset) return;

      const chunk = await readFileSlice(this.filePath, this.nextByteOffset, st.size);
      this.nextByteOffset = st.size;
      const text = this.pendingBuffer + chunk;
      const lastNl = text.lastIndexOf('\n');
      const complete = lastNl === -1 ? '' : text.slice(0, lastNl);
      this.pendingBuffer = lastNl === -1 ? text : text.slice(lastNl + 1);

      if (!complete) return;

      for (const line of complete.split('\n')) {
        if (!line) continue;
        let rec: unknown;
        try {
          rec = JSON.parse(line);
        } catch {
          this.emitEvent({ v: 1, kind: 'error', code: 'schema-unknown', message: 'json parse failure' });
          continue;
        }
        for (const ev of this.translator.translate(rec)) {
          this.emitEvent(ev);
        }
      }
    } finally {
      this.reading = false;
    }
  }

  private emitEvent(ev: ChatEvent): void {
    if (this.stopped) return;
    this.emit('event', ev);
  }
}

async function readFileSlice(path: string, start: number, end: number): Promise<string> {
  if (end <= start) return '';
  const { open } = await import('node:fs/promises');
  const fd = await open(path, 'r');
  try {
    const len = end - start;
    const buf = Buffer.alloc(len);
    await fd.read(buf, 0, len, start);
    return buf.toString('utf-8');
  } finally {
    await fd.close();
  }
}
