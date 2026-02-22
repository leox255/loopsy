import type { FastifyInstance } from 'fastify';
import { randomBytes, createECDH, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { PAIRING_CODE_LENGTH, PAIRING_TIMEOUT, CONFIG_DIR, CONFIG_FILE } from '@loopsy/protocol';
import type { PairingSession, PairingInitRequest, PairingInitResponse, PairingConfirmRequest } from '@loopsy/protocol';
import type { TlsManager } from '../services/tls-manager.js';

interface PairContext {
  hostname: string;
  apiKey: string;
  tlsManager: TlsManager;
  dataDir?: string;
}

export function registerPairRoutes(app: FastifyInstance, ctx: PairContext) {
  // Active pairing session (only one at a time)
  let session: PairingSession | null = null;
  let sessionEcdh: ReturnType<typeof createECDH> | null = null;
  let sessionTimeout: ReturnType<typeof setTimeout> | null = null;
  // Store peer info during key exchange until confirmed
  let pendingPeer: { hostname: string; apiKey: string; certFingerprint?: string } | null = null;

  // POST /api/v1/pair/start — Machine A starts a pairing session
  app.post('/api/v1/pair/start', async (_request, reply) => {
    if (session && session.state === 'waiting' && Date.now() < session.expiresAt) {
      return reply.status(409).send({ error: 'Pairing session already active' });
    }

    // Generate ECDH keypair
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();

    // Generate invite code (6 digits)
    const code = String(randomBytes(4).readUInt32BE() % 10 ** PAIRING_CODE_LENGTH).padStart(PAIRING_CODE_LENGTH, '0');

    session = {
      inviteCode: code,
      publicKey: ecdh.getPublicKey('base64'),
      expiresAt: Date.now() + PAIRING_TIMEOUT,
      state: 'waiting',
    };
    sessionEcdh = ecdh;
    pendingPeer = null;

    // Auto-expire
    if (sessionTimeout) clearTimeout(sessionTimeout);
    sessionTimeout = setTimeout(() => {
      if (session) session.state = 'expired';
      session = null;
      sessionEcdh = null;
      pendingPeer = null;
    }, PAIRING_TIMEOUT);

    return { inviteCode: code, expiresAt: session.expiresAt };
  });

  // POST /api/v1/pair/initiate — Machine B sends its public key + invite code
  app.post('/api/v1/pair/initiate', async (request, reply) => {
    const body = request.body as PairingInitRequest;

    if (!session || session.state !== 'waiting') {
      return reply.status(404).send({ error: 'No active pairing session' });
    }

    if (Date.now() > session.expiresAt) {
      session.state = 'expired';
      return reply.status(410).send({ error: 'Pairing session expired' });
    }

    if (body.inviteCode !== session.inviteCode) {
      return reply.status(403).send({ error: 'Invalid invite code' });
    }

    if (!sessionEcdh) {
      return reply.status(500).send({ error: 'Internal error: missing ECDH state' });
    }

    // Compute shared secret via ECDH
    const peerPubKey = Buffer.from(body.publicKey, 'base64');
    const sharedSecret = sessionEcdh.computeSecret(peerPubKey);

    // Derive SAS (Short Authentication String) — 6 digits from shared secret hash
    const sasHash = createHash('sha256').update(sharedSecret).update('loopsy-sas').digest();
    const sas = String(sasHash.readUInt32BE() % 10 ** 6).padStart(6, '0');

    session.peerPublicKey = body.publicKey;
    session.sas = sas;
    session.state = 'key_exchanged';
    pendingPeer = {
      hostname: body.hostname,
      apiKey: body.apiKey,
      certFingerprint: body.certFingerprint,
    };

    // Get our TLS fingerprint if available
    let ourFingerprint: string | undefined;
    if (ctx.tlsManager.hasCerts()) {
      const certs = await ctx.tlsManager.loadCerts();
      ourFingerprint = certs.fingerprint;
    }

    const response: PairingInitResponse = {
      publicKey: session.publicKey,
      hostname: ctx.hostname,
      apiKey: ctx.apiKey,
      certFingerprint: ourFingerprint,
      sas,
    };

    return response;
  });

  // POST /api/v1/pair/confirm — Both sides confirm the SAS matches
  app.post('/api/v1/pair/confirm', async (request, reply) => {
    const body = request.body as PairingConfirmRequest;

    if (!session || session.state !== 'key_exchanged') {
      return reply.status(404).send({ error: 'No pairing session awaiting confirmation' });
    }

    if (!body.confirmed) {
      session.state = 'expired';
      session = null;
      sessionEcdh = null;
      pendingPeer = null;
      return { success: false, message: 'Pairing cancelled' };
    }

    if (!pendingPeer) {
      return reply.status(500).send({ error: 'No pending peer info' });
    }

    // Write peer to config
    await addPeerToConfig(pendingPeer.hostname, pendingPeer.apiKey, pendingPeer.certFingerprint, ctx.dataDir);

    session.state = 'completed';
    const completedPeer = pendingPeer.hostname;

    // Cleanup
    session = null;
    sessionEcdh = null;
    pendingPeer = null;
    if (sessionTimeout) clearTimeout(sessionTimeout);

    return { success: true, message: `Paired with ${completedPeer}` };
  });

  // GET /api/v1/pair/status — Check current pairing session state
  app.get('/api/v1/pair/status', async () => {
    if (!session) return { active: false };
    return {
      active: true,
      state: session.state,
      sas: session.state === 'key_exchanged' ? session.sas : undefined,
      expiresAt: session.expiresAt,
    };
  });
}

async function addPeerToConfig(peerHostname: string, peerApiKey: string, certFingerprint?: string, dataDir?: string) {
  const configPath = join(dataDir ?? join(homedir(), CONFIG_DIR), CONFIG_FILE);
  const raw = await readFile(configPath, 'utf-8');
  const config = parseYaml(raw) as any;

  // Add to allowedKeys
  if (!config.auth) config.auth = {};
  if (!config.auth.allowedKeys) config.auth.allowedKeys = {};
  config.auth.allowedKeys[peerHostname] = peerApiKey;

  // Add cert fingerprint if provided
  if (certFingerprint) {
    if (!config.tls) config.tls = { enabled: false };
    if (!config.tls.pinnedCerts) config.tls.pinnedCerts = {};
    config.tls.pinnedCerts[peerHostname] = certFingerprint;
  }

  await writeFile(configPath, toYaml(config));
}
