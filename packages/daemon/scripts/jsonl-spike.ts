#!/usr/bin/env -S node --experimental-strip-types
/*
 * jsonl-spike.ts
 *
 * Throwaway discovery script for the chat-view feature. Reads real Claude
 * session JSONL files from ~/.claude/projects/ and answers three questions
 * before we commit to a ChatEvent protocol shape:
 *
 *   Q1. How do we map a daemon-spawned PTY → its sessionId?
 *       (Look at: cwd encoding in the directory name, first-record fields,
 *        env vars detectable on the running claude process.)
 *
 *   Q2. Are assistant messages written as deltas or as fully-formed objects
 *       at turn end? This decides whether the mobile chat panel needs a
 *       delta-accumulator or can just render append-only.
 *
 *   Q3. What is the real record-type diversity? List every `type` value, and
 *       for assistant messages list every content-block `type` we see.
 *
 * Output: human-readable Markdown to /tmp/jsonl-spike-report.md plus a tiny
 *         JSON dump alongside for any follow-up tooling.
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const SAMPLE_LIMIT = 10;   // top-N most recently modified sessions
const PREVIEW_LIMIT = 3;   // assistant messages to fully dump per session
const REPORT_PATH = '/tmp/jsonl-spike-report.md';
const JSON_PATH = '/tmp/jsonl-spike-report.json';

type RecordCounts = Record<string, number>;
type SessionSummary = {
  sessionId: string;
  filePath: string;
  bytes: number;
  mtime: string;
  lineCount: number;
  typeCounts: RecordCounts;
  assistantContentTypes: RecordCounts;
  toolUseNames: RecordCounts;
  /** Decoded cwd from the parent directory name (best effort). */
  cwdGuess: string;
  /** First record observed in the file. */
  firstRecord: unknown;
  /** Sample assistant records to inspect for delta vs whole-message shape. */
  assistantSamples: unknown[];
  /** Sample tool-result records (to see if outputs are inline strings or structured). */
  toolResultSamples: unknown[];
  /** Any record where `message.content` looked like a streaming delta. */
  deltaSamples: unknown[];
  parseErrors: number;
};

/** Decode the project dir name like "-Users-amosff-Documents-Personal-loopsy"
 * back into a filesystem path. The encoding is `/` → `-`, which is lossy for
 * paths containing literal dashes — but that's Claude's encoding, not ours. */
function decodeProjectDir(name: string): string {
  // Strip leading `-` then turn `-` into `/`.
  return '/' + name.replace(/^-/, '').replace(/-/g, '/');
}

