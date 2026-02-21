import type { FastifyInstance } from 'fastify';
import { listSessions } from '../session-manager.js';

export function registerStatusRoutes(app: FastifyInstance, apiKey: string) {
  app.get('/dashboard/api/status/aggregate', async () => {
    const { main, sessions } = await listSessions();
    const allSessions = main ? [main, ...sessions] : sessions;
    const running = allSessions.filter(s => s.status === 'running');

    const results = await Promise.allSettled(
      running.map(async (session) => {
        const res = await fetch(`http://127.0.0.1:${session.port}/api/v1/status`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return { ...session, ...(data as object) };
      }),
    );

    const enriched = results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { ...running[i], error: 'unreachable' },
    );

    // Include stopped sessions too
    const stopped = allSessions.filter(s => s.status !== 'running');

    return {
      sessions: [...enriched, ...stopped],
      timestamp: Date.now(),
    };
  });
}
