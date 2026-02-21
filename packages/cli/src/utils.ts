import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_PORT, CONFIG_DIR, CONFIG_FILE } from '@loopsy/protocol';

export async function loadApiKey(): Promise<string> {
  try {
    const configPath = join(homedir(), CONFIG_DIR, CONFIG_FILE);
    const raw = await readFile(configPath, 'utf-8');
    const config = parseYaml(raw) as any;
    return config?.auth?.apiKey ?? '';
  } catch {
    return '';
  }
}

export function parsePeerAddress(peer: string): { address: string; port: number } {
  const parts = peer.split(':');
  return {
    address: parts[0],
    port: parts.length > 1 ? parseInt(parts[1], 10) : DEFAULT_PORT,
  };
}

export async function daemonRequest(path: string, opts: RequestInit = {}): Promise<any> {
  const apiKey = await loadApiKey();
  const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/api/v1${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as any;
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json();
}
