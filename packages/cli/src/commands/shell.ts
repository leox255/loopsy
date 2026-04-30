import { runInteractive } from '../local-client.js';

interface ShellArgs {
  agent?: string;
  cwd?: string;
  name?: string;
}

/**
 * `loopsy shell` — start a new long-lived PTY managed by the daemon and
 * attach the current terminal to it. The session survives detach (Ctrl-A
 * D) and can be picked up later by another local terminal or by the
 * paired iOS app.
 */
export async function shellCommand(argv: ShellArgs): Promise<void> {
  const agent = argv.agent ?? 'shell';
  try {
    const code = await runInteractive({
      spawn: {
        agent,
        cwd: argv.cwd,
        name: argv.name,
      },
    });
    if (code !== null) process.exit(code);
    // detached — exit 0 so shell scripts can branch on it cleanly.
    process.exit(0);
  } catch (err) {
    process.stderr.write(`loopsy: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
