import type { FastifyInstance } from 'fastify';
import type { LoopsyNodeIdentity, HealthResponse, StatusResponse } from '@loopsy/protocol';
import { PROTOCOL_VERSION } from '@loopsy/protocol';
import type { PeerRegistry } from '@loopsy/discovery';
import type { JobManager } from '../services/job-manager.js';
import type { ContextStore } from '../services/context-store.js';

interface HealthRouteDeps {
  identity: LoopsyNodeIdentity;
  startTime: number;
  registry: PeerRegistry;
  jobManager: JobManager;
  contextStore: ContextStore;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthRouteDeps) {
  app.get('/api/v1/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      nodeId: deps.identity.nodeId,
      uptime: Date.now() - deps.startTime,
      version: PROTOCOL_VERSION,
    };
  });

  app.get('/api/v1/identity', async () => {
    return deps.identity;
  });

  app.get('/api/v1/status', async (): Promise<StatusResponse> => {
    const peers = deps.registry.getAll();
    const onlinePeers = peers.filter((p) => p.status === 'online');
    return {
      nodeId: deps.identity.nodeId,
      hostname: deps.identity.hostname,
      platform: deps.identity.platform,
      version: PROTOCOL_VERSION,
      uptime: Date.now() - deps.startTime,
      peers: {
        total: peers.length,
        online: onlinePeers.length,
        offline: peers.length - onlinePeers.length,
      },
      jobs: {
        active: deps.jobManager.activeCount,
        total: 0,
      },
      context: {
        entries: deps.contextStore.size,
      },
    };
  });
}
