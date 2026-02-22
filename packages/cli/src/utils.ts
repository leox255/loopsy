import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_PORT, CONFIG_DIR, CONFIG_FILE } from '@loopsy/protocol';

export async function loadCliConfig(dataDir?: string): Promise<{ apiKey: string; port: number }> {
  try {
    const dir = dataDir ?? join(homedir(), CONFIG_DIR);
    const configPath = join(dir, CONFIG_FILE);
    const raw = await readFile(configPath, 'utf-8');
    const config = parseYaml(raw) as any;
    return {
      apiKey: config?.auth?.apiKey ?? '',
      port: config?.server?.port ?? DEFAULT_PORT,
    };
  } catch {
    return { apiKey: '', port: DEFAULT_PORT };
  }
}

export async function loadApiKey(): Promise<string> {
  const { apiKey } = await loadCliConfig();
  return apiKey;
}

export function parsePeerAddress(peer: string): { address: string; port: number } {
  const parts = peer.split(':');
  return {
    address: parts[0],
    port: parts.length > 1 ? parseInt(parts[1], 10) : DEFAULT_PORT,
  };
}

export async function daemonRequest(path: string, opts: RequestInit = {}, dataDir?: string): Promise<any> {
  const { apiKey, port } = await loadCliConfig(dataDir);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (opts.body) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    ...opts,
    headers: {
      ...headers,
      ...(opts.headers as Record<string, string>),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as any;
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json();
}
