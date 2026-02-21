import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname as osHostname } from 'node:os';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { createServer } from 'node:net';
import { CONFIG_DIR, CONFIG_FILE, SESSIONS_DIR, DEFAULT_PORT } from '@loopsy/protocol';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOOPSY_DIR = join(homedir(), CONFIG_DIR);
const SESSIONS_PATH = join(LOOPSY_DIR, SESSIONS_DIR);

async function loadParentConfig(): Promise<any> {
  const raw = await readFile(join(LOOPSY_DIR, CONFIG_FILE), 'utf-8');
  return parseYaml(raw);
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '0.0.0.0');
  });
}

async function findFreePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error('No free port found in range');
}

async function getRunningSessionPorts(): Promise<Array<{ name: string; port: number }>> {
  const sessions: Array<{ name: string; port: number }> = [];
  try {
    const dirs = await readdir(SESSIONS_PATH);
    for (const name of dirs) {
      try {
        const configRaw = await readFile(join(SESSIONS_PATH, name, CONFIG_FILE), 'utf-8');
        const config = parseYaml(configRaw) as any;
        const pidRaw = await readFile(join(SESSIONS_PATH, name, 'daemon.pid'), 'utf-8');
        const pid = parseInt(pidRaw, 10);
        process.kill(pid, 0); // Check if running
        sessions.push({ name, port: config.server.port });
      } catch {
        // Not running or no config
      }
    }
  } catch {
    // No sessions dir yet
  }
  return sessions;
}

export async function sessionStartCommand(argv: any) {
  const name = argv.name as string;
  const sessionDir = join(SESSIONS_PATH, name);
  const pidFile = join(sessionDir, 'daemon.pid');

  // Check if already running
  try {
    const pid = parseInt(await readFile(pidFile, 'utf-8'), 10);
    process.kill(pid, 0);
    console.log(`Session "${name}" already running (PID ${pid})`);
    return;
  } catch {
    // Not running
  }

  // Load parent config
  const parentConfig = await loadParentConfig();
  const machineHostname = parentConfig.server?.hostname || osHostname();

  // Find a free port
  const runningSessions = await getRunningSessionPorts();
  const usedPorts = new Set(runningSessions.map((s) => s.port));
  let port = DEFAULT_PORT + 1;
  while (usedPorts.has(port) || !(await isPortFree(port))) {
    port++;
    if (port > DEFAULT_PORT + 100) throw new Error('No free port found');
  }

  // Build sibling manual peers (main daemon + other sessions)
  const manualPeers = [
    // Main daemon
    { address: '127.0.0.1', port: parentConfig.server?.port ?? DEFAULT_PORT },
    // Existing sibling sessions
    ...runningSessions.map((s) => ({ address: '127.0.0.1', port: s.port })),
    // Remote peers from parent config
    ...(parentConfig.discovery?.manualPeers ?? []),
  ];

  // Build session config
  const sessionConfig = {
    server: {
      port,
      host: '0.0.0.0',
      hostname: `${machineHostname}-${name}`,
    },
    auth: {
      apiKey: parentConfig.auth.apiKey,
      allowedKeys: { ...parentConfig.auth.allowedKeys },
    },
    execution: parentConfig.execution,
    transfer: parentConfig.transfer,
    rateLimits: parentConfig.rateLimits,
    discovery: {
      enabled: false, // Use manual peers for sessions to avoid mDNS conflicts
      manualPeers: manualPeers,
    },
    logging: { level: 'info' },
  };

  // Write session config
  await mkdir(join(sessionDir, 'logs'), { recursive: true });
  await writeFile(join(sessionDir, CONFIG_FILE), toYaml(sessionConfig));

  // Spawn daemon with --data-dir
  const daemonPath = join(__dirname, '..', '..', '..', 'daemon', 'dist', 'main.js');
  const child = spawn('node', [daemonPath, '--data-dir', sessionDir], {
    detached: true,
    stdio: 'ignore',
  });

  if (child.pid) {
    await writeFile(pidFile, String(child.pid));
    child.unref();
    console.log(`Session "${name}" started`);
    console.log(`  PID:      ${child.pid}`);
    console.log(`  Port:     ${port}`);
    console.log(`  Hostname: ${sessionConfig.server.hostname}`);
    console.log(`  Data dir: ${sessionDir}`);

    // Notify existing sibling sessions about the new peer
    for (const sibling of runningSessions) {
      try {
        await fetch(`http://127.0.0.1:${sibling.port}/api/v1/peers`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${parentConfig.auth.apiKey}`,
          },
          body: JSON.stringify({ address: '127.0.0.1', port }),
        });
      } catch {
        // Sibling might not be responding yet
      }
    }

    // Notify main daemon about the new session
    try {
      await fetch(`http://127.0.0.1:${parentConfig.server?.port ?? DEFAULT_PORT}/api/v1/peers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${parentConfig.auth.apiKey}`,
        },
        body: JSON.stringify({ address: '127.0.0.1', port }),
      });
    } catch {
      // Main daemon might not be running
    }
  } else {
    console.error(`Failed to start session "${name}"`);
  }
}

