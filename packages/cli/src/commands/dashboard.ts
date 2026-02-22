import { exec } from 'node:child_process';
import { platform } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_PORT } from '@loopsy/protocol';

function openBrowser(url: string) {
  const os = platform();
  const cmd =
    os === 'darwin' ? `open "${url}"` :
    os === 'win32' ? `start "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      console.log(`Could not open browser automatically.`);
      console.log(`Open this URL manually: ${url}`);
    }
  });
}

export async function dashboardCommand() {
  // Read daemon port from config
  let port = DEFAULT_PORT;
  try {
    const configPath = join(homedir(), CONFIG_DIR, CONFIG_FILE);
    const raw = await readFile(configPath, 'utf-8');
    const config = parseYaml(raw) as any;
    port = config?.server?.port ?? DEFAULT_PORT;
  } catch {}

  // Check if daemon is running
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error();
  } catch {
    console.log('Daemon is not running. Start it first with: loopsy start');
    return;
  }

  const url = `http://localhost:${port}/dashboard/`;
  console.log(`Opening dashboard at ${url}`);
  openBrowser(url);
}
