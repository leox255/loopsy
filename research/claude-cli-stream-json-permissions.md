# Claude Code CLI: stream-json Permission Request Events

**Date**: 2026-02-22
**Sources validated**: 4 independent official/authoritative sources

---

## TL;DR

The Claude Code CLI does NOT emit a `permission_request` event type on stdout in `--input-format stream-json` mode for runtime tool approval. The `-p` (print/non-interactive) mode has no built-in stdin-based interactive permission approval mechanism for the raw CLI stream. Instead, the official mechanism for programmatic permission control is the `--permission-prompt-tool` flag (pointing to an MCP server) or the Hooks system (`PermissionRequest` hook). The `-p` mode auto-denies tools that are not pre-approved via `--allowedTools` or `--dangerously-skip-permissions`.

---

## Key Findings

- **No `permission_request` stdout event exists** in `--output-format stream-json` output. The stream-json format emits event types such as `init`, `message`, `tool_use`, `tool_result`, `stream_event`, and `result` -- not runtime permission prompts.

- **`-p` mode does NOT support interactive stdin permission approval**. In non-interactive/print mode, tool uses that are not pre-approved are simply denied. This is confirmed by GitHub issue #9383 (permission approval UI not displayed, operations immediately rejected) and the Agent SDK spec.

- **The correct mechanism for programmatic permission approval** is the `--permission-prompt-tool <mcp_tool_name>` CLI flag, which delegates permission decisions to an MCP server tool. The MCP tool receives the permission request as structured input and returns an allow/deny decision.

- **The Hooks system** (`PermissionRequest` hook, `PreToolUse` hook) is the other official mechanism for intercepting and auto-approving/denying tool calls. Hooks receive JSON on stdin and emit JSON decisions on stdout -- but this is separate from the stream-json output channel.

- **`--input-format stream-json`** is for sending multi-turn prompts INTO Claude via stdin in stream-json format (e.g., for chaining Claude instances). It does not create a bidirectional permission approval channel.

---

## Detailed Findings

### 1. What `--output-format stream-json` Actually Emits

From official CLI reference and Agent SDK docs, stream-json output events include:

```json
// Session initialization
{ "type": "system", "subtype": "init", ... }

// Streaming text tokens (with --include-partial-messages)
{ "type": "stream_event", "event": { "delta": { "type": "text_delta", "text": "..." } } }

// Tool use invocation
{ "type": "assistant", "message": { "content": [{ "type": "tool_use", "name": "Bash", "input": {...} }] } }

// Tool result
{ "type": "tool_result", ... }

// Final result
{ "type": "result", "subtype": "success", "result": "...", "session_id": "..." }
```

There is NO `permission_request` event type in this stream. Permission denials appear after the fact in the result's `permission_denials` array.

Source: [Run Claude Code programmatically](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference)

### 2. What `--input-format stream-json` Is For

The `--input-format stream-json` flag is for SENDING structured input to Claude, not for receiving permission events. It allows piping JSON-formatted user messages into Claude, enabling Claude-to-Claude chaining (the output of one `claude -p` instance feeds into the input of another).

Example from docs:
```bash
claude -p "task A" --output-format stream-json | \
  claude -p --input-format stream-json "task B"
```

This is a unidirectional pipeline pattern. There is no documented bidirectional stdin/stdout protocol for runtime permission approval.

Source: [CLI reference](https://code.claude.com/docs/en/cli-reference), [Stream-JSON Chaining wiki](https://github.com/ruvnet/claude-flow/wiki/Stream-Chaining)

### 3. How `-p` Mode Handles Permissions

In `-p` (print/non-interactive) mode, permission behavior is determined BEFORE execution:

| Method | Effect |
|--------|--------|
| `--allowedTools "Bash,Read,Edit"` | Pre-approves specific tools; no prompt needed |
| `--allowedTools "Bash(git *)"` | Pre-approves tools with pattern matching |
| `--dangerously-skip-permissions` | Bypasses all permission checks |
| `--permission-mode bypassPermissions` | Same as above |
| `--permission-mode acceptEdits` | Auto-approves file edit operations |
| `--permission-prompt-tool <mcp>` | Delegates runtime decisions to an MCP server |
| (none of the above) | Tools not pre-approved are **auto-denied** |

The `-p` mode does NOT pause and wait for stdin input for permission approval. GitHub issue #9383 explicitly describes this behavior: "operations immediately rejected without user interaction."

Source: [Headless/programmatic docs](https://code.claude.com/docs/en/headless), [GitHub issue #9383](https://github.com/anthropics/claude-code/issues/9383)

### 4. The `--permission-prompt-tool` Mechanism (Closest to Runtime Approval)

For runtime permission decisions, the official pattern is:

```bash
claude -p "task" --permission-prompt-tool mcp__myserver__approve_tool
```

The MCP server tool named `approve_tool` receives a call when Claude needs permission, with input like:
```json
{
  "tool_use_id": "toolu_abc123",
  "tool_name": "Bash",
  "input": { "command": "rm -rf node_modules" }
}
```

The MCP tool returns:
```json
{
  "behavior": "allow",
  "updatedInput": { "command": "rm -rf node_modules" }
}
```
or:
```json
{
  "behavior": "deny",
  "message": "User denied this action"
}
```

This is NOT a stdin/stdout stream event -- it goes through the MCP protocol.

Source: [CLI reference --permission-prompt-tool](https://code.claude.com/docs/en/cli-reference), [Configure permissions](https://platform.claude.com/docs/en/agent-sdk/permissions), [lobehub MCP reference](https://lobehub.com/mcp/user-claude-code-permission-prompt-tool)

### 5. The Hooks System (`PermissionRequest` Hook)

For hook-based permission interception (configured in `.claude/settings.json`), the `PermissionRequest` hook fires when a permission dialog would appear. The hook script receives JSON on stdin:

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/project",
  "permission_mode": "default",
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": {
    "command": "rm -rf node_modules",
    "description": "Remove node_modules directory"
  },
  "permission_suggestions": [
    { "type": "toolAlwaysAllow", "tool": "Bash" }
  ]
}
```

The hook script outputs to stdout:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedInput": { "command": "rm -rf node_modules" }
    }
  }
}
```

Or to deny:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "This command is not allowed",
      "interrupt": false
    }
  }
}
```

The `PreToolUse` hook (fires before PermissionRequest) uses `permissionDecision` field:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Auto-approved by policy",
    "updatedInput": { "command": "npm test" }
  }
}
```
Values for `permissionDecision`: `"allow"`, `"deny"`, `"ask"`.

