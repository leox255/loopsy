import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';
import { CONFIG_DIR, CONFIG_FILE, TLS_DIR, TLS_CERT_FILE, DEFAULT_PORT } from '@loopsy/protocol';
import { parse as parseYaml } from 'yaml';

interface Check {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  fix?: string;
}

export async function doctorCommand() {
  const checks: Check[] = [];
  const loopsyDir = join(homedir(), CONFIG_DIR);
  const configPath = join(loopsyDir, CONFIG_FILE);

  // 1. Config exists
  let config: any = null;
  if (existsSync(configPath)) {
    try {
      const raw = await readFile(configPath, 'utf-8');
      config = parseYaml(raw);
      checks.push({ name: 'Config', status: 'pass', message: configPath });
    } catch (err: any) {
      checks.push({ name: 'Config', status: 'fail', message: `Invalid YAML: ${err.message}`, fix: 'loopsy init' });
    }
  } else {
    checks.push({ name: 'Config', status: 'fail', message: 'Not found', fix: 'loopsy init' });
  }

  // 2. Daemon running
  const port = config?.server?.port ?? DEFAULT_PORT;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      signal: AbortSignal.timeout(3000),
      headers: config?.auth?.apiKey ? { Authorization: `Bearer ${config.auth.apiKey}` } : {},
    });
    if (res.ok) {
      checks.push({ name: 'Daemon', status: 'pass', message: `Running on port ${port}` });
    } else {
      checks.push({ name: 'Daemon', status: 'fail', message: `HTTP ${res.status}`, fix: 'loopsy start' });
    }
  } catch {
    checks.push({ name: 'Daemon', status: 'fail', message: 'Not running', fix: 'loopsy start' });
  }

  // 3. MCP registered (check all supported agents)
  const mcpAgents = [
    { name: 'Claude Code', bin: 'claude', list: 'claude mcp list' },
    { name: 'Gemini CLI', bin: 'gemini', list: 'gemini mcp list' },
    { name: 'Codex CLI', bin: 'codex', list: 'codex mcp list' },
  ];
  const mcpResults: string[] = [];
  let anyRegistered = false;
  let anyAgentFound = false;

  for (const agent of mcpAgents) {
    try {
      execSync(`${agent.bin} --version`, { stdio: 'ignore' });
      anyAgentFound = true;
      try {
        const output = execSync(agent.list, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        if (output.includes('loopsy')) {
          mcpResults.push(agent.name);
          anyRegistered = true;
        }
      } catch {}
    } catch {}
  }

  if (anyRegistered) {
    checks.push({ name: 'MCP', status: 'pass', message: `Registered with ${mcpResults.join(', ')}` });
  } else if (anyAgentFound) {
    checks.push({ name: 'MCP', status: 'warn', message: 'Not registered with any agent', fix: 'loopsy mcp add' });
  } else {
    checks.push({ name: 'MCP', status: 'warn', message: 'No AI coding agents found on PATH' });
  }

  // 4. TLS
  const tlsCertPath = join(loopsyDir, TLS_DIR, TLS_CERT_FILE);
  if (existsSync(tlsCertPath)) {
    const tlsEnabled = config?.tls?.enabled;
    if (tlsEnabled) {
      checks.push({ name: 'TLS', status: 'pass', message: 'Enabled with certificate' });
    } else {
      checks.push({ name: 'TLS', status: 'warn', message: 'Certificate exists but TLS not enabled in config' });
    }
  } else {
    checks.push({ name: 'TLS', status: 'warn', message: 'No certificate (optional — set tls.enabled: true in config)' });
  }

  // 5. Peers
  const allowedKeys = config?.auth?.allowedKeys;
  const peerCount = allowedKeys ? Object.keys(allowedKeys).length : 0;
  if (peerCount > 0) {
    checks.push({ name: 'Peers', status: 'pass', message: `${peerCount} peer(s) configured` });
  } else {
    checks.push({ name: 'Peers', status: 'warn', message: 'No peers configured', fix: 'loopsy pair' });
  }

  // 6. System service
  const os = platform();
  let serviceEnabled = false;
  if (os === 'darwin') {
    serviceEnabled = existsSync(join(homedir(), 'Library', 'LaunchAgents', 'com.loopsy.daemon.plist'));
  } else if (os === 'linux') {
    serviceEnabled = existsSync(join(homedir(), '.config', 'systemd', 'user', 'loopsy.service'));
  } else if (os === 'win32') {
    try {
      execSync('schtasks /query /tn "LoopsyDaemon" /fo csv /nh', { stdio: 'pipe' });
      serviceEnabled = true;
    } catch {}
  }

  if (serviceEnabled) {
    checks.push({ name: 'Service', status: 'pass', message: 'Auto-start enabled' });
  } else {
    checks.push({ name: 'Service', status: 'warn', message: 'Not registered (daemon won\'t auto-start on login)', fix: 'loopsy enable' });
  }

  // Print results
  console.log('');
  console.log('Loopsy Health Check');
  console.log('─'.repeat(50));

  for (const check of checks) {
    const icon = check.status === 'pass' ? 'OK' : check.status === 'fail' ? 'FAIL' : 'WARN';
    const pad = check.name.padEnd(10);
    console.log(`  [${icon.padEnd(4)}] ${pad} ${check.message}`);
    if (check.fix && check.status !== 'pass') {
      console.log(`          Fix: ${check.fix}`);
    }
  }

  console.log('');

  const failures = checks.filter((c) => c.status === 'fail');
  if (failures.length === 0) {
    console.log('All checks passed!');
  } else {
    console.log(`${failures.length} check(s) failed.`);
    process.exitCode = 1;
  }
}
