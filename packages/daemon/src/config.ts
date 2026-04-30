import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { randomBytes } from 'node:crypto';
import type { LoopsyConfig } from '@loopsy/protocol';
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_PORT, MAX_FILE_SIZE, MAX_CONCURRENT_JOBS, DEFAULT_EXEC_TIMEOUT, RATE_LIMITS } from '@loopsy/protocol';

const DEFAULT_DATA_DIR = join(homedir(), CONFIG_DIR);

export function defaultConfig(): LoopsyConfig {
  return {
    // CSO #5: bind to localhost by default. Anyone who genuinely wants LAN
    // access opts in by setting `server.host: 0.0.0.0` in config.yaml. The
    // dashboard at /dashboard/* is unauthenticated by design (#5), so binding
    // wide-open exposed it to every device on the LAN.
    server: { port: DEFAULT_PORT, host: '127.0.0.1' },
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

/**
 * Persist a config back to disk. Used by the relay-client when it
 * mutates `customCommands` so the change survives a daemon restart.
 * The full config object is round-tripped — anything not in the new
 * value is removed, including secrets, so callers must pass the
 * already-merged config (typically the one returned by loadConfig).
 */
export async function saveConfig(config: LoopsyConfig, dataDir?: string): Promise<void> {
  const dir = dataDir ?? config.server?.dataDir ?? DEFAULT_DATA_DIR;
  await mkdir(dir, { recursive: true });
  const configPath = join(dir, CONFIG_FILE);
  // Strip computed/ephemeral fields that don't belong in YAML.
  const { server, ...rest } = config;
  const persisted = { server: { ...server, dataDir: undefined }, ...rest };
  await writeFile(configPath, stringifyYaml(persisted), { mode: 0o600 });
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
