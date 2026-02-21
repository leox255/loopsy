import type { FastifyInstance } from 'fastify';
import { listSessions } from '../session-manager.js';
import { fetchAndDeduplicatePeers } from './peer-utils.js';

const ALLOWED_PORT_MIN = 19532;
const ALLOWED_PORT_MAX = 19640;

function randomHex4(): string {
  return Math.random().toString(16).slice(2, 6);
}

export function registerMessageRoutes(
  app: FastifyInstance,
  apiKey: string,
  allowedKeys: Record<string, string>,
) {
  // Unified inbox/outbox across all sessions
  app.get('/dashboard/api/messages/all', async (req, reply) => {
    const tab = (req.query as any).tab === 'outbox' ? 'outbox' : 'inbox';
    const prefix = tab === 'inbox' ? 'inbox:' : 'outbox:';

    const { main, sessions } = await listSessions();
    const running = [];
    if (main && main.status === 'running') running.push(main);
    running.push(...sessions.filter((s) => s.status === 'running'));

    const results = await Promise.allSettled(
      running.map(async (s) => {
        const res = await fetch(
          `http://127.0.0.1:${s.port}/api/v1/context?prefix=${encodeURIComponent(prefix)}`,
          {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(3000),
          },
        );
        if (!res.ok) return [];
        const data = (await res.json()) as { entries?: any[] };
        return (data.entries || []).map((e: any) => ({ ...e, _sourcePort: s.port }));
      }),
    );

    const allEntries: any[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') allEntries.push(...r.value);
    }

    // Deduplicate by key (message IDs are globally unique)
    const map = new Map<string, any>();
    for (const e of allEntries) {
      const existing = map.get(e.key);
      if (!existing || (e.updatedAt && e.updatedAt > existing.updatedAt)) {
        map.set(e.key, e);
      }
    }

    const entries = Array.from(map.values()).sort(
      (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
    );

    return { entries, timestamp: Date.now() };
  });

  // Send message to remote peer via server-side routing
  app.post('/dashboard/api/messages/send', async (req, reply) => {
    const { fromPort, toHostname, body, type } = req.body as {
      fromPort: number;
      toHostname: string;
      body: string;
      type: string;
    };

    if (!fromPort || !toHostname || !body || !type) {
      return reply.status(400).send({ error: 'Missing required fields: fromPort, toHostname, body, type' });
    }

    if (fromPort < ALLOWED_PORT_MIN || fromPort > ALLOWED_PORT_MAX) {
      return reply.status(400).send({ error: 'Invalid fromPort' });
    }

    // Get sender hostname
    let fromHostname = 'unknown';
    try {
      const statusRes = await fetch(`http://127.0.0.1:${fromPort}/api/v1/status`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(3000),
      });
      if (statusRes.ok) {
        const statusData = (await statusRes.json()) as { hostname?: string };
        fromHostname = statusData.hostname || 'unknown';
      }
    } catch {}

    // Find target peer using deduplicated peer list (resolves 127.0.0.1 hostnames)
    let peerAddress: string | null = null;
    let peerPort: number | null = null;
    try {
      const allPeers = await fetchAndDeduplicatePeers(apiKey);
      const peer = allPeers.find((p) => p.hostname === toHostname);
      if (peer) {
        peerAddress = peer.address;
        peerPort = peer.port;
      }
    } catch {}

    if (!peerAddress || !peerPort) {
      return reply.status(404).send({ error: `Peer "${toHostname}" not found in peer registry` });
    }

    // Determine peer API key: check allowedKeys, fall back to own apiKey
    let peerApiKey = apiKey;
    for (const [, key] of Object.entries(allowedKeys)) {
      // Try each allowed key — for remote peers, their key is in our allowedKeys
      // For local sessions, they share our apiKey
      // We can't know which key maps to which peer by name alone,
      // so for remote peers we try the first non-self key
      if (key !== apiKey) {
        peerApiKey = key;
        break;
      }
    }

    // Generate message ID and envelope
    const id = `${Date.now()}-${fromHostname}-${randomHex4()}`;
    const envelope = { from: fromHostname, to: toHostname, ts: Date.now(), id, type, body };
    const value = JSON.stringify(envelope);

    // Store outbox on local session
    try {
      await fetch(`http://127.0.0.1:${fromPort}/api/v1/context/${encodeURIComponent('outbox:' + id)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value, ttl: 3600 }),
        signal: AbortSignal.timeout(3000),
      });
    } catch (err: any) {
      return reply.status(500).send({ error: 'Failed to store outbox', details: err.message });
    }

    // Put inbox on remote peer
    const inboxKey = `inbox:${toHostname}:${id}`;
    try {
      const inboxRes = await fetch(
        `http://${peerAddress}:${peerPort}/api/v1/context/${encodeURIComponent(inboxKey)}`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${peerApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ value, ttl: 3600 }),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!inboxRes.ok) {
        const errText = await inboxRes.text().catch(() => '');
        return reply.status(502).send({
          error: 'Outbox written but inbox delivery failed',
          details: `Remote returned ${inboxRes.status}: ${errText}`,
          id,
        });
      }
    } catch (err: any) {
      return reply.status(502).send({
        error: 'Outbox written but inbox delivery failed',
        details: err.message,
        id,
      });
    }

    return { success: true, id, outboxKey: 'outbox:' + id, inboxKey };
  });
}
