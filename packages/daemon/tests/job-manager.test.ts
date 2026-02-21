import { describe, it, expect } from 'vitest';
import { JobManager } from '../src/services/job-manager.js';
import { LoopsyError } from '@loopsy/protocol';

describe('JobManager', () => {
  it('executes a command and returns result', async () => {
    const jm = new JobManager({ denylist: [] });
    const result = await jm.execute({ command: 'echo', args: ['hello'] }, 'test-node');
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
    expect(result.killed).toBe(false);
  });

  it('denies blocked commands', async () => {
    const jm = new JobManager({ denylist: ['rm'] });
    await expect(jm.execute({ command: 'rm', args: ['-rf', '/'] }, 'test')).rejects.toThrow(LoopsyError);
  });

  it('returns stderr', async () => {
    const jm = new JobManager({ denylist: [] });
    const result = await jm.execute({ command: 'ls', args: ['/nonexistent_path_12345'] }, 'test');
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.exitCode).not.toBe(0);
  });

  it('tracks active jobs', async () => {
    const jm = new JobManager({ denylist: [] });
    // Start a slow command
    const promise = jm.execute({ command: 'sleep', args: ['0.1'] }, 'test');
    expect(jm.activeCount).toBe(1);
    await promise;
    expect(jm.activeCount).toBe(0);
  });

  it('enforces max concurrent limit', async () => {
    const jm = new JobManager({ denylist: [], maxConcurrent: 1 });
    const p1 = jm.execute({ command: 'sleep', args: ['0.5'] }, 'test');
    await expect(jm.execute({ command: 'echo', args: ['hi'] }, 'test')).rejects.toThrow(LoopsyError);
    await p1;
  });
});
