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
import { adapterForAgent } from '../src/services/transcript-adapters.ts';

function parseArgs() {
  const argv = process.argv.slice(2);
  let cwd = process.cwd();
  let sessionId: string | undefined;
  let noReplay = false;
  let fromOffset: number | undefined;
  let agent = 'claude';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') cwd = resolve(argv[++i]);
    else if (a === '--session-id') sessionId = argv[++i];
    else if (a === '--agent') agent = argv[++i];
    else if (a === '--no-replay') noReplay = true;
    else if (a === '--from-offset') fromOffset = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.error(`Usage: chat-tail [--cwd <path>] [--agent claude|gemini|codex] [--session-id <id>] [--no-replay] [--from-offset <N>]`);
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return { cwd, sessionId, noReplay, fromOffset, agent };
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
  const adapter = adapterForAgent(args.agent);
  if (!adapter) {
    console.error(`No transcript adapter for agent: ${args.agent}`);
    process.exit(2);
  }
  console.error(c.dim(`chat-tail agent=${args.agent} cwd=${args.cwd} sessionId=${args.sessionId ?? '(by spawn time)'}\n`));
  // For the verifier, treat the current time as the spawn time so the
  // adapter resolves a freshly-active file. --no-replay still works
  // through startByteOffset (the existing inflation hack), and the
  // stream will tail from there.
  const stream = new ChatEventStream({
    adapter,
    cwd: args.cwd,
    sessionId: args.sessionId,
    ptySpawnedAtMs: Date.now(),
    startByteOffset: args.fromOffset ?? 0,
  });
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
