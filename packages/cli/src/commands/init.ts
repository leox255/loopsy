import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { stringify as toYaml } from 'yaml';
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_PORT, MAX_FILE_SIZE, MAX_CONCURRENT_JOBS, DEFAULT_EXEC_TIMEOUT, RATE_LIMITS } from '@loopsy/protocol';
import { mcpServerPath } from '../package-root.js';

export async function initCommand() {
  const configDir = join(homedir(), CONFIG_DIR);
  const configPath = join(configDir, CONFIG_FILE);

  // Check if config already exists
  try {
    await readFile(configPath);
    console.log(`Config already exists at ${configPath}`);
    console.log('Use "loopsy key generate" to regenerate your API key.');
    return;
  } catch {
    // Config doesn't exist, create it
  }

  await mkdir(join(configDir, 'logs'), { recursive: true });

  const apiKey = randomBytes(32).toString('hex');

  const config = {
    // Bind to localhost by default — the relay handles WAN access for
    // mobile, and the local Unix socket handles `loopsy shell` for the
    // CLI. LAN peer-to-peer is opt-in via `loopsy start --lan` (or
    // editing this to `0.0.0.0`). Hostile-network exposure is the
    // common foot-gun we want to remove from the default install.
    server: { port: DEFAULT_PORT, host: '127.0.0.1' },
    auth: {
      apiKey,
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

  await writeFile(configPath, toYaml(config));

  console.log('Loopsy initialized!');
  console.log(`Config: ${configPath}`);
  console.log(`API Key: ${apiKey}`);
  console.log('');

  // Auto-register MCP server with available AI coding agents
  const serverPath = mcpServerPath();
  const agents = [
    { name: 'Claude Code', bin: 'claude', add: `claude mcp add loopsy -- node ${serverPath}`, remove: 'claude mcp remove loopsy' },
    { name: 'Gemini CLI', bin: 'gemini', add: `gemini mcp add loopsy -s user node ${serverPath}`, remove: 'gemini mcp remove loopsy -s user' },
    { name: 'Codex CLI', bin: 'codex', add: `codex mcp add loopsy -- node ${serverPath}`, remove: 'codex mcp remove loopsy' },
  ];

  let registered = 0;
  for (const agent of agents) {
    try {
      execSync(`${agent.bin} --version`, { stdio: 'ignore' });
      try { execSync(agent.remove, { stdio: 'ignore' }); } catch {}
      execSync(agent.add, { stdio: 'pipe' });
      console.log(`MCP server registered with ${agent.name}`);
      registered++;
    } catch {
      // Agent not installed or registration failed — skip
    }
  }
  if (registered === 0) {
    console.log('No AI coding agents found. Register MCP manually with: loopsy mcp add');
  }

  console.log('');
  console.log('Next steps:');
  console.log('  1. Run "loopsy start" to start the daemon');
  console.log('  2. Run "loopsy mobile pair" to control your laptop from your phone');
  console.log('     (first run asks whether to use the public relay at relay.loopsy.dev,');
  console.log('      or run "loopsy mobile pair --help" for self-host options)');
  console.log('');
  console.log('For agent-to-agent on a LAN (the original Loopsy):');
  console.log('  • Run "loopsy init && loopsy start" on each machine');
  console.log('  • "loopsy pair <ip>" to exchange keys; mDNS handles discovery');
}
