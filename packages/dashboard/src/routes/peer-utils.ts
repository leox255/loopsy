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

  // Build a port→hostname map from session list (known local sessions)
  const portHostnameMap = new Map<number, string>();
  if (main) portHostnameMap.set(main.port, main.hostname);
  for (const s of sessions) portHostnameMap.set(s.port, s.hostname);

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

  // Resolve hostnames for local peers (127.0.0.1) using the port→hostname map
  for (const p of allPeers) {
    if ((p.address === '127.0.0.1' || p.address === 'localhost') && portHostnameMap.has(p.port)) {
      p.hostname = portHostnameMap.get(p.port)!;
    }
  }

  // Resolve hostnames for peers that still look like IP addresses
  const looksLikeIp = (h: string) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === 'localhost';
  const unresolved = allPeers.filter((p) => looksLikeIp(p.hostname));
  if (unresolved.length > 0) {
    const uniqueTargets = [...new Map(unresolved.map((p) => [`${p.address}:${p.port}`, p])).values()];
    const statusResults = await Promise.allSettled(
      uniqueTargets.map(async (p) => {
        const host = p.address === '127.0.0.1' || p.address === 'localhost' ? '127.0.0.1' : p.address;
        const res = await fetch(`http://${host}:${p.port}/api/v1/status`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(2000),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { hostname?: string };
        return { address: p.address, port: p.port, hostname: data.hostname };
      }),
    );
    const resolvedMap = new Map<string, string>();
    for (const r of statusResults) {
      if (r.status === 'fulfilled' && r.value?.hostname) {
        resolvedMap.set(`${r.value.address}:${r.value.port}`, r.value.hostname);
      }
    }
    for (const p of allPeers) {
      const key = `${p.address}:${p.port}`;
      if (looksLikeIp(p.hostname) && resolvedMap.has(key)) {
        p.hostname = resolvedMap.get(key)!;
      }
    }
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
      }
      // Prefer a real hostname over 127.0.0.1
      if (p.hostname !== '127.0.0.1' && p.hostname !== 'localhost') {
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
