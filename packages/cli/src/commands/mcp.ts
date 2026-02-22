import { execSync } from 'node:child_process';
import { mcpServerPath } from '../package-root.js';

function claudeAvailable(): boolean {
  try {
    execSync('claude --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function mcpAddCommand() {
  const serverPath = mcpServerPath();

  if (!claudeAvailable()) {
    console.log('Claude Code CLI not found on PATH.');
    console.log('');
    console.log('To register manually, run:');
    console.log(`  claude mcp add loopsy -- node ${serverPath}`);
    return;
  }

  try {
    // Remove existing registration first (ignore errors)
    try {
      execSync('claude mcp remove loopsy', { stdio: 'ignore' });
    } catch {}

    execSync(`claude mcp add loopsy -- node ${serverPath}`, { stdio: 'inherit' });
    console.log('MCP server registered with Claude Code');
  } catch (err: any) {
    console.error('Failed to register MCP server:', err.message);
    console.log('');
    console.log('To register manually, run:');
    console.log(`  claude mcp add loopsy -- node ${serverPath}`);
  }
}

export async function mcpRemoveCommand() {
  if (!claudeAvailable()) {
    console.log('Claude Code CLI not found on PATH.');
    console.log('');
    console.log('To remove manually, run:');
    console.log('  claude mcp remove loopsy');
    return;
  }

  try {
    execSync('claude mcp remove loopsy', { stdio: 'inherit' });
    console.log('MCP server unregistered from Claude Code');
  } catch (err: any) {
    console.error('Failed to unregister MCP server:', err.message);
  }
}

export async function mcpStatusCommand() {
  if (!claudeAvailable()) {
    console.log('Claude Code CLI not found on PATH');
    return;
  }

  try {
    const output = execSync('claude mcp list', { encoding: 'utf-8' });
    const hasLoopsy = output.includes('loopsy');
    console.log(`MCP server: ${hasLoopsy ? 'registered' : 'not registered'}`);
    if (!hasLoopsy) {
      console.log('Run "loopsy mcp add" to register');
    }
  } catch {
    console.log('Could not check MCP status');
  }
}
