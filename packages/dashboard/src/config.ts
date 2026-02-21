import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_PORT } from '@loopsy/protocol';

export interface DashboardConfig {
  apiKey: string;
  mainPort: number;
  allowedKeys: Record<string, string>;
  hostname?: string;
}

export async function loadDashboardConfig(): Promise<DashboardConfig> {
  const configPath = join(homedir(), CONFIG_DIR, CONFIG_FILE);
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed = parseYaml(raw) as any;
    return {
      apiKey: parsed?.auth?.apiKey ?? '',
      mainPort: parsed?.server?.port ?? DEFAULT_PORT,
      allowedKeys: parsed?.auth?.allowedKeys ?? {},
      hostname: parsed?.server?.hostname,
    };
  } catch {
    return { apiKey: '', mainPort: DEFAULT_PORT, allowedKeys: {} };
  }
}
