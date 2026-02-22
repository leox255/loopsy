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

const startingNames = new Set<string>();

async function loadParentConfig(): Promise<any> {
  const raw = await readFile(join(LOOPSY_DIR, CONFIG_FILE), 'utf-8');
  return parseYaml(raw);
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(() => resolve(true)); });
    server.listen(port, '0.0.0.0');
  });
}

export interface SessionInfo {
  name: string;
  port: number;
  hostname: string;
  pid: number | null;
  status: 'running' | 'stopped';
  dataDir: string;
}

export async function listSessions(): Promise<{ main: SessionInfo | null; sessions: SessionInfo[] }> {
  // Main daemon — check PID file first, fall back to port health check
  let main: SessionInfo | null = null;
  try {
    const parentConfig = await loadParentConfig();
    const port = parentConfig.server?.port ?? DEFAULT_PORT;
    const hostname = parentConfig.server?.hostname || osHostname();
    let pid: number | null = null;
    let status: 'running' | 'stopped' = 'stopped';

    // Try PID file
    try {
      const pidRaw = await readFile(join(LOOPSY_DIR, 'daemon.pid'), 'utf-8');
      const pidNum = parseInt(pidRaw, 10);
      process.kill(pidNum, 0);
      pid = pidNum;
      status = 'running';
    } catch {}

    // PID check failed — try HTTP health check (handles stale/missing PID file)
    if (status === 'stopped') {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/status`, {
          headers: { Authorization: `Bearer ${parentConfig.auth?.apiKey}` },
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) status = 'running';
      } catch {}
    }

    main = { name: 'main', port, hostname, pid, status, dataDir: LOOPSY_DIR };
  } catch {}

  // Sessions
  const sessions: SessionInfo[] = [];
  try {
    const dirs = await readdir(SESSIONS_PATH);
    for (const name of dirs.sort()) {
      const sessionDir = join(SESSIONS_PATH, name);
      let port = 0;
      let hostname = name;
      try {
        const configRaw = await readFile(join(sessionDir, CONFIG_FILE), 'utf-8');
        const config = parseYaml(configRaw) as any;
        port = config.server?.port ?? 0;
        hostname = config.server?.hostname ?? name;
      } catch {}

      let pid: number | null = null;
      let status: 'running' | 'stopped' = 'stopped';
      try {
        const pidRaw = await readFile(join(sessionDir, 'daemon.pid'), 'utf-8');
        const pidNum = parseInt(pidRaw, 10);
        process.kill(pidNum, 0);
        pid = pidNum;
        status = 'running';
      } catch {}

      // PID check failed — try HTTP health check if port is known
      if (status === 'stopped' && port > 0) {
        try {
          const cfg = await loadParentConfig();
          const res = await fetch(`http://127.0.0.1:${port}/api/v1/status`, {
            headers: { Authorization: `Bearer ${cfg.auth?.apiKey}` },
            signal: AbortSignal.timeout(2000),
          });
          if (res.ok) status = 'running';
        } catch {}
      }

      sessions.push({ name, port, hostname, pid, status, dataDir: sessionDir });
    }
  } catch {}

  return { main, sessions };
}

export async function startSession(name: string): Promise<SessionInfo> {
  if (startingNames.has(name)) throw new Error(`Session "${name}" is already being started`);
  startingNames.add(name);

  try {
    const sessionDir = join(SESSIONS_PATH, name);
    const pidFile = join(sessionDir, 'daemon.pid');

    // Check if already running
    try {
      const pid = parseInt(await readFile(pidFile, 'utf-8'), 10);
      process.kill(pid, 0);
      throw new Error(`Session "${name}" already running (PID ${pid})`);
    } catch (e: any) {
      if (e.message.includes('already running')) throw e;
    }

    const parentConfig = await loadParentConfig();
    const machineHostname = parentConfig.server?.hostname || osHostname();

    // Find free port
    const { sessions } = await listSessions();
    const usedPorts = new Set(sessions.filter(s => s.status === 'running').map(s => s.port));
    let port = DEFAULT_PORT + 1;
    while (usedPorts.has(port) || !(await isPortFree(port))) {
      port++;
      if (port > DEFAULT_PORT + 100) throw new Error('No free port found');
    }

    // Build manual peers with hostnames
    const manualPeers = [
      { address: '127.0.0.1', port: parentConfig.server?.port ?? DEFAULT_PORT, hostname: machineHostname },
      ...sessions.filter(s => s.status === 'running').map(s => ({ address: '127.0.0.1', port: s.port, hostname: s.hostname })),
      ...(parentConfig.discovery?.manualPeers ?? []),
    ];

    const sessionConfig = {
      server: { port, host: '0.0.0.0', hostname: `${machineHostname}-${name}` },
      auth: { apiKey: parentConfig.auth.apiKey, allowedKeys: { ...parentConfig.auth.allowedKeys } },
      execution: parentConfig.execution,
      transfer: parentConfig.transfer,
      rateLimits: parentConfig.rateLimits,
      discovery: { enabled: false, manualPeers },
      logging: { level: 'info' },
    };

    await mkdir(join(sessionDir, 'logs'), { recursive: true });
    await writeFile(join(sessionDir, CONFIG_FILE), toYaml(sessionConfig));

    const daemonPath = join(__dirname, '..', '..', 'daemon', 'dist', 'main.js');
    const child = spawn('node', [daemonPath, '--data-dir', sessionDir], {
      detached: true,
      stdio: 'ignore',
    });

    if (!child.pid) throw new Error(`Failed to start session "${name}"`);

    await writeFile(pidFile, String(child.pid));
    child.unref();

    // Notify siblings
    const apiKey = parentConfig.auth.apiKey;
    for (const sibling of [...sessions.filter(s => s.status === 'running'), { port: parentConfig.server?.port ?? DEFAULT_PORT }]) {
      try {
        await fetch(`http://127.0.0.1:${sibling.port}/api/v1/peers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ address: '127.0.0.1', port, hostname: sessionConfig.server.hostname }),
        });
      } catch {}
    }

    return {
      name,
      port,
      hostname: sessionConfig.server.hostname,
      pid: child.pid,
      status: 'running',
      dataDir: sessionDir,
    };
  } finally {
    startingNames.delete(name);
  }
}

export async function stopSession(name: string): Promise<void> {
  const pidFile = join(SESSIONS_PATH, name, 'daemon.pid');
  let pid: number;
  try {
    pid = parseInt(await readFile(pidFile, 'utf-8'), 10);
  } catch {
    // PID file missing — already stopped
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e: any) {
    if (e.code !== 'ESRCH') throw e;
    // Process already dead — clean up stale PID file
  }
  try { await unlink(pidFile); } catch {}
}

export async function restartSession(name: string): Promise<SessionInfo> {
  await stopSession(name);
  // Wait for port release
  await new Promise(r => setTimeout(r, 1000));
  return startSession(name);
}

export async function stopAllSessions(): Promise<number> {
  const { sessions } = await listSessions();
  let stopped = 0;
  for (const s of sessions) {
    if (s.status === 'running' && s.pid) {
      try {
        process.kill(s.pid, 'SIGTERM');
        await unlink(join(SESSIONS_PATH, s.name, 'daemon.pid'));
        stopped++;
      } catch {}
    }
  }
  return stopped;
}
