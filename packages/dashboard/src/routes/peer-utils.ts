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

const looksLikeIp = (h: string) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === 'localhost';

function deduplicatePeers(allPeers: (PeerInfo & { _sourcePort?: number })[]): PeerInfo[] {
  const map = new Map<string, PeerInfo>();
  for (const p of allPeers) {
    const key = `${p.address}:${p.port}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...p, _seenBySessions: p._sourcePort ? [p._sourcePort] : [] });
    } else {
      if (p.status === 'online' && existing.status !== 'online') {
        existing.status = 'online';
      }
      if (p.lastSeen && (!existing.lastSeen || p.lastSeen > existing.lastSeen)) {
        existing.lastSeen = p.lastSeen;
      }
      if (!looksLikeIp(p.hostname) && looksLikeIp(existing.hostname)) {
        existing.hostname = p.hostname;
      }
      // Prefer richer data (platform, capabilities) from non-manual peers
      if (p.platform && p.platform !== 'unknown' && existing.platform === 'unknown') {
        existing.platform = p.platform;
        existing.version = p.version;
        existing.capabilities = p.capabilities;
      }
      if (p._sourcePort) existing._seenBySessions?.push(p._sourcePort);
    }
  }
  return Array.from(map.values());
}

export async function fetchAndDeduplicatePeers(
  apiKey: string,
  allowedKeys?: Record<string, string>,
): Promise<PeerInfo[]> {
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

  // Resolve hostnames, platform, and version for peers with missing info via /api/v1/status
  const needsEnrichment = allPeers.filter((p) => looksLikeIp(p.hostname) || !p.platform || p.platform === 'unknown');
  if (needsEnrichment.length > 0) {
    const uniqueTargets = [...new Map(needsEnrichment.map((p) => [`${p.address}:${p.port}`, p])).values()];
    const remoteKeys = new Set<string>([apiKey]);
    if (allowedKeys) {
      for (const key of Object.values(allowedKeys)) remoteKeys.add(key);
    }
    const statusResults = await Promise.allSettled(
      uniqueTargets.map(async (p) => {
        const host = p.address === '127.0.0.1' || p.address === 'localhost' ? '127.0.0.1' : p.address;
        for (const key of remoteKeys) {
          try {
            const res = await fetch(`http://${host}:${p.port}/api/v1/status`, {
              headers: { Authorization: `Bearer ${key}` },
              signal: AbortSignal.timeout(2000),
            });
            if (res.ok) {
              const data = (await res.json()) as { hostname?: string; platform?: string; version?: string };
              return { address: p.address, port: p.port, hostname: data.hostname, platform: data.platform, version: data.version };
            }
          } catch {}
        }
        return null;
      }),
    );
    interface ResolvedInfo { hostname?: string; platform?: string; version?: string }
    const resolvedMap = new Map<string, ResolvedInfo>();
    for (const r of statusResults) {
      if (r.status === 'fulfilled' && r.value) {
        resolvedMap.set(`${r.value.address}:${r.value.port}`, r.value);
      }
    }
    for (const p of allPeers) {
      const key = `${p.address}:${p.port}`;
      const resolved = resolvedMap.get(key);
      if (resolved) {
        if (looksLikeIp(p.hostname) && resolved.hostname) p.hostname = resolved.hostname;
        if ((!p.platform || p.platform === 'unknown') && resolved.platform) p.platform = resolved.platform;
        if ((!p.version || p.version === 'unknown') && resolved.version) p.version = resolved.version;
      }
    }
  }

  // Deduplicate local peers first
  let peers = deduplicatePeers(allPeers);

  // Transitive discovery: query each remote peer's peer list to find their workers
  if (allowedKeys && Object.keys(allowedKeys).length > 0) {
    const remotePeers = peers.filter(
      (p) => p.address !== '127.0.0.1' && p.address !== 'localhost' && p.status === 'online',
    );
    if (remotePeers.length > 0) {
      const remoteKeys = Object.values(allowedKeys);
      const transitiveResults = await Promise.allSettled(
        remotePeers.map(async (rp) => {
          for (const key of remoteKeys) {
            try {
              const res = await fetch(`http://${rp.address}:${rp.port}/api/v1/peers`, {
                headers: { Authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(3000),
              });
              if (res.ok) {
                const data = (await res.json()) as { peers?: PeerInfo[] };
                // Return only peers local to that remote machine (127.0.0.1 entries)
                // and remap their address to the remote machine's real IP
                return (data.peers || [])
                  .filter((p) => p.address === '127.0.0.1' || p.address === 'localhost')
                  .map((p) => ({
                    ...p,
                    address: rp.address,
                    // Resolve hostname if it's still an IP
                    hostname: looksLikeIp(p.hostname) ? p.hostname : p.hostname,
                  }));
              }
            } catch {}
          }
          return [];
        }),
      );

      const transitivePeers: PeerInfo[] = [];
      for (const r of transitiveResults) {
        if (r.status === 'fulfilled') transitivePeers.push(...r.value);
      }

      // Resolve IP hostnames for transitive peers via /api/v1/status
      const unresolvedTransitive = transitivePeers.filter((p) => looksLikeIp(p.hostname));
      if (unresolvedTransitive.length > 0) {
        const uniqueTransitive = [
          ...new Map(unresolvedTransitive.map((p) => [`${p.address}:${p.port}`, p])).values(),
        ];
        const remoteKeyList = Object.values(allowedKeys);
        const tStatusResults = await Promise.allSettled(
          uniqueTransitive.map(async (p) => {
            for (const key of remoteKeyList) {
              try {
                const res = await fetch(`http://${p.address}:${p.port}/api/v1/status`, {
                  headers: { Authorization: `Bearer ${key}` },
                  signal: AbortSignal.timeout(2000),
                });
                if (res.ok) {
                  const data = (await res.json()) as { hostname?: string };
                  return { address: p.address, port: p.port, hostname: data.hostname };
                }
              } catch {}
            }
            return null;
          }),
        );
        const tResolvedMap = new Map<string, string>();
        for (const r of tStatusResults) {
          if (r.status === 'fulfilled' && r.value?.hostname) {
            tResolvedMap.set(`${r.value.address}:${r.value.port}`, r.value.hostname);
          }
        }
        for (const p of transitivePeers) {
          const key = `${p.address}:${p.port}`;
          if (looksLikeIp(p.hostname) && tResolvedMap.has(key)) {
            p.hostname = tResolvedMap.get(key)!;
          }
        }
      }

      // Merge transitive peers into main list and deduplicate again
      peers = deduplicatePeers([...peers, ...transitivePeers]);
    }
  }

  // Sort: online first, then by lastSeen desc
  peers.sort((a, b) => {
    if (a.status === 'online' && b.status !== 'online') return -1;
    if (b.status === 'online' && a.status !== 'online') return 1;
    return (b.lastSeen || 0) - (a.lastSeen || 0);
  });

  return peers;
}
