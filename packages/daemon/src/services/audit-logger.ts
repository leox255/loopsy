import { appendFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { CONFIG_DIR } from '@loopsy/protocol';

export class AuditLogger {
  private ready = false;
  private auditFile: string;

  constructor(dataDir?: string) {
    const dir = dataDir ?? join(homedir(), CONFIG_DIR);
    this.auditFile = join(dir, 'logs', 'audit.jsonl');
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.auditFile), { recursive: true });
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
    await appendFile(this.auditFile, line).catch(() => {});
  }
}
