import { execSync } from 'node:child_process';
import { platform, userInfo } from 'node:os';

export interface SessionContext {
  daemonUser: string;
  daemonUid: number;
  daemonIsRoot: boolean;
  consoleUser: string | null;
  consoleUid: number | null;
  /** True when there is a console user and it differs from the daemon user. */
  mismatched: boolean;
}

/**
 * Detect the daemon's user vs. the user currently logged into the macOS
 * GUI ("console") session. Used to decide how to launch GUI-class commands.
 *
 * On non-darwin platforms, console fields are null and `mismatched` is false.
 */
export function detectSessionContext(): SessionContext {
  const info = userInfo();
  const daemonUser = info.username;
  const daemonUid = info.uid;
  const daemonIsRoot = daemonUid === 0;

  if (platform() !== 'darwin') {
    return {
      daemonUser,
      daemonUid,
      daemonIsRoot,
      consoleUser: null,
      consoleUid: null,
      mismatched: false,
    };
  }

  let consoleUser: string | null = null;
  let consoleUid: number | null = null;
  try {
    const raw = execSync('stat -f%Su /dev/console', { encoding: 'utf-8', timeout: 2000 }).trim();
    if (raw && raw !== 'root') {
      consoleUser = raw;
      const uidRaw = execSync(`id -u ${raw}`, { encoding: 'utf-8', timeout: 2000 }).trim();
      const parsed = Number.parseInt(uidRaw, 10);
      if (Number.isFinite(parsed)) consoleUid = parsed;
    }
  } catch {
    // No console session reachable (headless / loginwindow). Leave nulls.
  }

  const mismatched = consoleUser !== null && consoleUser !== daemonUser;
  return { daemonUser, daemonUid, daemonIsRoot, consoleUser, consoleUid, mismatched };
}

/**
 * Commands that need a real GUI session to do anything visible. When the
 * daemon's user owns no GUI session, these silently misroute (the bug that
 * motivated this module). The launcher uses this to decide whether to hop
 * into the console user's launchd domain.
 *
 * The list intentionally errs on the side of "definitely GUI" so non-GUI
 * shell work is unaffected. Path-based detection catches `/Applications/Foo.app/...`
 * binaries that users invoke directly.
 */
const GUI_CLASS_BINARIES = new Set([
  'open',
  'osascript',
]);

const GUI_CLASS_PATH_PREFIXES = [
  '/Applications/',
  '/System/Applications/',
];

export function isGuiClassCommand(command: string): boolean {
  const base = (command.split('/').pop() ?? command).toLowerCase();
  if (GUI_CLASS_BINARIES.has(base)) return true;
  return GUI_CLASS_PATH_PREFIXES.some((p) => command.startsWith(p));
}
