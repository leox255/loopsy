/**
 * Dashboard integration — mounts the dashboard UI and API routes
 * directly on the daemon's Fastify instance.
 *
 * Static files are served at /dashboard/ and API routes at /dashboard/api/*.
 * The dashboard routes proxy to the daemon's own /api/v1/* endpoints.
 *
 * Path resolution supports both monorepo and flat npm package layouts:
 *   Monorepo: packages/daemon/dist/ → ../../dashboard/dist/ and ../../dashboard/public/
 *   Flat:     dist/daemon/          → ../dashboard/        and ../dashboard/public/
 */

import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface DashboardContext {
  apiKey: string;
  allowedKeys: Record<string, string>;
}

function resolveDashboardDir(): { publicDir: string; routesDir: string } | null {
  // Monorepo: packages/daemon/dist/ → packages/dashboard/
  const monorepoPublic = join(__dirname, '..', '..', 'dashboard', 'public');
  const monorepoRoutes = join(__dirname, '..', '..', 'dashboard', 'dist', 'routes');

  // Flat npm package: dist/daemon/ → dist/dashboard/
  const flatPublic = join(__dirname, '..', 'dashboard', 'public');
  const flatRoutes = join(__dirname, '..', 'dashboard', 'routes');

  if (existsSync(monorepoPublic) && existsSync(monorepoRoutes)) {
    return { publicDir: monorepoPublic, routesDir: monorepoRoutes };
  }
  if (existsSync(flatPublic) && existsSync(flatRoutes)) {
    return { publicDir: flatPublic, routesDir: flatRoutes };
  }
  return null;
}

function resolveSessionManager(): string | null {
  // Monorepo
  const monorepo = join(__dirname, '..', '..', 'dashboard', 'dist', 'session-manager.js');
  // Flat
  const flat = join(__dirname, '..', 'dashboard', 'session-manager.js');

  if (existsSync(monorepo)) return monorepo;
  if (existsSync(flat)) return flat;
  return null;
}

export async function mountDashboard(app: FastifyInstance, ctx: DashboardContext): Promise<boolean> {
  const dirs = resolveDashboardDir();
  if (!dirs) {
    app.log.debug('Dashboard files not found, skipping mount');
    return false;
  }

  // Serve static files at /dashboard/
  await app.register(fastifyStatic, {
    root: dirs.publicDir,
    prefix: '/dashboard/',
    decorateReply: false,
  });

  // Redirect /dashboard to /dashboard/
  app.get('/dashboard', async (_request, reply) => {
    reply.redirect('/dashboard/');
  });

  // Dynamic import of dashboard route modules
  try {
    const toUrl = (p: string) => pathToFileURL(p).href;

    const { registerProxyRoutes } = await import(toUrl(join(dirs.routesDir, 'proxy.js')));
    const { registerSseRoutes } = await import(toUrl(join(dirs.routesDir, 'sse.js')));
    const { registerStatusRoutes } = await import(toUrl(join(dirs.routesDir, 'status.js')));
    const { registerSessionRoutes } = await import(toUrl(join(dirs.routesDir, 'sessions.js')));
    const { registerMessageRoutes } = await import(toUrl(join(dirs.routesDir, 'messages.js')));
    const { registerPeersAllRoute } = await import(toUrl(join(dirs.routesDir, 'peers-all.js')));
    const { registerAiTaskRoutes } = await import(toUrl(join(dirs.routesDir, 'ai-tasks.js')));

    registerProxyRoutes(app, ctx.apiKey);
    registerSseRoutes(app, ctx.apiKey);
    registerStatusRoutes(app, ctx.apiKey, ctx.allowedKeys);
    registerSessionRoutes(app);
    registerMessageRoutes(app, ctx.apiKey, ctx.allowedKeys);
    registerPeersAllRoute(app, ctx.apiKey, ctx.allowedKeys);
    registerAiTaskRoutes(app, ctx.apiKey, ctx.allowedKeys);

    app.log.info({ path: '/dashboard/' }, 'Dashboard mounted');
    return true;
  } catch (err) {
    app.log.warn({ err }, 'Failed to load dashboard routes');
    return false;
  }
}
