import { loadApiKey, parsePeerAddress } from '../utils.js';

export async function execCommand(argv: any) {
  const { address, port } = parsePeerAddress(argv.peer);
  const apiKey = argv.key || await loadApiKey();
  const cmd = argv.cmd as string[];
  const command = cmd[0];
  const args = cmd.slice(1);

  try {
    const res = await fetch(`http://${address}:${port}/api/v1/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ command, args, timeout: argv.timeout }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as any;
      console.error(`Error: ${body.error?.message ?? res.statusText}`);
      process.exit(1);
    }

    const result = await res.json() as any;
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode ?? 0);
  } catch (err: any) {
    console.error(`Failed to execute: ${err.message}`);
    process.exit(1);
  }
}
