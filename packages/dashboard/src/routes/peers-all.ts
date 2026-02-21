import type { FastifyInstance } from 'fastify';
import { fetchAndDeduplicatePeers } from './peer-utils.js';

export function registerPeersAllRoute(app: FastifyInstance, apiKey: string, allowedKeys?: Record<string, string>) {
  app.get('/dashboard/api/peers/all', async () => {
    const peers = await fetchAndDeduplicatePeers(apiKey, allowedKeys);
    return { peers, timestamp: Date.now() };
  });
}
