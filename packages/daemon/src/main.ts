#!/usr/bin/env node

import { loadConfig } from './config.js';
import { createDaemon } from './server.js';

async function main() {
  const config = await loadConfig();
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
