import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { PeerInfo } from '@loopsy/protocol';
import { CONFIG_DIR } from '@loopsy/protocol';

const PEERS_FILE = join(homedir(), CONFIG_DIR, 'peers.json');

export class PeerRegistry {
  private peers = new Map<string, PeerInfo>();

  async load(): Promise<void> {
    try {
      const data = await readFile(PEERS_FILE, 'utf-8');
      const entries: PeerInfo[] = JSON.parse(data);
      for (const peer of entries) {
        this.peers.set(peer.nodeId, peer);
      }
    } catch {
      // No peers file yet, that's fine
    }
  }

  async save(): Promise<void> {
    const dir = join(homedir(), CONFIG_DIR);
    await mkdir(dir, { recursive: true });
    const entries = Array.from(this.peers.values());
    await writeFile(PEERS_FILE, JSON.stringify(entries, null, 2));
  }

  get(nodeId: string): PeerInfo | undefined {
    return this.peers.get(nodeId);
  }

  getByAddress(address: string, port: number): PeerInfo | undefined {
    for (const peer of this.peers.values()) {
      if (peer.address === address && peer.port === port) return peer;
    }
    return undefined;
  }

  getAll(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  getOnline(): PeerInfo[] {
    return this.getAll().filter((p) => p.status === 'online');
  }

  upsert(peer: PeerInfo): void {
    const existing = this.peers.get(peer.nodeId);
    if (existing) {
      this.peers.set(peer.nodeId, { ...existing, ...peer });
    } else {
      this.peers.set(peer.nodeId, peer);
    }
  }

  remove(nodeId: string): boolean {
    return this.peers.delete(nodeId);
  }

  markOnline(nodeId: string): void {
    const peer = this.peers.get(nodeId);
    if (peer) {
      peer.status = 'online';
      peer.lastSeen = Date.now();
      peer.failureCount = 0;
    }
  }

  markFailure(nodeId: string): number {
    const peer = this.peers.get(nodeId);
    if (peer) {
      peer.failureCount++;
      return peer.failureCount;
    }
    return 0;
  }

  markOffline(nodeId: string): void {
    const peer = this.peers.get(nodeId);
    if (peer) {
      peer.status = 'offline';
    }
  }
}
