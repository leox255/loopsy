/**
 * Per-agent transcript adapters.
 *
 * Each agent's CLI writes its conversation history to a different place
 * with a different schema. This module abstracts both: a [TranscriptAdapter]
 * knows where to find the right file for a given (cwd, spawn time) and
 * how to translate parsed records into our wire-shape [ChatEvent].
 *
 * Supported today:
 *   - claude   → ~/.claude/projects/<cwd>/<id>.jsonl
 *   - gemini   → ~/.gemini/tmp/<basename(cwd)>/chats/session-<timestamp>-<id>.jsonl
 *   - codex    → ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl
 *
 * Not yet:
 *   - opencode → primary store is SQLite (~/.local/share/opencode/opencode.db).
 *     Tailing a SQLite write-ahead log requires different plumbing
 *     (polling + sqlite client) than the JSONL file-tail pattern, so
 *     it's deferred until we have a need for it.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { ChatEvent, ChatBlock } from './chat-event-stream.js';

export interface ResolveOptions {
  /** The cwd the PTY was spawned in. */
  cwd: string;
  /** Epoch-ms when the PTY was spawned. Used to bind to the right file. */
  spawnedAtMs: number;
  /** Explicit session id when we already know it from a prior discovery. */
  sessionId?: string;
}

export interface RecordTranslator {
  /** Translate a parsed JSON record into zero or more ChatEvents. */
  translate(rec: unknown): Generator<ChatEvent>;
  /** Final flush — close any open turn. Called at stream end. */
  flush(): Generator<ChatEvent>;
}

export interface TranscriptAdapter {
  /** Resolve the absolute file path of the transcript for this session. */
  resolveFile(opts: ResolveOptions): Promise<string | null>;
  /** Construct a fresh per-stream translator. */
  createTranslator(): RecordTranslator;
}

/* -----------------------------------------------------------------------
 * Claude
 * -----------------------------------------------------------------------*/

