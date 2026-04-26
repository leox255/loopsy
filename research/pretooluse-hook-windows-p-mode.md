# Research Brief: Claude Code PreToolUse Hooks on Windows in -p Mode

**Date:** 2026-02-22
**Researcher:** Research Agent (claude-sonnet-4-6)
**Topic:** Why Claude Code PreToolUse hooks do not fire on Windows when spawned with the `-p` flag

---

## TL;DR

Claude Code on Windows requires Git Bash to execute hook commands and depends on correctly passing stdin to hook subprocesses. Multiple independent bugs exist on Windows that collectively prevent hooks from ever firing in `-p` (non-interactive) mode. The Loopsy daemon spawns Claude via `cmd.exe` via `node-pty` on Windows, which means Git Bash is almost certainly not available to Claude for hook execution, and stdin piping to hook subprocesses is broken on Windows specifically. The settings file path itself is likely correct (`%USERPROFILE%\.claude\settings.json`), but hook execution never reaches the subprocess.

---

## Key Findings

### 1. Windows Hooks Require Git Bash — cmd.exe Cannot Execute Hook Scripts

The single most impactful root cause: **Claude Code uses Git Bash (`bash.exe`) to execute all hook commands on Windows**. Hook scripts written with Unix shell syntax (including `.sh` files, `$HOME`, `node`, etc.) will fail silently or with `'$HOME' is not recognized as an internal or external command` when Claude Code is launched from a context where Git Bash is not available.

- Claude Code attempts to auto-detect Git Bash at startup, but the detection uses the full path (e.g. `D:\Program Files\Git\bin\bash.exe`) internally while actually invoking just `bash` in hook subprocesses — which fails when `Git\bin` is not in `PATH`.
- The recommended Git for Windows installation adds `Git\cmd` to PATH but NOT `Git\bin`, so `bash` is not on PATH.
- Workaround: Set `CLAUDE_CODE_GIT_BASH_PATH=C:\Program Files\Git\bin\bash.exe` in the environment before launching Claude Code.
- **For Loopsy on Windows:** The daemon sets a sanitized env for Claude (line 156-181 of `ai-task-manager.ts`), which strips env keys starting with `CLAUDE`. This means `CLAUDE_CODE_GIT_BASH_PATH` is **actively stripped** from the environment, so even if the user has it set system-wide, it would be removed before Claude spawns.

