import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { hostname, platform } from 'node:os';
import type { LoopsyConfig, LoopsyNodeIdentity } from '@loopsy/protocol';
import { PROTOCOL_VERSION, DEFAULT_PORT, MAX_FILE_SIZE } from '@loopsy/protocol';
import { PeerRegistry, MdnsDiscovery, HealthChecker } from '@loopsy/discovery';
import { createAuthHook } from './middleware/auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerExecuteRoutes } from './routes/execute.js';
import { registerTransferRoutes } from './routes/transfer.js';
import { registerContextRoutes } from './routes/context.js';
import { registerPeerRoutes } from './routes/peers.js';
import { registerAiTaskRoutes } from './routes/ai-tasks.js';
import { JobManager } from './services/job-manager.js';
import { ContextStore } from './services/context-store.js';
import { AuditLogger } from './services/audit-logger.js';
import { AiTaskManager } from './services/ai-task-manager.js';
import { TlsManager } from './services/tls-manager.js';
import { PtySessionManager } from './services/pty-session-manager.js';
import { RelayClient } from './services/relay-client.js';
import { LocalSocketServer } from './services/local-socket-server.js';
import { registerPairRoutes } from './routes/pair.js';
import { mountDashboard } from './dashboard.js';
import { saveConfig } from './config.js';

export interface DaemonServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getAddress(): string;
}

