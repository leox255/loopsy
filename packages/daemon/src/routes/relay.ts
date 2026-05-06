/**
 * `/api/v1/relay/{status,reconnect}` — authenticated runtime control
 * over the daemon's RelayClient instance.
 *
 * `loopsy mobile pair` writes a fresh `relay:` block into
 * `~/.loopsy/config.yaml` and then POSTs `/relay/reconnect` so the
 * daemon swaps its in-memory RelayClient without restarting the process.
 * Active PTY sessions and the local Unix socket survive the swap.
 *
 * Both endpoints sit behind the standard bearer-auth hook
 * (`auth.ts:30` whitelists `/api/v1/health` only) so neither leaks
 * relay topology to anyone on the LAN.
 */

import type { FastifyInstance } from 'fastify';
import type { LoopsyConfig } from '@loopsy/protocol';
import { LoopsyError, LoopsyErrorCode } from '@loopsy/protocol';
import { loadConfig } from '../config.js';
import { RelayClient, type RelayClientLogger, type RelayClientStatus } from '../services/relay-client.js';
import type { PtySessionManager } from '../services/pty-session-manager.js';
import { saveConfig } from '../config.js';

/**
 * Mutable holder so the route can swap the RelayClient instance the
 * daemon is using. server.ts constructs the holder once at boot and
 * mutates `current` in place when /reconnect lands.
 */
export interface RelayClientHandle {
  current: RelayClient | null;
}

interface RelayRouteDeps {
  handle: RelayClientHandle;
  pty: PtySessionManager;
  logger: RelayClientLogger;
  /** Same in-memory config object the rest of the daemon reads. We mutate
   *  `config.relay` here so saveCustomCommands and other code see the new
   *  link without a daemon restart. */
  config: LoopsyConfig;
  /** Same dataDir as the rest of the daemon. Optional so this matches
   *  config.server.dataDir, which is also optional. */
  dataDir?: string;
}

export function registerRelayRoutes(app: FastifyInstance, deps: RelayRouteDeps) {
  app.get('/api/v1/relay/status', async (): Promise<RelayClientStatus> => {
    const client = deps.handle.current;
    if (!client) {
      return { connected: false, url: '', lastError: 'no relay configured' };
    }
    return client.getStatus();
  });

  app.post('/api/v1/relay/reconnect', async (request, reply) => {
    // Re-read the config from disk. The CLI just wrote a fresh `relay:`
    // block; we must not trust the in-memory copy because that's the
    // pre-pair state.
    let fresh: LoopsyConfig;
    try {
      fresh = await loadConfig(deps.dataDir);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const e = new LoopsyError(
        LoopsyErrorCode.INTERNAL_ERROR,
        `Failed to re-read config: ${message}`,
      );
      reply.code(500).send(e.toJSON());
      return;
    }

    if (!fresh.relay) {
      const e = new LoopsyError(
        LoopsyErrorCode.INVALID_REQUEST,
        'No relay block in ~/.loopsy/config.yaml after reload — refusing to reconnect.',
      );
      reply.code(400).send(e.toJSON());
      return;
    }

    // Tear down the old client (if any) FIRST so we don't end up with two
    // outbound WebSockets stepping on each other.
    if (deps.handle.current) {
      try { deps.handle.current.stop(); } catch { /* best effort */ }
    }

    // Mutate the live config object so other components (saveConfig
    // callbacks for custom commands, etc.) see the new relay block.
    deps.config.relay = fresh.relay;
    deps.config.customCommands = fresh.customCommands ?? deps.config.customCommands;

    const next = new RelayClient({
      relay: fresh.relay,
      pty: deps.pty,
      logger: deps.logger,
      customCommands: deps.config.customCommands ?? [],
      saveCustomCommands: async (commands) => {
        deps.config.customCommands = commands;
        await saveConfig(deps.config, deps.dataDir);
      },
    });
    deps.handle.current = next;
    next.start();

    // Return 202: the swap is committed but the WebSocket handshake is
    // still in flight. The CLI polls /relay/status to know when
    // `connected===true`.
    reply.code(202).send({ status: 'reconnecting', url: fresh.relay.url });
  });
}
