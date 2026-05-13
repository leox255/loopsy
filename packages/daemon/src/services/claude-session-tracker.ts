/**
 * Persistent loopsy_session_id → claude_session_id map.
 *
 * Why this exists: the user-facing "session" lives in the loopsy
 * SessionMeta on the phone and the PTY id on the daemon. The Claude CLI
 * inside the PTY generates its own session id (the JSONL filename under
 * ~/.claude/projects). Without persistence:
 *   - When the daemon's PTY is reaped (idle timeout, daemon restart),
 *     reattaching from the phone spawns a brand-new `claude` instance
 *     with a fresh session id and an empty conversation.
 *   - The user loses their chat history every time the daemon bounces,
 *     even though the JSONL files are still on disk.
 *
 * With persistence:
 *   - First spawn: watch ~/.claude/projects/<cwd>/ for the JSONL Claude
 *     creates immediately after launch (birthtime within ±10s of PTY
 *     spawn). Save loopsy_session_id → claude_session_id to disk.
 *   - Respawn: look up the prior claude_session_id and prepend
 *     `--resume <id>` so the user's conversation continues.
 *
 * State file: ~/.loopsy/claude-sessions.json. Tiny JSON object, atomic
 * write, in-memory cache. Survives daemon restarts.
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { encodeCwdToProjectDir } from './chat-event-stream.js';

const STATE_PATH = join(homedir(), '.loopsy', 'claude-sessions.json');

interface SessionRecord {
  claudeSessionId: string;
  cwd: string;
  updatedAt: number;
}

type State = Record<string, SessionRecord>;

let cache: State | null = null;

async function load(): Promise<State> {
  if (cache) return cache;
  try {
    const text = await readFile(STATE_PATH, 'utf-8');
    cache = JSON.parse(text) as State;
  } catch {
    cache = {};
  }
  return cache;
}

async function persist(s: State): Promise<void> {
  cache = s;
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(s, null, 2));
}

/**
 * Look up the Claude session-id we previously discovered for this loopsy
 * session. Returns null if we haven't seen this session before, or if
 * the JSONL file referenced no longer exists on disk (Claude rotated it
 * away, user manually deleted, etc.) — in either case the caller should
 * spawn fresh rather than risk a `--resume` against a stale id.
 */
export async function getClaudeSessionForLoopsy(loopsyId: string): Promise<string | null> {
  const s = await load();
  const rec = s[loopsyId];
  if (!rec) return null;
  const file = join(homedir(), '.claude', 'projects', encodeCwdToProjectDir(rec.cwd), `${rec.claudeSessionId}.jsonl`);
  if (!existsSync(file)) return null;
  return rec.claudeSessionId;
}

/**
 * Record a discovered mapping. Called once per (loopsy session, Claude
 * session) pair — typically right after the first JSONL appears
 * following a fresh PTY spawn.
 */
export async function rememberClaudeSession(loopsyId: string, claudeSessionId: string, cwd: string): Promise<void> {
  const s = await load();
  s[loopsyId] = { claudeSessionId, cwd, updatedAt: Date.now() };
  await persist(s);
}

/**
 * Poll the project dir for a JSONL whose birthtime is within ±10s of the
 * PTY spawn time, and remember the mapping. Times out after 30s. Safe to
 * run as fire-and-forget — on success it updates the persistent map; on
 * failure it just logs and gives up.
 *
 * Why a poll loop rather than fs.watch: macOS' fs.watch can miss events
 * on first-create depending on the parent dir watcher state, and the
 * grace window is short enough that a 500ms poll is dirt-cheap.
 */
export async function discoverClaudeSession(opts: {
  loopsyId: string;
  cwd: string;
  spawnedAtMs: number;
  deadlineMs?: number;
}): Promise<string | null> {
  const deadlineMs = opts.deadlineMs ?? 30_000;
  const projectDir = join(homedir(), '.claude', 'projects', encodeCwdToProjectDir(opts.cwd));
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const files = await readdir(projectDir);
      for (const f of files.filter((x) => x.endsWith('.jsonl'))) {
        try {
          const s = await stat(join(projectDir, f));
          if (Math.abs(s.birthtimeMs - opts.spawnedAtMs) <= 10_000) {
            const claudeSessionId = f.replace(/\.jsonl$/, '');
            await rememberClaudeSession(opts.loopsyId, claudeSessionId, opts.cwd);
            return claudeSessionId;
          }
        } catch { /* skip unreadable */ }
      }
    } catch { /* project dir not yet created — fine */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
