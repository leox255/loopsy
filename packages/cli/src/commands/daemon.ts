import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { CONFIG_DIR } from '@loopsy/protocol';
import { daemonRequest } from '../utils.js';
import { daemonMainPath } from '../package-root.js';

/** Spawn daemon, wrapping with caffeinate on macOS to prevent idle/system sleep */
function spawnDaemon(daemonPath: string, opts: { lan?: boolean } = {}) {
  // Pass LAN intent through an env var the daemon's config loader picks
  // up. Default config now binds 127.0.0.1; --lan flips to 0.0.0.0 for
  // people who want peer-to-peer over the local network.
  const env = { ...process.env, ...(opts.lan ? { LOOPSY_BIND_LAN: '1' } : {}) };
  if (platform() === 'darwin') {
    return spawn('caffeinate', ['-is', process.execPath, daemonPath], {
      detached: true,
      stdio: 'ignore',
      env,
    });
  }
  return spawn('node', [daemonPath], {
    detached: true,
    stdio: 'ignore',
    env,
  });
}

const PID_FILE = join(homedir(), CONFIG_DIR, 'daemon.pid');

export async function startCommand(argv?: { lan?: boolean }) {
  // Check if already running
  try {
    const pid = parseInt(await readFile(PID_FILE, 'utf-8'), 10);
    process.kill(pid, 0); // Check if process exists
    console.log(`Daemon already running (PID ${pid})`);
    return;
  } catch {
    // Not running, start it
  }

  const daemonPath = daemonMainPath();

  const child = spawnDaemon(daemonPath, { lan: argv?.lan });

  if (child.pid) {
    await writeFile(PID_FILE, String(child.pid));
    child.unref();
    console.log(`Loopsy daemon started (PID ${child.pid})`);
  } else {
    console.error('Failed to start daemon');
  }
}

export async function stopCommand() {
  try {
    const pid = parseInt(await readFile(PID_FILE, 'utf-8'), 10);
    process.kill(pid, 'SIGTERM');
    await unlink(PID_FILE);
    console.log(`Daemon stopped (PID ${pid})`);
  } catch {
    console.log('Daemon is not running');
  }
}

export async function restartCommand(argv?: { lan?: boolean }) {
  // Stop if running
  try {
    const pid = parseInt(await readFile(PID_FILE, 'utf-8'), 10);
    process.kill(pid, 'SIGTERM');
    await unlink(PID_FILE);
    console.log(`Daemon stopped (PID ${pid})`);
    // Brief pause to let the port release
    await new Promise((r) => setTimeout(r, 1000));
  } catch {
    // Not running, that's fine
  }

  // Start
  const daemonPath = daemonMainPath();
  const child = spawnDaemon(daemonPath, { lan: argv?.lan });

  if (child.pid) {
    await writeFile(PID_FILE, String(child.pid));
    child.unref();
    console.log(`Loopsy daemon started (PID ${child.pid})`);
  } else {
    console.error('Failed to start daemon');
  }
}

export async function statusCommand() {
  try {
    const result = await daemonRequest('/status');
    console.log(JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.log('Daemon is not running or unreachable');
    console.log(`Error: ${err.message}`);
  }
}
