# PreToolUse Hook Denial Format - Claude Code

**Date**: 2026-02-22
**Source**: [Claude Code Hooks Reference - Code.claude.com](https://code.claude.com/docs/en/hooks)

## TL;DR

To deny a tool in a PreToolUse hook, return **exit code 0** with JSON containing `hookSpecificOutput` with `permissionDecision: "deny"` and `permissionDecisionReason`. Do NOT use exit code 2 for denials—exit code 2 is for blocking errors (and has the same effect but is meant for unstructured stderr responses).

## Key Findings

### Exact Denial Format

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Your reason here"
  }
}
```

**Critical points:**
1. **Exit code must be 0** (success), not 2
2. **Must use `hookSpecificOutput`** (nested object structure)
3. **Must include `hookEventName: "PreToolUse"`**
4. **Must set `permissionDecision: "deny"`** (exact string)
5. **Field name is `permissionDecisionReason`** (not `reason`, not `message`, not `permissionDecisionMessage`)

### Why Your Hook Isn't Working

Your current format returns exit code 0 with the JSON above, which should work. If the tool is still executing:

1. **Verify the hook is matching**: Check that your `matcher` is correctly targeting the tool name (e.g., `"Bash"`, `"Write"`, etc.)
2. **Verify stdout contains only JSON**: If your shell profile prints text on startup, it can interfere with JSON parsing. The documentation explicitly warns: "Your hook's stdout must contain only the JSON object."
3. **Check the `permissionDecision` value**: Must be exactly `"deny"`, case-sensitive. Deprecated values `"block"` and `"approve"` exist but are for older configs.

### Comparison: Allow vs Deny vs Ask

The same hook can express three outcomes:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",  // Allow without prompt
    "permissionDecisionReason": "Safe command"
  }
}
```

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",  // Block the tool
    "permissionDecisionReason": "Destructive command blocked by hook"
  }
}
```

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",  // Prompt user
    "permissionDecisionReason": "Needs user confirmation"
  }
}
```

### Exit Code Behavior

For PreToolUse hooks specifically:

- **Exit 0 with JSON**: Claude Code parses the JSON decision. If `permissionDecision: "deny"`, tool is blocked
- **Exit 2**: Also blocks the tool, but treats stderr as the reason (unstructured). JSON is ignored on exit 2
- **Any other exit code**: Non-blocking error, execution continues

**Recommendation**: Use exit code 0 + JSON for denials (more reliable and explicit)

### Official Example from Docs

From the Claude Code documentation's `block-rm.sh` example:

```bash
#!/bin/bash
COMMAND=$(jq -r '.tool_input.command')

if echo "$COMMAND" | grep -q 'rm -rf'; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Destructive command blocked by hook"
    }
  }'
else
  exit 0  # allow the command
fi
```

**Key detail**: Uses `jq -n` to output pure JSON (no shell text pollution)

## Debugging Steps

If denials aren't working:

1. **Check hook execution**: Run `claude --debug` to see which hooks matched and their exit codes
2. **Verify JSON output**: Ensure your script outputs ONLY valid JSON to stdout. Use `jq` or similar to construct JSON safely.
3. **Test the JSON**: Manually verify your JSON is valid (no syntax errors)
4. **Check matcher**: Ensure the matcher pattern matches your tool name. Run with `Ctrl+O` verbose mode to see hook details.

## Relevant Fields Reference

| Field | Required | Values | Purpose |
|-------|----------|--------|---------|
| `hookEventName` | Yes | `"PreToolUse"` | Identifies the event type |
| `permissionDecision` | Yes | `"allow"`, `"deny"`, `"ask"` | The decision |
| `permissionDecisionReason` | Yes for deny | String | Shown to Claude (for deny) or user (for allow/ask) |
| `updatedInput` | No | Object | Modify tool params (combine with allow) |
| `additionalContext` | No | String | Context added to Claude's conversation |

## Important Notes

- **Deprecated values**: Pre-2026 versions of Claude Code used `decision: "block"` and `reason` (top-level). These still work for some events but NOT for PreToolUse. PreToolUse specifically requires the `hookSpecificOutput` format with `permissionDecision`.
- **Not affected by permission mode**: PreToolUse denials work regardless of the current permission mode (`default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`).
- **Tool events only**: This format applies to all tool events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`.

## Source

https://code.claude.com/docs/en/hooks#pretooluse-decision-control
