import { describe, it, expect, beforeEach } from 'vitest';
import { PeerRegistry } from '../src/peer-registry.js';
import type { PeerInfo } from '@loopsy/protocol';

function makePeer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    nodeId: 'test-node',
    hostname: 'test-host',
    address: '192.168.1.100',
    port: 19532,
    platform: 'darwin',
    version: '1.0.0',
    capabilities: ['execute'],
    status: 'online',
    lastSeen: Date.now(),
    failureCount: 0,
    trusted: false,
    manuallyAdded: false,
    ...overrides,
  };
}

describe('PeerRegistry', () => {
  let registry: PeerRegistry;

  beforeEach(() => {
    registry = new PeerRegistry();
  });

  it('adds and retrieves a peer', () => {
    const peer = makePeer();
    registry.upsert(peer);
    expect(registry.get('test-node')).toEqual(peer);
  });

  it('updates existing peer', () => {
    registry.upsert(makePeer());
    registry.upsert(makePeer({ status: 'offline' }));
    expect(registry.get('test-node')?.status).toBe('offline');
  });

  it('removes a peer', () => {
    registry.upsert(makePeer());
    expect(registry.remove('test-node')).toBe(true);
    expect(registry.get('test-node')).toBeUndefined();
  });

  it('lists all peers', () => {
    registry.upsert(makePeer({ nodeId: 'a' }));
    registry.upsert(makePeer({ nodeId: 'b' }));
    expect(registry.getAll()).toHaveLength(2);
  });

  it('filters online peers', () => {
    registry.upsert(makePeer({ nodeId: 'a', status: 'online' }));
    registry.upsert(makePeer({ nodeId: 'b', status: 'offline' }));
    expect(registry.getOnline()).toHaveLength(1);
  });

  it('marks peer online', () => {
    registry.upsert(makePeer({ status: 'offline', failureCount: 3 }));
    registry.markOnline('test-node');
    const peer = registry.get('test-node')!;
    expect(peer.status).toBe('online');
    expect(peer.failureCount).toBe(0);
  });

  it('tracks failure count', () => {
    registry.upsert(makePeer());
    registry.markFailure('test-node');
    registry.markFailure('test-node');
    expect(registry.get('test-node')?.failureCount).toBe(2);
  });

  it('finds peer by address', () => {
    registry.upsert(makePeer());
    expect(registry.getByAddress('192.168.1.100', 19532)?.nodeId).toBe('test-node');
  });
});
