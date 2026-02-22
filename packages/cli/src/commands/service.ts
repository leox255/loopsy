import { platform } from 'node:os';

interface ServiceStatus {
  enabled: boolean;
  running: boolean;
}

async function getPlatformModule() {
  const os = platform();
  switch (os) {
    case 'darwin':
      return import('./service/macos.js');
    case 'linux':
      return import('./service/linux.js');
    case 'win32':
      return import('./service/windows.js');
    default:
      console.error(`Unsupported platform: ${os}`);
      console.error('Supported platforms: macOS (launchd), Linux (systemd), Windows (Task Scheduler)');
      process.exit(1);
  }
}

export async function enableCommand() {
  const os = platform();
  const mod = await getPlatformModule();

  console.log(`Platform: ${os}`);
  console.log('');

  if (os === 'darwin') {
    await (mod as typeof import('./service/macos.js')).enableMacos();
  } else if (os === 'linux') {
    await (mod as typeof import('./service/linux.js')).enableLinux();
  } else if (os === 'win32') {
    await (mod as typeof import('./service/windows.js')).enableWindows();
  }
}

export async function disableCommand() {
  const os = platform();
  const mod = await getPlatformModule();

  if (os === 'darwin') {
    await (mod as typeof import('./service/macos.js')).disableMacos();
  } else if (os === 'linux') {
    await (mod as typeof import('./service/linux.js')).disableLinux();
  } else if (os === 'win32') {
    await (mod as typeof import('./service/windows.js')).disableWindows();
  }
}

export async function serviceStatusCommand() {
  const os = platform();
  const mod = await getPlatformModule();

  let status: ServiceStatus;
  if (os === 'darwin') {
    status = await (mod as typeof import('./service/macos.js')).statusMacos();
  } else if (os === 'linux') {
    status = await (mod as typeof import('./service/linux.js')).statusLinux();
  } else if (os === 'win32') {
    status = await (mod as typeof import('./service/windows.js')).statusWindows();
  } else {
    return;
  }

  console.log(`System service: ${status.enabled ? 'enabled' : 'disabled'}`);
  console.log(`Daemon process: ${status.running ? 'running' : 'stopped'}`);

  if (!status.enabled) {
    console.log('');
    console.log('Run "loopsy enable" to register the daemon as a system service');
  }
}
