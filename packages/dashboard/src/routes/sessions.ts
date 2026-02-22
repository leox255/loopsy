import type { FastifyInstance } from 'fastify';
import { listSessions, startSession, stopSession, restartSession } from '../session-manager.js';

export function registerSessionRoutes(app: FastifyInstance) {
  app.get('/dashboard/api/sessions', async () => {
    return listSessions();
  });

  app.post<{ Body: { name?: string; fleet?: boolean; count?: number } }>(
    '/dashboard/api/sessions',
    async (request) => {
      const { name, fleet, count } = request.body ?? {};

      if (fleet && count) {
        const results = [];
        for (let i = 1; i <= count; i++) {
          try {
            const session = await startSession(`worker-${i}`);
            results.push(session);
          } catch (err: any) {
            results.push({ name: `worker-${i}`, error: err.message });
          }
        }
        return { sessions: results };
      }

      if (name) {
        const session = await startSession(name);
        return session;
      }

      return { error: 'Provide "name" or "fleet" + "count"' };
    },
  );

  app.post<{ Params: { name: string } }>(
    '/dashboard/api/sessions/:name/restart',
    async (request, reply) => {
      try {
        const session = await restartSession(request.params.name);
        return { success: true, session };
      } catch (err: any) {
        reply.code(500);
        return { error: err.message };
      }
    },
  );

  app.post('/dashboard/api/sessions/restart-all', async () => {
    const { sessions } = await listSessions();
    const results = [];
    for (const s of sessions) {
      if (s.status === 'running') {
        try {
          const session = await restartSession(s.name);
          results.push(session);
        } catch (err: any) {
          results.push({ name: s.name, error: err.message });
        }
      }
    }
    return { sessions: results };
  });

  app.delete<{ Params: { name: string } }>(
    '/dashboard/api/sessions/:name',
    async (request, reply) => {
      try {
        await stopSession(request.params.name);
        return { success: true, name: request.params.name };
      } catch (err: any) {
        reply.code(404);
        return { error: err.message };
      }
    },
  );
}
