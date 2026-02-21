import type { FastifyInstance } from 'fastify';
import { listSessions, startSession, stopSession } from '../session-manager.js';

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
