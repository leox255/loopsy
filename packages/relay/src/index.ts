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
import { LANDING_HTML } from './landing.js';
import { PRIVACY_HTML } from './privacy.js';
import { SUPPORT_HTML } from './support.js';

/**
 * Build a per-request CSP. Inline scripts only via nonce; styles still need
 * `'unsafe-inline'` because xterm.js emits inline `<style>` at runtime, which
 * we accept. Font + style allow-listed for Google Fonts (used by Inter +
 * JetBrains Mono).
 */
function buildCsp(host: string, nonce: string): string {
  // Note: no `frame-ancestors`. Self-hosted relays are often mounted inside
  // parent dashboards/portals, including non-network schemes (data:, blob:,
  // chrome-extension:) where `frame-ancestors *` still blocks. Omitting the
  // directive falls back to "no restriction" — and there's no X-Frame-Options
  // set, so embedding works from any context. Safe because relay credentials
  // live in localStorage (no cookies = no clickjacking auth surface).
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net`,
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net",
    `connect-src 'self' wss://${host} https://cdn.jsdelivr.net`,
    "img-src 'self' data:",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=15552000; includeSubDomains',
};

export { DeviceObject } from './device-object.js';

const PAIR_TOKEN_DEFAULT_TTL_SEC = 5 * 60; // 5 minutes
const PAIR_TOKEN_MAX_TTL_SEC_DEFAULT = 30 * 60;

/**
 * Self-hosters keep the 30-minute cap by default; a deployment can raise it
 * via the `PAIR_TOKEN_MAX_TTL_SEC` env var (we use 7 days on the loopsy.dev
 * deployment so the App Store reviewer's pair URL stays valid for the
 * full review window). SAS still defends each token against drive-by
 * redemption regardless of TTL.
 */