Source: [Hooks reference](https://code.claude.com/docs/en/hooks)

### 6. Python/TypeScript SDK `canUseTool` Callback

The Agent SDK (Python/TypeScript packages, not the raw CLI) supports a `canUseTool` callback for runtime per-tool approval:

```typescript
for await (const message of query({
  prompt: "Do the task",
  options: {
    canUseTool: async (toolName, input) => {
      if (toolName === "Bash") {
        const approved = await askUser(`Allow: ${input.command}?`);
        return approved
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: "User denied" };
      }
      return { behavior: "allow", updatedInput: input };
    }
  }
}))
```

This is only available when using the SDK packages, not the raw `claude` CLI binary with `--input-format stream-json`.

Source: [Handle approvals and user input](https://platform.claude.com/docs/en/agent-sdk/user-input)

---

## Conflicts/Uncertainties

- **Unconfirmed**: Whether the `--permission-prompt-tool stdio` variant (noted in some community posts) creates a proper stdin/stdout channel for permission approval without MCP. The flag appears in some examples as `--permission-prompt-tool stdio` but the official docs only document MCP tool names as valid values. This may be an undocumented or deprecated feature.

- **Bug history**: GitHub issue #9383 (closed) documents that permission approval was broken in some scenarios. A later comment mentions v2.0.30 fixed some modal issues. The exact current behavior for edge cases may vary by version.

- **Stream-chaining community implementations**: Some third-party implementations (e.g., `claude-flow`) claim to handle permission events in stream-json pipelines, but these appear to work via pre-configured `--allowedTools` flags rather than true runtime stdin approval.

---

## Relevance Notes

For Loopsy/multi-agent workflows using `claude -p`:

1. **Pre-approve all needed tools** with `--allowedTools` to avoid silent denials. This is the most reliable pattern.
2. **If runtime approval is needed**, use `--permission-prompt-tool` pointing to an MCP server that can make the decision programmatically (e.g., consult a Loopsy context key).
3. **Hooks** (`PermissionRequest`, `PreToolUse`) are the best approach for automated policy-based approval without human interaction.
4. **Do not expect** a `permission_request` event on stdout when using `--output-format stream-json` -- it does not exist in the protocol.
5. **For human-in-the-loop approval** in headless scenarios, the Python/TypeScript SDK's `canUseTool` callback is the designed mechanism, not raw CLI stdin.

---

## Sources

- [Run Claude Code programmatically (headless)](https://code.claude.com/docs/en/headless)
- [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Hooks reference](https://code.claude.com/docs/en/hooks)
- [Configure permissions (Agent SDK)](https://platform.claude.com/docs/en/agent-sdk/permissions)
- [Handle approvals and user input](https://platform.claude.com/docs/en/agent-sdk/user-input)
- [GitHub issue #9383: Permission approval UI not displayed](https://github.com/anthropics/claude-code/issues/9383)
- [Stream-JSON Chaining wiki](https://github.com/ruvnet/claude-flow/wiki/Stream-Chaining)
- [lobehub --permission-prompt-tool reference](https://lobehub.com/mcp/user-claude-code-permission-prompt-tool)

---

# Addendum: PermissionRequest Hook — Complete Specification

**Date:** 2026-02-22
**Sources:** [Hooks reference](https://code.claude.com/docs/en/hooks), [Hooks guide](https://code.claude.com/docs/en/hooks-guide)

## 1. Exact settings.json Structure

Hooks live under a top-level `"hooks"` key. Each event name maps to an array of **matcher groups**. Each matcher group contains a `"matcher"` regex and an inner `"hooks"` array of **handler objects**.

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/your-hook-script.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

**Matcher field behavior:**

- Matches against `tool_name` for `PermissionRequest`
- Supports regex: `"Edit|Write"`, `"mcp__.*"`, `"Bash"`
- Use `"*"`, `""`, or omit `matcher` entirely to match all tools

**Handler object fields:**

| Field | Required | Description |
|---|---|---|
| `type` | yes | `"command"`, `"prompt"`, or `"agent"` |
| `command` | yes (command type) | Shell command to execute |
| `timeout` | no | Seconds before cancel (default: 600 cmd, 30 prompt, 60 agent) |
| `statusMessage` | no | Spinner message shown while hook runs |
| `async` | no | `command` type only: run in background (cannot block) |

**Settings file locations:**

| File | Scope |
|---|---|
| `~/.claude/settings.json` | All projects (user-global) |
| `.claude/settings.json` | Current project (shareable via git) |
| `.claude/settings.local.json` | Current project (gitignored) |

## 2. PermissionRequest Does NOT Fire in `-p` Mode

**Official statement from the hooks-guide limitations section:**

> "PermissionRequest hooks do not fire in non-interactive mode (`-p`). Use `PreToolUse` hooks for automated permission decisions."

The troubleshooting section also says:

> "If using PermissionRequest hooks in non-interactive mode (`-p`), switch to `PreToolUse` instead."

In `-p` mode there are no permission dialogs, so the `PermissionRequest` event never fires. For automated approval in `-p` mode, use:
- `PreToolUse` hooks with `permissionDecision: "allow"` in `hookSpecificOutput`
- `--allowedTools "Bash,Read,Edit"` CLI flag (simplest approach)
- `--permission-prompt-tool <mcp_tool>` for dynamic runtime decisions

## 3. stdin Format the Hook Receives

PermissionRequest hooks receive the following JSON object on stdin:

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../transcript.jsonl",
  "cwd": "/Users/my-project",
  "permission_mode": "default",
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": {
    "command": "rm -rf node_modules",
    "description": "Remove node_modules directory"
  },
  "permission_suggestions": [
    { "type": "toolAlwaysAllow", "tool": "Bash" }
  ]
}
```

Differences from `PreToolUse`: no `tool_use_id` field. `permission_suggestions` is optional.

`permission_mode` values: `"default"`, `"plan"`, `"acceptEdits"`, `"dontAsk"`, `"bypassPermissions"`

## 4. stdout Format the Hook Should Return

**Exit code rules:**

- Exit 0 + JSON on stdout: Claude Code processes `hookSpecificOutput` for the decision
- Exit 0 + no JSON (or exit 0 only): no effect, Claude Code handles normally
- Exit 2: deny the permission; stderr text becomes the error message (JSON on stdout is IGNORED)
- Any other exit code: non-blocking error, stderr logged in verbose mode only

**To allow:**

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow"
    }
  }
}
```

**To allow and modify the tool's input:**

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedInput": {
        "command": "npm run lint"
      }
    }
  }
}
```

**To allow and set a persistent "always allow" rule:**

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedPermissions": { "type": "toolAlwaysAllow", "tool": "Bash" }
    }
  }
}
```

**To deny:**

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "This command is not permitted by policy",
      "interrupt": false
    }
  }
}
```

`interrupt: true` stops Claude entirely when denying.

**Decision field summary for `PermissionRequest`:**

| Field | Values | Notes |
|---|---|---|
| `behavior` | `"allow"` or `"deny"` | Required |
| `updatedInput` | object | `"allow"` only: modifies tool input before execution |
| `updatedPermissions` | object | `"allow"` only: sets a persistent permission rule |
| `message` | string | `"deny"` only: tells Claude why permission was denied |
| `interrupt` | boolean | `"deny"` only: if `true`, stops Claude entirely |

## 5. PermissionRequest vs PreToolUse — Key Differences

| Aspect | PermissionRequest | PreToolUse |
|---|---|---|
| When it fires | Only when a permission dialog would appear | Before every tool call, regardless of permission status |
| Fires in `-p` mode | NO | YES |
| Output field | `hookSpecificOutput.decision.behavior` | `hookSpecificOutput.permissionDecision` |
| Decision values | `"allow"` or `"deny"` | `"allow"`, `"deny"`, or `"ask"` |
| Has `tool_use_id` | No | Yes |

## 6. Complete Example Hook Script

```bash
#!/bin/bash
# permission-hook.sh

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name')
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Deny rm -rf unconditionally
if echo "$CMD" | grep -q 'rm -rf'; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message: "Destructive rm -rf commands are blocked by policy"
      }
    }
  }'
  exit 0
fi

# Allow everything else
jq -n '{
  hookSpecificOutput: {
    hookEventName: "PermissionRequest",
    decision: {
      behavior: "allow"
    }
  }
}'
exit 0
```

Note: exit 0 in all paths. JSON is only processed by Claude Code on exit 0.
