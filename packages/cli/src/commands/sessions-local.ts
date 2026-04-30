/**
 * Commands that talk to the local IPC socket: list / attach / kill.
 * `shell` lives in its own file because it's the most prominent command;
 * the rest are grouped here for compactness.
 */

import { runInteractive, oneShotQuery } from '../local-client.js';

interface SessionInfo {
  id: string;
  agent: string;
  name?: string;
  cwd: string;
  cols: number;
  rows: number;
  alive: boolean;
  attachedClientCount: number;
  lastActivityAt: number;
  createdAt: number;
}

export async function listCommand(): Promise<void> {
  try {
    const reply = await oneShotQuery({ type: 'session-list' });
    const sessions: SessionInfo[] = (reply.sessions ?? []).filter((s: SessionInfo) => s.alive);
    if (sessions.length === 0) {
      process.stdout.write('No running sessions.\n');
      return;
    }
    // Compact, fixed-width-ish layout. Don't pull in a table dep.
    const rows = sessions.map((s) => ({
      shortId: s.id.slice(0, 8),
      name: s.name ?? '—',
      agent: s.agent,
      attached: String(s.attachedClientCount),
      idle: humanIdle(s.lastActivityAt),
    }));
    const widths = {
      shortId: Math.max(2, ...rows.map((r) => r.shortId.length)),
      name: Math.max(4, ...rows.map((r) => r.name.length)),
      agent: Math.max(5, ...rows.map((r) => r.agent.length)),
      attached: Math.max(8, ...rows.map((r) => r.attached.length)),
      idle: Math.max(5, ...rows.map((r) => r.idle.length)),
    };
    const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));
    process.stdout.write(
      pad('ID', widths.shortId) + '  ' +
      pad('NAME', widths.name) + '  ' +
      pad('AGENT', widths.agent) + '  ' +
      pad('ATTACHED', widths.attached) + '  ' +
      pad('IDLE', widths.idle) + '\n',
    );
    for (const r of rows) {
      process.stdout.write(
        pad(r.shortId, widths.shortId) + '  ' +
        pad(r.name, widths.name) + '  ' +
        pad(r.agent, widths.agent) + '  ' +
        pad(r.attached, widths.attached) + '  ' +
        pad(r.idle, widths.idle) + '\n',
      );
    }
  } catch (err) {
    process.stderr.write(`loopsy: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

interface AttachArgs { id: string }
export async function attachCommand(argv: AttachArgs): Promise<void> {
  try {
    const code = await runInteractive({ attach: { idOrName: argv.id } });
    process.exit(code ?? 0);
  } catch (err) {
    process.stderr.write(`loopsy: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

interface KillArgs { id: string }
export async function killCommand(argv: KillArgs): Promise<void> {
  try {
    const reply = await oneShotQuery({ type: 'session-kill', idOrName: argv.id });
    process.stdout.write(`Killed ${reply.sessionId}\n`);
  } catch (err) {
    process.stderr.write(`loopsy: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

function humanIdle(lastActivityAt: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - lastActivityAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}
