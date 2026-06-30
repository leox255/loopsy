import { platform } from 'node:os';
import { execFile } from 'node:child_process';

/**
 * Find the daemon by the TCP port it listens on, cross-platform.
 *
 * The daemon's identity is "the process bound to PORT" — far more reliable than
 * matching node command lines, which differ between the monorepo dev layout
 * (`packages/daemon/dist/main.js`) and a flat npm install (`dist/daemon/main.js`),
 * and `ps` doesn't exist on Windows at all. The previous orphan finder only
 * worked on macOS, so `loopsy stop` could never reclaim an orphaned daemon on
 * Windows (and a prior failed stop deletes the PID file, manufacturing exactly
 * such an orphan — see stopCommand).
 */

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(err ? '' : stdout ?? '');
    });
  });
}

/**
 * Parse `netstat -ano -p TCP` output for PIDs whose LOCAL address is on `port`.
 *
 * Matches the local-address column ending in `:port` rather than the connection
 * state, so it is locale-independent (Windows localizes "LISTENING"). The
 * daemon's listener and any server-side ESTABLISHED sockets all share its PID,
 * so this reliably yields the daemon PID(s). A client dialing out to `:port`
 * has the port in its *foreign* column, not local, so it is correctly ignored.
 */
export function parsePidsFromNetstat(output: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    if (cols[0].toUpperCase() !== 'TCP') continue;
    if (!cols[1].endsWith(`:${port}`)) continue;
    const pid = Number(cols[cols.length - 1]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** Parse a newline-separated PID list, e.g. from `lsof -t`. */
export function parsePidsFromLsof(output: string): number[] {
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** Parse `ss -ltnp` output, pulling PIDs out of `users:(("node",pid=1234,...))`. */
export function parsePidsFromSs(output: string): number[] {
  const pids = new Set<number>();
  for (const m of output.matchAll(/pid=(\d+)/g)) {
    const pid = Number(m[1]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

export async function findDaemonPidsByPort(port: number): Promise<number[]> {
  if (platform() === 'win32') {
    return parsePidsFromNetstat(await run('netstat', ['-ano', '-p', 'TCP']), port);
  }
  // macOS + most Linux ship lsof. Fall back to `ss` (iproute2) for Linux boxes
  // that don't have lsof installed.
  const viaLsof = parsePidsFromLsof(
    await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']),
  );
  if (viaLsof.length) return viaLsof;
  return parsePidsFromSs(await run('ss', ['-ltnpH', `sport = :${port}`]));
}