export async function sessionStartFleetCommand(argv: any) {
  const count = argv.count as number;
  for (let i = 1; i <= count; i++) {
    const name = `worker-${i}`;
    console.log(`\nStarting session ${i}/${count}...`);
    await sessionStartCommand({ name });
  }
  console.log(`\nFleet of ${count} sessions started.`);
}

export async function sessionStopCommand(argv: any) {
  const name = argv.name as string;
  const pidFile = join(SESSIONS_PATH, name, 'daemon.pid');
  try {
    const pid = parseInt(await readFile(pidFile, 'utf-8'), 10);
    process.kill(pid, 'SIGTERM');
    await unlink(pidFile);
    console.log(`Session "${name}" stopped (PID ${pid})`);
  } catch {
    console.log(`Session "${name}" is not running`);
  }
}

export async function sessionStopAllCommand() {
  try {
    const dirs = await readdir(SESSIONS_PATH);
    let stopped = 0;
    for (const name of dirs) {
      const pidFile = join(SESSIONS_PATH, name, 'daemon.pid');
      try {
        const pid = parseInt(await readFile(pidFile, 'utf-8'), 10);
        process.kill(pid, 'SIGTERM');
        await unlink(pidFile);
        console.log(`Stopped session "${name}" (PID ${pid})`);
        stopped++;
      } catch {
        // Not running
      }
    }
    console.log(`\nStopped ${stopped} session(s)`);
  } catch {
    console.log('No sessions found');
  }
}

export async function sessionListCommand() {
  try {
    const dirs = await readdir(SESSIONS_PATH);
    if (dirs.length === 0) {
      console.log('No sessions found');
      return;
    }

    console.log('Sessions:');
    console.log('  NAME            PORT    HOSTNAME                    PID     STATUS');
    console.log('  ' + '-'.repeat(70));

    for (const name of dirs.sort()) {
      let port = '?';
      let hostname = '?';
      let pid = '?';
      let status = 'stopped';

      try {
        const configRaw = await readFile(join(SESSIONS_PATH, name, CONFIG_FILE), 'utf-8');
        const config = parseYaml(configRaw) as any;
        port = String(config.server?.port ?? '?');
        hostname = config.server?.hostname ?? '?';
      } catch {}

      try {
        const pidRaw = await readFile(join(SESSIONS_PATH, name, 'daemon.pid'), 'utf-8');
        const pidNum = parseInt(pidRaw, 10);
        process.kill(pidNum, 0); // Check if running
        pid = String(pidNum);
        status = 'running';
      } catch {}

      console.log(
        `  ${name.padEnd(16)}${port.padEnd(8)}${hostname.padEnd(28)}${pid.padEnd(8)}${status}`
      );
    }
  } catch {
    console.log('No sessions found');
  }
}

export async function sessionStatusCommand(argv: any) {
  const name = argv.name as string;
  const sessionDir = join(SESSIONS_PATH, name);

  try {
    const configRaw = await readFile(join(sessionDir, CONFIG_FILE), 'utf-8');
    const config = parseYaml(configRaw) as any;
    const port = config.server?.port;

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/status`, {
      headers: { Authorization: `Bearer ${config.auth?.apiKey}` },
    });

    if (res.ok) {
      const status = await res.json();
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(`Session "${name}" is not responding (HTTP ${res.status})`);
    }
  } catch (err: any) {
    console.log(`Session "${name}" is not running or unreachable`);
    console.log(`Error: ${err.message}`);
  }
}

export function sessionCommand(argv: any) {
  // Handled by subcommands
}
