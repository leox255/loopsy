#!/usr/bin/env node

// Loopsy PermissionRequest Hook for Claude Code
//
// This script is invoked by Claude Code's PermissionRequest hook mechanism.
// It receives the permission request on stdin, registers it with the Loopsy
// daemon, and polls until the human approves/denies via the dashboard.
//
// Environment variables (set by the daemon at spawn time):
//   LOOPSY_TASK_ID      - The AI task ID
//   LOOPSY_DAEMON_PORT  - The daemon's HTTP port
//   LOOPSY_API_KEY      - API key for authenticating with the daemon

const taskId = process.env.LOOPSY_TASK_ID;
const port = process.env.LOOPSY_DAEMON_PORT || '19532';
const apiKey = process.env.LOOPSY_API_KEY;
const baseUrl = `http://127.0.0.1:${port}`;

// If LOOPSY_TASK_ID is not set, this is a normal Claude session — exit immediately (no-op)
if (!taskId) {
  // Return empty object so Claude continues with default behavior
  process.stdout.write('{}');
  process.exit(0);
}

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const hookInput = JSON.parse(input);
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
        toolName: hookInput.tool_name || 'unknown',
        toolInput: hookInput.tool_input || {},
        description: `Claude wants to use: ${hookInput.tool_name || 'a tool'}`,
      }),
    });

    if (!registerRes.ok) {
      // If we can't reach the daemon, deny for safety
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: 'Failed to register permission request with daemon' },
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
              hookEventName: 'PermissionRequest',
              decision: {
                behavior: data.approved ? 'allow' : 'deny',
                message: data.message || '',
              },
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
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Permission request timed out (5 minutes)' },
      },
    }));
    process.exit(0);
  } catch (err) {
    // Parse error or unexpected failure → deny
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: `Hook error: ${err.message}` },
      },
    }));
    process.exit(0);
  }
});
