#!/usr/bin/env -S node --experimental-strip-types
/*
 * chat-tail.ts
 *
 * Verifier for the new ChatEventStream service. Tails a Claude CLI session's
 * JSONL log and prints translated `ChatEvent`s to stdout, color-coded so we
 * can eyeball the translation before any wire-protocol work.
 *
 * Usage:
 *   node --experimental-strip-types packages/daemon/scripts/chat-tail.ts \
 *     [--cwd <path>] [--session-id <uuid>] [--no-replay] [--from-offset <N>]
 *
 * Defaults: --cwd = process.cwd(), tails the newest *.jsonl under
 * ~/.claude/projects/<encoded-cwd>/.
 */

import { resolve } from 'node:path';
import { ChatEventStream, type ChatEvent } from '../src/services/chat-event-stream.ts';

function parseArgs() {
  const argv = process.argv.slice(2);
  let cwd = process.cwd();
  let sessionId: string | undefined;
  let noReplay = false;
  let fromOffset: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') cwd = resolve(argv[++i]);
    else if (a === '--session-id') sessionId = argv[++i];
    else if (a === '--no-replay') noReplay = true;
    else if (a === '--from-offset') fromOffset = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.error(`Usage: chat-tail [--cwd <path>] [--session-id <uuid>] [--no-replay] [--from-offset <N>]`);
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return { cwd, sessionId, noReplay, fromOffset };
}

// Minimal ANSI helpers — no chalk dep so this can run straight via ts-strip.
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
};

function preview(s: string, max = 200): string {
  const compact = s.replace(/\s+/g, ' ').trim();
  return compact.length > max ? compact.slice(0, max) + '…' : compact;
}

function render(ev: ChatEvent): string {
  switch (ev.kind) {
    case 'capability':
      return ev.chat === 'available'
        ? c.green('● chat available')
        : c.yellow(`○ chat unavailable: ${ev.reason ?? '?'}`);
    case 'turn-start': {
      const role = ev.role === 'user' ? c.cyan('USER') : c.magenta('ASSISTANT');
      return `${c.dim('─'.repeat(60))}\n${role} ${c.dim(ev.messageId ?? ev.turnId)}`;
    }
    case 'turn-end':
      return c.dim(`└─ end${ev.stopReason ? ` (${ev.stopReason})` : ''}`);
    case 'error':
      return c.red(`✗ ${ev.code}: ${ev.message}`);
    case 'block':
      switch (ev.block.type) {
        case 'text':
          return `  ${c.bold('text')}    ${preview(ev.block.text, 500)}`;
        case 'thinking':
          return `  ${c.blue('think')}   ${preview(ev.block.text, 200)}`;
        case 'tool_use':
          return `  ${c.yellow('tool')}    ${c.bold(ev.block.name)} ${c.dim(preview(JSON.stringify(ev.block.input), 200))}`;
        case 'tool_result': {
          const body = typeof ev.block.content === 'string'
            ? preview(ev.block.content, 300)
            : preview(JSON.stringify(ev.block.content), 300);
          const tag = ev.block.isError ? c.red('error!') : c.green('result');
          return `  ${tag}  ${c.dim(ev.block.toolUseId)} ${body}`;
        }
      }
  }
}

async function main() {
  const args = parseArgs();
  console.error(c.dim(`chat-tail cwd=${args.cwd} sessionId=${args.sessionId ?? '(newest)'}\n`));
  const stream = new ChatEventStream({
    cwd: args.cwd,
    sessionId: args.sessionId,
    startByteOffset: args.fromOffset ?? (args.noReplay ? Number.MAX_SAFE_INTEGER : 0),
  });

  // --no-replay: jump straight to current end-of-file. We approximate by
  // starting at MAX_SAFE_INTEGER, which the tail rejects as a tail-gap. So
  // do the proper thing: resolve the file first, stat it, pass the size.
  if (args.noReplay) {
    const { stat, readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const root = join(homedir(), '.claude', 'projects', args.cwd.replace(/\//g, '-'));
    try {
      const entries = (await readdir(root)).filter((e) => e.endsWith('.jsonl'));
      let newest = '';
      let newestMt = 0;
      for (const e of entries) {
        const s = await stat(join(root, e));
        if (s.mtimeMs > newestMt) { newest = join(root, e); newestMt = s.mtimeMs; }
      }
      if (newest) {
        const s = await stat(newest);
        const cur = new ChatEventStream({ cwd: args.cwd, sessionId: args.sessionId, startByteOffset: s.size });
        wireAndRun(cur);
        return;
      }
    } catch { /* fall through */ }
  }

  wireAndRun(stream);
}

function wireAndRun(stream: ChatEventStream) {
  let count = 0;
  stream.on('event', (ev: ChatEvent) => {
    count++;
    process.stdout.write(render(ev) + '\n');
  });
  stream.on('end', () => {
    process.stderr.write(c.dim(`\n[chat-tail] ended, ${count} events\n`));
  });
  process.on('SIGINT', () => { stream.stop(); process.exit(0); });
  void stream.start();
}

void main();
