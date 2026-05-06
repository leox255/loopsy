import { describe, it, expect } from 'vitest';
import { RelayClient } from '../src/services/relay-client.js';
import { PtySessionManager } from '../src/services/pty-session-manager.js';

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
