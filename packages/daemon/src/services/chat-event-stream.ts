/**
 * Reads a Claude CLI session's JSONL log and translates the raw records into
 * a stable `ChatEvent` stream that a chat-style UI can render.
 *
 * Why this exists, in one line: PTY output is great for terminal rendering
 * but useless for "show me the conversation as a chat". The Claude CLI
 * already writes a structured trail of every turn to
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`; we tail that file.
 *
 * Spike findings (2026-05-13) that shaped this design:
 *   - Each `assistant` record carries ONE content block (text / thinking /
 *     tool_use). The same `message.id` recurs across multiple records that
 *     belong to one logical turn. We group on messageId.
 *   - First line of every JSONL file contains the sessionId, so resolving
 *     "which JSONL belongs to this cwd" is just: pick newest *.jsonl in the
 *     project dir.
 *   - Tool results come back inside `user` records as
 *     `message.content[].type === "tool_result"`.
 *   - `fs.watch` alone is lossy on macOS — atomic rewrites and rapid
 *     appends can miss events. We pair it with a 500ms poll + size-delta
 *     check so we never lose data.
 *
 * The shape here is intentionally NOT exported to `@loopsy/protocol` yet.
 * This is the daemon-internal translator; once we trust it, the wire
 * protocol version gets carved out from it.
 */

import { EventEmitter } from 'node:events';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs';

export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: unknown; isError: boolean; truncated?: boolean };

export type ChatErrorCode =
  | 'tail-gap'           // file shrank or rotated — we cannot guarantee we saw everything
  | 'jsonl-missing'      // expected file vanished
  | 'schema-unknown'     // a record had a shape we don't know how to translate
  | 'session-ended'      // Claude session exited cleanly
  | 'project-dir-missing'; // no `~/.claude/projects/<encoded-cwd>/` directory yet

export type ChatEvent =
  | { v: 1; kind: 'capability'; chat: 'available' | 'unavailable'; reason?: string }
  | { v: 1; kind: 'turn-start'; turnId: string; role: 'user' | 'assistant'; ts?: string; messageId?: string }
  | { v: 1; kind: 'block'; turnId: string; messageId: string; index: number; block: ChatBlock }
  | { v: 1; kind: 'turn-end'; turnId: string; stopReason?: string }
  | { v: 1; kind: 'error'; code: ChatErrorCode; message: string };

export interface ChatEventStreamOptions {
  /** The cwd Claude was launched from. Used to compute the project dir. */
  cwd: string;
  /** Optional sessionId. When omitted, we pick the newest *.jsonl under the project dir. */
  sessionId?: string;
  /** Override Claude's project root. Default `~/.claude/projects`. Mostly for testing. */
  claudeProjectsRoot?: string;
  /** Polling interval used as fs.watch backup. Default 500ms. */
  pollMs?: number;
  /** Byte offset to start tailing from. Default 0 (full replay). */
  startByteOffset?: number;
}

const DEFAULT_POLL_MS = 500;

/**
 * Encode a filesystem path the way Claude does for its projects directory:
 * leading `/` becomes the leading `-`, and every other `/` becomes `-`. The
 * encoding is lossy for paths containing literal dashes — that's Claude's
 * choice, not ours. We accept the same lossiness so directory lookups
 * agree with how Claude wrote the files.
 */
