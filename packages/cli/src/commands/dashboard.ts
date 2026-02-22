import { spawn } from 'node:child_process';
import { dashboardServerPath } from '../package-root.js';

export async function dashboardCommand(argv: any) {
  const port = argv.port || 19540;

  const serverPath = dashboardServerPath();

  const child = spawn('node', [serverPath, '--port', String(port)], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('error', (err) => {
    console.error('Failed to start dashboard:', err.message);
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });

  // Forward SIGINT/SIGTERM to child
  const forward = (signal: NodeJS.Signals) => {
    child.kill(signal);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
}
