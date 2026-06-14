import { describe, it, expect } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { RelayClient } from '../src/services/relay-client.js';
import { PtySessionManager } from '../src/services/pty-session-manager.js';

/** Poll `predicate` until true or the timeout elapses. */
async function waitFor(
  predicate: () => boolean,
  { timeout = 8000, interval = 25 }: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeout) throw new Error('waitFor: condition never became true');
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Minimal RelayClient.getStatus() coverage — the new field that
 * /api/v1/relay/status reads. We don't open a real WebSocket here;
 * just construct a client and verify the never-connected snapshot
 * shape.
 *
 * Live-connection states (post-open, post-error) are exercised by
 * the integration test suite that spawns a real daemon against a
 * mock relay; that suite lives in a follow-up because it needs a
 * WebSocket fixture (the daemon connects to /laptop/connect with
 * bearer subprotocol).
 */
describe('RelayClient.getStatus()', () => {
  it('reports connected=false and url for a never-started client', () => {
    const pty = new PtySessionManager();
    const client = new RelayClient({
      relay: {
        url: 'https://relay.example.com',
        deviceId: 'dev-123',
        deviceSecret: 'shh',
      },
      pty,
    });
    const s = client.getStatus();
    expect(s.connected).toBe(false);
    expect(s.url).toBe('https://relay.example.com');
    expect(s.lastError).toBeNull();
  });

  it('reports connected=false after stop() even if the WS was never opened', () => {
    const pty = new PtySessionManager();
    const client = new RelayClient({
      relay: {
        url: 'https://relay.example.com',
        deviceId: 'dev-123',
        deviceSecret: 'shh',
      },
      pty,
    });
    client.stop();
    expect(client.getStatus().connected).toBe(false);
  });
});

/**
 * Reconnect resilience — regression coverage for the silent-stall bug where
 * a dropped (or never-completed) relay connection killed the reconnect chain
 * and left the daemon "up" locally but unreachable from every paired phone.
 */
describe('RelayClient reconnect', () => {
  it('reconnects after the relay drops the socket', async () => {
    const wss = new WebSocketServer({ port: 0 });
    let connections = 0;
    wss.on('connection', (socket) => {
      connections++;
      // Drop the first connection to simulate a relay-side disconnect; the
      // client must come back on its own.
      if (connections === 1) socket.close();
    });
    const { port } = wss.address() as AddressInfo;
    const client = new RelayClient({
      relay: { url: `http://127.0.0.1:${port}`, deviceId: 'd', deviceSecret: 's' },
      pty: new PtySessionManager(),
    });
    client.start();
    try {
      await waitFor(() => connections >= 2);
      expect(connections).toBeGreaterThanOrEqual(2);
    } finally {
      client.stop();
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });

  it('keeps retrying a failed connect until the relay becomes reachable', async () => {
    // Reserve a port, then free it so the first connect attempt is refused.
    const probe = new WebSocketServer({ port: 0 });
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((r) => probe.close(() => r()));

    const client = new RelayClient({
      relay: { url: `http://127.0.0.1:${port}`, deviceId: 'd', deviceSecret: 's' },
      pty: new PtySessionManager(),
    });
    client.start(); // first attempt: ECONNREFUSED — must schedule another, not give up

    // Bring the relay up shortly after; the client's retry must find it.
    await new Promise((r) => setTimeout(r, 1200));
    const wss = new WebSocketServer({ port });
    let connected = false;
    wss.on('connection', () => {
      connected = true;
    });
    try {
      await waitFor(() => connected, { timeout: 12_000 });
      expect(connected).toBe(true);
    } finally {
      client.stop();
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });

  it('stops cleanly without scheduling further reconnects', async () => {
    const wss = new WebSocketServer({ port: 0 });
    let connections = 0;
    wss.on('connection', () => {
      connections++;
    });
    const { port } = wss.address() as AddressInfo;
    const client = new RelayClient({
      relay: { url: `http://127.0.0.1:${port}`, deviceId: 'd', deviceSecret: 's' },
      pty: new PtySessionManager(),
    });
    client.start();
    await waitFor(() => connections >= 1);
    client.stop();
    const after = connections;
    // Give any errant reconnect timer a window to fire; count must not grow.
    await new Promise((r) => setTimeout(r, 1500));
    expect(connections).toBe(after);
    await new Promise<void>((r) => wss.close(() => r()));
  });
});
