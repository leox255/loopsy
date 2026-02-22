import type { FastifyInstance } from 'fastify';
import { listSessions } from '../session-manager.js';
import { fetchAndDeduplicatePeers } from './peer-utils.js';

function resolveHost(address?: string): { host: string; isRemote: boolean } {
  const isRemote = !!address && address !== '127.0.0.1' && address !== 'localhost';
  return { host: isRemote ? address! : '127.0.0.1', isRemote };
}

function resolveApiKey(
  host: string,
  isRemote: boolean,
  localApiKey: string,
  allowedKeys: Record<string, string>,
): string {
  if (!isRemote) return localApiKey;
  // All remote peers share the same allowed key set — pick the first non-local key
  for (const key of Object.values(allowedKeys)) {
    if (key !== localApiKey) return key;
  }
  return localApiKey;
}

export function registerAiTaskRoutes(
  app: FastifyInstance,
  apiKey: string,
  allowedKeys: Record<string, string>,
) {
  // Dispatch an AI task to a target session/peer
  app.post('/dashboard/api/ai-tasks/dispatch', async (request, reply) => {
    const { targetPort, targetAddress, prompt, cwd, permissionMode, model, maxBudgetUsd, allowedTools, disallowedTools, additionalArgs, resumeSessionId } =
      request.body as any;

    if (!prompt) {
      reply.code(400);
      return { error: 'Missing prompt' };
    }

    const body: any = { prompt, cwd, permissionMode, model, maxBudgetUsd, allowedTools, disallowedTools, additionalArgs };
    if (resumeSessionId) body.resumeSessionId = resumeSessionId;

    const { host, isRemote } = resolveHost(targetAddress);
    const port = targetPort || 19532;
    const targetApiKey = resolveApiKey(host, isRemote, apiKey, allowedKeys);

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

  // Aggregate tasks across all running sessions AND remote peers
  app.get('/dashboard/api/ai-tasks/all', async () => {
    const { main, sessions } = await listSessions();
    const running: { host: string; port: number; hostname: string; key: string }[] = [];

    // Local sessions
    if (main && main.status === 'running') {
      running.push({ host: '127.0.0.1', port: main.port, hostname: main.hostname, key: apiKey });
    }
    for (const s of sessions.filter((s) => s.status === 'running')) {
      running.push({ host: '127.0.0.1', port: s.port, hostname: s.hostname, key: apiKey });
    }

    // Remote peers
    try {
      const peers = await fetchAndDeduplicatePeers(apiKey, allowedKeys);
      const remotePeers = peers.filter(
        (p) => p.address !== '127.0.0.1' && p.address !== 'localhost' && p.status === 'online',
      );
      for (const p of remotePeers) {
        const remoteKey = resolveApiKey(p.address, true, apiKey, allowedKeys);
        // Avoid duplicates (same address:port)
        if (!running.some((r) => r.host === p.address && r.port === p.port)) {
          running.push({ host: p.address, port: p.port, hostname: p.hostname, key: remoteKey });
        }
      }
    } catch {}

    const results = await Promise.allSettled(
      running.map(async (s) => {
        const res = await fetch(`http://${s.host}:${s.port}/api/v1/ai-tasks`, {
          headers: { Authorization: `Bearer ${s.key}` },
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return [];
        const data = (await res.json()) as { tasks?: any[] };
        return (data.tasks || []).map((t: any) => ({
          ...t,
          _sourcePort: s.port,
          _sourceAddress: s.host,
          _sourceHostname: s.hostname,
        }));
      }),
    );

    const tasks: any[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') tasks.push(...r.value);
    }

    // Deduplicate by taskId
    const map = new Map<string, any>();
    for (const t of tasks) {
      if (!map.has(t.taskId)) map.set(t.taskId, t);
    }

    const dedupedTasks = Array.from(map.values()).sort((a, b) => b.startedAt - a.startedAt);
    return { tasks: dedupedTasks, timestamp: Date.now() };
  });

  // SSE proxy: stream task events from a specific daemon
  app.get<{ Params: { port: string; taskId: string }; Querystring: { since?: string; address?: string } }>(
    '/dashboard/api/ai-tasks/stream/:port/:taskId',
    async (request, reply) => {
      const port = parseInt(request.params.port, 10);
      const { taskId } = request.params;
      const since = request.query.since || '0';
      const { host, isRemote } = resolveHost(request.query.address);
      const targetKey = resolveApiKey(host, isRemote, apiKey, allowedKeys);

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      try {
        const upstreamRes = await fetch(
          `http://${host}:${port}/api/v1/ai-tasks/${encodeURIComponent(taskId)}/stream?since=${since}`,
          {
            headers: { Authorization: `Bearer ${targetKey}` },
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
  app.post<{ Params: { port: string; taskId: string }; Querystring: { address?: string } }>(
    '/dashboard/api/ai-tasks/approve/:port/:taskId',
    async (request, reply) => {
      const port = parseInt(request.params.port, 10);
      const { taskId } = request.params;
      const { host, isRemote } = resolveHost(request.query.address);
      const targetKey = resolveApiKey(host, isRemote, apiKey, allowedKeys);

      try {
        const res = await fetch(`http://${host}:${port}/api/v1/ai-tasks/${encodeURIComponent(taskId)}/approve`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${targetKey}`,
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
  app.delete<{ Params: { port: string; taskId: string }; Querystring: { address?: string } }>(
    '/dashboard/api/ai-tasks/cancel/:port/:taskId',
    async (request, reply) => {
      const port = parseInt(request.params.port, 10);
      const { taskId } = request.params;
      const { host, isRemote } = resolveHost(request.query.address);
      const targetKey = resolveApiKey(host, isRemote, apiKey, allowedKeys);

      try {
        const res = await fetch(`http://${host}:${port}/api/v1/ai-tasks/${encodeURIComponent(taskId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${targetKey}` },
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
