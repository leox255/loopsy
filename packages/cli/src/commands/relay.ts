/**
 * `loopsy relay` and `loopsy mobile pair` commands.
 *
 *   loopsy relay configure <url>   register this device with the relay,
 *                                  store {url, deviceId, deviceSecret}
 *                                  in ~/.loopsy/config.yaml
 *   loopsy relay show              print current relay config (secret masked)
 *   loopsy relay unset             remove relay config
 *   loopsy mobile pair             fetch a one-time pair token + render QR
 */

import { readFile, writeFile, mkdir, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import qrcode from 'qrcode-terminal';
import { CONFIG_DIR, CONFIG_FILE } from '@loopsy/protocol';
import type { LoopsyConfig, RelayConfig } from '@loopsy/protocol';
import { daemonRequest } from '../utils.js';

const PUBLIC_RELAY_URL = 'https://relay.loopsy.dev';

interface RegisterResponse {
  device_id: string;
  device_secret: string;
  relay_url: string;
}

interface PhoneRecord {
  phone_id: string;
  label?: string;
  paired_at: number;
}

interface PhonesResponse {
  phones: PhoneRecord[];
}

interface PairTokenResponse {
  token: string;
  /** CSO #14: 4-digit verification code shown on the laptop, entered on the phone. */
  sas?: string;
  expires_at: number;
}

async function loadConfig(): Promise<{ config: LoopsyConfig; path: string }> {
  const path = join(homedir(), CONFIG_DIR, CONFIG_FILE);
  const raw = await readFile(path, 'utf-8');
  return { config: parseYaml(raw) as LoopsyConfig, path };
}

async function saveConfig(config: LoopsyConfig, path: string): Promise<void> {
  await writeFile(path, toYaml(config));
}

function maskSecret(s: string): string {
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * POST /device/register on the chosen relay URL. Returns a fully-formed
 * RelayConfig the caller can drop into ~/.loopsy/config.yaml.
 *
 * The relay echoes back a `relay_url` in the response (today it's literally
 * the request origin per packages/relay/src/index.ts:211, but a self-hosted
 * deployment behind a CF custom-domain rewrite or redirect could legitimately
 * canonicalize it). We trust the relay's response — this is a v1 trust call,
 * not a security boundary; a network MITM would intercept TLS itself, and
 * pinning the user-supplied URL would break legitimate canonicalization.
 */
export async function registerWithRelay(rawUrl: string): Promise<RelayConfig> {
  const url = normalizeUrl(rawUrl);
  const res = await fetch(`${url}/device/register`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Relay rejected register at ${url}: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { device_id: string; device_secret: string; relay_url: string };
  return {
    url: normalizeUrl(data.relay_url || url),
    deviceId: data.device_id,
    deviceSecret: data.device_secret,
  };
}

/**
 * Pick a relay URL from CLI flags / env / interactive consent. Returns null
 * if no URL was resolved (caller should print help and exit non-interactively).
 *
 * Precedence:
 *   1. --relay-url <url>
 *   2. --use-public-relay  → relay.loopsy.dev
 *   3. LOOPSY_RELAY_URL env var
 *   4. TTY + interactive consent → prompt user
 *   5. No TTY, no flag, no env → null (fail-closed)
 */
async function resolveRelayUrl(argv: {
  relayUrl?: string;
  usePublicRelay?: boolean;
}): Promise<string | null> {
  if (argv.relayUrl) return normalizeUrl(argv.relayUrl);
  if (argv.usePublicRelay) return PUBLIC_RELAY_URL;
  if (process.env.LOOPSY_RELAY_URL) return normalizeUrl(process.env.LOOPSY_RELAY_URL);

  // Interactive consent. Treat undefined isTTY (piped stdin) as non-interactive.
  if (!process.stdin.isTTY) return null;

  // Default to the public relay; user can decline, then we fail-closed.
  const url = PUBLIC_RELAY_URL;
  const isPublic = url === PUBLIC_RELAY_URL;
  const host = new URL(url).host;

  console.log('');
  console.log(`This will register your laptop with the relay at ${url}`);
  console.log('so your phone can reach the daemon without port forwarding.');
  console.log('');
  if (isPublic) {
    console.log('The relay is operated by the loopsy maintainers. Until end-to-end');
    console.log('encryption ships, the relay operator can:');
  } else {
    console.log('Until end-to-end encryption ships, whoever operates this relay can:');
  }
  console.log('  - read AND modify your terminal traffic (PTY input/output)');
  console.log('  - capture any password you type at a sudo prompt');
  console.log('  - run commands on your machine as you (the phone client can spawn');
  console.log('    sessions with arbitrary args and initial input)');
  console.log('');
  if (isPublic) {
    console.log('If you enable per-session auto-approve, the operator can also approve');
    console.log('those commands silently using your stored macOS password.');
    console.log('');
    console.log('See the trust model:');
    console.log('  https://github.com/leox255/loopsy#threat-model-read-this-first');
  } else {
    console.log('Make sure you trust whoever runs this relay.');
  }
  console.log('');
  console.log('A device secret will be stored at ~/.loopsy/config.yaml.');
  console.log('');

  const answer = await prompt(`Continue with ${host}? (y/N) [n]: `);
  if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
    return null;
  }
  return url;
}

const PAIR_LOCK_DIR = join(homedir(), CONFIG_DIR, '.pair.lock');
const PAIR_LOCK_STALE_MS = 60_000;

/**
 * Atomic mkdir lock. POSIX mkdir is atomic so concurrent `loopsy mobile pair`
 * invocations can't both win. Stale locks (>60s old) are reclaimed so a
 * crashed previous attempt doesn't leave the user wedged forever.
 *
 * We deliberately avoid `proper-lockfile` here: it's a heavier dependency for
 * what is genuinely a single-user single-machine race, and its semantics
 * around non-existent target paths require careful options that obscure
 * what's actually happening.
 */
async function acquirePairLock(): Promise<() => Promise<void>> {
  try {
    await mkdir(PAIR_LOCK_DIR);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Lock exists — check staleness.
    let ageMs = 0;
    try {
      const s = await stat(PAIR_LOCK_DIR);
      ageMs = Date.now() - s.mtimeMs;
    } catch {
      ageMs = PAIR_LOCK_STALE_MS + 1; // disappeared — try again
    }
    if (ageMs <= PAIR_LOCK_STALE_MS) {
      const remainingS = Math.max(1, Math.round((PAIR_LOCK_STALE_MS - ageMs) / 1000));
      throw new Error(
        `Another "loopsy mobile pair" is already running. ` +
        `Retry in ~${remainingS}s, or remove the stale lock at ${PAIR_LOCK_DIR}.`
      );
    }
    // Stale — reclaim.
    try { await rmdir(PAIR_LOCK_DIR); } catch { /* race; treat as ok */ }
    await mkdir(PAIR_LOCK_DIR);
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try { await rmdir(PAIR_LOCK_DIR); } catch { /* best effort */ }
  };
}

/**
 * Tell the running daemon to swap its RelayClient in place, then poll
 * /api/v1/relay/status until the new WebSocket reports `connected: true`.
 *
 * No daemon restart. Active PTY sessions, the local Unix socket, and any
 * existing peer registrations all survive.
 *
 * Falls back with a clear "older daemon" message if /reconnect 404s — the
 * user just needs to restart their daemon once to pick up this CLI's
 * matching daemon code.
 */
async function triggerRelayReconnect(opts: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await daemonRequest('/relay/reconnect', { method: 'POST' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('HTTP 404')) {
      throw new Error(
        'The running daemon is older than this CLI and does not support hot ' +
        'relay reconnect. Run: loopsy stop && loopsy start && loopsy mobile pair'
      );
    }
    throw err;
  }

  const timeoutMs = opts.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const s = await daemonRequest('/relay/status');
      if (s.connected) return;
    } catch { /* transient — keep polling */ }
    await sleep(500);
  }
  // One final fetch to surface lastError on timeout.
  let lastError: string | null | undefined;
  try {
    const s = await daemonRequest('/relay/status');
    lastError = s.lastError;
  } catch { /* status itself failed */ }
  throw new Error(
    `Relay did not come up within ${Math.round(timeoutMs / 1000)}s. ` +
    (lastError ? `Last error: ${lastError}. ` : '') +
    `Run "loopsy doctor" to diagnose.`
  );
}

