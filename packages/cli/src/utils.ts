import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_PORT, CONFIG_DIR, CONFIG_FILE } from '@loopsy/protocol';

export async function loadCliConfig(dataDir?: string): Promise<{ apiKey: string; port: number }> {
  try {
    const dir = dataDir ?? join(homedir(), CONFIG_DIR);
    const configPath = join(dir, CONFIG_FILE);
    const raw = await readFile(configPath, 'utf-8');
    const config = parseYaml(raw) as any;
    return {
      apiKey: config?.auth?.apiKey ?? '',
      port: config?.server?.port ?? DEFAULT_PORT,
    };
  } catch {
    return { apiKey: '', port: DEFAULT_PORT };
  }
}

export async function loadApiKey(): Promise<string> {
  const { apiKey } = await loadCliConfig();
  return apiKey;
}

export function parsePeerAddress(peer: string): { address: string; port: number } {
  const parts = peer.split(':');
  return {
    address: parts[0],
    port: parts.length > 1 ? parseInt(parts[1], 10) : DEFAULT_PORT,
  };
}

export interface PeerLike {
  nodeId?: string;
  address?: string;
  port?: number;
  hostname?: string;
  status?: string;
}

/**
 * Pick the registry peer that best matches `query` — a hostname, full nodeId,
 * nodeId prefix (as printed by `loopsy peers`), or address. Case-insensitive.
 * Prefers an `online` peer and more specific matches (exact hostname/nodeId)
 * over a nodeId prefix. Returns undefined when nothing matches.
 */
export function selectPeer(peers: PeerLike[], query: string): PeerLike | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const pick = (pred: (p: PeerLike) => boolean): PeerLike | undefined => {
    const matches = peers.filter(pred);
    return matches.find((p) => p.status === 'online') ?? matches[0];
  };
  return (
    pick((p) => p.hostname?.toLowerCase() === q) ??
    pick((p) => p.nodeId?.toLowerCase() === q) ??
    (q.length >= 4 ? pick((p) => p.nodeId?.toLowerCase().startsWith(q) ?? false) : undefined) ??
    pick((p) => p.address?.toLowerCase() === q)
  );
}

/**
 * Resolve a `peer` argument to a routable address. A literal IPv4 (optionally
 * `:port`) is used as-is. Otherwise the arg is treated as a peer NAME
 * (hostname / nodeId / nodeId prefix) and resolved against the daemon's peer
 * registry — the same list `loopsy peers` shows — so `loopsy exec <hostname>`
 * works without it being DNS-resolvable. Falls back to the literal host (DNS)
 * when the daemon is unreachable or nothing matches.
 */
export async function resolvePeerAddress(peer: string): Promise<{ address: string; port: number }> {
  const parsed = parsePeerAddress(peer);
  // A literal IPv4 is already routable — skip the registry lookup.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.address)) {
    return parsed;
  }
  try {
    const { peers } = await daemonRequest('/peers');
    const match = selectPeer(peers ?? [], parsed.address);
    if (match?.address) {
      // An explicit ":port" in the arg overrides the registry's port.
      const hadExplicitPort = peer.includes(':');
      return { address: match.address, port: hadExplicitPort ? parsed.port : match.port ?? parsed.port };
    }
  } catch {
    // Daemon down or no registry — fall through to the literal host.
  }
  return parsed;
}

export async function daemonRequest(path: string, opts: RequestInit = {}, dataDir?: string): Promise<any> {
  const { apiKey, port } = await loadCliConfig(dataDir);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (opts.body) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    ...opts,
    headers: {
      ...headers,
      ...(opts.headers as Record<string, string>),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as any;
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json();
}
