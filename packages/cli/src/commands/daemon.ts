import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { CONFIG_DIR } from '@loopsy/protocol';
import { daemonRequest } from '../utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PID_FILE = join(homedir(), CONFIG_DIR, 'daemon.pid');

export async function startCommand() {
  // Check if already running
  try {
    const pid = parseInt(await readFile(PID_FILE, 'utf-8'), 10);
    process.kill(pid, 0); // Check if process exists
    console.log(`Daemon already running (PID ${pid})`);
    return;
  } catch {
    // Not running, start it
  }

  // Find the daemon entry point (cli/dist/commands/ -> daemon/dist/main.js)
  const daemonPath = join(__dirname, '..', '..', '..', 'daemon', 'dist', 'main.js');

  const child = spawn('node', [daemonPath], {
    detached: true,
    stdio: 'ignore',
  });

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

export async function statusCommand() {
  try {
    const result = await daemonRequest('/status');
    console.log(JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.log('Daemon is not running or unreachable');
    console.log(`Error: ${err.message}`);
  }
}
