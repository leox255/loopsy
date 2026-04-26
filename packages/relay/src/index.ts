/**
 * Loopsy relay — Cloudflare Worker entry point.
 *
 * Routes:
 *   GET  /health
 *   POST /device/register                         → mint device_id + device_secret
 *   GET  /laptop/connect?device_id=X (Bearer)     → laptop persistent WSS
 *   POST /pair/issue (Bearer)                     → laptop fetches a pair token
 *   POST /pair/redeem                             → phone trades token for phone_secret
 *   GET  /phone/connect/:device_id?phone_id=Y&session_id=Z (Bearer phone_secret) → phone session WSS
 */

import type { Env, PairTokenPayload } from './types.js';
import {
  base64urlEncode,
  extractBearer,
  generateSecret,
  generateUuid,
  signPairToken,
  verifyPairToken,
} from './auth.js';
import { WEB_CLIENT_HTML } from './web-client.js';

export { DeviceObject } from './device-object.js';

const PAIR_TOKEN_DEFAULT_TTL_SEC = 5 * 60; // 5 minutes
const PAIR_TOKEN_MAX_TTL_SEC = 30 * 60;

function deviceStub(env: Env, deviceId: string): DurableObjectStub {
  return env.DEVICE.get(env.DEVICE.idFromName(deviceId));
}

async function forwardToDevice(
  env: Env,
  deviceId: string,
  op: string,
  request: Request,
  extraInit?: RequestInit,
): Promise<Response> {
  const stub = deviceStub(env, deviceId);
  const url = new URL(request.url);
  url.searchParams.set('op', op);
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
    body: extraInit?.body ?? request.body,
    ...extraInit,
  };
  // Preserve Upgrade for WebSocket forwarding.
  return stub.fetch(url.toString(), init);
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        service: 'loopsy-relay',
        version: '1.0.0',
        ts: Date.now(),
      });
    }

    if (url.pathname === '/app' || url.pathname === '/app/') {
      return new Response(WEB_CLIENT_HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
          // Allow xterm CSS+JS and the WSS we'll open back to ourselves.
          'content-security-policy': [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
            "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
            "connect-src 'self' wss: https://cdn.jsdelivr.net",
            "img-src 'self' data:",
          ].join('; '),
        },
      });
    }

    if (url.pathname === '/device/register' && request.method === 'POST') {
      // Server-chosen device_id prevents anyone from squatting an ID.
      const device_id = generateUuid();
      const stub = deviceStub(env, device_id);
      const regUrl = new URL(request.url);
      regUrl.searchParams.set('op', 'register');
      const r = await stub.fetch(regUrl.toString(), { method: 'POST' });
      if (!r.ok) return r;
      const { device_secret } = (await r.json()) as { device_secret: string };
      return Response.json({
        device_id,
        device_secret,
        relay_url: `${url.protocol}//${url.host}`,
      });
    }

    if (url.pathname === '/laptop/connect' && request.method === 'GET') {
      const device_id = url.searchParams.get('device_id');
      if (!device_id) return new Response('device_id required', { status: 400 });
      // Forward upgrade to the DO; auth is checked there.
      return forwardToDevice(env, device_id, 'connect-laptop', request);
    }

    if (url.pathname === '/pair/issue' && request.method === 'POST') {
      if (!env.PAIR_TOKEN_SECRET) {
        return new Response('relay missing PAIR_TOKEN_SECRET', { status: 503 });
      }
      const device_id = url.searchParams.get('device_id');
      if (!device_id) return new Response('device_id required', { status: 400 });
      const token = extractBearer(request);
      if (!token) return new Response('missing bearer', { status: 401 });

      // Verify device_secret via the DO before signing a token.
      const verifyUrl = new URL(request.url);
      verifyUrl.searchParams.set('op', 'verify-device-secret');
      const verify = await deviceStub(env, device_id).fetch(verifyUrl.toString(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!verify.ok) return new Response('forbidden', { status: 403 });

      let body: { ttl_seconds?: number } = {};
      try {
        body = (await request.json()) as typeof body;
      } catch {
        // empty body is fine
      }
      const ttl = Math.max(
        30,
        Math.min(body?.ttl_seconds ?? PAIR_TOKEN_DEFAULT_TTL_SEC, PAIR_TOKEN_MAX_TTL_SEC),
      );
      const now = Math.floor(Date.now() / 1000);
      const nonce = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
      const payload: PairTokenPayload = { did: device_id, iat: now, exp: now + ttl, nonce };
      const tokenStr = await signPairToken(payload, env.PAIR_TOKEN_SECRET);
      return Response.json({ token: tokenStr, expires_at: payload.exp });
    }

    if (url.pathname === '/pair/redeem' && request.method === 'POST') {
      if (!env.PAIR_TOKEN_SECRET) {
        return new Response('relay missing PAIR_TOKEN_SECRET', { status: 503 });
      }
      const body = (await request.json().catch(() => ({}))) as { token?: string; label?: string };
      if (!body.token) return new Response('token required', { status: 400 });
      const payload = await verifyPairToken(body.token, env.PAIR_TOKEN_SECRET);
      if (!payload) return new Response('invalid or expired token', { status: 401 });

      // Forward to that device's DO to consume the nonce and mint a phone_secret.
      const stub = deviceStub(env, payload.did);
      const redeemUrl = new URL(request.url);
      redeemUrl.searchParams.set('op', 'redeem-pair');
      const r = await stub.fetch(redeemUrl.toString(), {
        method: 'POST',
        body: JSON.stringify({ nonce: payload.nonce, exp: payload.exp, label: body.label }),
        headers: { 'content-type': 'application/json' },
      });
      if (!r.ok) return r;
      const { phone_id, phone_secret } = (await r.json()) as { phone_id: string; phone_secret: string };
      return Response.json({
        device_id: payload.did,
        phone_id,
        phone_secret,
        relay_url: `${url.protocol}//${url.host}`,
      });
    }

    const phoneConnectMatch = /^\/phone\/connect\/([^/]+)$/.exec(url.pathname);
    if (phoneConnectMatch && request.method === 'GET') {
      const device_id = phoneConnectMatch[1];
      // forwardToDevice keeps the Bearer + Upgrade headers intact.
      return forwardToDevice(env, device_id, 'connect-phone', request);
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// Eliminate "unused" warning for re-exported helper used only by other modules.
export const __unused_for_tooling__ = generateSecret;
