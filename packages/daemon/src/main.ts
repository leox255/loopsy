#!/usr/bin/env node

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

async function main() {
  const { dataDir } = parseArgs();
  const config = await loadConfig(dataDir);
  const daemon = await createDaemon(config);

  const shutdown = async () => {
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