export function encodeCwdToProjectDir(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

/** Resolve the JSONL file path for a session, given just a cwd. */
async function resolveSessionFile(opts: {
  cwd: string;
  sessionId?: string;
  claudeProjectsRoot: string;
}): Promise<string | null> {
  const dir = join(opts.claudeProjectsRoot, encodeCwdToProjectDir(opts.cwd));
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const jsonls = entries.filter((e) => e.endsWith('.jsonl'));
  if (jsonls.length === 0) return null;
  if (opts.sessionId) {
    const match = jsonls.find((e) => e === `${opts.sessionId}.jsonl`);
    return match ? join(dir, match) : null;
  }
  // Pick newest by mtime.
  let best: { path: string; mtimeMs: number } | null = null;
  for (const f of jsonls) {
    const full = join(dir, f);
    try {
      const s = await stat(full);
      if (!best || s.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: s.mtimeMs };
    } catch { /* skip */ }
  }
  return best?.path ?? null;
}

interface ParsedLine {
  raw: any;
  byteOffset: number;
}

/**
 * Translate raw JSONL records into `ChatEvent`s, with `messageId` grouping
 * so the consumer can render multi-block assistant turns as a single
 * conversation entry.
 */
class JsonlTranslator {
  private currentTurnId: string | null = null;
  private currentMessageId: string | null = null;
  private blockIndex = 0;
  private currentStopReason: string | undefined;

  *translate(rec: any): Generator<ChatEvent> {
    if (!rec || typeof rec !== 'object') return;

    switch (rec.type) {
      case 'user':
        yield* this.handleUser(rec);
        return;
      case 'assistant':
        yield* this.handleAssistant(rec);
        return;
      // Records we deliberately drop: noise for a chat view.
      case 'permission-mode':
      case 'file-history-snapshot':
      case 'last-prompt':
      case 'ai-title':
      case 'queue-operation':
      case 'attachment':
      case 'system':
        return;
      default:
        // Unknown — emit a soft error so the UI can surface "we missed something".
        yield { v: 1, kind: 'error', code: 'schema-unknown', message: `unknown record type: ${rec.type}` };
    }
  }

  /** Flush any open assistant turn — called at end-of-replay so the UI knows the turn closed. */
  *flushOpenTurn(): Generator<ChatEvent> {
    if (this.currentTurnId) {
      yield { v: 1, kind: 'turn-end', turnId: this.currentTurnId, stopReason: this.currentStopReason };
      this.currentTurnId = null;
      this.currentMessageId = null;
      this.blockIndex = 0;
      this.currentStopReason = undefined;
    }
  }

  private *handleUser(rec: any): Generator<ChatEvent> {
    // Close any open assistant turn first; user turns are atomic in the JSONL.
    yield* this.flushOpenTurn();

    const turnId = rec.uuid ?? `user-${Date.now()}`;
    const content = rec.message?.content;

    // User records carry either a literal prompt string OR an array of
    // content blocks that may include `tool_result`. We split: prompts get
    // emitted as user turn-start+text-block+turn-end; tool_results become
    // their own turn-start/block/turn-end triplets so the chat UI can
    // render them inline.
    if (typeof content === 'string') {
      yield { v: 1, kind: 'turn-start', turnId, role: 'user', ts: rec.timestamp };
      yield { v: 1, kind: 'block', turnId, messageId: turnId, index: 0, block: { type: 'text', text: content } };
      yield { v: 1, kind: 'turn-end', turnId };
      return;
    }
    if (!Array.isArray(content)) return;

    let i = 0;
    for (const b of content) {
      if (b?.type === 'tool_result') {
        const trId = `${turnId}#tr${i}`;
        yield { v: 1, kind: 'turn-start', turnId: trId, role: 'user', ts: rec.timestamp };
        yield {
          v: 1,
          kind: 'block',
          turnId: trId,
          messageId: trId,
          index: 0,
          block: {
            type: 'tool_result',
            toolUseId: b.tool_use_id,
            content: b.content,
            isError: b.is_error === true,
          },
        };
        yield { v: 1, kind: 'turn-end', turnId: trId };
      } else if (b?.type === 'text' && typeof b.text === 'string') {
        const tId = `${turnId}#u${i}`;
        yield { v: 1, kind: 'turn-start', turnId: tId, role: 'user', ts: rec.timestamp };
        yield { v: 1, kind: 'block', turnId: tId, messageId: tId, index: 0, block: { type: 'text', text: b.text } };
        yield { v: 1, kind: 'turn-end', turnId: tId };
      }
      i++;
    }
  }

  private *handleAssistant(rec: any): Generator<ChatEvent> {
    const messageId: string | undefined = rec.message?.id;
    if (!messageId) {
      yield { v: 1, kind: 'error', code: 'schema-unknown', message: 'assistant record missing message.id' };
      return;
    }
    // Start a new turn whenever messageId changes. Same messageId across
    // multiple records → same turn (one block per record).
    if (this.currentMessageId !== messageId) {
      yield* this.flushOpenTurn();
      this.currentTurnId = messageId;
      this.currentMessageId = messageId;
      this.blockIndex = 0;
      yield { v: 1, kind: 'turn-start', turnId: messageId, role: 'assistant', ts: rec.timestamp, messageId };
    }
    this.currentStopReason = rec.message?.stop_reason ?? this.currentStopReason;

    const blocks = Array.isArray(rec.message?.content) ? rec.message.content : [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      const turnId = this.currentTurnId!;
      const idx = this.blockIndex++;
      switch (b.type) {
        case 'text':
          if (typeof b.text === 'string') {
            yield { v: 1, kind: 'block', turnId, messageId, index: idx, block: { type: 'text', text: b.text } };
          }
          break;
        case 'thinking':
          // Thinking blocks may be empty / signature-only. Emit anyway so
          // the UI can show "Claude is reasoning…" affordance.
          yield {
            v: 1,
            kind: 'block',
            turnId,
            messageId,
            index: idx,
            block: { type: 'thinking', text: typeof b.thinking === 'string' ? b.thinking : '' },
          };
          break;
        case 'tool_use':
          yield {
            v: 1,
            kind: 'block',
            turnId,
            messageId,
            index: idx,
            block: { type: 'tool_use', id: b.id, name: b.name, input: b.input },
          };
          break;
        default:
          yield { v: 1, kind: 'error', code: 'schema-unknown', message: `unknown assistant block: ${b.type}` };
      }
    }
  }
}

/**
 * EventEmitter-based file tail. Emits `event` for each ChatEvent, `error`
 * for fatal errors that ended the tail, and `end` when stop() is called.
 *
 * Tailing strategy:
 *   1. fs.watch on the file (low latency on most platforms, lossy on some).
 *   2. setInterval poll every `pollMs` as a backup. We re-stat the file
 *      and compare size; if it grew, read the new bytes; if it shrank,
 *      emit a `tail-gap` error and stop.
 *   3. Partial last line is held in `pendingBuffer` until the next read
 *      delivers the closing `\n`.
 */
export class ChatEventStream extends EventEmitter {
  private opts: Required<Omit<ChatEventStreamOptions, 'sessionId' | 'startByteOffset'>> & Pick<ChatEventStreamOptions, 'sessionId' | 'startByteOffset'>;
  private filePath: string | null = null;
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private nextByteOffset = 0;
  private pendingBuffer = '';
  private translator = new JsonlTranslator();
  private stopped = false;
  private reading = false;

  constructor(options: ChatEventStreamOptions) {
    super();
    this.opts = {
      cwd: options.cwd,
      sessionId: options.sessionId,
      claudeProjectsRoot: options.claudeProjectsRoot ?? join(homedir(), '.claude', 'projects'),
      pollMs: options.pollMs ?? DEFAULT_POLL_MS,
      startByteOffset: options.startByteOffset,
    };
    this.nextByteOffset = options.startByteOffset ?? 0;
  }

  async start(): Promise<void> {
    const path = await resolveSessionFile({
      cwd: this.opts.cwd,
      sessionId: this.opts.sessionId,
      claudeProjectsRoot: this.opts.claudeProjectsRoot,
    });
    if (!path) {
      this.emit('event', {
        v: 1,
        kind: 'capability',
        chat: 'unavailable',
        reason: this.opts.sessionId
          ? `no JSONL file for sessionId=${this.opts.sessionId} under ${encodeCwdToProjectDir(this.opts.cwd)}`
          : `no JSONL files under ${encodeCwdToProjectDir(this.opts.cwd)}`,
      } satisfies ChatEvent);
      return;
    }
    this.filePath = path;
    this.emit('event', { v: 1, kind: 'capability', chat: 'available' } satisfies ChatEvent);

    // Replay everything from startByteOffset.
    await this.readNew();

    if (this.stopped) return;
    // Switch to live tailing.
    try {
      this.watcher = fs.watch(this.filePath, () => { void this.readNew(); });
    } catch {
      // fs.watch can throw on some filesystems — polling alone still works.
    }
    this.pollTimer = setInterval(() => { void this.readNew(); }, this.opts.pollMs);
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
        // File truncated or rotated. We can't know whether we missed events
        // mid-stream, so we surface this and stop. Restart with a fresh
        // ChatEventStream if recovery is desired.
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
        let rec: any;
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

/**
 * Read [start, end) from a file. Node's `readFile` reads the whole thing,
 * so we use a low-level file handle for a single ranged read. Allocating
 * a Buffer of size `end - start` is fine for the chunks we expect (single
 * appended assistant record is typically <50 KB).
 */
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
