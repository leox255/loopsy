import type { FastifyInstance } from 'fastify';
import { listSessions } from '../session-manager.js';
import { fetchAndDeduplicatePeers } from './peer-utils.js';

export function registerAiTaskRoutes(
  app: FastifyInstance,
  apiKey: string,
  allowedKeys: Record<string, string>,
) {
  // Dispatch an AI task to a target session/peer
  app.post('/dashboard/api/ai-tasks/dispatch', async (request, reply) => {
    const { targetPort, targetAddress, prompt, cwd, permissionMode, model, maxBudgetUsd, allowedTools, disallowedTools, additionalArgs } =
      request.body as any;

    if (!prompt) {
      reply.code(400);
      return { error: 'Missing prompt' };
    }

    const body = { prompt, cwd, permissionMode, model, maxBudgetUsd, allowedTools, disallowedTools, additionalArgs };

    // Determine target: local session or remote peer
    const isRemote = targetAddress && targetAddress !== '127.0.0.1' && targetAddress !== 'localhost';
    const host = isRemote ? targetAddress : '127.0.0.1';
    const port = targetPort || 19532;

    // Resolve API key for remote peers
    let targetApiKey = apiKey;
    if (isRemote) {
      for (const key of Object.values(allowedKeys)) {
        if (key !== apiKey) {
          targetApiKey = key;
          break;
        }
      }
    }

    try {
      const res = await fetch(`http://${host}:${port}/api/v1/ai-tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${targetApiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json();
      if (!res.ok) {
        reply.code(res.status);
      }
      return { ...data as object, _targetPort: port, _targetAddress: host };
    } catch (err: any) {
      reply.code(502);
      return { error: `Failed to reach target: ${err.message}` };
    }
  });

  // Aggregate tasks across all running sessions
  app.get('/dashboard/api/ai-tasks/all', async () => {
    const { main, sessions } = await listSessions();
    const running = [];
    if (main && main.status === 'running') running.push(main);
    running.push(...sessions.filter((s) => s.status === 'running'));

    const results = await Promise.allSettled(
      running.map(async (s) => {
        const res = await fetch(`http://127.0.0.1:${s.port}/api/v1/ai-tasks`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return [];
        const data = (await res.json()) as { tasks?: any[] };
        return (data.tasks || []).map((t: any) => ({ ...t, _sourcePort: s.port, _sourceHostname: s.hostname }));
      }),
    );

    const tasks: any[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') tasks.push(...r.value);
    }

    // Deduplicate by taskId (same task won't be on multiple sessions)
    const map = new Map<string, any>();
    for (const t of tasks) {
      if (!map.has(t.taskId)) map.set(t.taskId, t);
    }

    const dedupedTasks = Array.from(map.values()).sort((a, b) => b.startedAt - a.startedAt);
    return { tasks: dedupedTasks, timestamp: Date.now() };
  });

  // SSE proxy: stream task events from a specific daemon
  app.get<{ Params: { port: string; taskId: string }; Querystring: { since?: string } }>(
    '/dashboard/api/ai-tasks/stream/:port/:taskId',
    async (request, reply) => {
      const port = parseInt(request.params.port, 10);
      const { taskId } = request.params;
      const since = request.query.since || '0';

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      try {
        const upstreamRes = await fetch(
          `http://127.0.0.1:${port}/api/v1/ai-tasks/${encodeURIComponent(taskId)}/stream?since=${since}`,
          {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(DEFAULT_AI_TASK_TIMEOUT),
          },
        );

        if (!upstreamRes.ok) {
          const errText = await upstreamRes.text();
          reply.raw.write(
            `data: ${JSON.stringify({ type: 'error', taskId, timestamp: Date.now(), data: errText })}\n\n`,
          );
          reply.raw.end();
          return;
        }

        if (upstreamRes.body) {
          for await (const chunk of upstreamRes.body as any) {
            if (reply.raw.destroyed) break;
            reply.raw.write(chunk);
          }
        }
      } catch (err: any) {
        reply.raw.write(
          `data: ${JSON.stringify({ type: 'error', taskId, timestamp: Date.now(), data: err.message })}\n\n`,
        );
      }

      reply.raw.end();
    },
  );

  // Proxy approval to daemon
  app.post<{ Params: { port: string; taskId: string } }>(
    '/dashboard/api/ai-tasks/approve/:port/:taskId',
    async (request, reply) => {
      const port = parseInt(request.params.port, 10);
      const { taskId } = request.params;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/ai-tasks/${encodeURIComponent(taskId)}/approve`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(request.body),
          signal: AbortSignal.timeout(5000),
        });
        const data = await res.json();
        if (!res.ok) reply.code(res.status);
        return data;
      } catch (err: any) {
        reply.code(502);
        return { error: err.message };
      }
    },
  );

  // Proxy cancel to daemon
  app.delete<{ Params: { port: string; taskId: string } }>(
    '/dashboard/api/ai-tasks/cancel/:port/:taskId',
    async (request, reply) => {
      const port = parseInt(request.params.port, 10);
      const { taskId } = request.params;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/ai-tasks/${encodeURIComponent(taskId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5000),
        });
        const data = await res.json();
        if (!res.ok) reply.code(res.status);
        return data;
      } catch (err: any) {
        reply.code(502);
        return { error: err.message };
      }
    },
  );
}

// Import the constant
const DEFAULT_AI_TASK_TIMEOUT = 1_800_000;
