import { createECDH, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, hostname as osHostname, networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_PORT } from '@loopsy/protocol';
import { daemonRequest } from '../utils.js';

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * `loopsy pair` — Start a pairing session (Machine A, the one waiting)
 * `loopsy pair <address>` — Connect to Machine A (Machine B, the one initiating)
 */
export async function pairCommand(argv: any) {
  const target = argv.address as string | undefined;

  if (target) {
    await pairAsInitiator(target);
  } else {
    await pairAsWaiter();
  }
}

/** Machine A: start a pairing session and wait for peer to connect */
async function pairAsWaiter() {
  console.log('Starting pairing session...');
  console.log('');

  const result = await daemonRequest('/pair/start', { method: 'POST' });
  const expiresIn = Math.round((result.expiresAt - Date.now()) / 1000);

  // Show local IP addresses for easy pairing
  const localIps = getLocalIps();

  console.log(`Invite code: ${result.inviteCode}`);
  console.log(`Expires in ${expiresIn} seconds`);
  console.log('');
  console.log('On the other machine, run:');
  if (localIps.length > 0) {
    for (const ip of localIps) {
      console.log(`  loopsy pair ${ip}`);
    }
  } else {
    console.log(`  loopsy pair <this-machine-ip>`);
  }
  console.log('');

  // Poll for status changes
  console.log('Waiting for peer to connect...');

  let lastState = 'waiting';
  while (true) {
    await sleep(2000);

    const status = await daemonRequest('/pair/status');
    if (!status.active) {
      console.log('Pairing session ended');
      return;
    }

    if (status.state === 'key_exchanged' && lastState === 'waiting') {
      console.log('');
      console.log(`Peer connected! Verification code: ${status.sas}`);
      console.log('');
      const answer = await prompt('Does the code match on the other machine? (y/n): ');

      if (answer.toLowerCase() === 'y') {
        const confirmResult = await daemonRequest('/pair/confirm', {
          method: 'POST',
          body: JSON.stringify({ confirmed: true }),
        });
        console.log('');
        console.log(confirmResult.message);
        console.log('Restart the daemon to pick up the new peer: loopsy stop && loopsy start');
        return;
      } else {
        await daemonRequest('/pair/confirm', {
          method: 'POST',
          body: JSON.stringify({ confirmed: false }),
        });
        console.log('Pairing cancelled');
        return;
      }
    }

    if (status.state === 'completed') {
      console.log('Pairing completed!');
      return;
    }

    if (status.state === 'expired') {
      console.log('Pairing session expired');
      return;
    }

    lastState = status.state;
  }
}

/** Machine B: connect to Machine A's pairing session */
async function pairAsInitiator(target: string) {
  // Parse target address
  const parts = target.split(':');
  const address = parts[0];
  const port = parts.length > 1 ? parseInt(parts[1], 10) : DEFAULT_PORT;

  console.log(`Connecting to ${address}:${port}...`);

  // Ask for invite code
  const inviteCode = await prompt('Enter invite code: ');
  if (!inviteCode) {
    console.log('Cancelled');
    return;
  }

  // Generate ECDH keypair
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();

  // Load our config to get API key and hostname
  const configPath = join(homedir(), CONFIG_DIR, CONFIG_FILE);
  const configRaw = await readFile(configPath, 'utf-8');
  const config = parseYaml(configRaw) as any;
  const myApiKey = config.auth?.apiKey;
  const myHostname = config.server?.hostname || osHostname();

  if (!myApiKey) {
    console.error('No API key found. Run "loopsy init" first.');
    return;
  }

  // Send our public key and invite code to Machine A
  // Note: pairing endpoints are unauthed (no apiKey required)
  const response = await fetch(`http://${address}:${port}/api/v1/pair/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: ecdh.getPublicKey('base64'),
      inviteCode,
      hostname: myHostname,
      apiKey: myApiKey,
    }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as any;
    console.error(`Pairing failed: ${body.error || `HTTP ${response.status}`}`);
    return;
  }

  const peerInfo = await response.json() as any;

  // Verify SAS
  const peerPubKey = Buffer.from(peerInfo.publicKey, 'base64');
  const sharedSecret = ecdh.computeSecret(peerPubKey);
  const sasHash = createHash('sha256').update(sharedSecret).update('loopsy-sas').digest();
  const localSas = String(sasHash.readUInt32BE() % 10 ** 6).padStart(6, '0');

  console.log('');
  console.log(`Verification code: ${localSas}`);
  console.log('');
  const answer = await prompt('Does this code match on the other machine? (y/n): ');

  if (answer.toLowerCase() !== 'y') {
    // Notify peer to cancel
    try {
      await fetch(`http://${address}:${port}/api/v1/pair/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: false }),
      });
    } catch {}
    console.log('Pairing cancelled');
    return;
  }

  // Confirm pairing on peer
  const confirmResp = await fetch(`http://${address}:${port}/api/v1/pair/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed: true }),
  });

  if (!confirmResp.ok) {
    const errBody = await confirmResp.json().catch(() => ({})) as any;
    console.error(`Pairing confirmation failed: ${errBody.error || `HTTP ${confirmResp.status}`}`);
    console.error('The other machine may have already cancelled the session, or the session expired.');
    return;
  }

  // Save peer info to our config
  await addPeerToConfig(peerInfo.hostname, peerInfo.apiKey, peerInfo.certFingerprint);

  // Also add as a manual peer for discovery
  await addManualPeer(address, port, peerInfo.hostname);

  console.log('');
  console.log(`Paired with ${peerInfo.hostname}!`);
  console.log('Restart the daemon to pick up the new peer: loopsy stop && loopsy start');
}

async function addPeerToConfig(peerHostname: string, peerApiKey: string, certFingerprint?: string) {
  const configPath = join(homedir(), CONFIG_DIR, CONFIG_FILE);
  const raw = await readFile(configPath, 'utf-8');
  const config = parseYaml(raw) as any;

  if (!config.auth) config.auth = {};
  if (!config.auth.allowedKeys) config.auth.allowedKeys = {};
  config.auth.allowedKeys[peerHostname] = peerApiKey;

  if (certFingerprint) {
    if (!config.tls) config.tls = { enabled: false };
    if (!config.tls.pinnedCerts) config.tls.pinnedCerts = {};
    config.tls.pinnedCerts[peerHostname] = certFingerprint;
  }

  await writeFile(configPath, toYaml(config));
}

async function addManualPeer(address: string, port: number, hostname: string) {
  const configPath = join(homedir(), CONFIG_DIR, CONFIG_FILE);
  const raw = await readFile(configPath, 'utf-8');
  const config = parseYaml(raw) as any;

  if (!config.discovery) config.discovery = { enabled: true, manualPeers: [] };
  if (!config.discovery.manualPeers) config.discovery.manualPeers = [];

  // Check if already present
  const exists = config.discovery.manualPeers.some(
    (p: any) => p.address === address && p.port === port,
  );
  if (!exists) {
    config.discovery.manualPeers.push({ address, port, hostname });
    await writeFile(configPath, toYaml(config));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Get non-loopback IPv4 addresses for display */
function getLocalIps(): string[] {
  const ips: string[] = [];
  const interfaces = networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  return ips;
}
