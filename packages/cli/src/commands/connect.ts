import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_PORT } from '@loopsy/protocol';

const CONFIG_PATH = join(homedir(), CONFIG_DIR, CONFIG_FILE);

function getLanAddresses(): string[] {
  const nets = networkInterfaces();
  const addresses: string[] = [];
  for (const ifaces of Object.values(nets)) {
    if (!ifaces) continue;
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

async function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

export async function connectCommand() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    // Load config
    let config: any;
    try {
      const raw = await readFile(CONFIG_PATH, 'utf-8');
      config = parseYaml(raw);
    } catch {
      console.log('Config not found. Run "loopsy init" first.');
      return;
    }

    const myKey = config.auth?.apiKey ?? 'unknown';
    const myAddresses = getLanAddresses();

    // Step 1: Show this machine's info
    console.log('');
    console.log('=== This Machine ===');
    console.log(`IP address(es): ${myAddresses.join(', ') || 'unknown'}`);
    console.log(`Port: ${config.server?.port ?? DEFAULT_PORT}`);
    console.log(`API Key: ${myKey}`);
    console.log('');
    console.log('Share the above IP and API key with the other machine.');
    console.log('');

    // Step 2: Get peer info
    const peerIp = await prompt(rl, 'Enter the peer\'s IP address: ');
    if (!peerIp) {
      console.log('No IP provided, aborting.');
      return;
    }

    const peerPortStr = await prompt(rl, `Enter the peer's port (default ${DEFAULT_PORT}): `);
    const peerPort = peerPortStr ? parseInt(peerPortStr, 10) : DEFAULT_PORT;

    const peerKey = await prompt(rl, 'Enter the peer\'s API key: ');
    if (!peerKey) {
      console.log('No API key provided, aborting.');
      return;
    }

    const peerName = await prompt(rl, 'Give this peer a name (e.g. windows-pc, macbook): ');
    const name = peerName || `peer-${peerIp}`;

    // Step 3: Update config
    config.auth = config.auth ?? {};
    config.auth.allowedKeys = config.auth.allowedKeys ?? {};
    config.auth.allowedKeys[name] = peerKey;

    config.discovery = config.discovery ?? {};
    config.discovery.manualPeers = config.discovery.manualPeers ?? [];

    // Avoid duplicate manual peers
    const exists = config.discovery.manualPeers.some(
      (p: any) => p.address === peerIp && p.port === peerPort,
    );
    if (!exists) {
      config.discovery.manualPeers.push({ address: peerIp, port: peerPort });
    }

    await writeFile(CONFIG_PATH, toYaml(config));
    console.log('');
    console.log(`Peer "${name}" added to config.`);

    // Step 4: Test connection
    console.log(`Testing connection to ${peerIp}:${peerPort}...`);
    try {
      const res = await fetch(`http://${peerIp}:${peerPort}/api/v1/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json() as any;
        console.log(`Connected! Peer node: ${data.nodeId}`);
      } else {
        console.log(`Peer responded with HTTP ${res.status}. It may not be running yet.`);
      }
    } catch {
      console.log('Could not reach peer. Make sure:');
      console.log('  - The peer has run "loopsy init" and "loopsy start"');
      console.log('  - Both machines are on the same network');
      console.log(`  - Port ${peerPort} is not blocked by a firewall`);
      console.log('');
      console.log('The config has been saved. You can retry once the peer is running.');
    }

    // Step 5: Usage examples
    console.log('');
    console.log('=== Ready! ===');
    console.log('');
    console.log('Make sure the daemon is running:');
    console.log('  loopsy start');
    console.log('');
    console.log('Try these commands:');
    console.log(`  loopsy exec ${peerIp} -k ${peerKey.slice(0, 8)}... echo hello`);
    console.log(`  loopsy context set my_message "Hello from this machine"`);
    console.log(`  loopsy peers`);
    console.log('');
    console.log('The other machine should also run "loopsy connect" and enter this');
    console.log('machine\'s IP and API key so both sides can communicate.');
  } finally {
    rl.close();
  }
}
