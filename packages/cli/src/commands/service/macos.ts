import { writeFile, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { daemonMainPath } from '../../package-root.js';

const PLIST_DIR = join(homedir(), 'Library', 'LaunchAgents');
const PLIST_LABEL = 'com.loopsy.daemon';
const PLIST_PATH = join(PLIST_DIR, `${PLIST_LABEL}.plist`);

function buildPlist(): string {
  const nodePath = process.execPath;
  const daemonPath = daemonMainPath();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${daemonPath}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${join(homedir(), '.loopsy', 'logs', 'daemon.stdout.log')}</string>
    <key>StandardErrorPath</key>
    <string>${join(homedir(), '.loopsy', 'logs', 'daemon.stderr.log')}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${process.env.PATH}</string>
    </dict>
</dict>
</plist>`;
}

export async function enableMacos(): Promise<void> {
  const plist = buildPlist();
  await writeFile(PLIST_PATH, plist);
  console.log(`Wrote ${PLIST_PATH}`);

  // Unload first in case it's already loaded (ignore errors)
  try {
    execSync(`launchctl bootout gui/${process.getuid!()} ${PLIST_PATH}`, { stdio: 'ignore' });
  } catch {}

  execSync(`launchctl bootstrap gui/${process.getuid!()} ${PLIST_PATH}`);
  console.log('Loopsy daemon registered with launchd');
  console.log('The daemon will start automatically on login');
}

export async function disableMacos(): Promise<void> {
  try {
    execSync(`launchctl bootout gui/${process.getuid!()} ${PLIST_PATH}`, { stdio: 'ignore' });
  } catch {}

  try {
    await unlink(PLIST_PATH);
  } catch {}

  console.log('Loopsy daemon unregistered from launchd');
}

export async function statusMacos(): Promise<{ enabled: boolean; running: boolean }> {
  let enabled = false;
  let running = false;

  try {
    await readFile(PLIST_PATH);
    enabled = true;
  } catch {}

  if (enabled) {
    try {
      const output = execSync(`launchctl print gui/${process.getuid!()}/${PLIST_LABEL}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      running = output.includes('state = running');
    } catch {}
  }

  return { enabled, running };
}
