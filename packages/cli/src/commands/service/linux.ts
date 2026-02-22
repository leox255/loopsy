import { writeFile, unlink, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { daemonMainPath } from '../../package-root.js';

const SYSTEMD_DIR = join(homedir(), '.config', 'systemd', 'user');
const SERVICE_NAME = 'loopsy';
const SERVICE_PATH = join(SYSTEMD_DIR, `${SERVICE_NAME}.service`);

function buildUnit(): string {
  const nodePath = process.execPath;
  const daemonPath = daemonMainPath();

  return `[Unit]
Description=Loopsy daemon — cross-machine communication for Claude Code
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${daemonPath}
Restart=always
RestartSec=5
Environment=PATH=${process.env.PATH}

[Install]
WantedBy=default.target
`;
}

export async function enableLinux(): Promise<void> {
  await mkdir(SYSTEMD_DIR, { recursive: true });
  await writeFile(SERVICE_PATH, buildUnit());
  console.log(`Wrote ${SERVICE_PATH}`);

  execSync('systemctl --user daemon-reload');
  execSync(`systemctl --user enable ${SERVICE_NAME}`);
  execSync(`systemctl --user start ${SERVICE_NAME}`);
  console.log('Loopsy daemon registered with systemd');

  // Check if linger is enabled
  try {
    const output = execSync(`loginctl show-user $(whoami) -p Linger`, { encoding: 'utf-8' });
    if (output.includes('Linger=no')) {
      console.log('');
      console.log('WARNING: User linger is not enabled. The daemon will stop when you log out.');
      console.log('To keep it running after logout, run:');
      console.log('  sudo loginctl enable-linger $(whoami)');
    }
  } catch {}
}

export async function disableLinux(): Promise<void> {
  try {
    execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'ignore' });
  } catch {}
  try {
    execSync(`systemctl --user disable ${SERVICE_NAME}`, { stdio: 'ignore' });
  } catch {}
  try {
    await unlink(SERVICE_PATH);
  } catch {}
  try {
    execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
  } catch {}

  console.log('Loopsy daemon unregistered from systemd');
}

export async function statusLinux(): Promise<{ enabled: boolean; running: boolean }> {
  let enabled = false;
  let running = false;

  try {
    await readFile(SERVICE_PATH);
    enabled = true;
  } catch {}

  if (enabled) {
    try {
      const output = execSync(`systemctl --user is-active ${SERVICE_NAME}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      running = output.trim() === 'active';
    } catch {}
  }

  return { enabled, running };
}
