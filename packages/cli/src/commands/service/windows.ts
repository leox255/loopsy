import { execSync } from 'node:child_process';
import { daemonMainPath } from '../../package-root.js';

const TASK_NAME = 'LoopsyDaemon';

export async function enableWindows(): Promise<void> {
  const nodePath = process.execPath;
  const daemonPath = daemonMainPath();

  // Delete existing task if present (ignore errors)
  try {
    execSync(`schtasks /delete /tn "${TASK_NAME}" /f`, { stdio: 'ignore' });
  } catch {}

  // Create a task that runs at logon
  // /sc onlogon: trigger on user logon
  // /rl LIMITED: run with user privileges (no elevation)
  const cmd = `schtasks /create /tn "${TASK_NAME}" /tr "\\"${nodePath}\\" \\"${daemonPath}\\"" /sc onlogon /rl LIMITED /f`;
  execSync(cmd);

  // Also start it now
  try {
    execSync(`schtasks /run /tn "${TASK_NAME}"`, { stdio: 'ignore' });
  } catch {}

  console.log('Loopsy daemon registered with Task Scheduler');
  console.log('The daemon will start automatically on logon');
}

export async function disableWindows(): Promise<void> {
  // Stop the running task
  try {
    execSync(`schtasks /end /tn "${TASK_NAME}"`, { stdio: 'ignore' });
  } catch {}

  // Delete the scheduled task
  try {
    execSync(`schtasks /delete /tn "${TASK_NAME}" /f`);
  } catch {}

  console.log('Loopsy daemon unregistered from Task Scheduler');
}

export async function statusWindows(): Promise<{ enabled: boolean; running: boolean }> {
  let enabled = false;
  let running = false;

  try {
    const output = execSync(`schtasks /query /tn "${TASK_NAME}" /fo csv /nh`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    enabled = output.includes(TASK_NAME);
    running = output.includes('Running');
  } catch {}

  return { enabled, running };
}