/** Encode a filesystem path the way Claude does for its projects dir. */
export function encodeCwdToClaudeProjectDir(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

class ClaudeTranslator implements RecordTranslator {
  private currentTurnId: string | null = null;
  private currentMessageId: string | null = null;
  private blockIndex = 0;
  private currentStopReason: string | undefined;

  *translate(recIn: unknown): Generator<ChatEvent> {
    const rec = recIn as any;
    if (!rec || typeof rec !== 'object') return;
    switch (rec.type) {
      case 'user':
        yield* this.handleUser(rec);
        return;
      case 'assistant':
        yield* this.handleAssistant(rec);
        return;
      case 'permission-mode':
      case 'file-history-snapshot':
      case 'last-prompt':
      case 'ai-title':
      case 'queue-operation':
      case 'attachment':
      case 'system':
        return;
      default:
        yield { v: 1, kind: 'error', code: 'schema-unknown', message: `unknown claude record: ${rec.type}` };
    }
  }

  *flush(): Generator<ChatEvent> {
    yield* this.flushOpenTurn();
  }

  private *flushOpenTurn(): Generator<ChatEvent> {
    if (this.currentTurnId) {
      yield { v: 1, kind: 'turn-end', turnId: this.currentTurnId, stopReason: this.currentStopReason };
      this.currentTurnId = null;
      this.currentMessageId = null;
      this.blockIndex = 0;
      this.currentStopReason = undefined;
    }
  }

  private *handleUser(rec: any): Generator<ChatEvent> {
    yield* this.flushOpenTurn();
    const turnId = rec.uuid ?? `user-${Date.now()}`;
    const content = rec.message?.content;
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

    const stop = rec.message?.stop_reason;
    if (stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens') {
      yield* this.flushOpenTurn();
    }
  }
}

export const claudeAdapter: TranscriptAdapter = {
  async resolveFile(opts) {
    const dir = join(homedir(), '.claude', 'projects', encodeCwdToClaudeProjectDir(opts.cwd));
    let entries: string[];
    try { entries = await readdir(dir); } catch { return null; }
    const jsonls = entries.filter((e) => e.endsWith('.jsonl'));
    if (opts.sessionId) {
      const match = jsonls.find((e) => e === `${opts.sessionId}.jsonl`);
      return match ? join(dir, match) : null;
    }
    return pickBySpawnBirthtime(dir, jsonls, opts.spawnedAtMs);
  },
  createTranslator: () => new ClaudeTranslator(),
};

/* -----------------------------------------------------------------------
 * Gemini
 * -----------------------------------------------------------------------*/

class GeminiTranslator implements RecordTranslator {
  private openTurnId: string | null = null;
  private blockIndex = 0;

  *translate(recIn: unknown): Generator<ChatEvent> {
    const rec = recIn as any;
    if (!rec || typeof rec !== 'object') return;
    // The first line of every Gemini session file is metadata
    // ({sessionId, projectHash, startTime, ...}). Skip it.
    if (typeof rec.sessionId === 'string' && rec.type === undefined) return;
    // `$set` records are partial state updates ({lastUpdated, etc.}).
    if (rec.$set) return;

    if (rec.type === 'user') {
      yield* this.flushOpenTurn();
      const turnId = rec.id ?? `user-${Date.now()}`;
      yield { v: 1, kind: 'turn-start', turnId, role: 'user', ts: rec.timestamp };
      const text = extractGeminiText(rec.content);
      if (text) {
        yield { v: 1, kind: 'block', turnId, messageId: turnId, index: 0, block: { type: 'text', text } };
      }
      yield { v: 1, kind: 'turn-end', turnId };
      return;
    }

    if (rec.type === 'gemini') {
      yield* this.flushOpenTurn();
      const turnId = rec.id ?? `gemini-${Date.now()}`;
      this.openTurnId = turnId;
      this.blockIndex = 0;
      yield { v: 1, kind: 'turn-start', turnId, role: 'assistant', ts: rec.timestamp, messageId: turnId };
      // `thoughts` is an array of {subject, description}. Render as
      // thinking blocks so the mobile collapses them under the Reasoning
      // pill alongside any tool calls.
      if (Array.isArray(rec.thoughts)) {
        for (const t of rec.thoughts) {
          const txt = [t?.subject, t?.description].filter(Boolean).join(': ');
          yield {
            v: 1,
            kind: 'block',
            turnId,
            messageId: turnId,
            index: this.blockIndex++,
            block: { type: 'thinking', text: txt },
          };
        }
      }
      const text = typeof rec.content === 'string'
        ? rec.content
        : extractGeminiText(rec.content);
      if (text) {
        yield {
          v: 1,
          kind: 'block',
          turnId,
          messageId: turnId,
          index: this.blockIndex++,
          block: { type: 'text', text },
        };
      }
      yield { v: 1, kind: 'turn-end', turnId };
      this.openTurnId = null;
      return;
    }

    if (rec.type === 'tool_use' || rec.type === 'tool_call') {
      // Gemini's CLI emits tool calls as separate records. Splice them
      // into the open assistant turn if one exists; otherwise drop.
      if (this.openTurnId) {
        yield {
          v: 1,
          kind: 'block',
          turnId: this.openTurnId,
          messageId: this.openTurnId,
          index: this.blockIndex++,
          block: { type: 'tool_use', id: rec.id ?? 'gemini-tool', name: rec.name ?? rec.tool ?? 'tool', input: rec.args ?? rec.input },
        };
      }
      return;
    }
    if (rec.type === 'tool_result' || rec.type === 'tool_response') {
      if (this.openTurnId) {
        yield {
          v: 1,
          kind: 'block',
          turnId: this.openTurnId,
          messageId: this.openTurnId,
          index: this.blockIndex++,
          block: {
            type: 'tool_result',
            toolUseId: rec.tool_use_id ?? rec.id ?? 'gemini-tool',
            content: rec.content ?? rec.result,
            isError: rec.error === true || rec.is_error === true,
          },
        };
      }
      return;
    }

    // `info`, `system`, etc. — surface unknowns softly so the UI can flag
    // schema drift without blowing up.
    if (rec.type && rec.type !== 'info') {
      yield { v: 1, kind: 'error', code: 'schema-unknown', message: `unknown gemini record: ${rec.type}` };
    }
  }

  *flush(): Generator<ChatEvent> {
    yield* this.flushOpenTurn();
  }

  private *flushOpenTurn(): Generator<ChatEvent> {
    if (this.openTurnId) {
      yield { v: 1, kind: 'turn-end', turnId: this.openTurnId };
      this.openTurnId = null;
      this.blockIndex = 0;
    }
  }
}

function extractGeminiText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

async function resolveGeminiProjectDir(cwd: string): Promise<string | null> {
  // Gemini stores chats under ~/.gemini/tmp/<project-name>/chats/.
  // The "project name" defaults to basename(cwd), but Gemini will append
  // -1, -2 etc when basenames collide across projects. We try the bare
  // basename first, then scan the parent dir for any folder whose
  // `.project_root` matches our cwd.
  const root = join(homedir(), '.gemini', 'tmp');
  const base = basename(cwd);
  const direct = join(root, base);
  if (existsSync(direct)) {
    const probe = await readProjectRoot(direct);
    if (probe === cwd || probe === null) return direct;
  }
  try {
    const all = await readdir(root, { withFileTypes: true });
    for (const e of all) {
      if (!e.isDirectory()) continue;
      const candidate = join(root, e.name);
      const probe = await readProjectRoot(candidate);
      if (probe === cwd) return candidate;
    }
  } catch { /* root may not exist */ }
  return null;
}

async function readProjectRoot(dir: string): Promise<string | null> {
  try {
    const text = await readFile(join(dir, '.project_root'), 'utf-8');
    return text.trim();
  } catch { return null; }
}

export const geminiAdapter: TranscriptAdapter = {
  async resolveFile(opts) {
    const project = await resolveGeminiProjectDir(opts.cwd);
    if (!project) return null;
    const chatsDir = join(project, 'chats');
    let entries: string[];
    try { entries = await readdir(chatsDir); } catch { return null; }
    // Both .json (final) and .jsonl (live) shapes exist. The .jsonl files
    // are the ones an active session writes to; we prefer those.
    const sessions = entries.filter((e) => e.startsWith('session-') && (e.endsWith('.jsonl') || e.endsWith('.json')));
    if (opts.sessionId) {
      const match = sessions.find((e) => e.includes(opts.sessionId!));
      return match ? join(chatsDir, match) : null;
    }
    return pickBySpawnBirthtime(chatsDir, sessions, opts.spawnedAtMs);
  },
  createTranslator: () => new GeminiTranslator(),
};

/* -----------------------------------------------------------------------
 * Codex
 * -----------------------------------------------------------------------*/

class CodexTranslator implements RecordTranslator {
  private currentTurnId: string | null = null;
  private blockIndex = 0;
  private currentRole: 'user' | 'assistant' | null = null;

  *translate(recIn: unknown): Generator<ChatEvent> {
    const rec = recIn as any;
    if (!rec || typeof rec !== 'object') return;

    const t = rec.type;
    const p = rec.payload ?? {};

    if (t === 'session_meta') return;
    if (t === 'turn_context' || t === 'compacted') return;

    if (t === 'response_item') {
      const sub = p.type;
      // Use event_msg/{user_message,agent_message,agent_reasoning} as the
      // canonical text source instead of response_item/message because:
      //   - response_item/message includes role=developer and role=system
      //     entries (permissions instructions, apps instructions, etc.)
      //     that aren't part of the user-visible chat.
      //   - role=user response_items include the codex CLI's
      //     env-context wrapper (AGENTS.md content, <INSTRUCTIONS>
      //     blocks). The event_msg/user_message form has the same text
      //     but at least we know it's the "live event" — which we can
      //     clean up uniformly.
      // We keep response_item only for tool calls/results, since those
      // aren't duplicated in event_msg.
      if (sub === 'message' || sub === 'reasoning') return;

      if (sub === 'function_call' || sub === 'custom_tool_call' || sub === 'web_search_call') {
        yield* this.openTurn('assistant', rec.timestamp);
        yield {
          v: 1,
          kind: 'block',
          turnId: this.currentTurnId!,
          messageId: this.currentTurnId!,
          index: this.blockIndex++,
          block: {
            type: 'tool_use',
            id: p.call_id ?? p.id ?? 'codex-tool',
            name: p.name ?? sub,
            input: p.arguments ?? p.input ?? p.query,
          },
        };
        return;
      }
      if (sub === 'function_call_output' || sub === 'custom_tool_call_output') {
        yield* this.openTurn('assistant', rec.timestamp);
        yield {
          v: 1,
          kind: 'block',
          turnId: this.currentTurnId!,
          messageId: this.currentTurnId!,
          index: this.blockIndex++,
          block: {
            type: 'tool_result',
            toolUseId: p.call_id ?? p.id ?? 'codex-tool',
            content: p.output ?? p.result,
            isError: p.success === false,
          },
        };
        return;
      }
      return;
    }

    if (t === 'event_msg') {
      const sub = p.type;
      if (sub === 'task_started' || sub === 'task_complete' || sub === 'token_count' || sub === 'turn_aborted' || sub === 'context_compacted') return;

      if (sub === 'user_message') {
        const cleaned = cleanCodexUserMessage(typeof p.message === 'string' ? p.message : '');
        if (!cleaned) return; // pure env-context wrapper, nothing to show
        yield* this.flushOpenTurn();
        const turnId = `codex-user-${rec.timestamp ?? Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        yield { v: 1, kind: 'turn-start', turnId, role: 'user', ts: rec.timestamp };
        yield { v: 1, kind: 'block', turnId, messageId: turnId, index: 0, block: { type: 'text', text: cleaned } };
        yield { v: 1, kind: 'turn-end', turnId };
        return;
      }

      if (sub === 'agent_message') {
        yield* this.openTurn('assistant', rec.timestamp);
        const text = typeof p.message === 'string' ? p.message : '';
        if (text) {
          yield {
            v: 1,
            kind: 'block',
            turnId: this.currentTurnId!,
            messageId: this.currentTurnId!,
            index: this.blockIndex++,
            block: { type: 'text', text },
          };
        }
        yield* this.flushOpenTurn();
        return;
      }

      if (sub === 'agent_reasoning') {
        yield* this.openTurn('assistant', rec.timestamp);
        const text = typeof p.text === 'string' ? p.text : (typeof p.message === 'string' ? p.message : '');
        if (text) {
          yield {
            v: 1,
            kind: 'block',
            turnId: this.currentTurnId!,
            messageId: this.currentTurnId!,
            index: this.blockIndex++,
            block: { type: 'thinking', text },
          };
        }
        return;
      }
      return;
    }
  }

  *flush(): Generator<ChatEvent> {
    yield* this.flushOpenTurn();
  }

  private *openTurn(role: 'user' | 'assistant', ts?: string): Generator<ChatEvent> {
    if (this.currentRole !== role) {
      yield* this.flushOpenTurn();
    }
    if (!this.currentTurnId) {
      this.currentTurnId = `codex-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.currentRole = role;
      this.blockIndex = 0;
      yield { v: 1, kind: 'turn-start', turnId: this.currentTurnId, role, ts };
    }
  }

  private *flushOpenTurn(): Generator<ChatEvent> {
    if (this.currentTurnId) {
      yield { v: 1, kind: 'turn-end', turnId: this.currentTurnId };
      this.currentTurnId = null;
      this.currentRole = null;
      this.blockIndex = 0;
    }
  }
}

/**
 * Strip the env-context wrapper that Codex's CLI prepends to user
 * messages (AGENTS.md content, <INSTRUCTIONS> blocks, system prefixes
 * like "IMPORTANT: …"). Returns an empty string when the message is
 * 100% wrapper — the translator drops those entirely so the chat feed
 * doesn't show session setup as if it were a user prompt.
 */
function cleanCodexUserMessage(raw: string): string {
  if (!raw) return '';
  let text = raw;
  // Drop <INSTRUCTIONS>...</INSTRUCTIONS> blocks (Codex injects these).
  text = text.replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '').trim();
  // Drop AGENTS.md preamble: lines that start with "# AGENTS.md
  // instructions for …" through the next blank line.
  text = text.replace(/^#\s+AGENTS\.md instructions for[\s\S]*?(?:\n\n|$)/i, '').trim();
  // Drop the "IMPORTANT: Do NOT read or execute…" preflight prefix the
  // orchestrator injects to scope agent access — that's not user content.
  text = text.replace(/^IMPORTANT:[\s\S]*?\n\n/i, '').trim();
  return text;
}

function extractCodexMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) => {
      if (typeof c?.text === 'string') return c.text;
      if (typeof c?.input_text === 'string') return c.input_text;
      if (typeof c?.output_text === 'string') return c.output_text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export const codexAdapter: TranscriptAdapter = {
  async resolveFile(opts) {
    // Codex shards by date: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl.
    // First narrow by stat-based birthtime window (cheap), THEN verify
    // session_meta.cwd matches (expensive — opens the file). Order
    // matters because rollouts in the same cwd can pile up over weeks
    // and we'd otherwise pay a JSON parse for every one of them.
    const root = join(homedir(), '.codex', 'sessions');
    const GRACE_MS = 10_000;
    const days = [
      new Date(opts.spawnedAtMs),
      new Date(opts.spawnedAtMs - 86400_000),
      new Date(opts.spawnedAtMs + 86400_000),
    ];

    const inWindow: { path: string; birthtimeMs: number }[] = [];
    for (const d of days) {
      const dayDir = join(root, String(d.getUTCFullYear()), pad2(d.getUTCMonth() + 1), pad2(d.getUTCDate()));
      let entries: string[];
      try { entries = await readdir(dayDir); } catch { continue; }
      for (const f of entries.filter((e) => e.startsWith('rollout-') && e.endsWith('.jsonl'))) {
        const full = join(dayDir, f);
        let s;
        try { s = await stat(full); } catch { continue; }
        if (Math.abs(s.birthtimeMs - opts.spawnedAtMs) <= GRACE_MS) {
          inWindow.push({ path: full, birthtimeMs: s.birthtimeMs });
        }
      }
    }
    if (inWindow.length === 0) return null;

    // Verify cwd on the in-window candidates only. Closer-to-spawn
    // first so we typically only check one file.
    inWindow.sort((a, b) =>
      Math.abs(a.birthtimeMs - opts.spawnedAtMs) - Math.abs(b.birthtimeMs - opts.spawnedAtMs),
    );
    for (const c of inWindow) {
      if (await codexFileMatchesCwd(c.path, opts.cwd)) return c.path;
    }
    return null;
  },
  createTranslator: () => new CodexTranslator(),
};

function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }

async function codexFileMatchesCwd(path: string, cwd: string): Promise<boolean> {
  // Read just enough of the file to find the session_meta record (it's
  // the first line) without scanning the whole rollout.
  try {
    const text = await readFile(path, 'utf-8');
    const firstLine = text.split('\n', 1)[0] ?? '';
    if (!firstLine) return false;
    const obj = JSON.parse(firstLine);
    return obj?.type === 'session_meta' && obj?.payload?.cwd === cwd;
  } catch { return false; }
}

/* -----------------------------------------------------------------------
 * Shared
 * -----------------------------------------------------------------------*/

async function pickBySpawnBirthtime(
  dir: string,
  filenames: string[],
  spawnedAtMs: number,
  graceMs = 10_000,
): Promise<string | null> {
  const candidates: { path: string; birthtimeMs: number }[] = [];
  for (const f of filenames) {
    const full = join(dir, f);
    try {
      const s = await stat(full);
      candidates.push({ path: full, birthtimeMs: s.birthtimeMs });
    } catch { /* skip */ }
  }
  if (candidates.length === 0) return null;
  const inWindow = candidates.filter((c) => Math.abs(c.birthtimeMs - spawnedAtMs) <= graceMs);
  if (inWindow.length === 0) return null;
  inWindow.sort((a, b) => Math.abs(a.birthtimeMs - spawnedAtMs) - Math.abs(b.birthtimeMs - spawnedAtMs));
  return inWindow[0].path;
}

/** Re-export for chat-event-stream's old callsite that built its own block types. */
export type { ChatBlock };

/**
 * Pick the adapter for a given agent. Returns null for agents we don't
 * have transcript support for yet (currently: opencode).
 */
export function adapterForAgent(agent: string): TranscriptAdapter | null {
  switch (agent) {
    case 'claude': return claudeAdapter;
    case 'gemini': return geminiAdapter;
    case 'codex': return codexAdapter;
    default: return null;
  }
}
