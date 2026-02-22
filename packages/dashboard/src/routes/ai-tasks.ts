import type { FastifyInstance } from 'fastify';
import { listSessions } from '../session-manager.js';
import { fetchAndDeduplicatePeers } from './peer-utils.js';

function resolveHost(address?: string): { host: string; isRemote: boolean } {
  const addr = address?.trim() || '';
  const isRemote = addr.length > 0 && addr !== '127.0.0.1' && addr !== 'localhost';
  return { host: isRemote ? addr : '127.0.0.1', isRemote };
}

function getRemoteKeys(
  localApiKey: string,
  allowedKeys: Record<string, string>,
): string[] {
  const keys: string[] = [];
  for (const key of Object.values(allowedKeys)) {
    if (key !== localApiKey) keys.push(key);
  }
  // Also include local key as last resort
  keys.push(localApiKey);
  return keys;
}

/** Probe a remote host to find which key works */
async function findWorkingKey(
  host: string,
  port: number,
  localApiKey: string,
  allowedKeys: Record<string, string>,
): Promise<string> {
  const keys = getRemoteKeys(localApiKey, allowedKeys);
  for (const key of keys) {
    try {
      const res = await fetch(`http://${host}:${port}/api/v1/status`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return key;
    } catch {}
  }
  return keys[0] || localApiKey;
}

export function registerAiTaskRoutes(
  app: FastifyInstance,
  apiKey: string,
  allowedKeys: Record<string, string>,
) {
  // Dispatch an AI task to a target session/peer
  app.post('/dashboard/api/ai-tasks/dispatch', async (request, reply) => {
    const { targetPort, targetAddress, prompt, cwd, permissionMode, model, agent, maxBudgetUsd, allowedTools, disallowedTools, additionalArgs, resumeSessionId } =
      request.body as any;

    if (!prompt) {
      reply.code(400);
      return { error: 'Missing prompt' };
    }

    const body: any = { prompt, cwd, permissionMode, model, agent, maxBudgetUsd, allowedTools, disallowedTools, additionalArgs };
    if (resumeSessionId) body.resumeSessionId = resumeSessionId;

    const { host, isRemote } = resolveHost(targetAddress);
    const port = targetPort || 19532;
    const keysToTry = isRemote ? getRemoteKeys(apiKey, allowedKeys) : [apiKey];

    let lastError: string = 'No keys available';
    for (const key of keysToTry) {
      try {
        const res = await fetch(`http://${host}:${port}/api/v1/ai-tasks`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json() as any;
        if (res.status === 401 || res.status === 403) {
          // Wrong key — try next
          lastError = data?.error?.message || data?.message || 'Invalid API key';
          continue;
        }
        if (!res.ok) {
          reply.code(res.status);
          const errMsg = typeof data.error === 'string' ? data.error : data.error?.message || data.message || 'Unknown error';
          return { error: errMsg, _targetPort: port, _targetAddress: host };
        }
        return { ...data as object, _targetPort: port, _targetAddress: host };
      } catch (err: any) {
        lastError = err.message;
      }
    }
    reply.code(502);
    return { error: `Failed to reach target: ${lastError}` };
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
      const remoteKeys = getRemoteKeys(apiKey, allowedKeys);
      for (const p of remotePeers) {
        // Avoid duplicates (same address:port)
        if (!running.some((r) => r.host === p.address && r.port === p.port)) {
          // Try each key — use the first that works for listing
          running.push({ host: p.address, port: p.port, hostname: p.hostname, key: remoteKeys[0] || apiKey });
        }
      }
    } catch {}

    const allRemoteKeys = getRemoteKeys(apiKey, allowedKeys);
    const results = await Promise.allSettled(
      running.map(async (s) => {
        const isRemoteSession = s.host !== '127.0.0.1' && s.host !== 'localhost';
        const keysToTry = isRemoteSession ? allRemoteKeys : [apiKey];
        for (const key of keysToTry) {
          try {
            const res = await fetch(`http://${s.host}:${s.port}/api/v1/ai-tasks`, {
              headers: { Authorization: `Bearer ${key}` },
              signal: AbortSignal.timeout(3000),
            });
            if (res.status === 401 || res.status === 403) continue;
            if (!res.ok) return [];
            const data = (await res.json()) as { tasks?: any[] };
            return (data.tasks || []).map((t: any) => ({
              ...t,
              _sourcePort: s.port,
              _sourceAddress: s.host,
              _sourceHostname: s.hostname,
            }));
          } catch { continue; }
        }
        return [];
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
      const targetKey = isRemote
        ? await findWorkingKey(host, port, apiKey, allowedKeys)
        : apiKey;

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
      const targetKey = isRemote
        ? await findWorkingKey(host, port, apiKey, allowedKeys)
        : apiKey;

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
      const targetKey = isRemote
        ? await findWorkingKey(host, port, apiKey, allowedKeys)
        : apiKey;

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
