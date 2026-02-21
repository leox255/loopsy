import type { FastifyInstance } from 'fastify';
import { LoopsyError, LoopsyErrorCode } from '@loopsy/protocol';
import type { ContextStore } from '../services/context-store.js';

export function registerContextRoutes(app: FastifyInstance, contextStore: ContextStore) {
  app.put<{ Params: { key: string } }>('/api/v1/context/:key', async (request, reply) => {
    try {
      const { key } = request.params;
      const body = request.body as { value: string; ttl?: number };
      if (!body?.value) {
        throw new LoopsyError(LoopsyErrorCode.INVALID_REQUEST, 'Missing value');
      }
      const fromNodeId = (request.headers['x-loopsy-node-id'] as string) ?? 'local';
      const entry = contextStore.set(key, body.value, fromNodeId, body.ttl);
      await contextStore.save();
      return entry;
    } catch (err) {
      if (err instanceof LoopsyError) {
        reply.code(400);
        return err.toJSON();
      }
      throw err;
    }
  });

  app.get<{ Params: { key: string } }>('/api/v1/context/:key', async (request, reply) => {
    const { key } = request.params;
    const entry = contextStore.get(key);
    if (!entry) {
      const err = new LoopsyError(LoopsyErrorCode.CONTEXT_KEY_NOT_FOUND, `Key '${key}' not found`);
      reply.code(404);
      return err.toJSON();
    }
    return entry;
  });

  app.delete<{ Params: { key: string } }>('/api/v1/context/:key', async (request, reply) => {
    const { key } = request.params;
    const deleted = contextStore.delete(key);
    if (!deleted) {
      const err = new LoopsyError(LoopsyErrorCode.CONTEXT_KEY_NOT_FOUND, `Key '${key}' not found`);
      reply.code(404);
      return err.toJSON();
    }
    await contextStore.save();
    return { success: true, key };
  });

  app.get('/api/v1/context', async (request) => {
    const { prefix } = request.query as { prefix?: string };
    return { entries: contextStore.list(prefix) };
  });
}
