import type { FastifyRequest, FastifyReply } from 'fastify';
import { LoopsyError, LoopsyErrorCode } from '@loopsy/protocol';

export function createAuthHook(ownKey: string, allowedKeys: Record<string, string>) {
  const validKeys = new Set([ownKey, ...Object.values(allowedKeys)]);

  return async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for health endpoint and dashboard static/API routes
    if (request.url === '/api/v1/health') return;
    if (request.url.startsWith('/dashboard')) return;
    // Skip auth for pairing endpoints (unauthenticated by design)
    if (request.url.startsWith('/api/v1/pair/')) return;

    const authHeader = request.headers.authorization;
    if (!authHeader) {
      const err = new LoopsyError(LoopsyErrorCode.AUTH_MISSING_KEY, 'Missing Authorization header');
      reply.code(401).send(err.toJSON());
      return;
    }

    const key = authHeader.replace(/^Bearer\s+/i, '');
    if (!validKeys.has(key)) {
      const err = new LoopsyError(LoopsyErrorCode.AUTH_INVALID_KEY, 'Invalid API key');
      reply.code(403).send(err.toJSON());
      return;
    }
  };
}
