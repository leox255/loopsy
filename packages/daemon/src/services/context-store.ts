import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ContextEntry } from '@loopsy/protocol';
import { CONFIG_DIR, MAX_CONTEXT_ENTRIES, MAX_CONTEXT_VALUE_SIZE } from '@loopsy/protocol';
import { LoopsyError, LoopsyErrorCode } from '@loopsy/protocol';

export class ContextStore {
  private entries = new Map<string, ContextEntry>();
  private expiryTimer: ReturnType<typeof setInterval> | null = null;
  private contextFile: string;

  constructor(dataDir?: string) {
    const dir = dataDir ?? join(homedir(), CONFIG_DIR);
    this.contextFile = join(dir, 'context.json');
  }

  async load(): Promise<void> {
    try {
      const data = await readFile(this.contextFile, 'utf-8');
      const items: ContextEntry[] = JSON.parse(data);
      for (const entry of items) {
        if (!entry.expiresAt || entry.expiresAt > Date.now()) {
          this.entries.set(entry.key, entry);
        }
      }
    } catch {
      // No context file yet
    }
  }

  async save(): Promise<void> {
    const dir = join(this.contextFile, '..');
    await mkdir(dir, { recursive: true });
    await writeFile(this.contextFile, JSON.stringify(Array.from(this.entries.values()), null, 2));
  }

  startExpiryCheck(): void {
    this.expiryTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.entries) {
        if (entry.expiresAt && entry.expiresAt <= now) {
          this.entries.delete(key);
        }
      }
    }, 10_000);
  }

  stopExpiryCheck(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  set(key: string, value: string, fromNodeId: string, ttl?: number): ContextEntry {
    if (value.length > MAX_CONTEXT_VALUE_SIZE) {
      throw new LoopsyError(LoopsyErrorCode.CONTEXT_VALUE_TOO_LARGE, `Value exceeds max size of ${MAX_CONTEXT_VALUE_SIZE} bytes`);
    }
    if (this.entries.size >= MAX_CONTEXT_ENTRIES && !this.entries.has(key)) {
      throw new LoopsyError(LoopsyErrorCode.CONTEXT_MAX_ENTRIES, `Max context entries (${MAX_CONTEXT_ENTRIES}) reached`);
    }
    const now = Date.now();
    const entry: ContextEntry = {
      key,
      value,
      fromNodeId,
      createdAt: this.entries.get(key)?.createdAt ?? now,
      updatedAt: now,
      ttl,
      expiresAt: ttl ? now + ttl * 1000 : undefined,
    };
    this.entries.set(key, entry);
    return entry;
  }

  get(key: string): ContextEntry | undefined {
    const entry = this.entries.get(key);
    if (entry?.expiresAt && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  list(prefix?: string): ContextEntry[] {
    const now = Date.now();
    const result: ContextEntry[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt && entry.expiresAt <= now) {
        this.entries.delete(key);
      } else if (!prefix || key.startsWith(prefix)) {
        result.push(entry);
      }
    }
    return result;
  }

  get size(): number {
    return this.entries.size;
  }
}
