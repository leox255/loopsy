import type { FastifyInstance } from 'fastify';
import { listSessions } from '../session-manager.js';
import { fetchAndDeduplicatePeers } from './peer-utils.js';

export function registerStatusRoutes(app: FastifyInstance, apiKey: string) {
  app.get('/dashboard/api/status/aggregate', async () => {
    const { main, sessions } = await listSessions();
    const allSessions = main ? [main, ...sessions] : sessions;
    const running = allSessions.filter(s => s.status === 'running');

    // Fetch status and peers in parallel
    const [statusResults, peers] = await Promise.all([
      Promise.allSettled(
        running.map(async (session) => {
          const res = await fetch(`http://127.0.0.1:${session.port}/api/v1/status`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(3000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          return { ...session, ...(data as object) };
        }),
      ),
      fetchAndDeduplicatePeers(apiKey).catch(() => []),
    ]);

    const enriched = statusResults.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { ...running[i], error: 'unreachable' },
    );

    // Include stopped sessions too
    const stopped = allSessions.filter(s => s.status !== 'running');

    return {
      sessions: [...enriched, ...stopped],
      network: {
        peers,
        uniqueCount: peers.length,
        onlineCount: peers.filter((p) => p.status === 'online').length,
      },
      timestamp: Date.now(),
    };
  });
}
