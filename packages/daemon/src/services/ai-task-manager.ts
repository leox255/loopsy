import { randomUUID } from 'node:crypto';
import { realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as pty from 'node-pty';
import { which } from '../utils/which.js';
import type {
  AiTaskParams,
  AiTaskInfo,
  AiTaskStatus,
  AiTaskApprovalRequest,
  AiTaskApprovalResponse,
  AiTaskStreamEvent,
  PermissionRequestEntry,
  PermissionResponseEntry,
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
  ptyProcess: pty.IPty;
  eventBuffer: AiTaskStreamEvent[];
  subscribers: Set<EventCallback>;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

// Strip ANSI escape sequences and PTY control characters from output
function stripAnsi(str: string): string {
  return str
    // Remove all ESC sequences: CSI (ESC[...), OSC (ESC]...), and other ESC sequences
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')     // CSI sequences (e.g. ESC[0m, ESC[?25h)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b[()][0-9A-B]/g, '')             // Character set selection
    .replace(/\x1b[=>]/g, '')                      // Keypad modes
    .replace(/\x1b\x1b/g, '')                      // Double ESC
    .replace(/\r/g, '')                             // Carriage returns
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '') // Other control chars (keep \n and \t)
    .replace(/\[<u/g, '');                          // PTY artifacts
}

export interface AiTaskManagerConfig {
  maxConcurrent?: number;
  daemonPort: number;
  apiKey: string;
}

export class AiTaskManager {
  private tasks = new Map<string, AiTask>();
  private recentTasks = new Map<string, { info: AiTaskInfo; eventBuffer: AiTaskStreamEvent[] }>();
  private pendingPermissions = new Map<string, PermissionRequestEntry>();
  private permissionResponses = new Map<string, PermissionResponseEntry>();
  private maxConcurrent: number;
  private daemonPort: number;
  private apiKey: string;

  constructor(config: AiTaskManagerConfig) {
    this.maxConcurrent = config.maxConcurrent ?? MAX_CONCURRENT_AI_TASKS;
    this.daemonPort = config.daemonPort;
    this.apiKey = config.apiKey;
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
    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(process.env)) {
      if (val === undefined) continue;
      if (key.startsWith('CLAUDE') || key.startsWith('ANTHROPIC_') || key.startsWith('OTEL_') || key === 'MCP_') {
        continue;
      }
      env[key] = val;
    }

    // Set env vars for the permission hook script (also available via CLI args)
    env.LOOPSY_TASK_ID = taskId;
    env.LOOPSY_DAEMON_PORT = String(this.daemonPort);
    env.LOOPSY_API_KEY = this.apiKey;

    // Create a per-task temp directory with .claude/settings.local.json
    // containing the PreToolUse hook config with task-specific args baked in.
    // This ensures the hook receives the task ID even though Claude Code
    // doesn't propagate parent env vars to hook subprocesses.
    const hookScriptPath = this.getHookScriptPath();
    const taskCwd = params.cwd || process.cwd();
    const taskTmpDir = join(tmpdir(), `loopsy-task-${taskId}`);
    const claudeSettingsDir = join(taskTmpDir, '.claude');
    mkdirSync(claudeSettingsDir, { recursive: true });
    writeFileSync(join(claudeSettingsDir, 'settings.local.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: '',
          hooks: [{
            type: 'command',
            command: `node ${hookScriptPath} ${taskId} ${this.daemonPort} ${this.apiKey}`,
            timeout: 300,
          }],
        }],
      },
    }, null, 2));
    // Also write a CLAUDE.md that tells Claude the actual working directory
    writeFileSync(join(taskTmpDir, 'CLAUDE.md'),
      `Your actual working directory is: ${taskCwd}\n` +
      `Always use absolute paths rooted at ${taskCwd} for all file operations.\n`);

    // Grant access to the actual working directory
    args.push('--add-dir', taskCwd);

    // Use node-pty to spawn with a pseudo-TTY
    // Claude CLI (Bun runtime) buffers stdout when connected to a pipe;
    // a PTY ensures real-time streaming output
    let spawnFile: string;
    let spawnArgs: string[];
    if (process.platform === 'win32') {
      // On Windows, .cmd files must be spawned via cmd.exe for ConPTY to work
      spawnFile = 'cmd.exe';
      spawnArgs = ['/c', claudePath, ...args];
    } else {
      // On macOS/Linux, resolve symlinks for node-pty
      try {
        spawnFile = realpathSync(claudePath);
      } catch {
        spawnFile = claudePath;
      }
      spawnArgs = args;
    }
    const proc = pty.spawn(spawnFile, spawnArgs, {
      name: 'xterm-256color',
      cols: process.platform === 'win32' ? 9999 : 32000, // ConPTY needs wide cols to avoid JSON line wrapping
      rows: 50,
      cwd: taskTmpDir,
      env,
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
      ptyProcess: proc,
      eventBuffer: [],
      subscribers: new Set(),
    };

    this.tasks.set(taskId, task);

    // Set timeout
    task.timeoutTimer = setTimeout(() => {
      this.cancel(taskId);
      this.emit(task, { type: 'error', taskId, timestamp: Date.now(), data: 'Task timed out' });
    }, DEFAULT_AI_TASK_TIMEOUT);

    // Buffer for incomplete lines from PTY
    let lineBuffer = '';

    // Parse PTY output — data arrives as chunks that may contain partial lines
    proc.onData((data: string) => {
      // Debug: log raw PTY data
      if (process.env.LOOPSY_DEBUG_PTY) {
        console.log(`[PTY ${taskId.slice(0,8)}] raw(${data.length}): ${JSON.stringify(data.slice(0, 300))}`);
      }
      // Strip ANSI before buffering to prevent escape sequences splitting JSON
      const cleaned = stripAnsi(data);
      lineBuffer += cleaned;
      const lines = lineBuffer.split('\n');
      // Keep the last element (may be incomplete)
      lineBuffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (process.env.LOOPSY_DEBUG_PTY) {
          console.log(`[PTY ${taskId.slice(0,8)}] line(${line.length}): ${line.slice(0, 100)}...`);
        }
        try {
          const parsed = JSON.parse(line);
          this.handleClaudeEvent(task, parsed);
        } catch (err) {
          if (process.env.LOOPSY_DEBUG_PTY) {
            console.log(`[PTY ${taskId.slice(0,8)}] JSON parse fail: ${(err as Error).message}, line starts: ${JSON.stringify(line.slice(0, 80))}`);
          }
          // Non-JSON line — forward as text
          if (line.length > 0) {
            this.emit(task, { type: 'text', taskId, timestamp: Date.now(), data: line });
          }
        }
      }
    });

    // Handle process exit
    proc.onExit(({ exitCode, signal }) => {
      // Process any remaining buffered data
      if (lineBuffer.trim()) {
        const line = stripAnsi(lineBuffer).trim();
        if (line) {
          try {
            const parsed = JSON.parse(line);
            this.handleClaudeEvent(task, parsed);
          } catch {
            if (line.length > 0) {
              this.emit(task, { type: 'text', taskId, timestamp: Date.now(), data: line });
            }
          }
        }
        lineBuffer = '';
      }

      if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
      info.exitCode = exitCode;
      info.completedAt = Date.now();
      info.updatedAt = Date.now();
      info.status = exitCode === 0 ? 'completed' : (signal ? 'cancelled' : 'failed');
      if (exitCode !== 0 && !info.error) {
        info.error = signal ? `Killed by signal ${signal}` : `Exit code ${exitCode}`;
      }
      this.emit(task, { type: 'exit', taskId, timestamp: Date.now(), data: { exitCode, signal } });

      // Move to recent tasks (preserve event buffer) and clean up
      this.recentTasks.set(taskId, { info: { ...info }, eventBuffer: [...task.eventBuffer] });
      this.tasks.delete(taskId);
      setTimeout(() => this.recentTasks.delete(taskId), 300_000); // keep 5 min

      // Clean up per-task temp directory
      try { rmSync(taskTmpDir, { recursive: true, force: true }); } catch {}
    });

    // Emit initial status
    this.emit(task, { type: 'status', taskId, timestamp: now, data: { status: 'running' } });

    return { ...info };
  }

  /**
   * Register a permission request from the hook script.
   * Called by POST /ai-tasks/:taskId/permission-request
   */
  registerPermissionRequest(taskId: string, request: Omit<PermissionRequestEntry, 'taskId' | 'timestamp'>): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    const entry: PermissionRequestEntry = {
      ...request,
      taskId,
      timestamp: Date.now(),
    };

    this.pendingPermissions.set(request.requestId, entry);

    // Update task status
    const approval: AiTaskApprovalRequest = {
      toolName: request.toolName,
      toolInput: request.toolInput,
      requestId: request.requestId,
      timestamp: entry.timestamp,
      description: request.description,
    };
    task.info.status = 'waiting_approval';
    task.info.pendingApproval = approval;
    task.info.updatedAt = entry.timestamp;

    // Emit SSE event for dashboard
    this.emit(task, {
      type: 'permission_request',
      taskId,
      timestamp: entry.timestamp,
      data: approval,
    });

    return true;
  }

  /**
   * Resolve a pending permission request (approve or deny).
   * Called by POST /ai-tasks/:taskId/approve
   */
  resolvePermission(taskId: string, requestId: string, approved: boolean, message?: string): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || pending.taskId !== taskId) return false;

    const response: PermissionResponseEntry = {
      requestId,
      approved,
      message,
      resolvedAt: Date.now(),
    };

    this.permissionResponses.set(requestId, response);
    this.pendingPermissions.delete(requestId);

    // Update task status
    const task = this.tasks.get(taskId);
    if (task) {
      task.info.status = 'running';
      task.info.pendingApproval = undefined;
      task.info.updatedAt = Date.now();

      this.emit(task, {
        type: 'status',
        taskId,
        timestamp: Date.now(),
        data: { status: 'running', approved },
      });
    }

    // Clean up response after 60s (hook should have polled by then)
    setTimeout(() => this.permissionResponses.delete(requestId), 60_000);

    return true;
  }

  /**
   * Get the permission response for a given requestId (polled by hook script).
   * Returns null if not yet resolved.
   */
  getPermissionResponse(taskId: string, requestId: string): PermissionResponseEntry | null {
    const response = this.permissionResponses.get(requestId);
    if (!response) return null;
    return response;
  }

  /**
   * Legacy approve method — now delegates to resolvePermission.
   */
  approve(taskId: string, response: AiTaskApprovalResponse & { message?: string }): boolean {
    return this.resolvePermission(taskId, response.requestId, response.approved, response.message);
  }

  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    task.info.status = 'cancelled';
    task.info.updatedAt = Date.now();
    task.ptyProcess.kill('SIGTERM');
    setTimeout(() => {
      if (this.tasks.has(taskId)) {
        try { task.ptyProcess.kill('SIGKILL'); } catch {}
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
      try { task.ptyProcess.kill('SIGKILL'); } catch {}
      if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
      this.tasks.delete(id);
    }
  }

  /**
   * Get the absolute path to the permission hook script.
   * Used by external callers (e.g. hook installer).
   */
  getHookScriptPath(): string {
    // In the built output, hook lives at dist/hooks/permission-hook.mjs
    // relative to dist/services/ai-task-manager.js
    const thisFile = fileURLToPath(import.meta.url);
    return join(dirname(thisFile), '..', 'hooks', 'permission-hook.mjs');
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
      // Claude CLI stream-json wraps content in message.content[]
      const content = parsed.message?.content || [];
      for (const block of content) {
        if (block.type === 'thinking') {
          this.emit(task, { type: 'thinking', taskId, timestamp: ts, data: block.thinking || '' });
        } else if (block.type === 'text') {
          this.emit(task, { type: 'text', taskId, timestamp: ts, data: block.text || '' });
        }
      }
      // Also handle flat format (content_block_delta)
      if (content.length === 0) {
        const subtype = parsed.subtype || parsed.delta?.type;
        if (subtype === 'thinking' || subtype === 'thinking_delta') {
          this.emit(task, { type: 'thinking', taskId, timestamp: ts, data: parsed.text || parsed.delta?.thinking || '' });
        } else if (parsed.text || parsed.delta?.text) {
          this.emit(task, { type: 'text', taskId, timestamp: ts, data: parsed.text || parsed.delta?.text || '' });
        }
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
      this.emit(task, { type: 'result', taskId, timestamp: ts, data: { text: parsed.result, cost: parsed.total_cost_usd, duration: parsed.duration_ms } });
    } else if (cliType === 'error') {
      task.info.error = parsed.message || parsed.error || JSON.stringify(parsed);
      this.emit(task, { type: 'error', taskId, timestamp: ts, data: parsed.message || parsed.error || parsed });
    } else if (cliType === 'system') {
      // System init/status — emit as system event with structured data
      this.emit(task, { type: 'system', taskId, timestamp: ts, data: parsed });
    } else if (cliType === 'rate_limit_event') {
      // Rate limit info — silently ignore (not useful for consumers)
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