/**
 * Friendly version of the no-relay help. Used when interactive consent is
 * declined or no flag/env supplies a URL.
 */
function printNoRelayHelp(): void {
  console.error('No relay configured. Mobile pairing routes through a Cloudflare Worker relay so');
  console.error('your phone can reach the daemon without port forwarding or a VPN.');
  console.error('');
  console.error('Pick one:');
  console.error('');
  console.error('  Use the public relay (fastest, run by the loopsy maintainers — read the trust');
  console.error('  notes at https://github.com/leox255/loopsy#threat-model-read-this-first):');
  console.error('    loopsy mobile pair --use-public-relay');
  console.error('');
  console.error('  Self-host on your own Cloudflare account (~30s, free tier, full privacy):');
  console.error('    npx @loopsy/deploy-relay');
  console.error('    loopsy mobile pair --relay-url https://<your-relay>.workers.dev');
  console.error('');
  console.error('Or set LOOPSY_RELAY_URL in your environment.');
}

export async function relayConfigureCommand(argv: { url: string }): Promise<void> {
  console.log(`Registering this device with the relay at ${normalizeUrl(argv.url)}...`);

  let relay: RelayConfig;
  try {
    relay = await registerWithRelay(argv.url);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  let configEntry: { config: LoopsyConfig; path: string };
  try {
    configEntry = await loadConfig();
  } catch {
    console.error('No config found at ~/.loopsy/config.yaml — run "loopsy init" first.');
    process.exitCode = 1;
    return;
  }
  const { config, path } = configEntry;
  config.relay = { ...(config.relay ?? {}), ...relay };
  await saveConfig(config, path);

  console.log('');
  console.log('Relay configured.');
  console.log(`  url:           ${relay.url}`);
  console.log(`  device_id:     ${relay.deviceId}`);
  console.log(`  device_secret: ${maskSecret(relay.deviceSecret)}`);
  console.log('');
  console.log('Restart the daemon for the relay link to come up:');
  console.log('  loopsy stop && loopsy start');
  console.log('');
  console.log('Or use "loopsy mobile pair" — that command now reconnects the daemon');
  console.log('in place without restarting (active sessions survive).');
}

export async function relayShowCommand(): Promise<void> {
  const { config } = await loadConfig();
  if (!config.relay) {
    console.log('No relay configured. Run "loopsy relay configure <url>".');
    return;
  }
  console.log(`url:           ${config.relay.url}`);
  console.log(`device_id:     ${config.relay.deviceId}`);
  console.log(`device_secret: ${maskSecret(config.relay.deviceSecret)}`);
}

export async function relayUnsetCommand(): Promise<void> {
  const { config, path } = await loadConfig();
  if (!config.relay) {
    console.log('No relay configured.');
    return;
  }
  delete config.relay;
  await saveConfig(config, path);
  console.log('Relay configuration removed. Restart the daemon to apply.');
}

export async function mobilePairCommand(argv: {
  ttl?: number;
  multiUse?: boolean;
  qrPng?: string;
  relayUrl?: string;
  usePublicRelay?: boolean;
}): Promise<void> {
  let { config, path: configPath } = await loadConfig();

  if (!config.relay) {
    // First-time pair: resolve a relay URL, register, write config, ask the
    // running daemon to swap its RelayClient in place, then poll for
    // readiness before issuing the QR.
    const url = await resolveRelayUrl({
      relayUrl: argv.relayUrl,
      usePublicRelay: argv.usePublicRelay,
    });
    if (!url) {
      printNoRelayHelp();
      process.exitCode = 1;
      return;
    }

    let releaseLock: (() => Promise<void>) | null = null;
    try {
      releaseLock = await acquirePairLock();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }

    try {
      console.log(`Registering this device with the relay at ${url}...`);
      const relay = await registerWithRelay(url);
      config.relay = { ...(config.relay ?? {}), ...relay };
      await saveConfig(config, configPath);

      console.log('Telling daemon to reconnect to the new relay...');
      try {
        await triggerRelayReconnect();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Cannot connect') || msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
          console.error('Daemon is not running. Run "loopsy start" then re-run this command.');
        } else {
          console.error(msg);
        }
        process.exitCode = 1;
        return;
      }

      // Re-load so we have the freshly-written relay block.
      ({ config } = await loadConfig());
      console.log('Relay link is up. Issuing pair token...');
    } finally {
      if (releaseLock) await releaseLock();
    }
  }

  if (!config.relay) {
    // Should be unreachable after the block above, but keep as a defensive guard.
    printNoRelayHelp();
    process.exitCode = 1;
    return;
  }
  // 30-day ceiling here mirrors the relay's hard cap. The relay then
  // applies its own (smaller) PAIR_TOKEN_MAX_TTL_SEC env-config on top,
  // so self-hosters are still bounded by their own deployment's policy.
  const ttl = Math.max(60, Math.min(argv.ttl ?? 300, 30 * 24 * 60 * 60));
  const url = `${config.relay.url}/pair/issue?device_id=${encodeURIComponent(config.relay.deviceId)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.relay.deviceSecret}`,
      'content-type': 'application/json',
    },
    // multi-use: only set when --multi-use is passed. App Store review
    // demos use this so the reviewer can retry pairing without burning
    // the URL on the first attempt. Single-use is the default.
    body: JSON.stringify({ ttl_seconds: ttl, ...(argv.multiUse ? { multi: true } : {}) }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Pair token request failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as PairTokenResponse;

  const expiresIn = Math.max(0, data.expires_at - Math.floor(Date.now() / 1000));
  // The web client (served at /app) reads the pair URL from the page's hash.
  // QR encodes a normal HTTPS URL so any phone camera/QR app can open it in
  // the browser without needing a custom URL-scheme handler installed.
  const innerPair = `loopsy://pair?u=${encodeURIComponent(config.relay.url)}&t=${encodeURIComponent(data.token)}`;
  const webUrl = `${config.relay.url}/app#${encodeURIComponent(innerPair)}`;
  console.log('');
  if (data.sas) {
    // CSO #14: SAS displayed PROMINENTLY so the user reads it from the laptop
    // and types it on the phone. Defends against the redeem-race where a
    // leaked QR alone (screenshot, OCR) would otherwise let an attacker pair.
    console.log(`  ┌─────────────────────────────────────────┐`);
    console.log(`  │  Verification code:   \x1b[1m${data.sas}\x1b[0m              │`);
    console.log(`  │  Enter this on your phone after scan.   │`);
    console.log(`  └─────────────────────────────────────────┘`);
    console.log('');
  }
  console.log('Scan this QR with your phone camera to pair (opens in browser):');
  console.log('');
  qrcode.generate(webUrl, { small: true }, (q: string) => console.log(q));
  console.log('');
  console.log('Or open this link on your phone:');
  console.log(`  ${webUrl}`);
  console.log('');
  const useLabel = argv.multiUse ? 'Multi-use (demo).' : 'Single use.';
  console.log(`Token expires in ${expiresIn}s. ${useLabel}`);
  // Optional: write a PNG QR to disk for App Store review attachments etc.
  if (argv.qrPng) {
    const QRCode = (await import('qrcode')).default;
    await QRCode.toFile(argv.qrPng, webUrl, { width: 512, margin: 2 });
    console.log(`QR PNG saved to: ${argv.qrPng}`);
  }
}

