#!/usr/bin/env node

// Loopsy PreToolUse Hook for Claude Code
//
// This script is invoked by Claude Code's PreToolUse hook mechanism.
// It fires before every tool use (including in -p mode), registers the
// permission request with the Loopsy daemon, and polls until the human
// approves/denies via the dashboard.
//
// Usage (env vars set by daemon at spawn time):
//   LOOPSY_TASK_ID      - The AI task ID
//   LOOPSY_DAEMON_PORT  - The daemon's HTTP port
//   LOOPSY_API_KEY      - API key for authenticating with the daemon
//
// OR command-line args (embedded by daemon in per-task settings):
//   node permission-hook.mjs <taskId> <port> <apiKey>

// Support both env vars and CLI args
const taskId = process.argv[2] || process.env.LOOPSY_TASK_ID;
const port = process.argv[3] || process.env.LOOPSY_DAEMON_PORT || '19532';
const apiKey = process.argv[4] || process.env.LOOPSY_API_KEY;
const baseUrl = `http://127.0.0.1:${port}`;

// If no task ID, this is a normal Claude session — no-op
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
      // If we can't reach the daemon, deny for safety
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          permissionDecision: 'deny',
          permissionDecisionReason: 'Failed to register permission request with daemon',
        },
      }));
      process.exit(0);
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
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              permissionDecision: data.approved ? 'allow' : 'deny',
              permissionDecisionReason: data.message || '',
            },
          }));
          process.exit(0);
        }
      } catch {
        // Network error during poll — keep trying
      }
    }

    // Timeout → deny
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'Permission request timed out (5 minutes)',
      },
    }));
    process.exit(0);
  } catch (err) {
    // Parse error or unexpected failure → deny
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: `Hook error: ${err.message}`,
      },
    }));
    process.exit(0);
  }
});
