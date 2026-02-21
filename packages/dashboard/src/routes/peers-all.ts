import type { FastifyInstance } from 'fastify';
import { fetchAndDeduplicatePeers } from './peer-utils.js';

export function registerPeersAllRoute(app: FastifyInstance, apiKey: string) {
  app.get('/dashboard/api/peers/all', async () => {
    const peers = await fetchAndDeduplicatePeers(apiKey);
    return { peers, timestamp: Date.now() };
  });
}
