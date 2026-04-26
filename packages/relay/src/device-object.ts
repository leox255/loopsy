/**
 * DeviceObject — Durable Object that owns one laptop's persistent WebSocket
 * and splices in/out connected phone-session WebSockets.
 *
 * Wire protocol on the laptop's persistent WS:
 *   - text frames  : JSON control messages with a `sessionId` field
 *   - binary frames: [16 bytes session UUID][PTY bytes...]
 *
 * Wire protocol on a phone session WS (one WS per active chat):
 *   - text frames  : JSON control messages (sessionId implicit, set by relay)
 *   - binary frames: raw PTY input bytes (sessionId implicit)
 *
 * The DO accepts WebSockets with `state.acceptWebSocket(ws, [tag])` so the
 * runtime can hibernate them without losing state. Tags identify the role:
 *   - device   : the laptop's persistent WS
 *   - session:<sessionId> : a phone session WS
 *
 * One DO instance exists per laptop, addressed by `device_id` (string).
 *
 * Persisted state in DO storage:
 *   device_secret           : bearer token the laptop authenticates with
 *   phone:<phone_id>        : { secret, label, paired_at }  one entry per paired phone
 *   used_nonce:<nonce>      : 1 (with absolute expiry around the token's exp)
 */

import type { Env } from './types.js';
import { extractBearer, generateSecret, generateUuid, timingSafeEqual } from './auth.js';

/** Convert a hyphenated UUID v4 to 16 raw bytes (BE). */
function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) throw new Error(`bad uuid: ${uuid}`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Convert 16 raw bytes back to a hyphenated UUID v4 string. */
function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.length < 16) throw new Error('not enough bytes for uuid');
  const hex = Array.from(bytes.slice(0, 16))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const DEVICE_TAG = 'device';
const sessionTag = (id: string) => `session:${id}`;

interface PhoneRecord {
  secret: string;
  label?: string;
  paired_at: number;
}

