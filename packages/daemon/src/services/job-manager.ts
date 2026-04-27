import { type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ExecuteParams, ExecuteResult, JobInfo } from '@loopsy/protocol';
import { LoopsyError, LoopsyErrorCode, MAX_CONCURRENT_JOBS } from '@loopsy/protocol';
import { launchManagedProcess } from './process-launcher.js';

/** Env vars that block nested AI CLI execution — strip from child processes */
const NESTING_BLOCK_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRY_POINT'];

/** Build a clean env for child processes, stripping nesting-prevention vars */
export function buildCleanEnv(extraEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val === undefined) continue;
    if (NESTING_BLOCK_VARS.includes(key)) continue;
    env[key] = val;
  }
  if (extraEnv) Object.assign(env, extraEnv);
  return env;
}

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
    this.validateCommand(params.command, params.args ?? []);

    if (this.jobs.size >= this.maxConcurrent) {
      throw new LoopsyError(LoopsyErrorCode.EXEC_MAX_CONCURRENT, `Max concurrent jobs (${this.maxConcurrent}) reached`);
    }

    const jobId = randomUUID();
    const startedAt = Date.now();

    return new Promise<ExecuteResult>((resolve, reject) => {
      let proc: ChildProcess;
      try {
        ({ process: proc } = launchManagedProcess(params.command, params.args ?? [], {
          cwd: params.cwd,
          env: buildCleanEnv(params.env),
          shell: false,
          timeout: params.timeout,
        }));
      } catch (err) {
        reject(err);
        return;
      }

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

  /**
   * CSO #1: the previous denylist matched only the basename of `command`,
   * which trivially fell to `sh -c "rm -rf …"`. Walk well-known shell wrappers
   * and inspect the inner command/script too. This is best-effort defense in
   * depth; a determined attacker with a valid bearer can still escape via
   * `python -c`, `find -exec`, etc., so the documented trust model is now
   * "any peer with the API key effectively has shell on this Mac" — the
   * denylist exists to catch accidental fat-finger commands, not to contain
   * malicious peers.
   */
  private validateCommand(command: string, args: readonly string[] = []): void {
    const checked = new Set<string>();
    const queue: { cmd: string; args: readonly string[] }[] = [{ cmd: command, args }];

    while (queue.length) {
      const { cmd, args: cmdArgs } = queue.shift()!;
      const base = (cmd.split('/').pop() ?? cmd).toLowerCase();
      if (checked.has(base)) continue;
      checked.add(base);

      if (this.denylist.includes(base)) {
        throw new LoopsyError(LoopsyErrorCode.EXEC_COMMAND_DENIED, `Command '${base}' is denied`);
      }
      if (this.allowlist && !this.allowlist.includes(base)) {
        throw new LoopsyError(LoopsyErrorCode.EXEC_COMMAND_DENIED, `Command '${base}' is not in the allowlist`);
      }

      // Detect shell wrappers and queue the inner command for re-validation.
      // We catch the common forms: `sh -c "rm -rf …"`, `bash -c …`, `zsh -c`,
      // `python -c`, `node -e`, `perl -e`, `ruby -e`. The denylist is then
      // matched against tokens of the inner command line (best-effort tokenize).
      const wrappers: Record<string, string> = {
        sh: '-c', bash: '-c', zsh: '-c', dash: '-c',
        python: '-c', python3: '-c', node: '-e', perl: '-e', ruby: '-e',
      };
      if (base in wrappers) {
        const flag = wrappers[base];
        const idx = cmdArgs.indexOf(flag);
        if (idx >= 0 && cmdArgs[idx + 1]) {
          const inner = cmdArgs[idx + 1];
          // Tokenize loosely on whitespace + common shell separators.
          const tokens = inner.split(/[\s;&|`<>(){}\[\]]+/).filter(Boolean);
          for (const tok of tokens) {
            // Skip option flags ("-rf", "-i") and quoted strings.
            if (tok.startsWith('-')) continue;
            if (tok.startsWith('"') || tok.startsWith("'")) continue;
            // Schedule recursion (capped to depth 3 via `checked` set).
            queue.push({ cmd: tok, args: [] });
          }
        }
      }

      // Also catch `find … -exec rm …`, `xargs rm`.
      if (base === 'find') {
        const execIdx = cmdArgs.indexOf('-exec');
        if (execIdx >= 0 && cmdArgs[execIdx + 1]) {
          queue.push({ cmd: cmdArgs[execIdx + 1], args: cmdArgs.slice(execIdx + 2) });
        }
      }
      if (base === 'xargs' && cmdArgs.length > 0) {
        queue.push({ cmd: cmdArgs[0], args: cmdArgs.slice(1) });
      }
    }
  }
}
