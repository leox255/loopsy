import type { FastifyInstance } from 'fastify';
import { HandshakeSchema, LoopsyError, LoopsyErrorCode } from '@loopsy/protocol';
import type { LoopsyNodeIdentity, PeerInfo } from '@loopsy/protocol';
import type { PeerRegistry } from '@loopsy/discovery';

export function registerPeerRoutes(
  app: FastifyInstance,
  identity: LoopsyNodeIdentity,
  registry: PeerRegistry,
) {
  // Handshake: receive a peer's identity
  app.post('/api/v1/peers/handshake', async (request) => {
    const data = HandshakeSchema.parse(request.body);
    const address = request.ip;

    const peer: PeerInfo = {
      nodeId: data.nodeId,
      hostname: data.hostname,
      address,
      port: data.port,
      platform: data.platform,
      version: data.version,
      capabilities: data.capabilities,
      status: 'online',
      lastSeen: Date.now(),
      failureCount: 0,
      trusted: false,
      manuallyAdded: false,
    };

    registry.upsert(peer);
    await registry.save();

    return {
      nodeId: identity.nodeId,
      hostname: identity.hostname,
      platform: identity.platform,
      version: identity.version,
      port: identity.port,
      capabilities: identity.capabilities,
    };
  });

  // List all known peers
  app.get('/api/v1/peers', async () => {
    return { peers: registry.getAll() };
  });

  // Add a manual peer
  app.post('/api/v1/peers', async (request) => {
    const body = request.body as { address: string; port: number; nodeId?: string; hostname?: string };
    const peer: PeerInfo = {
      nodeId: body.nodeId ?? `manual-${body.address}:${body.port}`,
      hostname: body.hostname || body.address,
      address: body.address,
      port: body.port,
      platform: 'unknown',
      version: 'unknown',
      capabilities: [],
      status: 'unknown',
      lastSeen: 0,
      failureCount: 0,
      trusted: false,
      manuallyAdded: true,
    };
    registry.upsert(peer);
    await registry.save();
    return peer;
  });

  // Remove a peer
  app.delete<{ Params: { nodeId: string } }>('/api/v1/peers/:nodeId', async (request, reply) => {
    const { nodeId } = request.params;
    const removed = registry.remove(nodeId);
    if (!removed) {
      reply.code(404);
      return new LoopsyError(LoopsyErrorCode.PEER_NOT_FOUND, `Peer ${nodeId} not found`).toJSON();
    }
    await registry.save();
    return { success: true, nodeId };
  });
}
