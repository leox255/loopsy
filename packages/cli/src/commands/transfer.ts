import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadApiKey, parsePeerAddress } from '../utils.js';

export async function sendCommand(argv: any) {
  const { address, port } = parsePeerAddress(argv.peer);
  const apiKey = argv.key || await loadApiKey();

  try {
    const fileData = await readFile(argv.src);
    const formData = new FormData();
    formData.append('destPath', argv.dest);
    formData.append('file', new Blob([fileData]), argv.src.split('/').pop() ?? 'file');

    const res = await fetch(`http://${address}:${port}/api/v1/transfer/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as any;
      console.error(`Error: ${body.error?.message ?? res.statusText}`);
      process.exit(1);
    }

    const result = await res.json() as any;
    console.log(`File sent: ${result.path} (${result.size} bytes, sha256: ${result.checksum})`);
  } catch (err: any) {
    console.error(`Failed to send: ${err.message}`);
    process.exit(1);
  }
}

export async function pullCommand(argv: any) {
  const { address, port } = parsePeerAddress(argv.peer);
  const apiKey = argv.key || await loadApiKey();

  try {
    const res = await fetch(`http://${address}:${port}/api/v1/transfer/pull`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ sourcePath: argv.src }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as any;
      console.error(`Error: ${body.error?.message ?? res.statusText}`);
      process.exit(1);
    }

    await mkdir(dirname(argv.dest), { recursive: true });
    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(argv.dest, buffer);
    console.log(`File pulled: ${argv.dest} (${buffer.length} bytes)`);
  } catch (err: any) {
    console.error(`Failed to pull: ${err.message}`);
    process.exit(1);
  }
}
