import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CONFIG_DIR } from '@loopsy/protocol';

const LOG_DIR = join(homedir(), CONFIG_DIR, 'logs');
const AUDIT_FILE = join(LOG_DIR, 'audit.jsonl');

export class AuditLogger {
  private ready = false;

  async init(): Promise<void> {
    await mkdir(LOG_DIR, { recursive: true });
    this.ready = true;
  }

  async log(entry: {
    requestId: string;
    method: string;
    path: string;
    fromIp: string;
    statusCode: number;
    duration: number;
    error?: string;
  }): Promise<void> {
    if (!this.ready) return;
    const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n';
    await appendFile(AUDIT_FILE, line).catch(() => {});
  }
}
