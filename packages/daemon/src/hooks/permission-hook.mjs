#!/usr/bin/env node

// Loopsy PreToolUse Hook for Claude Code
//
// This script is invoked by Claude Code's PreToolUse hook mechanism.
// It fires before every tool use (including in -p mode), registers the
// permission request with the Loopsy daemon, and polls until the human
// approves/denies via the dashboard.
//
// Exit codes:
//   0 + JSON stdout  → allow or deny (via permissionDecision in hookSpecificOutput)
//
// Usage (command-line args embedded by daemon in per-task settings):
//   node permission-hook.mjs <taskId> <port> <apiKey>

// Support both CLI args and env vars
const taskId = process.argv[2] || process.env.LOOPSY_TASK_ID;
const port = process.argv[3] || process.env.LOOPSY_DAEMON_PORT || '19532';
const apiKey = process.argv[4] || process.env.LOOPSY_API_KEY;
const baseUrl = `http://127.0.0.1:${port}`;

function allow() {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Approved via Loopsy dashboard',
    },
  }));
  process.exit(0);
}

import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const logFile = join(tmpdir(), 'loopsy-hook-debug.log');

function log(msg) {
  try { appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

function deny(reason) {
  log(`DENY: ${reason}`);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason || 'Denied via Loopsy dashboard',
    },
  }));
  process.exit(0);
}

// If no task ID, this is a normal Claude session — no-op (allow all)
if (!taskId) {
  process.stdout.write('{}');
  process.exit(0);
}

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    // On Windows, Claude Code may not pipe stdin to hook subprocesses (upstream bug).
    // If stdin is empty, fall back to env vars for task context and use 'unknown' tool name.
    let hookInput;
    try {
      hookInput = input.trim() ? JSON.parse(input) : {};
    } catch {
      log(`Failed to parse stdin (${input.length} bytes), treating as empty`);
      hookInput = {};
    }
    const toolName = hookInput.tool_name || 'unknown';
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Register permission request with the daemon
    log(`Hook invoked: tool=${toolName} taskId=${taskId} port=${port} baseUrl=${baseUrl}`);
    let registerRes;
    try {
      registerRes = await fetch(`${baseUrl}/api/v1/ai-tasks/${taskId}/permission-request`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requestId,
          toolName,
          toolInput: hookInput.tool_input || {},
          description: `Claude wants to use: ${toolName}`,
        }),
      });
    } catch (fetchErr) {
      deny(`Failed to connect to daemon at ${baseUrl}: ${fetchErr.message}`);
      return;
    }

    log(`Register response: status=${registerRes.status}`);
    if (!registerRes.ok) {
      let body = '';
      try { body = await registerRes.text(); } catch {}
      deny(`Failed to register: HTTP ${registerRes.status} ${body}`);
      return;
    }
    log(`Permission request registered, polling for response...`);

    // Poll for decision (100ms interval, 5min timeout)
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));

      try {
        const res = await fetch(
          `${baseUrl}/api/v1/ai-tasks/${taskId}/permission-response?requestId=${requestId}`,
          { headers: { 'Authorization': `Bearer ${apiKey}` } },
        );
        if (!res.ok) continue;

        const data = await res.json();
        if (data.resolved) {
          if (data.approved) {
            allow();
          } else {
            deny(data.message || 'Denied by user');
          }
          return;
        }
      } catch {
        // Network error during poll — keep trying
      }
    }

    deny('Permission request timed out (5 minutes)');
  } catch (err) {
    deny(`Hook error: ${err.message}`);
  }
});
