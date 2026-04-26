# Research: OpenAI Codex CLI

**Date:** 2026-02-22
**Sources:** developers.openai.com/codex, github.com/openai/codex

---

## TL;DR

OpenAI's Codex CLI is a locally-running terminal coding agent (command: `codex`) built in Rust, similar to Claude Code. It fully supports MCP servers (both STDIO and HTTP), stores configuration in `~/.codex/config.toml` (TOML format), and has a well-developed non-interactive mode via `codex exec` with JSONL streaming output.

---

## Key Findings

- **CLI command name**: `codex`
- **Installation**: `npm i -g @openai/codex` or Homebrew
- **Platform**: macOS, Linux (Windows via WSL, experimental)
- **Built with**: Rust
- **Requires**: ChatGPT Plus/Pro/Business/Edu/Enterprise plan (or API key via `CODEX_API_KEY`)
- **MCP support**: Full, for both STDIO and streamable HTTP servers
- **Config format**: TOML, at `~/.codex/config.toml` (user) or `.codex/config.toml` (project-scoped)
- **Non-interactive mode**: `codex exec` with `--json` flag for JSONL streaming, very similar to `claude -p --output-format stream-json`

---

## Detailed Findings

### 1. MCP (Model Context Protocol) Support

Codex fully supports MCP servers. They are configured in `~/.codex/config.toml` under `[mcp_servers.<id>]` tables. Both the CLI and the IDE extension share this config file.

**Adding a server via CLI:**
```bash
codex mcp add <server-name> -- <stdio-command>
codex mcp add context7 -- npx -y @upstash/context7-mcp
# With env vars:
codex mcp add myserver --env VAR1=VALUE1 -- myserver-binary
```

**View active MCP servers** interactively with `/mcp` in the TUI.

**STDIO server config keys:**
| Key | Required | Description |
|---|---|---|
| `command` | Yes | Command to launch the server |
| `args` | No | Array of arguments |
| `env` | No | Environment variables (inline table) |
| `cwd` | No | Working directory |
| `env_vars` | No | Env vars to forward from parent |
| `startup_timeout_sec` | No | Default: 10s |
| `tool_timeout_sec` | No | Default: 60s |
| `enabled` | No | Toggle without deletion |
| `enabled_tools` | No | Allow-list of specific tools |
| `disabled_tools` | No | Deny-list of specific tools |
| `required` | No | Fail startup if server unavailable |

**HTTP server config keys:**
| Key | Required | Description |
|---|---|---|
| `url` | Yes | Server endpoint URL |
| `bearer_token_env_var` | No | Env var name holding auth token |
| `http_headers` | No | Static header key/value pairs |
| `env_http_headers` | No | Headers sourced from env vars |