async function pickRecentJsonl(): Promise<{ path: string; mtimeMs: number; bytes: number; sessionId: string; projectDir: string }[]> {
  const entries = await readdir(CLAUDE_PROJECTS_DIR);
  const candidates: { path: string; mtimeMs: number; bytes: number; sessionId: string; projectDir: string }[] = [];
  for (const projectDir of entries) {
    const projectPath = join(CLAUDE_PROJECTS_DIR, projectDir);
    let inner: string[];
    try {
      inner = await readdir(projectPath);
    } catch {
      continue;
    }
    for (const file of inner) {
      if (!file.endsWith('.jsonl')) continue;
      const full = join(projectPath, file);
      try {
        const s = await stat(full);
        if (!s.isFile()) continue;
        candidates.push({
          path: full,
          mtimeMs: s.mtimeMs,
          bytes: s.size,
          sessionId: file.replace(/\.jsonl$/, ''),
          projectDir,
        });
      } catch {
        /* ignore */
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.slice(0, SAMPLE_LIMIT);
}

function bump(counts: RecordCounts, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

async function summarizeSession(meta: { path: string; bytes: number; mtimeMs: number; sessionId: string; projectDir: string }): Promise<SessionSummary> {
  const text = await readFile(meta.path, 'utf-8');
  const lines = text.split('\n');
  const summary: SessionSummary = {
    sessionId: meta.sessionId,
    filePath: meta.path,
    bytes: meta.bytes,
    mtime: new Date(meta.mtimeMs).toISOString(),
    lineCount: lines.length,
    typeCounts: {},
    assistantContentTypes: {},
    toolUseNames: {},
    cwdGuess: decodeProjectDir(meta.projectDir),
    firstRecord: null,
    assistantSamples: [],
    toolResultSamples: [],
    deltaSamples: [],
    parseErrors: 0,
  };

  let firstSeen = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      summary.parseErrors++;
      continue;
    }
    if (!firstSeen) {
      summary.firstRecord = obj;
      firstSeen = true;
    }
    const t = typeof obj.type === 'string' ? obj.type : '(no-type)';
    bump(summary.typeCounts, t);

    // Assistant content block diversity.
    if (t === 'assistant' && obj.message?.content) {
      const blocks = Array.isArray(obj.message.content) ? obj.message.content : [obj.message.content];
      for (const b of blocks) {
        const bt = typeof b?.type === 'string' ? b.type : typeof b;
        bump(summary.assistantContentTypes, bt);
        if (b?.type === 'tool_use' && typeof b.name === 'string') {
          bump(summary.toolUseNames, b.name);
        }
      }
      if (summary.assistantSamples.length < PREVIEW_LIMIT) {
        summary.assistantSamples.push(obj);
      }
      // Heuristic for delta-style streaming: a partial text block with no
      // stop_reason, or a `delta` field on the message.
      if (obj.message?.delta || obj.partial === true || obj.message?.stop_reason == null && blocks.length === 0) {
        if (summary.deltaSamples.length < PREVIEW_LIMIT) summary.deltaSamples.push(obj);
      }
    }

    if ((t === 'tool_result' || t === 'tool-result') && summary.toolResultSamples.length < PREVIEW_LIMIT) {
      summary.toolResultSamples.push(obj);
    }
    // User messages can also carry tool_result blocks (the way Anthropic
    // SDKs roundtrip results back to the model). Capture one for shape.
    if (t === 'user' && Array.isArray(obj.message?.content)) {
      for (const b of obj.message.content) {
        if (b?.type === 'tool_result' && summary.toolResultSamples.length < PREVIEW_LIMIT) {
          summary.toolResultSamples.push(obj);
          break;
        }
      }
    }
  }

  return summary;
}

function renderReport(summaries: SessionSummary[]): string {
  const out: string[] = [];
  out.push('# JSONL spike report');
  out.push('');
  out.push(`Generated: ${new Date().toISOString()}`);
  out.push(`Sampled ${summaries.length} most recent session(s) under \`${CLAUDE_PROJECTS_DIR}\`.`);
  out.push('');
  out.push('## Q1 — sessionId resolution');
  out.push('');
  out.push('Project directory naming pattern (decoded → original):');
  out.push('');
  for (const s of summaries) {
    out.push(`- \`${s.cwdGuess}\` → session \`${s.sessionId}\``);
  }
  out.push('');
  out.push('Observation: Claude stores files at `~/.claude/projects/<cwd-with-slashes-as-dashes>/<sessionId>.jsonl`.');
  out.push('That means: given the cwd of a daemon-spawned PTY we can compute the project directory deterministically,');
  out.push('but the sessionId itself is generated by Claude on launch — so we need either:');
  out.push('  (a) parse the first-record sessionId from the file we are tailing, OR');
  out.push('  (b) ask the Claude CLI for its session id via stdout (look at first record below).');
  out.push('');
  out.push('First record per session (raw):');
  out.push('');
  for (const s of summaries) {
    out.push(`### ${s.sessionId}`);
    out.push('```json');
    out.push(JSON.stringify(s.firstRecord, null, 2));
    out.push('```');
  }

  out.push('');
  out.push('## Q2 — assistant messages: deltas or whole?');
  out.push('');
  out.push('Sample assistant records from the most recent session:');
  out.push('');
  const recent = summaries[0];
  if (recent) {
    for (const a of recent.assistantSamples) {
      out.push('```json');
      out.push(JSON.stringify(a, null, 2).slice(0, 4000));
      out.push('```');
    }
  }
  out.push('');
  out.push('Delta-shaped records detected (if any):');
  out.push('');
  for (const s of summaries) {
    if (s.deltaSamples.length > 0) {
      out.push(`- ${s.sessionId}: ${s.deltaSamples.length} delta-like record(s)`);
    }
  }
  out.push('');

  out.push('## Q3 — record-type diversity');
  out.push('');
  const allTypes: RecordCounts = {};
  const allBlocks: RecordCounts = {};
  const allTools: RecordCounts = {};
  for (const s of summaries) {
    for (const [k, v] of Object.entries(s.typeCounts)) allTypes[k] = (allTypes[k] ?? 0) + v;
    for (const [k, v] of Object.entries(s.assistantContentTypes)) allBlocks[k] = (allBlocks[k] ?? 0) + v;
    for (const [k, v] of Object.entries(s.toolUseNames)) allTools[k] = (allTools[k] ?? 0) + v;
  }
  out.push('Record types across all sampled sessions:');
  out.push('');
  for (const [k, v] of Object.entries(allTypes).sort((a, b) => b[1] - a[1])) {
    out.push(`- \`${k}\` × ${v}`);
  }
  out.push('');
  out.push('Assistant content-block types:');
  out.push('');
  for (const [k, v] of Object.entries(allBlocks).sort((a, b) => b[1] - a[1])) {
    out.push(`- \`${k}\` × ${v}`);
  }
  out.push('');
  out.push('Top 10 tool names seen in `tool_use` blocks:');
  out.push('');
  for (const [k, v] of Object.entries(allTools).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    out.push(`- \`${k}\` × ${v}`);
  }
  out.push('');

  out.push('## Per-session stats');
  out.push('');
  for (const s of summaries) {
    out.push(`### ${s.sessionId}`);
    out.push(`- cwd: \`${s.cwdGuess}\``);
    out.push(`- mtime: ${s.mtime}`);
    out.push(`- bytes: ${s.bytes.toLocaleString()}`);
    out.push(`- lines: ${s.lineCount.toLocaleString()}`);
    out.push(`- parse errors: ${s.parseErrors}`);
    out.push(`- types: ${Object.entries(s.typeCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    out.push('');
  }

  out.push('## Tool result shape (sample)');
  out.push('');
  const sampleTr = summaries.flatMap((s) => s.toolResultSamples).slice(0, 2);
  for (const r of sampleTr) {
    out.push('```json');
    out.push(JSON.stringify(r, null, 2).slice(0, 3000));
    out.push('```');
  }

  return out.join('\n');
}

async function main() {
  const recent = await pickRecentJsonl();
  if (recent.length === 0) {
    console.error('No JSONL sessions found under', CLAUDE_PROJECTS_DIR);
    process.exit(1);
  }
  const summaries: SessionSummary[] = [];
  for (const meta of recent) {
    process.stderr.write(`scanning ${meta.sessionId} (${(meta.bytes / 1024 / 1024).toFixed(1)} MB)…\n`);
    try {
      summaries.push(await summarizeSession(meta));
    } catch (err) {
      process.stderr.write(`  failed: ${(err as Error).message}\n`);
    }
  }
  const report = renderReport(summaries);
  await writeFile(REPORT_PATH, report);
  await writeFile(JSON_PATH, JSON.stringify(summaries, null, 2));
  process.stderr.write(`\nReport: ${REPORT_PATH}\nJSON:   ${JSON_PATH}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
