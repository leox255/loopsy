import { randomUUID } from 'node:crypto';
import { realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import * as pty from 'node-pty';
import { which } from '../utils/which.js';
import type {
  AiTaskParams,
  AiTaskInfo,
  AiTaskStatus,
  AiTaskApprovalRequest,
  AiTaskApprovalResponse,
  AiTaskStreamEvent,
  AiAgent,
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

type ResolvedAgent = 'claude' | 'gemini' | 'codex';
type EventCallback = (event: AiTaskStreamEvent) => void;

interface AiTask {
  info: AiTaskInfo;
  ptyProcess?: pty.IPty;
  childProcess?: ChildProcess;
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

  /** Auto-detect the first available agent CLI */
  private async detectAgent(): Promise<ResolvedAgent> {
    for (const agent of ['claude', 'gemini', 'codex'] as const) {
      const path = await which(agent);
      if (path) return agent;
    }
    throw new LoopsyError(
      LoopsyErrorCode.AI_TASK_AGENT_NOT_FOUND,
      'No AI agent CLI found in PATH. Install claude-code, gemini-cli, or codex-cli.',
    );
  }

  /** Build CLI args for Claude */
  private buildClaudeArgs(params: AiTaskParams): string[] {
    const args = ['-p', params.prompt, '--output-format', 'stream-json', '--verbose'];

    if (params.permissionMode) {
      args.push('--permission-mode', params.permissionMode);
      if (params.permissionMode === 'bypassPermissions') {
        args.push('--dangerously-skip-permissions');
      }
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

    return args;
  }

  /** Build CLI args for Gemini CLI */
  private buildGeminiArgs(params: AiTaskParams): string[] {
    const args = ['-p', params.prompt, '--output-format', 'stream-json'];

    if (params.permissionMode === 'bypassPermissions') {
      args.push('--yolo');
    } else if (params.permissionMode === 'acceptEdits') {
      args.push('--approval-mode', 'auto_edit');
    }
    if (params.model) {
      args.push('-m', params.model);
    }
    if (params.additionalArgs?.length) {
      args.push(...params.additionalArgs);
    }

    return args;
  }

  /** Build CLI args for Codex CLI */
  private buildCodexArgs(params: AiTaskParams): string[] {
    const args = ['exec', params.prompt, '--json', '--skip-git-repo-check'];

    if (params.permissionMode === 'bypassPermissions' || params.permissionMode === 'acceptEdits') {
      args.push('--full-auto');
    }
    if (params.model) {
      args.push('-m', params.model);
    }
    if (params.cwd) {
      args.push('--cd', params.cwd);
    }
    if (params.additionalArgs?.length) {
      args.push(...params.additionalArgs);
    }

    return args;
  }

  /** Build a sanitized env for the given agent */
  private buildEnv(agent: ResolvedAgent, taskId: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(process.env)) {
      if (val === undefined) continue;

      // Per-agent env stripping
      switch (agent) {
        case 'claude':
          if (key.startsWith('CLAUDE') || key.startsWith('ANTHROPIC_') || key.startsWith('OTEL_') || key === 'MCP_') continue;
          break;
        case 'gemini':
          if (key.startsWith('GEMINI_') && key !== 'GEMINI_API_KEY') continue;
          break;
        case 'codex':
          if (key.startsWith('CODEX_') && key !== 'CODEX_API_KEY') continue;
          break;
      }
      env[key] = val;
    }

    // Loopsy task env vars
    env.LOOPSY_TASK_ID = taskId;
    env.LOOPSY_DAEMON_PORT = String(this.daemonPort);
    env.LOOPSY_API_KEY = this.apiKey;

    return env;
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

    // Resolve agent
    const agentParam = params.agent || 'auto';
    const resolvedAgent: ResolvedAgent = agentParam === 'auto'
      ? await this.detectAgent()
      : agentParam;

    // Find CLI binary
    const cliPath = await which(resolvedAgent);
    if (!cliPath) {
      const errorCode = resolvedAgent === 'claude'
        ? LoopsyErrorCode.AI_TASK_CLAUDE_NOT_FOUND
        : LoopsyErrorCode.AI_TASK_AGENT_NOT_FOUND;
      throw new LoopsyError(errorCode, `${resolvedAgent} CLI not found in PATH`);
    }

    const taskId = randomUUID();
    const now = Date.now();

    // Build per-agent CLI args
    let args: string[];
    switch (resolvedAgent) {
      case 'claude':
        args = this.buildClaudeArgs(params);
        break;
      case 'gemini':
        args = this.buildGeminiArgs(params);
        break;
      case 'codex':
        args = this.buildCodexArgs(params);
        break;
    }

    // Build sanitized env
    const env = this.buildEnv(resolvedAgent, taskId);

    const isBypass = params.permissionMode === 'bypassPermissions';
    const taskCwd = params.cwd || homedir();
    const taskTmpDir = join(tmpdir(), `loopsy-task-${taskId}`);
    let spawnCwd: string;

    // Permission hook setup — Claude only, non-bypass mode
    if (resolvedAgent === 'claude' && !isBypass) {
      const hookScriptPath = this.getHookScriptPath();
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
      writeFileSync(join(taskTmpDir, 'CLAUDE.md'),
        `Your actual working directory is: ${taskCwd}\n` +
        `Always use absolute paths rooted at ${taskCwd} for all file operations.\n`);

      args.push('--add-dir', taskCwd);
      if (homedir() !== taskCwd) {
        args.push('--add-dir', homedir());
      }
      spawnCwd = taskTmpDir;
    } else {
      mkdirSync(taskTmpDir, { recursive: true });
      spawnCwd = taskCwd;
    }

    // Spawn the process
    let ptyProcess: pty.IPty | undefined;
    let childProcess: ChildProcess | undefined;
    let pid: number | undefined;

    if (resolvedAgent === 'claude') {
      // Claude needs PTY (Bun runtime buffers stdout on pipes)
      let spawnFile: string;
      let spawnArgs: string[];
      if (process.platform === 'win32') {
        spawnFile = 'cmd.exe';
        spawnArgs = ['/c', cliPath, ...args];
      } else {
        try {
          spawnFile = realpathSync(cliPath);
        } catch {
          spawnFile = cliPath;
        }
        spawnArgs = args;
      }
      ptyProcess = pty.spawn(spawnFile, spawnArgs, {
        name: 'xterm-256color',
        cols: process.platform === 'win32' ? 9999 : 32000,
        rows: 50,
        cwd: spawnCwd,
        env,
      });
      pid = ptyProcess.pid;
    } else {
      // Gemini and Codex use child_process.spawn
      childProcess = spawn(cliPath, args, {
        cwd: spawnCwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      pid = childProcess.pid;
    }

    const info: AiTaskInfo = {
      taskId,
      prompt: params.prompt,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      fromNodeId,
      pid,
      model: params.model,
      agent: resolvedAgent,
    };

    const task: AiTask = {
      info,
      ptyProcess,
      childProcess,
      eventBuffer: [],
      subscribers: new Set(),
    };

    this.tasks.set(taskId, task);

    // Set timeout
    task.timeoutTimer = setTimeout(() => {
      this.cancel(taskId);
      this.emit(task, { type: 'error', taskId, timestamp: Date.now(), data: 'Task timed out' });
    }, DEFAULT_AI_TASK_TIMEOUT);

    // Buffer for incomplete lines
    let lineBuffer = '';

    const processLine = (line: string) => {
      if (!line) return;
      if (process.env.LOOPSY_DEBUG_PTY) {
        console.log(`[${resolvedAgent.toUpperCase()} ${taskId.slice(0,8)}] line(${line.length}): ${line.slice(0, 100)}...`);
      }
      try {
        const parsed = JSON.parse(line);
        switch (resolvedAgent) {
          case 'claude':
            this.handleClaudeEvent(task, parsed);
            break;
          case 'gemini':
            this.handleGeminiEvent(task, parsed);
            break;
          case 'codex':
            this.handleCodexEvent(task, parsed);
            break;
        }
      } catch (err) {
        if (process.env.LOOPSY_DEBUG_PTY) {
          console.log(`[${resolvedAgent.toUpperCase()} ${taskId.slice(0,8)}] JSON parse fail: ${(err as Error).message}, line starts: ${JSON.stringify(line.slice(0, 80))}`);
        }
        if (line.length > 0) {
          this.emit(task, { type: 'text', taskId, timestamp: Date.now(), data: line });
        }
      }
    };

    const processChunk = (data: string, needsAnsiStrip: boolean) => {
      if (process.env.LOOPSY_DEBUG_PTY) {
        console.log(`[${resolvedAgent.toUpperCase()} ${taskId.slice(0,8)}] raw(${data.length}): ${JSON.stringify(data.slice(0, 300))}`);
      }
      const cleaned = needsAnsiStrip ? stripAnsi(data) : data;
      lineBuffer += cleaned;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line) processLine(line);
      }
    };

    const handleExit = (exitCode: number | null, signal?: number | null) => {
      // Process remaining buffer
      if (lineBuffer.trim()) {
        const line = (resolvedAgent === 'claude' ? stripAnsi(lineBuffer) : lineBuffer).trim();
        if (line) processLine(line);
        lineBuffer = '';
      }

      if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
      info.exitCode = exitCode;
      info.completedAt = Date.now();
      info.updatedAt = Date.now();
      info.status = exitCode === 0 ? 'completed' : (signal ? 'cancelled' : 'failed');
      info.pendingApproval = undefined;
      if (exitCode !== 0 && !info.error) {
        info.error = signal ? `Killed by signal ${signal}` : `Exit code ${exitCode}`;
      }
      this.emit(task, { type: 'exit', taskId, timestamp: Date.now(), data: { exitCode, signal } });

      this.recentTasks.set(taskId, { info: { ...info }, eventBuffer: [...task.eventBuffer] });
      this.tasks.delete(taskId);

      try { rmSync(taskTmpDir, { recursive: true, force: true }); } catch {}
    };

    if (ptyProcess) {
      // PTY data handler (Claude)
      ptyProcess.onData((data: string) => processChunk(data, true));
      ptyProcess.onExit(({ exitCode, signal }) => handleExit(exitCode, signal));
    } else if (childProcess) {
      // child_process data handler (Gemini/Codex)
      childProcess.stdout!.on('data', (data: Buffer) => processChunk(data.toString(), false));
      childProcess.stderr!.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
          this.emit(task, { type: 'text', taskId, timestamp: Date.now(), data: text });
        }
      });
      childProcess.on('exit', (code, signal) => {
        const sigNum = signal ? (({ SIGTERM: 15, SIGKILL: 9 } as Record<string, number>)[signal] || 1) : null;
        handleExit(code ?? null, sigNum);
      });
    }

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

    if (task.ptyProcess) {
      task.ptyProcess.kill('SIGTERM');
      setTimeout(() => {
        if (this.tasks.has(taskId)) {
          try { task.ptyProcess!.kill('SIGKILL'); } catch {}
        }
      }, 5000);
    } else if (task.childProcess) {
      task.childProcess.kill('SIGTERM');
      setTimeout(() => {
        if (this.tasks.has(taskId)) {
          try { task.childProcess!.kill('SIGKILL'); } catch {}
        }
      }, 5000);
    }

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
      try {
        if (task.ptyProcess) task.ptyProcess.kill('SIGKILL');
        else if (task.childProcess) task.childProcess.kill('SIGKILL');
      } catch {}
      if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
      this.tasks.delete(id);
    }
  }

  deleteTask(taskId: string): boolean {
    // Delete a completed/failed task from the recent tasks store
    if (this.recentTasks.has(taskId)) {
      this.recentTasks.delete(taskId);
      return true;
    }
    return false;
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
      // Ignored here — the PreToolUse hook (permission-hook.mjs) handles
      // permission requests via the /permission-request endpoint. Emitting
      // a second event from stream-json would create duplicate approval
      // banners with mismatched requestIds, causing approvals to fail.
    } else if (cliType === 'result') {
      // Capture session ID for follow-up conversations
      if (parsed.session_id) {
        task.info.sessionId = parsed.session_id;
      }
      this.emit(task, { type: 'result', taskId, timestamp: ts, data: { text: parsed.result, cost: parsed.total_cost_usd, duration: parsed.duration_ms, sessionId: parsed.session_id } });
    } else if (cliType === 'error') {
      task.info.error = parsed.message || parsed.error || JSON.stringify(parsed);
      this.emit(task, { type: 'error', taskId, timestamp: ts, data: parsed.message || parsed.error || parsed });
    } else if (cliType === 'system') {
      // System init/status — emit as system event with structured data
      this.emit(task, { type: 'system', taskId, timestamp: ts, data: parsed });
    } else if (cliType === 'rate_limit_event' || cliType === 'user') {
      // Rate limit and user echo events — silently ignore
    } else {
      // Unknown event type — forward as-is
      this.emit(task, { type: 'text', taskId, timestamp: ts, data: JSON.stringify(parsed) });
    }
  }

  private handleGeminiEvent(task: AiTask, parsed: any): void {
    const taskId = task.info.taskId;
    const ts = Date.now();
    const cliType = parsed.type;

    if (cliType === 'init') {
      this.emit(task, { type: 'system', taskId, timestamp: ts, data: parsed });
    } else if (cliType === 'message') {
      // Extract text from content blocks
      const content = parsed.content || parsed.message?.content || [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' || block.text) {
            this.emit(task, { type: 'text', taskId, timestamp: ts, data: block.text || '' });
          }
        }
      } else if (typeof content === 'string') {
        this.emit(task, { type: 'text', taskId, timestamp: ts, data: content });
      } else if (parsed.text) {
        this.emit(task, { type: 'text', taskId, timestamp: ts, data: parsed.text });
      }
    } else if (cliType === 'tool_use') {
      this.emit(task, { type: 'tool_use', taskId, timestamp: ts, data: { name: parsed.name, input: parsed.input } });
    } else if (cliType === 'tool_result') {
      this.emit(task, { type: 'tool_result', taskId, timestamp: ts, data: { name: parsed.name, content: parsed.content, output: parsed.output } });
    } else if (cliType === 'result') {
      this.emit(task, { type: 'result', taskId, timestamp: ts, data: { text: parsed.response || parsed.result, cost: parsed.stats?.cost, duration: parsed.stats?.duration_ms } });
    } else if (cliType === 'error') {
      task.info.error = parsed.message || parsed.error || JSON.stringify(parsed);
      this.emit(task, { type: 'error', taskId, timestamp: ts, data: parsed.message || parsed.error || parsed });
    } else {
      // Forward unknown events as text
      this.emit(task, { type: 'text', taskId, timestamp: ts, data: JSON.stringify(parsed) });
    }
  }

  private handleCodexEvent(task: AiTask, parsed: any): void {
    const taskId = task.info.taskId;
    const ts = Date.now();
    const cliType = parsed.type;

    if (cliType === 'thread.started') {
      this.emit(task, { type: 'system', taskId, timestamp: ts, data: parsed });
    } else if (cliType === 'item.completed') {
      const item = parsed.item || parsed;
      const itemType = item.type || item.item_type;

      if (itemType === 'agent_message' || itemType === 'message') {
        const text = item.content || item.text || '';
        if (text) this.emit(task, { type: 'text', taskId, timestamp: ts, data: text });
      } else if (itemType === 'reasoning') {
        const text = item.content || item.text || '';
        if (text) this.emit(task, { type: 'thinking', taskId, timestamp: ts, data: text });
      } else if (itemType === 'command_execution') {
        this.emit(task, { type: 'tool_use', taskId, timestamp: ts, data: { name: 'command', input: { command: item.command || item.input } } });
        if (item.output || item.result) {
          this.emit(task, { type: 'tool_result', taskId, timestamp: ts, data: { name: 'command', content: item.output || item.result } });
        }
      } else if (itemType === 'file_change') {
        this.emit(task, { type: 'tool_use', taskId, timestamp: ts, data: { name: 'file_change', input: { file: item.file || item.path, action: item.action } } });
      } else if (itemType === 'mcp_tool_call') {
        this.emit(task, { type: 'tool_use', taskId, timestamp: ts, data: { name: item.tool_name || item.name, input: item.input || item.arguments } });
      }
    } else if (cliType === 'error') {
      task.info.error = parsed.message || parsed.error || JSON.stringify(parsed);
      this.emit(task, { type: 'error', taskId, timestamp: ts, data: parsed.message || parsed.error || parsed });
    } else if (cliType === 'turn.completed') {
      // Ignore — exit event handles completion
    } else {
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
