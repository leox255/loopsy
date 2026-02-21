import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function dashboardCommand(argv: any) {
  const port = argv.port || 19540;

  // Resolve the dashboard server entry point
  const serverPath = resolve(__dirname, '..', '..', '..', 'dashboard', 'dist', 'server.js');

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