**Source:** [developers.openai.com/codex/mcp](https://developers.openai.com/codex/mcp)

---

### 2. Tool/Extension Registration

Tools (beyond MCP) are registered via feature flags in `[features]` table of `config.toml`:

| Feature | Status | Description |
|---|---|---|
| `shell_tool` | Stable, on by default | Standard shell command execution |
| `web_search` | Available | Web search integration |
| `multi_agent` | Available | Agent collaboration tools |
| `unified_exec` | Beta | PTY-backed execution tool |

MCP servers are the primary extension mechanism. Each MCP server's tools become available to the agent automatically once configured. You can scope which tools are active using `enabled_tools` / `disabled_tools` per server.

There is no separate plugin or extension registry — MCP is the standard integration path.

**Source:** [developers.openai.com/codex/config-reference/](https://developers.openai.com/codex/config-reference/)

---

### 3. Config File Location and Format

**Format:** TOML

**Locations (in priority order):**
1. `~/.codex/config.toml` — User-level defaults
2. `.codex/config.toml` — Project-scoped overrides (in trusted projects)
3. CLI flags `-c key=value` — Per-invocation overrides

**Admin enforcement:** `requirements.toml` can impose hard constraints (allowed sandbox modes, approval policies, MCP allowlists).

**JSON Schema** for IDE autocompletion available at `/codex/config-schema.json` (works with VS Code + Even Better TOML extension).

**Full sample `~/.codex/config.toml`:**
```toml
# Core model settings
model = "gpt-5.2-codex"
model_provider = "openai"
approval_policy = "on-request"       # untrusted | on-request | never
sandbox_mode = "workspace-write"     # read-only | workspace-write | danger-full-access

# Feature flags
[features]
shell_tool = true
web_search = true
multi_agent = false
unified_exec = false   # beta PTY-backed exec

# MCP servers — STDIO transport
[mcp_servers.docs]
enabled = true
command = "docs-server"
args = ["--port", "4000"]
env = { "API_KEY" = "value" }
startup_timeout_sec = 10.0
tool_timeout_sec = 60.0

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]

# MCP servers — HTTP transport
[mcp_servers.github]
url = "https://github-mcp.example.com/mcp"
bearer_token_env_var = "GITHUB_TOKEN"
enabled_tools = ["list_issues"]

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_OAUTH_TOKEN"

# History
[history]
persistence = "save-all"   # or "ephemeral"
```

**Sources:** [developers.openai.com/codex/config-reference/](https://developers.openai.com/codex/config-reference/), [developers.openai.com/codex/config-sample/](https://developers.openai.com/codex/config-sample/)

---

### 4. Non-Interactive / Programmatic Mode

The dedicated non-interactive subcommand is `codex exec` (alias: `codex e`).

**Core usage:**
```bash
codex exec "your task prompt here"
codex exec - < prompt.txt          # read prompt from stdin
```

**Key flags for scripting:**

| Flag | Purpose |
|---|---|
| `--json` | JSONL output: one JSON event per line to stdout |
| `-o <path>` / `--output-last-message` | Write final assistant message to file |
| `--output-schema <path>` | Enforce JSON Schema on final response (structured output) |
| `--ephemeral` | Do not persist session files to disk |
| `--full-auto` | Auto-approve workspace writes, skip prompts |
| `--sandbox <mode>` | Set sandbox mode (read-only, workspace-write, danger-full-access) |
| `--dangerously-bypass-approvals-and-sandbox` | Skip all approval prompts |
| `--skip-git-repo-check` | Allow running outside a git repo |

**JSONL event stream format** (with `--json`):
```json
{"type":"thread.started","thread_id":"abc123"}
{"type":"turn.started"}
{"type":"item.completed","item":{"type":"agent_message","text":"Here is the summary..."}}
{"type":"item.completed","item":{"type":"command_execution","command":"ls -la","output":"..."}}
{"type":"item.completed","item":{"type":"file_change","path":"src/foo.ts","diff":"..."}}
{"type":"item.completed","item":{"type":"mcp_tool_call","server":"github","tool":"list_issues"}}
{"type":"turn.completed"}
```

**Default behavior (no `--json`):**
- Progress streamed to stderr
- Final assistant message printed to stdout
- Pipeable: `codex exec "generate release notes" | tee output.md`

**Structured output example:**
```bash
codex exec "extract metadata" \
  --output-schema ./schema.json \
  -o ./output.json
```

**Authentication for scripted use:**
```bash
CODEX_API_KEY=<key> codex exec --json "analyze codebase"
```

**Session resumption:**
```bash
codex exec resume --last "continue from where you left off"
codex exec resume --all
codex exec resume <SESSION_UUID>
```

**Sources:** [developers.openai.com/codex/noninteractive/](https://developers.openai.com/codex/noninteractive/), [developers.openai.com/codex/cli/reference/](https://developers.openai.com/codex/cli/reference/)

---

### 5. CLI Command Name and Invocation

**Command:** `codex`

**Install:**
```bash
npm i -g @openai/codex
# or Homebrew (see pricing page for link)
```

**Interactive mode** (default):
```bash
codex                          # start TUI session
codex "fix the type errors"    # start with initial prompt
```

**Non-interactive mode:**
```bash
codex exec "your task"
codex e "your task"            # alias
```

**MCP management:**
```bash
codex mcp add <name> -- <command>
codex mcp add <name> --env KEY=VAL -- <command>
```

**Source:** [developers.openai.com/codex/cli/](https://developers.openai.com/codex/cli/)

---

## Relevance Notes for Loopsy

1. **Loopsy integration**: Codex's `codex exec --json` is directly analogous to Claude's `claude -p --output-format stream-json`. A Loopsy daemon on a Codex machine could spawn `codex exec` the same way it spawns `claude -p` for AI tasks.

2. **MCP server opportunity**: Loopsy could publish an MCP server that registers with Codex via `~/.codex/config.toml`. Codex machines could then use Loopsy tools natively the same way Claude Code does.

3. **Config path difference**: Codex uses `~/.codex/config.toml` (TOML), Claude Code uses `~/.claude.json` / project `CLAUDE.md`. These are distinct and non-overlapping.

4. **Approval model**: Codex `--full-auto` is roughly equivalent to Claude's `--dangerously-skip-permissions`. For Loopsy's remote AI task execution, `codex exec --full-auto --json` would be the right invocation.

5. **PTY requirement**: The docs mention a beta `unified_exec` feature using PTY-backed execution. Loopsy already uses node-pty for Claude tasks; same approach would apply for Codex.

---

## Conflicts / Uncertainties

- The exact model name shown in samples (`gpt-5.2-codex`, `gpt-5-codex`) varies between pages. This may be due to the docs being updated alongside model releases. Not a research blocker.
- Windows support is listed as "experimental" with WSL recommended. Cross-platform behavior for `codex exec` on Windows is not fully documented.
- The Homebrew installation path was not fully detailed in the docs fetched; it redirects to a pricing page. npm install is the primary documented path.
- The `--experimental-json` flag mentioned in one reference vs plain `--json` — unclear if these are aliases or if `--json` graduated from experimental. Treat `--json` as the stable flag.

---

## Sources

- [Codex CLI Overview](https://developers.openai.com/codex/cli/)
- [MCP Configuration](https://developers.openai.com/codex/mcp)
- [Configuration Reference](https://developers.openai.com/codex/config-reference/)
- [Sample Configuration](https://developers.openai.com/codex/config-sample/)
- [Non-Interactive Mode](https://developers.openai.com/codex/noninteractive/)
- [CLI Command Reference](https://developers.openai.com/codex/cli/reference/)
- [Codex CLI Features](https://developers.openai.com/codex/cli/features/)
- [GitHub: openai/codex docs/config.md](https://github.com/openai/codex/blob/main/docs/config.md)