export class DeviceObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const op = url.searchParams.get('op');

    // Internal RPC operations (Worker → DO via fetch with op=...)
    if (op === 'register') return this.handleRegister();
    if (op === 'redeem-pair') return this.handleRedeemPair(request);
    if (op === 'connect-laptop') return this.handleConnectLaptop(request);
    if (op === 'connect-phone') return this.handleConnectPhone(request);
    if (op === 'verify-device-secret') return this.handleVerifyDeviceSecret(request);

    return new Response('unknown op', { status: 400 });
  }

  /** First-time device registration: generate and persist a device_secret. */
  private async handleRegister(): Promise<Response> {
    const existing = await this.state.storage.get<string>('device_secret');
    if (existing) {
      return Response.json({ error: 'device already registered' }, { status: 409 });
    }
    const secret = generateSecret();
    await this.state.storage.put('device_secret', secret);
    return Response.json({ device_secret: secret });
  }

  /** Verify that a Bearer token matches this device's secret. */
  private async handleVerifyDeviceSecret(request: Request): Promise<Response> {
    const token = extractBearer(request);
    if (!token) return new Response('missing bearer', { status: 401 });
    const expected = await this.state.storage.get<string>('device_secret');
    if (!expected || !timingSafeEqual(token, expected)) {
      return new Response('invalid', { status: 403 });
    }
    return new Response('ok', { status: 200 });
  }

  /**
   * Phone redeems a pair token. The Worker has already verified the HMAC
   * signature and the token's `did` matches this DO. We need to:
   *   - check the nonce hasn't been used (single-use semantics)
   *   - mint and store a phone_secret bound to a fresh phone_id
   *   - return {phone_id, phone_secret}
   */
  private async handleRedeemPair(request: Request): Promise<Response> {
    const body = (await request.json()) as { nonce: string; exp: number; label?: string };
    if (!body?.nonce || typeof body.exp !== 'number') {
      return new Response('bad body', { status: 400 });
    }
    const nonceKey = `used_nonce:${body.nonce}`;
    const already = await this.state.storage.get(nonceKey);
    if (already) return new Response('nonce already used', { status: 409 });

    const phone_id = generateUuid();
    const phone_secret = generateSecret();
    const rec: PhoneRecord = { secret: phone_secret, label: body.label, paired_at: Date.now() };
    await this.state.storage.put(`phone:${phone_id}`, rec);
    // Track the nonce as used. Each entry is tiny; periodic cleanup can be
    // added later via DurableObjectState.setAlarm if we ever need it.
    await this.state.storage.put(nonceKey, 1);
    return Response.json({ phone_id, phone_secret });
  }

  /** Laptop opens its persistent WS. Bearer = device_secret. */
  private async handleConnectLaptop(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected WebSocket upgrade', { status: 426 });
    }
    const token = extractBearer(request);
    if (!token) return new Response('missing bearer', { status: 401 });
    const expected = await this.state.storage.get<string>('device_secret');
    if (!expected || !timingSafeEqual(token, expected)) {
      return new Response('forbidden', { status: 403 });
    }

    // Replace any prior device WS.
    for (const ws of this.state.getWebSockets(DEVICE_TAG)) {
      try {
        ws.close(4001, 'replaced by new device connection');
      } catch {
        /* ignore */
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.state.acceptWebSocket(server, [DEVICE_TAG]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Phone opens a session WS for a paired phone_id. Bearer = phone_secret. */
  private async handleConnectPhone(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected WebSocket upgrade', { status: 426 });
    }
    const url = new URL(request.url);
    const phone_id = url.searchParams.get('phone_id');
    const session_id = url.searchParams.get('session_id');
    if (!phone_id || !session_id) {
      return new Response('phone_id and session_id required', { status: 400 });
    }
    const token = extractBearer(request);
    if (!token) return new Response('missing bearer', { status: 401 });
    const rec = await this.state.storage.get<PhoneRecord>(`phone:${phone_id}`);
    if (!rec || !timingSafeEqual(token, rec.secret)) {
      return new Response('forbidden', { status: 403 });
    }

    // Replace prior WS for the same session.
    for (const ws of this.state.getWebSockets(sessionTag(session_id))) {
      try {
        ws.close(4002, 'replaced by new session connection');
      } catch {
        /* ignore */
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.state.acceptWebSocket(server, [sessionTag(session_id)]);

    // Notify the device a phone is attaching.
    const device = this.state.getWebSockets(DEVICE_TAG)[0];
    if (device) {
      try {
        device.send(JSON.stringify({ type: 'session-attach', sessionId: session_id, phoneId: phone_id }));
      } catch {
        /* ignore */
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── WebSocket message routing (Hibernation API) ────────────────────────

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const tags = this.state.getTags(ws);
    const isDevice = tags.includes(DEVICE_TAG);
    const sessionTagPrefix = 'session:';
    const sessionTagFromWs = tags.find((t) => t.startsWith(sessionTagPrefix));
    const sessionIdFromWs = sessionTagFromWs?.slice(sessionTagPrefix.length);

    if (message instanceof ArrayBuffer) {
      const buf = new Uint8Array(message);
      if (isDevice) {
        if (buf.length < 16) return;
        const sid = bytesToUuid(buf);
        const payload = buf.slice(16);
        const target = this.state.getWebSockets(sessionTag(sid))[0];
        if (target) {
          try {
            target.send(payload);
          } catch {
            /* ignore */
          }
        }
        return;
      }
      if (!sessionIdFromWs) return;
      const device = this.state.getWebSockets(DEVICE_TAG)[0];
      if (!device) return;
      const prefix = uuidToBytes(sessionIdFromWs);
      const out = new Uint8Array(prefix.length + buf.length);
      out.set(prefix, 0);
      out.set(buf, prefix.length);
      try {
        device.send(out);
      } catch {
        /* ignore */
      }
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }

    if (isDevice) {
      const sid = parsed?.sessionId;
      if (!sid) return;
      const target = this.state.getWebSockets(sessionTag(sid))[0];
      if (target) {
        try {
          target.send(JSON.stringify(parsed));
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (!sessionIdFromWs) return;
    const device = this.state.getWebSockets(DEVICE_TAG)[0];
    if (!device) return;
    try {
      device.send(JSON.stringify({ ...parsed, sessionId: sessionIdFromWs }));
    } catch {
      /* ignore */
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    const tags = this.state.getTags(ws);
    if (tags.includes(DEVICE_TAG)) {
      for (const sws of this.state.getWebSockets()) {
        if (sws === ws) continue;
        try {
          sws.send(JSON.stringify({ type: 'device-disconnected', code, reason }));
        } catch {
          /* ignore */
        }
      }
      return;
    }
    const sessionTagPrefix = 'session:';
    const sessionTagFromWs = tags.find((t) => t.startsWith(sessionTagPrefix));
    if (sessionTagFromWs) {
      const sid = sessionTagFromWs.slice(sessionTagPrefix.length);
      const device = this.state.getWebSockets(DEVICE_TAG)[0];
      if (device) {
        try {
          device.send(JSON.stringify({ type: 'session-detach', sessionId: sid, code, reason }));
        } catch {
          /* ignore */
        }
      }
    }
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    // Errors are surfaced via webSocketClose.
  }
}
