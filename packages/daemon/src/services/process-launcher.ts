import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { LoopsyError, LoopsyErrorCode } from '@loopsy/protocol';
import {
  detectSessionContext,
  isGuiClassCommand,
  type SessionContext,
} from '../utils/session-context.js';

export interface LaunchResult {
  process: ChildProcess;
  /** Where the process actually ran. Useful for audit logging. */
  routedTo: 'daemon-user' | 'console-user';
  sessionContext: SessionContext;
}

/**
 * Launch a child process with awareness of the macOS GUI session.
 *
 * Default behavior (no flags, no config): if the command is GUI-class
 * (`open`, `osascript`, `/Applications/...`) AND the daemon user differs
 * from the console user, transparently re-route the launch into the
 * console user's launchd domain via `launchctl asuser`. This makes the
 * difference between "URL opens in the visible browser" and "URL opens
 * invisibly in a Chrome instance owned by the daemon's user".
 *
 * Routing succeeds without any sudo when the daemon runs as root (the
 * recommended system-install path). When the daemon runs as a regular
 * user that is not the console user, routing is attempted with `sudo -n`;
 * if sudoers isn't configured for passwordless hop, the spawn surfaces a
 * clear error rather than silently misrouting.
 *
 * Non-GUI commands are spawned exactly as before. Non-darwin platforms
 * always take the direct-spawn path.
 */
export function launchManagedProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): LaunchResult {
  const sessionContext = detectSessionContext();
  const guiClass = isGuiClassCommand(command);

  if (!guiClass || !sessionContext.mismatched) {
    return {
      process: spawn(command, [...args], options),
      routedTo: 'daemon-user',
      sessionContext,
    };
  }

  // GUI command + mismatched users → route into console user's session.
  const consoleUid = sessionContext.consoleUid;
  const consoleUser = sessionContext.consoleUser;
  if (consoleUid === null || consoleUser === null) {
    throw new LoopsyError(
      LoopsyErrorCode.EXEC_GUI_SESSION_UNAVAILABLE,
      `GUI command '${command}' needs a console session, but none is currently active on this machine.`,
    );
  }

  const wrapped = sessionContext.daemonIsRoot
    ? ['asuser', String(consoleUid), command, ...args]
    : ['asuser', String(consoleUid), 'sudo', '-n', '-u', consoleUser, command, ...args];

  return {
    process: spawn('launchctl', wrapped, options),
    routedTo: 'console-user',
    sessionContext,
  };
}
