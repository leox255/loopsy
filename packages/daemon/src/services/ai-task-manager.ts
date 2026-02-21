import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { which } from '../utils/which.js';
import type {
  AiTaskParams,
  AiTaskInfo,
  AiTaskStatus,
  AiTaskApprovalRequest,
  AiTaskApprovalResponse,
  AiTaskStreamEvent,
} from '@loopsy/protocol';
import {
  LoopsyError,
  LoopsyErrorCode,
  MAX_CONCURRENT_AI_TASKS,
  DEFAULT_AI_TASK_TIMEOUT,
  AI_TASK_EVENT_BUFFER_SIZE,
} from '@loopsy/protocol';

type EventCallback = (event: AiTaskStreamEvent) => void;

interface AiTask {
  info: AiTaskInfo;
  process: ChildProcess;
  eventBuffer: AiTaskStreamEvent[];
  subscribers: Set<EventCallback>;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

export class AiTaskManager {
  private tasks = new Map<string, AiTask>();
  private recentTasks = new Map<string, { info: AiTaskInfo; eventBuffer: AiTaskStreamEvent[] }>(); // completed tasks kept briefly
  private maxConcurrent: number;

  constructor(opts?: { maxConcurrent?: number }) {
    this.maxConcurrent = opts?.maxConcurrent ?? MAX_CONCURRENT_AI_TASKS;
  }

  async dispatch(params: AiTaskParams, fromNodeId: string): Promise<AiTaskInfo> {
    const activeCount = Array.from(this.tasks.values()).filter(
      (t) => t.info.status === 'running' || t.info.status === 'waiting_approval',
    ).length;
    if (activeCount >= this.maxConcurrent) {
      throw new LoopsyError(
        LoopsyErrorCode.AI_TASK_MAX_CONCURRENT,
        `Max concurrent AI tasks (${this.maxConcurrent}) reached`,
      );
    }

    // Find claude CLI
    const claudePath = await which('claude');
    if (!claudePath) {
      throw new LoopsyError(
        LoopsyErrorCode.AI_TASK_CLAUDE_NOT_FOUND,
        'Claude CLI not found in PATH. Install claude-code first.',
      );
    }

    const taskId = randomUUID();
    const now = Date.now();

    // Build CLI args
    const args = ['-p', params.prompt, '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];

    if (params.permissionMode && params.permissionMode !== 'default') {
      args.push('--permission-mode', params.permissionMode);
    }
    if (params.model) {
      args.push('--model', params.model);
    }
    if (params.maxBudgetUsd) {
      args.push('--max-budget-usd', String(params.maxBudgetUsd));
    }
    if (params.allowedTools?.length) {
      args.push('--allowedTools', params.allowedTools.join(' '));
    }
    if (params.disallowedTools?.length) {
      args.push('--disallowedTools', params.disallowedTools.join(' '));
    }
    if (params.additionalArgs?.length) {
      args.push(...params.additionalArgs);
    }

    // Strip all Claude-related env vars to avoid nesting detection
    // When daemon runs standalone (not inside Claude Code), these won't exist anyway
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE') || key.startsWith('ANTHROPIC_') || key === 'MCP_') {
        delete env[key];
      }
    }

