import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { LoopsyError, LoopsyErrorCode } from '@loopsy/protocol';

/**
 * CSO #11: constant-time membership check. `Set.has(key)` uses V8 string
 * equality which is not timing-stable for short bearer tokens. Iterate every
 * key and accumulate without short-circuiting so wall time is independent of
 * which slot matched.
 */
function timingSafeIncludes(keys: readonly string[], candidate: string): boolean {
  let match = false;
  const candidateBuf = Buffer.from(candidate, 'utf8');
  for (const valid of keys) {
    const validBuf = Buffer.from(valid, 'utf8');
    if (validBuf.length !== candidateBuf.length) {
      let acc = 0;
      for (let i = 0; i < validBuf.length; i++) acc |= validBuf[i];
      continue;
    }
    if (timingSafeEqual(validBuf, candidateBuf)) match = true;
  }
  return match;
}

export function createAuthHook(ownKey: string, allowedKeys: Record<string, string>) {
  const keyList: string[] = [ownKey, ...Object.values(allowedKeys)];

  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === '/api/v1/health') return;
    if (request.url.startsWith('/api/v1/pair/')) return;
    // CSO #5: dashboard API now requires the bearer. Static dashboard files
    // (HTML / JS / CSS bundle) stay public — they have no secrets in them.
    if (request.url === '/dashboard' || request.url === '/dashboard/' ||
        /^\/dashboard\/(?!api\/)[^?]*\.(html|js|css|map|svg|png|ico|woff2?|ttf)(\?|$)/.test(request.url)) {
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader) {
      // CSO #23: log auth failures to spot abuse.
      request.log.warn(
        { url: request.url, ip: request.ip, ua: request.headers['user-agent'] },
        '[auth] missing Authorization header',
      );
      const err = new LoopsyError(LoopsyErrorCode.AUTH_MISSING_KEY, 'Missing Authorization header');
      reply.code(401).send(err.toJSON());
      return;
    }

    const key = authHeader.replace(/^Bearer\s+/i, '');
    if (!timingSafeIncludes(keyList, key)) {
      const fp = key.length > 8 ? `${key.slice(0, 6)}…` : '<short>';
      request.log.warn(
        { url: request.url, ip: request.ip, keyFp: fp, ua: request.headers['user-agent'] },
        '[auth] invalid bearer',
      );
      const err = new LoopsyError(LoopsyErrorCode.AUTH_INVALID_KEY, 'Invalid API key');
      reply.code(403).send(err.toJSON());
      return;
    }
  };
}