/** CSO #8: list phones currently paired to this device. */
export async function phoneListCommand(): Promise<void> {
  const { config } = await loadConfig();
  if (!config.relay) {
    console.error('No relay configured. Run "loopsy relay configure <url>" first.');
    process.exitCode = 1;
    return;
  }
  const url = `${config.relay.url}/device/${encodeURIComponent(config.relay.deviceId)}/phones`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${config.relay.deviceSecret}` },
  });
  if (!res.ok) {
    console.error(`Failed: ${res.status} ${await res.text().catch(() => '')}`);
    process.exitCode = 1;
    return;
  }
  const data = (await res.json()) as PhonesResponse;
  if (data.phones.length === 0) {
    console.log('No phones paired.');
    return;
  }
  console.log('');
  console.log('Phones paired with this device:');
  for (const p of data.phones) {
    const date = new Date(p.paired_at).toISOString().slice(0, 19).replace('T', ' ');
    console.log(`  ${p.phone_id}  paired ${date}  ${p.label ?? ''}`);
  }
  console.log('');
  console.log('Revoke with: loopsy phone revoke <phone_id>');
}

/** CSO #8: revoke a paired phone. */
export async function phoneRevokeCommand(argv: { phoneId: string }): Promise<void> {
  const { config } = await loadConfig();
  if (!config.relay) {
    console.error('No relay configured.');
    process.exitCode = 1;
    return;
  }
  const url = `${config.relay.url}/device/${encodeURIComponent(config.relay.deviceId)}/phones/${encodeURIComponent(argv.phoneId)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${config.relay.deviceSecret}` },
  });
  if (!res.ok && res.status !== 204) {
    console.error(`Failed: ${res.status} ${await res.text().catch(() => '')}`);
    process.exitCode = 1;
    return;
  }
  // Also drop the local auto-approve token for this phone — otherwise a
  // stolen-then-revoked phone would still hold a valid sudo-equivalent.
  // Inline the file-edit instead of importing from daemon to keep the CLI
  // free of daemon-runtime deps.
  try {
    const { promises: fsp } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const path = join(homedir(), '.loopsy', 'auto-approve.json');
    const raw = await fsp.readFile(path, 'utf8').catch(() => '');
    if (raw) {
      const store = JSON.parse(raw) as Record<string, unknown>;
      if (argv.phoneId in store) {
        delete store[argv.phoneId];
        await fsp.writeFile(path, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
      }
    }
  } catch { /* best-effort; server-side revoke already succeeded */ }
  console.log(`Revoked phone ${argv.phoneId}. Any active session WS for that phone is closed.`);
}