    const proc = spawn(claudePath, args, {
      cwd: params.cwd || process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const info: AiTaskInfo = {
      taskId,
      prompt: params.prompt,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      fromNodeId,
      pid: proc.pid,
      model: params.model,
    };

    const task: AiTask = {
      info,
      process: proc,
      eventBuffer: [],
      subscribers: new Set(),
    };

    this.tasks.set(taskId, task);

    // Set timeout
    task.timeoutTimer = setTimeout(() => {
      this.cancel(taskId);
      this.emit(task, { type: 'error', taskId, timestamp: Date.now(), data: 'Task timed out' });
    }, DEFAULT_AI_TASK_TIMEOUT);

    // Parse stdout line-by-line as JSON
    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line);
        this.handleClaudeEvent(task, parsed);
      } catch {
        // Non-JSON line — forward as text
        this.emit(task, { type: 'text', taskId, timestamp: Date.now(), data: line });
      }
    });

    // Capture stderr
    proc.stderr?.on('data', (chunk: Buffer) => {
      this.emit(task, { type: 'error', taskId, timestamp: Date.now(), data: chunk.toString() });
    });

    // Handle process exit
    proc.on('close', (exitCode, signal) => {
      if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
      info.exitCode = exitCode;
      info.completedAt = Date.now();
      info.updatedAt = Date.now();
      info.status = exitCode === 0 ? 'completed' : (signal ? 'cancelled' : 'failed');
      if (exitCode !== 0 && !info.error) {
        info.error = signal ? `Killed by ${signal}` : `Exit code ${exitCode}`;
      }
      this.emit(task, { type: 'exit', taskId, timestamp: Date.now(), data: { exitCode, signal } });

      // Move to recent tasks (preserve event buffer) and clean up
      this.recentTasks.set(taskId, { info: { ...info }, eventBuffer: [...task.eventBuffer] });
      this.tasks.delete(taskId);
      setTimeout(() => this.recentTasks.delete(taskId), 300_000); // keep 5 min
    });

    proc.on('error', (err) => {
      if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
      info.status = 'failed';
      info.error = err.message;
      info.updatedAt = Date.now();
      info.completedAt = Date.now();
      this.emit(task, { type: 'error', taskId, timestamp: Date.now(), data: err.message });
      this.recentTasks.set(taskId, { info: { ...info }, eventBuffer: [...task.eventBuffer] });
      this.tasks.delete(taskId);
    });

    // Emit initial status
    this.emit(task, { type: 'status', taskId, timestamp: now, data: { status: 'running' } });

    return { ...info };
  }

  approve(taskId: string, response: AiTaskApprovalResponse): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.info.status !== 'waiting_approval') return false;
    if (!task.info.pendingApproval) return false;

    // Write approval to Claude's stdin as JSON
    const stdinMsg = JSON.stringify({
      type: 'permission_response',
      id: response.requestId,
      allow: response.approved,
    }) + '\n';

    try {
      task.process.stdin?.write(stdinMsg);
    } catch {
      return false;
    }

    task.info.status = 'running';
    task.info.pendingApproval = undefined;
    task.info.updatedAt = Date.now();

    this.emit(task, {
      type: 'status',
      taskId,
      timestamp: Date.now(),
      data: { status: 'running', approved: response.approved },
    });

    return true;
  }

  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    task.info.status = 'cancelled';
    task.info.updatedAt = Date.now();
    task.process.kill('SIGTERM');
    setTimeout(() => {
      if (this.tasks.has(taskId)) {
        task.process.kill('SIGKILL');
      }
    }, 5000);
    return true;
  }

  getTask(taskId: string): AiTaskInfo | undefined {
    const active = this.tasks.get(taskId);
    if (active) return { ...active.info };
    const recent = this.recentTasks.get(taskId);
    if (recent) return { ...recent.info };
    return undefined;
  }

  getAllTasks(): AiTaskInfo[] {
    const active = Array.from(this.tasks.values()).map((t) => ({ ...t.info }));
    const recent = Array.from(this.recentTasks.values()).map((t) => ({ ...t.info }));
    return [...active, ...recent].sort((a, b) => b.startedAt - a.startedAt);
  }

  getEventBuffer(taskId: string): AiTaskStreamEvent[] {
    const active = this.tasks.get(taskId);
    if (active) return [...active.eventBuffer];
    const recent = this.recentTasks.get(taskId);
    if (recent) return [...recent.eventBuffer];
    return [];
  }

  subscribe(taskId: string, callback: EventCallback): (() => void) | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.subscribers.add(callback);
    return () => { task.subscribers.delete(callback); };
  }

  cancelAll(): void {
    for (const [id, task] of this.tasks) {
      task.process.kill('SIGKILL');
      if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
      this.tasks.delete(id);
    }
  }

  get activeCount(): number {
    return this.tasks.size;
  }

  private handleClaudeEvent(task: AiTask, parsed: any): void {
    const taskId = task.info.taskId;
    const ts = Date.now();

    // Map Claude CLI stream-json events to our event types
    const cliType = parsed.type;

    if (cliType === 'assistant' || cliType === 'content_block_delta') {
      const subtype = parsed.subtype || parsed.delta?.type;
      if (subtype === 'thinking' || subtype === 'thinking_delta') {
        this.emit(task, { type: 'thinking', taskId, timestamp: ts, data: parsed.text || parsed.delta?.thinking || '' });
      } else {
        this.emit(task, { type: 'text', taskId, timestamp: ts, data: parsed.text || parsed.delta?.text || '' });
      }
    } else if (cliType === 'tool_use') {
      this.emit(task, { type: 'tool_use', taskId, timestamp: ts, data: { name: parsed.name, input: parsed.input } });
    } else if (cliType === 'tool_result') {
      this.emit(task, { type: 'tool_result', taskId, timestamp: ts, data: { name: parsed.name, content: parsed.content, output: parsed.output } });
    } else if (cliType === 'permission_request' || cliType === 'input_request') {
      // Claude is asking for permission
      const approval: AiTaskApprovalRequest = {
        toolName: parsed.tool?.name || parsed.toolName || parsed.name || 'unknown',
        toolInput: parsed.tool?.input || parsed.toolInput || parsed.input || {},
        requestId: parsed.id || parsed.request_id || randomUUID(),
        timestamp: ts,
        description: parsed.description || parsed.message || `Claude wants to use: ${parsed.tool?.name || parsed.name || 'a tool'}`,
      };
      task.info.status = 'waiting_approval';
      task.info.pendingApproval = approval;
      task.info.updatedAt = ts;
      this.emit(task, { type: 'permission_request', taskId, timestamp: ts, data: approval });
    } else if (cliType === 'result') {
      this.emit(task, { type: 'result', taskId, timestamp: ts, data: { text: parsed.text, cost: parsed.cost, duration: parsed.duration } });
    } else if (cliType === 'error') {
      task.info.error = parsed.message || parsed.error || JSON.stringify(parsed);
      this.emit(task, { type: 'error', taskId, timestamp: ts, data: parsed.message || parsed.error || parsed });
    } else if (cliType === 'system') {
      // System messages — forward as text
      this.emit(task, { type: 'text', taskId, timestamp: ts, data: parsed.message || parsed.text || JSON.stringify(parsed) });
    } else {
      // Unknown event type — forward as-is
      this.emit(task, { type: 'text', taskId, timestamp: ts, data: JSON.stringify(parsed) });
    }
  }

  private emit(task: AiTask, event: AiTaskStreamEvent): void {
    // Buffer event
    task.eventBuffer.push(event);
    if (task.eventBuffer.length > AI_TASK_EVENT_BUFFER_SIZE) {
      task.eventBuffer.shift();
    }
    // Notify subscribers
    for (const cb of task.subscribers) {
      try { cb(event); } catch {}
    }
  }
}