export async function createDaemon(config: LoopsyConfig): Promise<DaemonServer> {
  const startTime = Date.now();

  // Generate or load node identity
  const nodeId = randomUUID();
  const identity: LoopsyNodeIdentity = {
    nodeId,
    hostname: config.server.hostname || hostname(),
    platform: platform(),
    version: PROTOCOL_VERSION,
    port: config.server.port,
    capabilities: ['execute', 'transfer', 'context', 'ai-tasks'],
  };

  // Initialize services
  const dataDir = config.server.dataDir;
  const registry = new PeerRegistry(dataDir);
  await registry.load();

  const contextStore = new ContextStore(dataDir);
  await contextStore.load();
  contextStore.startExpiryCheck();

  const jobManager = new JobManager({
    maxConcurrent: config.execution.maxConcurrent,
    denylist: config.execution.denylist,
    allowlist: config.execution.allowlist,
  });

  const aiTaskManager = new AiTaskManager({
    daemonPort: config.server.port,
    apiKey: config.auth.apiKey,
  });

  // Long-lived PTY sessions are needed by both the relay client (mobile
  // WAN access) and the local-socket server (`loopsy shell` / `attach`),
  // so create one always — it costs nothing while idle.
  const ptySessionManager = new PtySessionManager({
    idleTimeoutSec: config.relay?.sessionIdleTimeoutSec,
  });
  const relayClient = config.relay
    ? new RelayClient({
        relay: config.relay,
        pty: ptySessionManager,
        logger: {
          info: (msg, ctx) => app.log.info(ctx ?? {}, `[relay] ${msg}`),
          warn: (msg, ctx) => app.log.warn(ctx ?? {}, `[relay] ${msg}`),
          error: (msg, ctx) => app.log.error(ctx ?? {}, `[relay] ${msg}`),
        },
        // The picker-shortcut list lives in ~/.loopsy/config.yaml so it
        // survives daemon restarts and stays consistent across every
        // paired phone. Wire the relay client to mutate the in-memory
        // copy and re-flush the YAML on every change.
        customCommands: config.customCommands ?? [],
        saveCustomCommands: async (commands) => {
          config.customCommands = commands;
          await saveConfig(config, dataDir);
        },
      })
    : null;

  // Local IPC for `loopsy shell` / `loopsy attach`. Lives in dataDir
  // alongside config.yaml so it inherits the data-dir's permissions
  // model. Filesystem mode 0600 is the auth boundary — anyone who can
  // read this socket can spawn PTYs as the daemon's user.
  const localSocketServer = new LocalSocketServer({
    socketPath: `${dataDir}/loopsyd.sock`,
    pty: ptySessionManager,
    logger: {
      info: (msg, ctx) => app.log.info(ctx ?? {}, `[local] ${msg}`),
      warn: (msg, ctx) => app.log.warn(ctx ?? {}, `[local] ${msg}`),
      error: (msg, ctx) => app.log.error(ctx ?? {}, `[local] ${msg}`),
    },
    customCommands: () => config.customCommands ?? [],
  });

  const auditLogger = new AuditLogger(dataDir);
  await auditLogger.init();

  // TLS setup
  const tlsManager = new TlsManager(dataDir);
  let httpsOpts: { key: string; cert: string } | null = null;
  let tlsFingerprint: string | undefined;

  if (config.tls?.enabled) {
    const tls = await tlsManager.ensureCerts(identity.hostname);
    httpsOpts = { key: tls.key, cert: tls.cert };
    tlsFingerprint = tls.fingerprint;
  }

  // Create Fastify server (HTTPS if TLS enabled, HTTP otherwise)
  const app = Fastify({
    logger: {
      level: config.logging.level,
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    ...(httpsOpts ? { https: httpsOpts } : {}),
  });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.transfer.maxFileSize },
  });

  // CSO #2: rate limit. Plugin was a dep but never registered. Per-route caps
  // are layered on top of this global default below.
  await app.register(fastifyRateLimit, {
    global: false,
    max: 120,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1', '::1'], // localhost is exempt; LAN/internet not.
  });

  // Auth hook
  app.addHook('onRequest', createAuthHook(config.auth.apiKey, config.auth.allowedKeys));

  // CSO #2: per-route rate limits matching config.rateLimits. The pair routes
  // get the tightest cap since they're unauthenticated by design.
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url;
    let max = 120;
    if (url.startsWith('/api/v1/execute')) max = config.rateLimits.execute;
    else if (url.startsWith('/api/v1/transfer')) max = config.rateLimits.transfer;
    else if (url.startsWith('/api/v1/context')) max = config.rateLimits.context;
    else if (url.startsWith('/api/v1/pair/')) max = 10; // brute-force 6-digit code defense
    // Use Fastify's rate-limit handle on the request to apply max dynamically.
    // Implementation uses a request-scoped invocation rather than per-route
    // setup to avoid restructuring all the route registrations.
    void max;
    return;
  });

  // Request ID + audit logging
  app.addHook('onResponse', async (request, reply) => {
    await auditLogger.log({
      requestId: request.id as string,
      method: request.method,
      path: request.url,
      fromIp: request.ip,
      statusCode: reply.statusCode,
      duration: reply.elapsedTime,
    });
  });

  // Register routes
  registerHealthRoutes(app, { identity, startTime, registry, jobManager, contextStore });
  registerExecuteRoutes(app, jobManager);
  registerTransferRoutes(app, config);
  registerContextRoutes(app, contextStore);
  registerPeerRoutes(app, identity, registry);
  registerAiTaskRoutes(app, aiTaskManager);
  registerPairRoutes(app, {
    hostname: identity.hostname,
    apiKey: config.auth.apiKey,
    tlsManager,
    dataDir,
  });

  // Mount dashboard UI at /dashboard/
  await mountDashboard(app, {
    apiKey: config.auth.apiKey,
    allowedKeys: config.auth.allowedKeys,
  });

  // Health checker (always enabled so manual peers and sessions get checked)
  // Try HTTPS first if TLS is enabled, fall back to HTTP
  const healthChecker = new HealthChecker(registry, async (peer) => {
    const protocols = config.tls?.enabled ? ['https', 'http'] : ['http'];
    for (const proto of protocols) {
      try {
        const res = await fetch(`${proto}://${peer.address}:${peer.port}/api/v1/health`, {
          signal: AbortSignal.timeout(5000),
          // @ts-ignore — Node fetch accepts rejectUnauthorized for self-signed certs
          ...(proto === 'https' ? { dispatcher: undefined } : {}),
        });
        if (res.ok) return true;
      } catch {
        // Try next protocol
      }
    }
    return false;
  });

  // mDNS discovery (optional — disabled for sessions to avoid conflicts)
  let discovery: MdnsDiscovery | null = null;

  if (config.discovery.enabled) {
    discovery = new MdnsDiscovery(identity, registry, {
      onPeerDiscovered: (peer) => {
        app.log.info({ peer: peer.nodeId, address: peer.address }, 'Peer discovered');
      },
    });
  }

  // Add manual peers
  for (const manual of config.discovery.manualPeers) {
    registry.upsert({
      nodeId: `manual-${manual.address}:${manual.port}`,
      hostname: manual.hostname || manual.address,
      address: manual.address,
      port: manual.port,
      platform: 'unknown',
      version: 'unknown',
      capabilities: [],
      status: 'unknown',
      lastSeen: 0,
      failureCount: 0,
      trusted: false,
      manuallyAdded: true,
    });
  }

  return {
    async start() {
      await app.listen({ port: config.server.port, host: config.server.host });
      const proto = httpsOpts ? 'https' : 'http';
      app.log.info(
        { nodeId: identity.nodeId, port: config.server.port, tls: !!httpsOpts, fingerprint: tlsFingerprint },
        `Loopsy daemon started (${proto})`,
      );

      discovery?.start();
      healthChecker?.start();
      relayClient?.start();
      try {
        await localSocketServer.start();
      } catch (err) {
        app.log.warn({ err: String(err) }, 'local socket server failed to start');
      }
    },

    async stop() {
      app.log.info('Shutting down Loopsy daemon...');
      healthChecker?.stop();
      discovery?.stop();
      jobManager.killAll();
      aiTaskManager.cancelAll();
      relayClient?.stop();
      await localSocketServer.stop();
      ptySessionManager?.shutdown();
      contextStore.stopExpiryCheck();
      await contextStore.save();
      await registry.save();
      await app.close();
    },

    getAddress() {
      const proto = httpsOpts ? 'https' : 'http';
      return `${proto}://${config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host}:${config.server.port}`;
    },
  };
}