Source: [Issue #16602](https://github.com/anthropics/claude-code/issues/16602), [Issue #22700](https://github.com/anthropics/claude-code/issues/22700), [Issue #3461](https://github.com/anthropics/claude-code/issues/3461)

### 2. Windows Hooks: stdin Is Not Passed to Hook Subprocess Commands

A separate, critical Windows-specific bug: **Claude Code on Windows does not pass stdin data to hook commands**. Since PreToolUse hooks receive all their context (tool name, tool input, permission mode, etc.) via stdin as JSON, a hook that receives empty stdin will fail to operate correctly.

Confirmed behavior from issue #10450:
- Hooks ARE registered and fired (PostToolUse/PreToolUse do trigger)
- When manually piping stdin to the hook script (`echo '{...}' | node script.mjs`), the script works perfectly
- When Claude Code itself invokes the hook, stdin is empty
- Result: `[error] Hook output does not start with {, treating as plain text` — the hook produces no JSON output, so Claude Code treats the empty output as plain text and continues without blocking

This is a fundamentally broken pipe between Claude Code's hook invocation mechanism and the subprocess on Windows. The issue was **closed as NOT_PLANNED**, meaning Anthropic has deprioritized fixing it.

Source: [Issue #10450](https://github.com/anthropics/claude-code/issues/10450), [Issue #17424](https://github.com/anthropics/claude-code/issues/17424), [Issue #14219](https://github.com/anthropics/claude-code/issues/14219)

### 3. The Loopsy Daemon Spawns Claude via cmd.exe via node-pty on Windows

From `packages/daemon/src/services/ai-task-manager.ts` line 312:

```typescript
// Windows with simple prompt: use PTY via cmd.exe
ptyProcess = pty.spawn('cmd.exe', ['/c', cliPath, ...args], {
  name: 'xterm-256color',
  cols: 9999,
  rows: 50,
  cwd: spawnCwd,
  env,
});
```

Claude Code is launched as a subprocess of `cmd.exe` via node-pty. This has multiple consequences:
- `cmd.exe` does not set up a Unix-compatible shell environment, so Claude's auto-detection of Git Bash may fail or detect incorrectly
- The PTY environment differs from a normal Git Bash terminal session where `bash` would be on PATH
- node-pty on Windows creates a ConPTY (Windows Console Pseudoterminal), which is a different subprocess communication path than Unix PTYs — stdin redirection to hook subprocesses may behave differently

### 4. The Env Stripping Bug: CLAUDE_CODE_GIT_BASH_PATH Is Actively Removed

In `ai-task-manager.ts` lines 162-164:

```typescript
case 'claude':
  if (key.startsWith('CLAUDE') || key.startsWith('ANTHROPIC_') || ...) continue;
  break;
```

The env-stripping loop skips all keys starting with `CLAUDE`. This means `CLAUDE_CODE_GIT_BASH_PATH` — the environment variable that tells Claude Code where to find Git Bash for hook execution — is explicitly stripped before Claude is spawned. Even if the user or system has this variable configured, Claude Code will launch without it, and hook execution will fail.

### 5. Hook Command Uses Absolute Path to `node` — Windows Path Assumptions May Break

The hook entry injected into `~/.claude/settings.json` by the daemon (line 250):

```typescript
command: `node ${hookScriptPath} ${taskId} ${this.daemonPort} ${this.apiKey}`,
```

`hookScriptPath` is constructed from `import.meta.url` (line 659):

```typescript
const thisFile = fileURLToPath(import.meta.url);
return join(dirname(thisFile), '..', 'hooks', 'permission-hook.mjs');
```

On Windows, this produces a Windows path like `C:\Users\Vee\loopsy\packages\daemon\dist\hooks\permission-hook.mjs`. The hook command string becomes:

```
node C:\Users\Vee\loopsy\packages\daemon\dist\hooks\permission-hook.mjs <taskId> <port> <key>
```

When Claude Code executes this via Git Bash on Windows, the Windows path with backslashes may be mangled. Git Bash converts `/c/...` paths but raw `C:\...` paths are often mishandled — the backslashes get interpreted as escape characters in bash. The path needs to be quoted or converted to forward slashes.

Additionally, if `node` is not on Git Bash's PATH (only on cmd.exe/PowerShell's PATH), the command will fail with `node: command not found`.

Source: [Issue #3417](https://github.com/anthropics/claude-code/issues/3417), [Issue #15481](https://github.com/anthropics/claude-code/issues/15481)

### 6. Settings File Path on Windows

**Confirmed correct:** The official documentation states the user settings path on Windows is `~/.claude/settings.json`, which resolves to `%USERPROFILE%\.claude\settings.json`. Node.js `os.homedir()` on Windows returns `C:\Users\<username>`, so `join(homedir(), '.claude', 'settings.json')` produces the correct Windows path. The Loopsy daemon uses `join(homedir(), '.claude', 'settings.json')` (line 245), so the file is written to the right location.

However: there is a separate documented historical bug (issue #9406) where Windows path construction used `:USERPROFILE` as a literal string instead of expanding it. This was a regression in v2.0.14 and likely fixed by now. It is not the root cause of the current hook failure.

Source: [Issue #9406](https://github.com/anthropics/claude-code/issues/9406), [Claude Code Settings Docs](https://code.claude.com/docs/en/settings)

### 7. Claude Code Snapshots Hooks at Session Startup

From official docs:
> "Direct edits to hooks in settings files don't take effect immediately. Claude Code captures a snapshot of hooks at startup and uses it throughout the session."

The Loopsy daemon writes the hook to `~/.claude/settings.json` **before** spawning Claude. This timing is correct — Claude reads the settings at startup. The hook injection is not the problem.

### 8. PermissionRequest Hooks Do Not Fire in Non-Interactive Mode (-p)

This is a separate, documented limitation: `PermissionRequest` hooks (the dialog-based permission UI) do not fire in `-p` mode. However, **PreToolUse hooks are different** — PreToolUse does fire in `-p` mode. The Loopsy hook correctly uses `PreToolUse`, not `PermissionRequest`, so this documented limitation does not directly apply.

Source: [Hooks Guide](https://code.claude.com/docs/en/hooks-guide), second search result summary

### 9. Hooks Initialization Failure with --dangerously-skip-permissions

A separate bug (issue #10385): on first launch with `--dangerously-skip-permissions`, hooks fail to fire. This is a one-time initialization issue resolved by subsequent runs. The Loopsy daemon does not use `--dangerously-skip-permissions` in non-bypass mode, so this is not the issue.

---

## Detailed Excerpts

### Official Docs — Settings Path on Windows
> "| **User** | `~/.claude/settings.json` (expands to `%USERPROFILE%\.claude\settings.json`) |"

Source: [code.claude.com/docs/en/settings](https://code.claude.com/docs/en/settings)

### Issue #16602 — CLAUDE_CODE_GIT_BASH_PATH Required for Hooks (Not Documented)
> "The current documentation mentions `CLAUDE_CODE_GIT_BASH_PATH` in the context of 'portable Git installations' but does not clearly indicate that **It is required for hooks to work on Windows when using Git-Bash**"
> "Without setting this variable, Claude Code defaults to using **cmd.exe** for hook execution on Windows, which causes failures: Error: `'$HOME' is not recognized as an internal or external command`"

Source: [github.com/anthropics/claude-code/issues/16602](https://github.com/anthropics/claude-code/issues/16602)

### Issue #10450 — stdin Not Passed to Hook Commands on Windows
> "The hook script works perfectly when stdin data is manually piped. The worker receives and processes data correctly. **The issue is that Claude Code on Windows does not pass stdin data to hook commands.**"
> "Hooks produce zero output, causing: `[error] Hook output does not start with {, treating as plain text`"

Source: [github.com/anthropics/claude-code/issues/10450](https://github.com/anthropics/claude-code/issues/10450)

### Issue #22700 — Hook Execution Uses 'bash' Instead of Detected Full Path
> "Claude Code correctly detects the full bash path during startup (e.g., `D:\Program Files\Git\bin\bash.exe`) but fails to use it when executing plugin hooks. Instead, it attempts to execute just `bash`, which fails when Git's `\bin` directory isn't in the system PATH."

Source: [github.com/anthropics/claude-code/issues/22700](https://github.com/anthropics/claude-code/issues/22700)

### Official Docs — Hook Snapshot at Startup
> "Claude Code captures a snapshot of hooks at startup and uses it throughout the session. This prevents malicious or accidental hook modifications from taking effect mid-session without your review."

Source: [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)

---

## Relevance Notes (For Loopsy Daemon Implementation)

The following specific bugs in `packages/daemon/src/services/ai-task-manager.ts` directly cause hook failure on Windows:

1. **Line 163:** `if (key.startsWith('CLAUDE') || ...)` — strips `CLAUDE_CODE_GIT_BASH_PATH` from the spawned env. Fix: explicitly whitelist `CLAUDE_CODE_GIT_BASH_PATH`.

2. **Lines 312-319:** Spawning via `cmd.exe` via node-pty. Claude Code running as a child of cmd.exe may not be able to find Git Bash, even if `CLAUDE_CODE_GIT_BASH_PATH` is passed. Consider spawning via Git Bash directly instead: `pty.spawn('C:\\Program Files\\Git\\bin\\bash.exe', ['-c', `"${cliPath}" ${args.join(' ')}`], ...)` — but this requires knowing the Git Bash path.

3. **Line 250:** The hook command `node ${hookScriptPath}` contains a raw Windows path with backslashes. When executed by Git Bash, backslashes in the path will be misinterpreted. Fix: convert the path to forward slashes (`hookScriptPath.replace(/\\/g, '/')`), or wrap the path in quotes: `node "${hookScriptPath}"`.

4. **Underlying platform bug (unfixable):** Even if 1-3 are fixed, the stdin-not-passed bug (issue #10450, closed NOT_PLANNED) means the hook script may receive empty stdin on Windows. A workaround is to make the hook tolerant of empty stdin by defaulting to `allow` when input is empty/invalid. Currently the hook already does this via the `if (!taskId)` check, but if stdin is empty, `JSON.parse(input)` will throw and fall through to the `deny` path.

---

## Conflicts / Uncertainties

1. **Fixed or not?** The search result summary for the initial search stated: "Fixed hooks (PreToolUse, PostToolUse) silently failing to execute on Windows by using Git Bash instead of cmd.exe (#25981)". This suggests a fix was released, but the exact version it shipped in is unclear. Claude Code 2.1.50 on Windows (the version in use on kai) may or may not include this fix — issue #25981 should be checked directly to confirm.

2. **stdin bug status:** Issue #10450 (stdin not passed to hooks on Windows) was closed as NOT_PLANNED. This does not mean it was fixed — NOT_PLANNED means Anthropic chose not to fix it. This bug may still be present in 2.1.50.

3. **node-pty ConPTY behavior:** It is not fully confirmed whether node-pty's ConPTY implementation on Windows properly connects stdin of hook subprocesses spawned by Claude Code. This is an area requiring direct testing.

4. **`node` availability in Git Bash:** Even with Git Bash configured, `node` must be on Git Bash's PATH. Since Claude Code itself runs via node, node is likely on PATH for cmd.exe, but Git Bash maintains a separate PATH that may not include node.

---

## Summary of Most Likely Root Causes (Ranked)

| Rank | Root Cause | Fixable in Loopsy? |
|------|-----------|-------------------|
| 1 | `CLAUDE_CODE_GIT_BASH_PATH` is stripped from env before spawning Claude | Yes — whitelist this key |
| 2 | Hook command contains raw Windows backslash path, breaks when executed by Git Bash | Yes — convert to forward slashes |
| 3 | Claude spawned via `cmd.exe` PTY may not propagate stdin to hook subprocesses | Partial — may need to spawn via bash |
| 4 | stdin not passed to hooks on Windows (platform bug #10450, NOT_PLANNED) | Workaround only — make hook tolerant of empty stdin |
| 5 | `node` not on Git Bash's PATH | Partial — pass full node.exe path |

---

## Sources

- [Hooks Reference — code.claude.com](https://code.claude.com/docs/en/hooks)
- [Claude Code Settings — code.claude.com](https://code.claude.com/docs/en/settings)
- [Issue #16602: CLAUDE_CODE_GIT_BASH_PATH required for hooks on Windows](https://github.com/anthropics/claude-code/issues/16602)
- [Issue #10450: No hook is working on Windows (stdin not passed)](https://github.com/anthropics/claude-code/issues/10450)
- [Issue #22700: Hook execution uses 'bash' instead of detected full path on Windows](https://github.com/anthropics/claude-code/issues/22700)
- [Issue #3417: Hooks don't work on Windows (path escaping)](https://github.com/anthropics/claude-code/issues/3417)
- [Issue #15481: Hook fails on Windows paths with spaces](https://github.com/anthropics/claude-code/issues/15481)
- [Issue #9406: ENOENT error on Windows due to invalid path](https://github.com/anthropics/claude-code/issues/9406)
- [Issue #10385: Hooks initialization failure with --dangerously-skip-permissions](https://github.com/anthropics/claude-code/issues/10385)
- [Issue #9542: SessionStart hooks cause infinite hang on Windows](https://github.com/anthropics/claude-code/issues/9542)
- [Issue #1202: Documentation error: settings.json location](https://github.com/anthropics/claude-code/issues/1202)
- [Issue #581: Non-interactive mode doesn't respect configured tool permissions](https://github.com/anthropics/claude-code/issues/581)
- [netnerds.net: Fixing Claude Code's PowerShell Problem with Hooks](https://blog.netnerds.net/2026/02/claude-code-powershell-hooks/)
