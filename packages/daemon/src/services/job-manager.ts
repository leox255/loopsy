import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ExecuteParams, ExecuteResult, JobInfo } from '@loopsy/protocol';
import { LoopsyError, LoopsyErrorCode, MAX_CONCURRENT_JOBS } from '@loopsy/protocol';

export class JobManager {
  private jobs = new Map<string, { process: ChildProcess; info: JobInfo }>();
  private maxConcurrent: number;
  private denylist: string[];
  private allowlist?: string[];

  constructor(opts: { maxConcurrent?: number; denylist?: string[]; allowlist?: string[] }) {
    this.maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT_JOBS;
    this.denylist = opts.denylist ?? [];
    this.allowlist = opts.allowlist;
  }

  async execute(params: ExecuteParams, fromNodeId: string): Promise<ExecuteResult> {
    this.validateCommand(params.command);

    if (this.jobs.size >= this.maxConcurrent) {
      throw new LoopsyError(LoopsyErrorCode.EXEC_MAX_CONCURRENT, `Max concurrent jobs (${this.maxConcurrent}) reached`);
    }

    const jobId = randomUUID();
    const startedAt = Date.now();

    return new Promise<ExecuteResult>((resolve, reject) => {
      const proc = spawn(params.command, params.args ?? [], {
        cwd: params.cwd,
        env: params.env ? { ...process.env, ...params.env } : process.env,
        shell: false,
        timeout: params.timeout,
      });

      const info: JobInfo = {
        jobId,
        command: params.command,
        args: params.args ?? [],
        startedAt,
        fromNodeId,
        pid: proc.pid,
      };

      this.jobs.set(jobId, { process: proc, info });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on('close', (exitCode, signal) => {
        this.jobs.delete(jobId);
        resolve({
          jobId,
          exitCode,
          stdout,
          stderr,
          duration: Date.now() - startedAt,
          killed: signal !== null,
        });
      });

      proc.on('error', (err) => {
        this.jobs.delete(jobId);
        reject(new LoopsyError(LoopsyErrorCode.EXEC_FAILED, `Execution failed: ${err.message}`));
      });
    });
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    job.process.kill('SIGTERM');
    setTimeout(() => {
      if (this.jobs.has(jobId)) {
        job.process.kill('SIGKILL');
      }
    }, 5000);
    return true;
  }

  getActiveJobs(): JobInfo[] {
    return Array.from(this.jobs.values()).map((j) => j.info);
  }

  killAll(): void {
    for (const [id, job] of this.jobs) {
      job.process.kill('SIGKILL');
      this.jobs.delete(id);
    }
  }

  get activeCount(): number {
    return this.jobs.size;
  }

  private validateCommand(command: string): void {
    const base = command.split('/').pop() ?? command;
    if (this.denylist.includes(base)) {
      throw new LoopsyError(LoopsyErrorCode.EXEC_COMMAND_DENIED, `Command '${base}' is denied`);
    }
    if (this.allowlist && !this.allowlist.includes(base)) {
      throw new LoopsyError(LoopsyErrorCode.EXEC_COMMAND_DENIED, `Command '${base}' is not in the allowlist`);
    }
  }
}
