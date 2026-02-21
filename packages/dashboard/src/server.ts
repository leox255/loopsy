#!/usr/bin/env node

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { loadDashboardConfig } from './config.js';
import { registerProxyRoutes } from './routes/proxy.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSseRoutes } from './routes/sse.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerPeersAllRoute } from './routes/peers-all.js';
import { registerAiTaskRoutes } from './routes/ai-tasks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DASHBOARD_PORT = 19540;

function parsePort(): number {
  const args = process.argv.slice(2);
  const portIdx = args.indexOf('--port');
  if (portIdx !== -1 && args[portIdx + 1]) {
    return parseInt(args[portIdx + 1], 10);
  }
  return DEFAULT_DASHBOARD_PORT;
}

function getLanIp(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

async function main() {
  const port = parsePort();
  const config = await loadDashboardConfig();

  if (!config.apiKey) {
    console.error('No API key found. Run "loopsy init" first.');
    process.exit(1);
  }

  const app = Fastify({ logger: false });

  await app.register(fastifyCors, { origin: true });

  // Serve public/ directory
  await app.register(fastifyStatic, {
    root: join(__dirname, '..', 'public'),
    prefix: '/',
  });

  // API routes
  registerProxyRoutes(app, config.apiKey);
  registerSessionRoutes(app);
  registerSseRoutes(app, config.apiKey);
  registerStatusRoutes(app, config.apiKey, config.allowedKeys);
  registerMessageRoutes(app, config.apiKey, config.allowedKeys);
  registerPeersAllRoute(app, config.apiKey, config.allowedKeys);
  registerAiTaskRoutes(app, config.apiKey, config.allowedKeys);

  await app.listen({ port, host: '0.0.0.0' });

  const lanIp = getLanIp();
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║        LOOPSY // DASHBOARD               ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║  Local:   http://localhost:${port}        ║`);
  console.log(`  ║  Network: http://${lanIp}:${port}   ║`);
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log('  Open the Network URL on your phone to access the dashboard.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
}

main().catch((err) => {
  console.error('Failed to start dashboard:', err);
  process.exit(1);
});
