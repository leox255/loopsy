import { spawn, execSync } from 'node:child_process';
import { readFile, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { CONFIG_DIR } from '@loopsy/protocol';
import { daemonRequest } from '../utils.js';
import { daemonMainPath } from '../package-root.js';

const LAUNCHD_PLIST = join(homedir(), 'Library', 'LaunchAgents', 'com.loopsy.daemon.plist');
const LAUNCHD_LABEL = 'com.loopsy.daemon';

/**
 * Check whether the daemon is managed by launchd on macOS. If so, manual
 * `process.kill` is futile — launchd's KeepAlive=true respawns it within
 * seconds — so stop/restart must delegate via `launchctl`.
 */
async function isLaunchdManaged(): Promise<boolean> {
  if (platform() !== 'darwin') return false;
  try {
    await access(LAUNCHD_PLIST);
    return true;
  } catch {
    return false;
  }
}

function launchctlUid(): string {
  return String(process.getuid!());
}

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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPidFile(): Promise<number | null> {
  try {
    const pid = parseInt(await readFile(PID_FILE, 'utf-8'), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Wait until pid is no longer alive. Escalates to SIGKILL if SIGTERM doesn't
 * land in `graceMs`. Returns true if dead, false if we gave up.
 */
async function waitForDeath(pid: number, graceMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < graceMs) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  // SIGTERM didn't take. Force.
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 200));
  return !isProcessAlive(pid);
}

export async function startCommand(argv?: { lan?: boolean }) {
  // Reject if a daemon is already running. Checks both the recorded PID and
  // the HTTP port so an orphan daemon (PID file stale or absent) is detected
  // before we EADDRINUSE on spawn.
  const recordedPid = await readPidFile();
  if (recordedPid && isProcessAlive(recordedPid)) {
    console.log(`Daemon already running (PID ${recordedPid})`);
    return;
  }
  try {
    await daemonRequest('/health');
    console.log('A daemon is already responding on the local port, but its PID file is missing or stale.');
    console.log('Run `loopsy stop` first (it will clean up by port if no PID is recorded), then `loopsy start`.');
    return;
  } catch {
    // Port not in use — good to start.
  }

  // If launchd is managing this daemon, hand off to it so the user gets the
  // KeepAlive=true behavior they registered. Manual `spawn` from here would
  // race the launchd-spawned process on the port (whichever loses crashes
  // with EADDRINUSE) and confuse subsequent restart attempts.
  if (await isLaunchdManaged()) {
    try {
      execSync(`launchctl kickstart gui/${launchctlUid()}/${LAUNCHD_LABEL}`, { stdio: 'ignore' });
    } catch {
      try {
        execSync(`launchctl bootstrap gui/${launchctlUid()} ${LAUNCHD_PLIST}`, { stdio: 'ignore' });
      } catch {}
    }
    for (let i = 0; i < 50; i++) {
      const pid = await readPidFile();
      if (pid && isProcessAlive(pid)) {
        console.log(`Loopsy daemon started by launchd (PID ${pid})`);
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log('Loopsy daemon launchd-spawned — could not confirm via PID file within 5s. Run `loopsy status` to check.');
    return;
  }

  const child = spawnDaemon(daemonMainPath(), { lan: argv?.lan });
  if (!child.pid) {
    console.error('Failed to start daemon');
    return;
  }
  child.unref();
  // The daemon writes its own PID file on startup (we no longer trust
  // spawn().pid because `caffeinate` on macOS makes that the wrapper PID,
  // not the long-lived node process). Wait briefly for it to appear.
  for (let i = 0; i < 30; i++) {
    const pid = await readPidFile();
    if (pid && isProcessAlive(pid)) {
      console.log(`Loopsy daemon started (PID ${pid})`);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log('Loopsy daemon spawned — could not confirm via PID file within 3s. Run `loopsy status` to check.');
}

export async function stopCommand() {
  // launchd takeover: if the service is registered, `kill <pid>` is a no-op —
  // KeepAlive=true respawns it within ~1s. We must `launchctl bootout` to
  // stop it cleanly. (Reload via `launchctl bootstrap` later restarts it.)
  if (await isLaunchdManaged()) {
    try {
      execSync(`launchctl bootout gui/${launchctlUid()}/${LAUNCHD_LABEL}`, { stdio: 'ignore' });
    } catch { /* already booted out is fine */ }
    // Wait until the daemon is actually gone — launchctl is async.
    for (let i = 0; i < 50; i++) {
      try { await daemonRequest('/health'); } catch { break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    try { await unlink(PID_FILE); } catch { /* daemon's own SIGTERM handler usually does this */ }
    console.log('Daemon stopped (launchd service booted out). Re-enable with `loopsy start` or `loopsy enable`.');
    return;
  }

  const pidFromFile = await readPidFile();
  let pidsToKill: number[] = [];

  if (pidFromFile && isProcessAlive(pidFromFile)) {
    pidsToKill.push(pidFromFile);
  } else {
    // PID file missing or stale. Probe HTTP — if a daemon is responding, look
    // it up by port. This recovers from a previous `loopsy start` that saved
    // the wrong PID (the macOS caffeinate parent) and left the node child
    // orphaned.
    try {
      await daemonRequest('/health');
      const orphans = await findOrphanDaemonPids();
      pidsToKill = orphans;
    } catch {
      // Nothing responding.
    }
  }

  if (pidsToKill.length === 0) {
    console.log('Daemon is not running');
    try { await unlink(PID_FILE); } catch { /* ignore */ }
    return;
  }

  for (const pid of pidsToKill) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  const allDead = (await Promise.all(pidsToKill.map((p) => waitForDeath(p)))).every(Boolean);
  try { await unlink(PID_FILE); } catch { /* daemon may have cleaned up first */ }

  if (allDead) {
    console.log(`Daemon stopped (${pidsToKill.length === 1 ? `PID ${pidsToKill[0]}` : `PIDs ${pidsToKill.join(', ')}`})`);
  } else {
    console.error(`Daemon may not have stopped cleanly. Surviving PIDs: ${pidsToKill.filter(isProcessAlive).join(', ')}`);
  }
}

/**
 * Locate orphan loopsy daemon processes by scanning `ps`. Used when the PID
 * file is gone but a daemon is still bound to the port (the failure mode the
 * old restart logic created).
 */
async function findOrphanDaemonPids(): Promise<number[]> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile('ps', ['-Ao', 'pid,command'], (err, stdout) => {
      if (err) return resolve([]);
      const pids: number[] = [];
      for (const line of stdout.split('\n')) {
        if (/packages\/daemon\/dist\/main\.js/.test(line) && !/grep/.test(line)) {
          const m = line.match(/^\s*(\d+)/);
          if (m) pids.push(parseInt(m[1], 10));
        }
      }
      resolve(pids);
    });
  });
}

export async function restartCommand(argv?: { lan?: boolean }) {
  // When launchd manages the daemon, `kickstart -k` is the cleanest restart
  // primitive: kill + respawn in one atomic action under the same job.
  if (await isLaunchdManaged()) {
    try {
      execSync(`launchctl kickstart -k gui/${launchctlUid()}/${LAUNCHD_LABEL}`, { stdio: 'ignore' });
    } catch {
      // Job not loaded — bootstrap it.
      try {
        execSync(`launchctl bootstrap gui/${launchctlUid()} ${LAUNCHD_PLIST}`, { stdio: 'ignore' });
      } catch (err) {
        console.error('Failed to restart via launchd:', (err as Error).message);
        return;
      }
    }
    for (let i = 0; i < 50; i++) {
      const pid = await readPidFile();
      if (pid && isProcessAlive(pid)) {
        // Confirm it's actually serving — kickstart returns before the daemon
        // has bound the listener.
        try { await daemonRequest('/health'); console.log(`Loopsy daemon restarted by launchd (PID ${pid})`); return; }
        catch { /* still coming up */ }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log('Loopsy daemon kickstarted — could not confirm via PID + /health within 5s. Run `loopsy status` to check.');
    return;
  }

  await stopCommand();
  // Brief pause to let the OS release the listening port. macOS sometimes
  // holds it in TIME_WAIT briefly even after the listener exits.
  await new Promise((r) => setTimeout(r, 500));
  await startCommand(argv);
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
