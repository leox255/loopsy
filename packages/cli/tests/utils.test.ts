import { describe, it, expect } from 'vitest';
import { parsePeerAddress, selectPeer, type PeerLike } from '../src/utils.js';

describe('parsePeerAddress', () => {
  it('parses host:port', () => {
    const result = parsePeerAddress('192.168.1.100:19532');
    expect(result.address).toBe('192.168.1.100');
    expect(result.port).toBe(19532);
  });

  it('defaults port to 19532', () => {
    const result = parsePeerAddress('192.168.1.100');
    expect(result.address).toBe('192.168.1.100');
    expect(result.port).toBe(19532);
  });

  it('handles custom port', () => {
    const result = parsePeerAddress('10.0.0.1:8080');
    expect(result.address).toBe('10.0.0.1');
    expect(result.port).toBe(8080);
  });
});

describe('selectPeer', () => {
  // Mirrors a real registry: one stale manual entry + two discovered entries
  // for the same Windows host, only one of which is online.
  const peers: PeerLike[] = [
    { nodeId: 'manual-192.168.1.75:19532', address: '192.168.1.75', port: 19532, hostname: '192.168.1.75', status: 'offline' },
    { nodeId: 'f561fa67-1111-2222-3333-444455556666', address: '192.168.1.75', port: 19532, hostname: 'DESKTOP-PVTH8R3', status: 'offline' },
    { nodeId: 'c8473dae-7926-4f63-bec8-dad6dff286c1', address: '192.168.1.75', port: 19532, hostname: 'DESKTOP-PVTH8R3', status: 'online' },
  ];

  it('resolves by hostname, preferring the online peer', () => {
    expect(selectPeer(peers, 'DESKTOP-PVTH8R3')?.nodeId).toBe('c8473dae-7926-4f63-bec8-dad6dff286c1');
  });

  it('is case-insensitive', () => {
    expect(selectPeer(peers, 'desktop-pvth8r3')?.status).toBe('online');
  });

  it('resolves by nodeId prefix (as printed by `loopsy peers`)', () => {
    expect(selectPeer(peers, 'c8473dae')?.hostname).toBe('DESKTOP-PVTH8R3');
  });

  it('resolves by full nodeId', () => {
    expect(selectPeer(peers, 'f561fa67-1111-2222-3333-444455556666')?.status).toBe('offline');
  });

  it('does not prefix-match on very short queries', () => {
    expect(selectPeer(peers, 'c8')).toBeUndefined();
  });

  it('returns undefined when nothing matches', () => {
    expect(selectPeer(peers, 'nope')).toBeUndefined();
  });
});
