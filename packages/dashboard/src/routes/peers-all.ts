import type { FastifyInstance } from 'fastify';
import { fetchAndDeduplicatePeers } from './peer-utils.js';
import { listSessions } from '../session-manager.js';

function resolveApiKey(
  address: string,
  localApiKey: string,
  allowedKeys: Record<string, string>,
): string {
  if (address === '127.0.0.1' || address === 'localhost') return localApiKey;
  for (const key of Object.values(allowedKeys)) {
    if (key !== localApiKey) return key;
  }
  return localApiKey;
}

export function registerPeersAllRoute(app: FastifyInstance, apiKey: string, allowedKeys?: Record<string, string>) {
  app.get('/dashboard/api/peers/all', async () => {
    const peers = await fetchAndDeduplicatePeers(apiKey, allowedKeys);
    return { peers, timestamp: Date.now() };
  });

  // Delete peers by nodeId across all local sessions and optionally remote machines
  app.post('/dashboard/api/peers/delete', async (request) => {
    const { peers: peersToDelete } = request.body as {
      peers: Array<{ nodeId: string; address: string; port: number; _seenBySessions?: number[] }>;
    };

    if (!peersToDelete?.length) return { deleted: 0 };

    const { main, sessions } = await listSessions();
    const localPorts: number[] = [];
    if (main && main.status === 'running') localPorts.push(main.port);
    for (const s of sessions.filter((s) => s.status === 'running')) {
      localPorts.push(s.port);
    }

    let deleted = 0;

    for (const peer of peersToDelete) {
      // Delete from all local sessions
      for (const port of localPorts) {
        try {
          const res = await fetch(
            `http://127.0.0.1:${port}/api/v1/peers/${encodeURIComponent(peer.nodeId)}`,
            {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${apiKey}` },
              signal: AbortSignal.timeout(3000),
            },
          );
          if (res.ok) deleted++;
        } catch {}
      }

      // If this peer is on a remote machine, also tell that machine to remove it
      const isRemote = peer.address !== '127.0.0.1' && peer.address !== 'localhost';
      if (isRemote && allowedKeys) {
        const remoteKey = resolveApiKey(peer.address, apiKey, allowedKeys);
        try {
          const res = await fetch(
            `http://${peer.address}:${peer.port}/api/v1/peers/${encodeURIComponent(peer.nodeId)}`,
            {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${remoteKey}` },
              signal: AbortSignal.timeout(3000),
            },
          );
          if (res.ok) deleted++;
        } catch {}
      }
    }

    return { deleted, requested: peersToDelete.length };
  });
}
