import { Bonjour, type Service } from 'bonjour-service';
import type { LoopsyNodeIdentity, PeerInfo } from '@loopsy/protocol';
import { MDNS_SERVICE_TYPE, DEFAULT_PORT } from '@loopsy/protocol';
import { PeerRegistry } from './peer-registry.js';

export interface DiscoveryEvents {
  onPeerDiscovered?: (peer: PeerInfo) => void;
  onPeerRemoved?: (nodeId: string) => void;
}

export class MdnsDiscovery {
  private bonjour: Bonjour | null = null;
  private browser: ReturnType<Bonjour['find']> | null = null;
  private published = false;

  constructor(
    private readonly identity: LoopsyNodeIdentity,
    private readonly registry: PeerRegistry,
    private readonly events: DiscoveryEvents = {},
  ) {}

  start(): void {
    this.bonjour = new Bonjour();
    this.advertise();
    this.browse();
  }

  private advertise(): void {
    if (!this.bonjour) return;

    this.bonjour.publish({
      name: `loopsy-${this.identity.nodeId.slice(0, 8)}`,
      type: MDNS_SERVICE_TYPE.replace(/^_/, '').replace(/\._tcp$/, ''),
      port: this.identity.port,
      txt: {
        nodeId: this.identity.nodeId,
        version: this.identity.version,
        platform: this.identity.platform,
        capabilities: this.identity.capabilities.join(','),
      },
    });
    this.published = true;
  }

  private browse(): void {
    if (!this.bonjour) return;

    this.browser = this.bonjour.find(
      { type: MDNS_SERVICE_TYPE.replace(/^_/, '').replace(/\._tcp$/, '') },
      (service: Service) => {
        this.handleServiceFound(service);
      },
    );
  }

  private handleServiceFound(service: Service): void {
    const txt = service.txt as Record<string, string> | undefined;
    if (!txt?.nodeId || txt.nodeId === this.identity.nodeId) return;

    const addresses = service.addresses ?? [];
    const address =
      addresses.find((a: string) => !a.includes(':')) ?? addresses[0] ?? service.host;

    if (!address) return;

    const peer: PeerInfo = {
      nodeId: txt.nodeId,
      hostname: service.host ?? 'unknown',
      address,
      port: service.port ?? DEFAULT_PORT,
      platform: txt.platform ?? 'unknown',
      version: txt.version ?? 'unknown',
      capabilities: txt.capabilities?.split(',') ?? [],
      status: 'online',
      lastSeen: Date.now(),
      failureCount: 0,
      trusted: false,
      manuallyAdded: false,
    };

    this.registry.upsert(peer);
    this.events.onPeerDiscovered?.(peer);
  }

  stop(): void {
    if (this.browser) {
      this.browser.stop();
      this.browser = null;
    }
    if (this.bonjour) {
      if (this.published) {
        this.bonjour.unpublishAll();
        this.published = false;
      }
      this.bonjour.destroy();
      this.bonjour = null;
    }
  }
}
