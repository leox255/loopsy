/**
 * Shared types for the Loopsy relay.
 *
 * The relay sits between phones (clients) and laptops (devices).
 * Both connect over WebSockets; the relay splices their streams.
 */

export interface Env {
  DEVICE: DurableObjectNamespace;
  /** Secret used to sign pair tokens (HMAC-SHA-256). Set via `wrangler secret put PAIR_TOKEN_SECRET`. */
  PAIR_TOKEN_SECRET: string;
  /**
   * Optional comma-separated origin allowlist (CSO #13). E.g.
   * `https://loopsy.dev,https://app.example.com`. Browser hits to `/app` on
   * the relay's own host are always allowed; native apps send no Origin.
   */
  ALLOWED_ORIGINS?: string;
  /**
   * Optional registration secret (CSO #9). When set, `/device/register`
   * requires the caller to send `X-Registration-Secret: <value>`. Set with
   * `wrangler secret put REGISTRATION_SECRET`.
   */
  REGISTRATION_SECRET?: string;
  /**
   * Controls what `/` serves. `"landing"` (default, used by loopsy.dev) shows
   * the marketing page. `"app"` (used by self-hosted deploys via
   * `@loopsy/deploy-relay`) 302-redirects `/` to `/app` so the deploy is just
   * the web client with no marketing surface.
   */
  HOMEPAGE_MODE?: 'landing' | 'app';
}

/** Logical role of a connected WebSocket attached to a DeviceObject. */
export type Role = 'device' | 'session';

/**
 * Control frame sent as JSON text frames over the WebSockets.
 * Binary frames carry raw PTY bytes.
 */
export type ControlFrame =
  | { type: 'hello'; role: Role; sessionId?: string; agent?: 'shell' | 'claude' | 'gemini' | 'codex' }
  | { type: 'session-open'; sessionId: string; agent: 'shell' | 'claude' | 'gemini' | 'codex'; cols: number; rows: number }
  | { type: 'session-close'; sessionId: string; reason?: string }
  | { type: 'session-stdout'; sessionId: string }
  | { type: 'session-stdin'; sessionId: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'signal'; sessionId: string; signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP' }
  | { type: 'error'; message: string }
  | { type: 'heartbeat' };

/**
 * Pair token payload signed by the relay.
 * Phones present the token to /pair/redeem to bind to a device.
 */
export interface PairTokenPayload {
  /** device_id this token grants pairing access to */
  did: string;
  /** issued-at (seconds since epoch) */
  iat: number;
  /** expires-at (seconds since epoch) */
  exp: number;
  /** random nonce so two tokens for the same device differ */
  nonce: string;
  /**
   * CSO #14: short authentication string (SAS), 4 digits. Displayed on the
   * laptop next to the QR. The phone must transmit it back during redeem so
   * a leaked QR alone (e.g. screenshotted into a chat) can't be redeemed by
   * an attacker who didn't see the laptop's screen.
   */
  sas: string;
}
