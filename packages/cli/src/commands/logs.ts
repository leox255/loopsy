import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CONFIG_DIR } from '@loopsy/protocol';
import { spawn } from 'node:child_process';

const AUDIT_FILE = join(homedir(), CONFIG_DIR, 'logs', 'audit.jsonl');

export async function logsCommand(argv: any) {
  if (argv.follow) {
    const tail = spawn('tail', ['-f', AUDIT_FILE], { stdio: 'inherit' });
    tail.on('error', () => {
      console.error('Could not tail logs. Is the daemon running?');
    });
  } else {
    try {
      const stream = createReadStream(AUDIT_FILE, 'utf-8');
      for await (const chunk of stream) {
        process.stdout.write(chunk);
      }
    } catch {
      console.log('No logs found. Is the daemon running?');
    }
  }
}