function pairTokenMaxTtl(env: Env): number {
  const raw = (env as unknown as { PAIR_TOKEN_MAX_TTL_SEC?: string }).PAIR_TOKEN_MAX_TTL_SEC;
  if (!raw) return PAIR_TOKEN_MAX_TTL_SEC_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return PAIR_TOKEN_MAX_TTL_SEC_DEFAULT;
  return Math.min(n, 30 * 24 * 60 * 60); // hard ceiling: 30 days
}

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

    // `/` behavior. Self-hosted deploys (`@loopsy/deploy-relay`) set
    // HOMEPAGE_MODE=app via wrangler [vars], in which case `/` 302-redirects
    // to `/app` — the deploy has no marketing surface, just the web client.
    // The loopsy.dev relay leaves it unset and serves the landing.
    if (url.pathname === '/' || url.pathname === '') {
      if (env.HOMEPAGE_MODE === 'app') {
        return Response.redirect(`${url.protocol}//${url.host}/app`, 302);
      }
      const nonce = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
      const html = LANDING_HTML.replace(/__CSP_NONCE__/g, nonce);
      return new Response(html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=300',
          'content-security-policy': buildCsp(url.host, nonce),
          ...SECURITY_HEADERS,
        },
      });
    }

    if (url.pathname === '/privacy' || url.pathname === '/privacy/') {
      return new Response(PRIVACY_HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=300',
        },
      });
    }

    if (url.pathname === '/support' || url.pathname === '/support/') {
      return new Response(SUPPORT_HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=300',
        },
      });
    }

    if (url.pathname === '/app' || url.pathname === '/app/') {
      const nonce = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
      const html = WEB_CLIENT_HTML.replace(/__CSP_NONCE__/g, nonce);
      return new Response(html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
          'content-security-policy': buildCsp(url.host, nonce),
          ...SECURITY_HEADERS,
        },
      });
    }

    if (url.pathname === '/device/register' && request.method === 'POST') {
      // CSO #9: optional registration secret. When the relay operator sets
      // REGISTRATION_SECRET via wrangler, callers must include it. Without
      // the secret set, registration is open (legacy behavior); with it set,
      // accidental abuse from internet scanners is blocked.
      if (env.REGISTRATION_SECRET) {
        const offered = request.headers.get('X-Registration-Secret');
        if (!offered || offered !== env.REGISTRATION_SECRET) {
          return new Response('registration disabled', { status: 403 });
        }
      }
      // CSO #9: cheap per-IP rate limit using the Worker's per-isolate Cache.
      // Real production setups should add CF Rate Limiting at the dashboard
      // level too — this is just a backstop.
      const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
      const cacheKey = new Request(`https://rl/${encodeURIComponent(ip)}`);
      const cache = caches.default;
      const cached = await cache.match(cacheKey);
      if (cached) {
        const count = parseInt((await cached.text()) || '0', 10) + 1;
        if (count > 5) {
          return new Response('too many registrations from this IP, slow down', { status: 429 });
        }
        await cache.put(
          cacheKey,
          new Response(String(count), { headers: { 'cache-control': 'max-age=60' } }),
        );
      } else {
        await cache.put(
          cacheKey,
          new Response('1', { headers: { 'cache-control': 'max-age=60' } }),
        );
      }

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

    // CSO #8: phone self-revoke. Phone uses its own bearer (phone_secret) to
    // delete its own record from the relay when the user "forgets pairing"
    // in the Flutter app.
    const selfRevokeMatch = /^\/device\/([^/]+)\/phones\/self$/.exec(url.pathname);
    if (selfRevokeMatch && request.method === 'DELETE') {
      const device_id = selfRevokeMatch[1];
      const phone_id = url.searchParams.get('phone_id');
      if (!phone_id) return new Response('phone_id required', { status: 400 });
      const newUrl = new URL(request.url);
      newUrl.searchParams.set('op', 'phone-self-revoke');
      newUrl.searchParams.set('phone_id', phone_id);
      return deviceStub(env, device_id).fetch(newUrl.toString(), {
        method: 'POST',
        headers: request.headers,
      });
    }

    // CSO #8: phone list / revoke endpoints (laptop owner).
    const phoneListMatch = /^\/device\/([^/]+)\/phones$/.exec(url.pathname);
    if (phoneListMatch && request.method === 'GET') {
      const device_id = phoneListMatch[1];
      return forwardToDevice(env, device_id, 'list-phones', request);
    }
    const phoneRevokeMatch = /^\/device\/([^/]+)\/phones\/([^/]+)$/.exec(url.pathname);
    if (phoneRevokeMatch && request.method === 'DELETE') {
      const device_id = phoneRevokeMatch[1];
      const phone_id = phoneRevokeMatch[2];
      const newUrl = new URL(request.url);
      newUrl.searchParams.set('phone_id', phone_id);
      newUrl.searchParams.set('op', 'revoke-phone');
      return deviceStub(env, device_id).fetch(newUrl.toString(), {
        method: 'POST',
        headers: request.headers,
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

      let body: { ttl_seconds?: number; multi?: boolean } = {};
      try {
        body = (await request.json()) as typeof body;
      } catch {
        // empty body is fine
      }
      // Demo (multi-use) tokens get a separate, longer TTL ceiling because
      // they're explicitly minted for App Store review where the reviewer
      // needs days, not minutes. Regular single-use tokens still respect
      // PAIR_TOKEN_MAX_TTL_SEC (1 hour by default on loopsy.dev).
      const MAX_DEMO_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
      const maxTtl = body?.multi === true ? MAX_DEMO_TTL_SEC : pairTokenMaxTtl(env);
      const ttl = Math.max(
        30,
        Math.min(body?.ttl_seconds ?? PAIR_TOKEN_DEFAULT_TTL_SEC, maxTtl),
      );
      const now = Math.floor(Date.now() / 1000);
      const nonce = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
      // CSO #14: 4-digit SAS. Padded so it always renders as 4 chars.
      const sasNum = (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % 10000;
      const sas = String(sasNum).padStart(4, '0');
      const payload: PairTokenPayload = { did: device_id, iat: now, exp: now + ttl, nonce, sas };
      // Demo-mode: token allows multiple redeems until exp. Off by default;
      // only enabled when explicitly requested (App Store review demo).
      if (body?.multi === true) payload.multi = true;
      const tokenStr = await signPairToken(payload, env.PAIR_TOKEN_SECRET);
      return Response.json({ token: tokenStr, sas, expires_at: payload.exp, multi: payload.multi === true });
    }

    if (url.pathname === '/pair/redeem' && request.method === 'POST') {
      if (!env.PAIR_TOKEN_SECRET) {
        return new Response('relay missing PAIR_TOKEN_SECRET', { status: 503 });
      }
      const body = (await request.json().catch(() => ({}))) as { token?: string; sas?: string; label?: string };
      if (!body.token) return new Response('token required', { status: 400 });
      const payload = await verifyPairToken(body.token, env.PAIR_TOKEN_SECRET);
      if (!payload) return new Response('invalid or expired token', { status: 401 });

      // CSO #14: SAS check. Tokens issued by /pair/issue carry a 4-digit SAS
      // shown on the laptop. The phone must pass it back here. This defends
      // against the redeem-race where a leaked QR (screenshot, OCR bot) lets
      // an attacker pair before the legitimate user.
      if (typeof payload.sas === 'string' && payload.sas.length > 0) {
        if (!body.sas || body.sas !== payload.sas) {
          return new Response('verification code mismatch', { status: 401 });
        }
      }

      // Forward to that device's DO to consume the nonce and mint a phone_secret.
      const stub = deviceStub(env, payload.did);
      const redeemUrl = new URL(request.url);
      redeemUrl.searchParams.set('op', 'redeem-pair');
      const r = await stub.fetch(redeemUrl.toString(), {
        method: 'POST',
        body: JSON.stringify({
          nonce: payload.nonce,
          exp: payload.exp,
          label: body.label,
          // Forward the demo-mode flag so the DO can skip nonce-burn for
          // tokens explicitly minted with multi=true.
          multi: payload.multi === true,
        }),
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
