import { HEALTH_CHECK_INTERVAL, HEALTH_CHECK_MAX_FAILURES } from '@loopsy/protocol';
import type { PeerInfo } from '@loopsy/protocol';
import { PeerRegistry } from './peer-registry.js';

export class HealthChecker {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly registry: PeerRegistry,
    private readonly checkPeer: (peer: PeerInfo) => Promise<boolean>,
    private readonly onPeerOffline?: (peer: PeerInfo) => void,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.checkAll(), HEALTH_CHECK_INTERVAL);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async checkAll(): Promise<void> {
    const peers = this.registry.getAll().filter((p) => p.status !== 'offline' || p.failureCount < HEALTH_CHECK_MAX_FAILURES);

    await Promise.allSettled(
      peers.map((peer) => this.checkOne(peer)),
    );
  }

  private async checkOne(peer: PeerInfo): Promise<void> {
    try {
      const ok = await this.checkPeer(peer);
      if (ok) {
        this.registry.markOnline(peer.nodeId);
      } else {
        this.handleFailure(peer);
      }
    } catch {
      this.handleFailure(peer);
    }
  }

  private handleFailure(peer: PeerInfo): void {
    const failures = this.registry.markFailure(peer.nodeId);
    if (failures >= HEALTH_CHECK_MAX_FAILURES) {
      this.registry.markOffline(peer.nodeId);
      this.onPeerOffline?.(peer);
    }
  }
}
