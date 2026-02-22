#!/usr/bin/env node

// Loopsy PreToolUse Hook for Claude Code
//
// This script is invoked by Claude Code's PreToolUse hook mechanism.
// It fires before every tool use (including in -p mode), registers the
// permission request with the Loopsy daemon, and polls until the human
// approves/denies via the dashboard.
//
// Exit codes:
//   0 + JSON stdout  → allow (Claude proceeds with tool)
//   2 + stderr text  → deny (Claude blocks tool, stderr shown as error)
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
      permissionDecision: 'allow',
    },
  }));
  process.exit(0);
}

function deny(reason) {
  process.stderr.write(reason || 'Denied');
  process.exit(2);
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
    const hookInput = JSON.parse(input);
    const toolName = hookInput.tool_name || 'unknown';
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Register permission request with the daemon
    const registerRes = await fetch(`${baseUrl}/api/v1/ai-tasks/${taskId}/permission-request`, {
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

    if (!registerRes.ok) {
      deny('Failed to register permission request with daemon');
      return;
    }

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
