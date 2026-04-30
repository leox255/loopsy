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

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import qrcode from 'qrcode-terminal';
import { CONFIG_DIR, CONFIG_FILE } from '@loopsy/protocol';
import type { LoopsyConfig, RelayConfig } from '@loopsy/protocol';

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

export async function relayConfigureCommand(argv: { url: string }): Promise<void> {
  const url = argv.url.replace(/\/$/, '');
  console.log(`Registering this device with the relay at ${url}...`);

  const res = await fetch(`${url}/device/register`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Relay rejected register: ${res.status} ${body}`);
  }
  const data = (await res.json()) as RegisterResponse;

  let configEntry: { config: LoopsyConfig; path: string };
  try {
    configEntry = await loadConfig();
  } catch {
    console.error('No config found at ~/.loopsy/config.yaml — run "loopsy init" first.');
    process.exitCode = 1;
    return;
  }
  const { config, path } = configEntry;
  const relay: RelayConfig = {
    url: data.relay_url,
    deviceId: data.device_id,
    deviceSecret: data.device_secret,
  };
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

export async function mobilePairCommand(argv: { ttl?: number }): Promise<void> {
  const { config } = await loadConfig();
  if (!config.relay) {
    console.error('No relay configured. Run "loopsy relay configure <url>" first.');
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
    body: JSON.stringify({ ttl_seconds: ttl }),
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
  console.log(`Token expires in ${expiresIn}s. Single use.`);
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
