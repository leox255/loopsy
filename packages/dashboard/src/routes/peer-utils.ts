import { listSessions } from '../session-manager.js';

export interface PeerInfo {
  nodeId?: string;
  hostname: string;
  address: string;
  port: number;
  platform?: string;
  version?: string;
  capabilities?: string[];
  status: string;
  lastSeen?: number;
  failureCount?: number;
  trusted?: boolean;
  manuallyAdded?: boolean;
  _seenBySessions?: number[];
}

export async function fetchAndDeduplicatePeers(apiKey: string): Promise<PeerInfo[]> {
  const { main, sessions } = await listSessions();
  const running = [];
  if (main && main.status === 'running') running.push(main);
  running.push(...sessions.filter((s) => s.status === 'running'));

  const results = await Promise.allSettled(
    running.map(async (s) => {
      const res = await fetch(`http://127.0.0.1:${s.port}/api/v1/peers`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { peers?: PeerInfo[] };
      return (data.peers || []).map((p) => ({ ...p, _sourcePort: s.port }));
    }),
  );

  const allPeers: (PeerInfo & { _sourcePort?: number })[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') allPeers.push(...r.value);
  }

  // Deduplicate by address:port
  const map = new Map<string, PeerInfo>();
  for (const p of allPeers) {
    const key = `${p.address}:${p.port}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...p, _seenBySessions: [p._sourcePort!] });
    } else {
      // Prefer online status
      if (p.status === 'online' && existing.status !== 'online') {
        existing.status = 'online';
      }
      // Take max lastSeen
      if (p.lastSeen && (!existing.lastSeen || p.lastSeen > existing.lastSeen)) {
        existing.lastSeen = p.lastSeen;
        existing.hostname = p.hostname;
      }
      existing._seenBySessions?.push(p._sourcePort!);
    }
  }

  const peers = Array.from(map.values());
  // Sort: online first, then by lastSeen desc
  peers.sort((a, b) => {
    if (a.status === 'online' && b.status !== 'online') return -1;
    if (b.status === 'online' && a.status !== 'online') return 1;
    return (b.lastSeen || 0) - (a.lastSeen || 0);
  });

  return peers;
}
