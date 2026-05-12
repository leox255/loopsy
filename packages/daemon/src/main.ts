#!/usr/bin/env node

import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CONFIG_DIR } from '@loopsy/protocol';
import { loadConfig } from './config.js';
import { createDaemon } from './server.js';

function parseArgs(): { dataDir?: string } {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--data-dir');
  if (idx !== -1 && args[idx + 1]) {
    return { dataDir: args[idx + 1] };
  }
  return {};
}

const PID_FILE = join(homedir(), CONFIG_DIR, 'daemon.pid');

async function main() {
  const { dataDir } = parseArgs();
  const config = await loadConfig(dataDir);
  const daemon = await createDaemon(config);

  // Write our own PID so `loopsy stop` kills the right process. The CLI used
  // to save `spawn().pid` from a `caffeinate` wrapper, which on macOS yielded
  // a parent PID that didn't always match the long-lived node daemon — leaving
  // `loopsy restart` to silently spawn a duplicate that crashed on EADDRINUSE.
  await writeFile(PID_FILE, String(process.pid));

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await unlink(PID_FILE); } catch { /* best-effort */ }
    await daemon.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await daemon.start();
}

main().catch((err) => {
  console.error('Failed to start Loopsy daemon:', err);
  process.exit(1);
});
