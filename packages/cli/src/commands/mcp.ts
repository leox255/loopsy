import { execSync } from 'node:child_process';
import { mcpServerPath } from '../package-root.js';

interface AgentCLI {
  name: string;
  bin: string;
  addCmd: (serverPath: string) => string;
  removeCmd: string;
  listCmd: string;
}

const AGENTS: AgentCLI[] = [
  {
    name: 'Claude Code',
    bin: 'claude',
    addCmd: (p) => `claude mcp add loopsy -- node ${p}`,
    removeCmd: 'claude mcp remove loopsy',
    listCmd: 'claude mcp list',
  },
  {
    name: 'Gemini CLI',
    bin: 'gemini',
    addCmd: (p) => `gemini mcp add loopsy -s user node ${p}`,
    removeCmd: 'gemini mcp remove loopsy -s user',
    listCmd: 'gemini mcp list',
  },
  {
    name: 'Codex CLI',
    bin: 'codex',
    addCmd: (p) => `codex mcp add loopsy -- node ${p}`,
    removeCmd: 'codex mcp remove loopsy',
    listCmd: 'codex mcp list',
  },
];

function isAvailable(bin: string): boolean {
  try {
    execSync(`${bin} --version`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function mcpAddCommand() {
  const serverPath = mcpServerPath();
  let registered = 0;

  for (const agent of AGENTS) {
    if (!isAvailable(agent.bin)) continue;

    try {
      // Remove existing registration first (ignore errors)
      try {
        execSync(agent.removeCmd, { stdio: 'ignore' });
      } catch {}

      execSync(agent.addCmd(serverPath), { stdio: 'pipe' });
      console.log(`  Registered with ${agent.name}`);
      registered++;
    } catch (err: any) {
      console.error(`  Failed to register with ${agent.name}: ${err.message}`);
    }
  }

  if (registered === 0) {
    console.log('No supported AI coding agents found on PATH.');
    console.log('');
    console.log('Manual registration:');
    for (const agent of AGENTS) {
      console.log(`  ${agent.name}: ${agent.addCmd(serverPath)}`);
    }
  } else {
    console.log(`\nMCP server registered with ${registered} agent(s)`);
  }
}

export async function mcpRemoveCommand() {
  let removed = 0;

  for (const agent of AGENTS) {
    if (!isAvailable(agent.bin)) continue;

    try {
      execSync(agent.removeCmd, { stdio: 'pipe' });
      console.log(`  Unregistered from ${agent.name}`);
      removed++;
    } catch {
      // Not registered or failed — skip silently
    }
  }

  if (removed === 0) {
    console.log('No registrations found to remove.');
  } else {
    console.log(`\nMCP server removed from ${removed} agent(s)`);
  }
}

export async function mcpStatusCommand() {
  let found = false;

  for (const agent of AGENTS) {
    if (!isAvailable(agent.bin)) {
      console.log(`  ${agent.name}: not installed`);
      continue;
    }

    found = true;
    try {
      const output = execSync(agent.listCmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      const hasLoopsy = output.includes('loopsy');
      console.log(`  ${agent.name}: ${hasLoopsy ? 'registered' : 'not registered'}`);
    } catch {
      console.log(`  ${agent.name}: could not check`);
    }
  }

  if (!found) {
    console.log('No supported AI coding agents found on PATH.');
  }
}
