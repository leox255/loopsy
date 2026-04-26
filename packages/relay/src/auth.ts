/**
 * Auth helpers for the Loopsy relay.
 *
 * Two kinds of secrets:
 *   - device_secret  (per laptop): bearer token for /laptop/connect, /pair/issue
 *   - phone_secret   (per phone) : bearer token for /phone/connect/:device_id
 *
 * Plus pair tokens (HMAC-signed, short-lived) issued by laptops and redeemed
 * by phones to bind themselves to a device.
 */

import type { PairTokenPayload } from './types.js';

/** Constant-time compare of two strings (returns false on length mismatch). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * SHA-256 of a UTF-8 string, hex-encoded. Used to store secrets at rest in
 * Durable Object storage (CSO #7) so a CF dashboard / wrangler-tail leak
 * cannot directly impersonate paired phones/devices — an attacker would also
 * need to brute-force the hash.
 */
export async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  let out = '';
  for (const b of new Uint8Array(hash)) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Extract the Bearer token from the request. Order:
 *   1. `Authorization: Bearer <token>` header (default; daemons + native apps).
 *   2. `Sec-WebSocket-Protocol: loopsy.bearer.<token>` subprotocol — browsers
 *      can set this on `new WebSocket(url, protocols)` and it's NOT logged in
 *      Cloudflare's URL/query-string log paths (CSO #3 mitigation).
 *   3. Legacy `?token=…` query param — kept for backwards compatibility with
 *      already-paired phones, but the daemon-side relay client and the
 *      Flutter/web clients have been updated to use (1) or (2).
 *      Documented as deprecated in NOTES; remove in v2.
 */
export function extractBearer(request: Request): string | null {
  const h = request.headers.get('Authorization') ?? request.headers.get('authorization');
  if (h) {
    const m = /^Bearer\s+(.+)$/.exec(h);
    if (m) return m[1].trim();
  }
  // Sec-WebSocket-Protocol can carry comma-separated subprotocols. We accept
  // any token of the form `loopsy.bearer.<bearer>`; the server should echo
  // the same subprotocol back in the WS upgrade response (handled in DO).
  const subproto = request.headers.get('Sec-WebSocket-Protocol') ?? request.headers.get('sec-websocket-protocol');
  if (subproto) {
    for (const part of subproto.split(',')) {
      const trimmed = part.trim();
      if (trimmed.startsWith('loopsy.bearer.')) return trimmed.slice('loopsy.bearer.'.length);
    }
  }
  const url = new URL(request.url);
  const t = url.searchParams.get('token');
  return t ?? null;
}

/**
 * If the client offered a bearer subprotocol, return the exact protocol
 * string so the server can echo it on the upgrade response — required by
 * the WebSocket spec when the client sent any subprotocols.
 */
export function bearerSubprotocol(request: Request): string | undefined {
  const subproto = request.headers.get('Sec-WebSocket-Protocol') ?? request.headers.get('sec-websocket-protocol');
  if (!subproto) return undefined;
  for (const part of subproto.split(',')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('loopsy.bearer.')) return trimmed;
  }
  return undefined;
}

/**
 * Same-origin / origin-allowlist check for WS upgrades (CSO #13). We accept:
 *   - missing Origin (native apps don't send one)
 *   - the relay's own host (browser hits to /app)
 *   - any explicit allowlist entries (via env var ALLOWED_ORIGINS, comma sep)
 */
export function isOriginAllowed(request: Request, allowList: string | undefined): boolean {
  const origin = request.headers.get('Origin') ?? request.headers.get('origin');
  if (!origin || origin === 'null') return true; // native apps, file://, etc.
  const url = new URL(request.url);
  if (origin === `${url.protocol}//${url.host}`) return true;
  if (allowList) {
    for (const allowed of allowList.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (origin === allowed) return true;
    }
  }
  return false;
}

/** Generate a random secret suitable for bearer auth (32 bytes, base64url). */
export function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

/** Generate a UUID v4 (relies on Workers' crypto.randomUUID). */
export function generateUuid(): string {
  return crypto.randomUUID();
}

/** Base64url (no padding) encode raw bytes. */
export function base64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Base64url (no padding) decode to raw bytes. */
export function base64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Sign a pair-token payload. Returns `<base64url-payload>.<base64url-sig>`. */
export async function signPairToken(payload: PairTokenPayload, secret: string): Promise<string> {
  const payloadStr = JSON.stringify(payload);
  const payloadBytes = new TextEncoder().encode(payloadStr);
  const key = await importHmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, payloadBytes));
  return `${base64urlEncode(payloadBytes)}.${base64urlEncode(sig)}`;
}

/** Verify and parse a pair token. Returns the payload or null on failure. */
export async function verifyPairToken(token: string, secret: string): Promise<PairTokenPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [b64Payload, b64Sig] = parts;
  let payloadBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    payloadBytes = base64urlDecode(b64Payload);
    sigBytes = base64urlDecode(b64Sig);
  } catch {
    return null;
  }
  const key = await importHmacKey(secret);
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, payloadBytes);
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as PairTokenPayload;
    if (typeof payload.did !== 'string') return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
