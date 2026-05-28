// Read a real session JSONL through each adapter and print the
// translated ChatEvents — verifies the pipeline that the chat panel
// consumes.

import { codexAdapter, geminiAdapter, claudeAdapter } from '../dist/services/transcript-adapters.js';
import { readFile } from 'node:fs/promises';

async function run(label, file, adapter) {
  console.log(`\n=== ${label}\n${file}`);
  const text = await readFile(file, 'utf-8');
  const translator = adapter.createTranslator();
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    for (const ev of translator.translate(rec)) events.push(ev);
  }
  for (const ev of translator.flush()) events.push(ev);
  console.log(`emitted ${events.length} events:`);
  for (const ev of events) {
    const summary = ev.kind === 'block'
      ? `block.${ev.block.type}${ev.block.text ? `: "${ev.block.text.slice(0,80)}"` : ''}`
      : `${ev.kind}${ev.role ? ` (${ev.role})` : ''}${ev.reason ? ' — ' + ev.reason : ''}${ev.message ? ' — ' + ev.message : ''}`;
    console.log(`  ${summary}`);
  }
}

// Most recent test files from our submit-test runs
await run(
  'CODEX',
  '/Users/amosff/.codex/sessions/2026/05/13/rollout-2026-05-13T15-57-26-019e2169-dd3d-7973-8ff2-1dc86be6e33f.jsonl',
  codexAdapter,
);
await run(
  'GEMINI',
  '/Users/amosff/.gemini/tmp/tmp/chats/session-2026-05-13T13-00-70db5bb9.jsonl',
  geminiAdapter,
);
