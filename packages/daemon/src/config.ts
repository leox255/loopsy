import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { randomBytes } from 'node:crypto';
import type { LoopsyConfig } from '@loopsy/protocol';
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_PORT, MAX_FILE_SIZE, MAX_CONCURRENT_JOBS, DEFAULT_EXEC_TIMEOUT, RATE_LIMITS } from '@loopsy/protocol';

const DEFAULT_DATA_DIR = join(homedir(), CONFIG_DIR);

export function defaultConfig(): LoopsyConfig {
  return {
    server: { port: DEFAULT_PORT, host: '0.0.0.0' },
    auth: {
      apiKey: randomBytes(32).toString('hex'),
      allowedKeys: {},
    },
    execution: {
      denylist: ['rm', 'rmdir', 'format', 'mkfs', 'dd', 'shutdown', 'reboot'],
      maxConcurrent: MAX_CONCURRENT_JOBS,
      defaultTimeout: DEFAULT_EXEC_TIMEOUT,
    },
    transfer: {
      allowedPaths: [homedir()],
      deniedPaths: [join(homedir(), '.ssh'), join(homedir(), '.gnupg')],
      maxFileSize: MAX_FILE_SIZE,
    },
    rateLimits: { ...RATE_LIMITS },
    discovery: { enabled: true, manualPeers: [] },
    logging: { level: 'info' },
  };
}

export async function loadConfig(dataDir?: string): Promise<LoopsyConfig> {
  const dir = dataDir ?? DEFAULT_DATA_DIR;
  const configPath = join(dir, CONFIG_FILE);
  const defaults = defaultConfig();
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed = parseYaml(raw) as Partial<LoopsyConfig>;
    const config = deepMerge(defaults, parsed) as LoopsyConfig;
    config.server.dataDir = dir;
    return config;
  } catch {
    defaults.server.dataDir = dir;
    return defaults;
  }
}

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] ?? {}, source[key]);
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}
