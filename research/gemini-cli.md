# Research Brief: Google Gemini CLI

**Date:** 2026-02-22
**Researcher:** Research Agent (claude-sonnet-4-6)

---

## TL;DR

Google's Gemini CLI (`gemini`) is an open-source terminal AI agent analogous to Claude Code, released in 2025. It fully supports MCP servers (stdio, SSE, and HTTP transports), configured via a `~/.gemini/settings.json` file. It has a headless/non-interactive mode activated with `gemini -p "prompt"` and supports `--output-format stream-json` for NDJSON streaming output.

---

## Key Findings

- **CLI command name**: `gemini`
- **npm package**: `@google/gemini-cli` (install: `npm install -g @google/gemini-cli` or `brew install gemini-cli`)
- **MCP support**: Yes, full and first-class. Supports stdio, SSE, and HTTP transports.
- **Config file**: `~/.gemini/settings.json` (user-level); `.gemini/settings.json` (project-level)
- **Context file**: `GEMINI.md` (analogous to Claude Code's `CLAUDE.md`), searched hierarchically
- **Headless/programmatic mode**: Yes, via `gemini -p "prompt"` or `echo "prompt" | gemini`
- **Output formats**: `text` (default), `json` (single JSON object at completion), `stream-json` (NDJSON stream)
- **GitHub repo**: https://github.com/google-gemini/gemini-cli

---

## Detailed Findings

### 1. MCP Support

MCP support is fully built in and well-documented. Gemini CLI can act as an MCP client, connecting to any MCP server over stdio, SSE, or HTTP.

**Configuration in `settings.json`:**

```json
{
  "mcpServers": {
    "my-server": {
      "command": "path/to/server",
      "args": ["--arg1", "value1"],
      "env": {
        "API_KEY": "$MY_API_TOKEN"
      },
      "cwd": "./server-directory",
      "timeout": 30000,
      "trust": false,
      "includeTools": ["tool1", "tool2"],
      "excludeTools": ["tool3"]
    },
    "remote-sse-server": {
      "url": "http://localhost:8080/sse"
    },
    "remote-http-server": {
      "httpUrl": "https://api.example.com/mcp/"
    }
  }
}
```

**Required fields (choose one per server):**
- `command` (string): Path to executable for stdio transport
- `url` (string): SSE endpoint URL
- `httpUrl` (string): HTTP streaming endpoint URL

**Optional fields per server:**
| Field | Type | Purpose |
|---|---|---|
| `args` | string[] | Command-line arguments (stdio) |
| `env` | object | Env vars; supports `$VAR` and `${VAR}` syntax |
| `cwd` | string | Working directory (stdio) |
| `headers` | object | Custom HTTP headers (remote transports) |
| `timeout` | number | Request timeout in ms (default: 600,000) |
| `trust` | boolean | Bypass tool-call confirmation prompts |
| `includeTools` | string[] | Allowlist of tools to expose |
| `excludeTools` | string[] | Denylist of tools to suppress |
| `description` | string | Human-readable label |

**Global MCP defaults (in `mcp` key):**
```json
{
  "mcp": {
    "allowed": ["trusted-server"],
    "excluded": ["experimental-server"]
  }
}
```

**CLI commands for MCP management (alternative to manual JSON editing):**
```bash
# Add a stdio server
gemini mcp add my-server python server.py

# Add an SSE server
gemini mcp add --transport sse sse-server https://api.example.com/sse/

# Add an HTTP server
gemini mcp add --transport http http-server https://api.example.com/mcp/

# List all configured servers
gemini mcp list

# Remove a server
gemini mcp remove my-server
```

**Scope flag for `gemini mcp add`:** `-s, --scope` accepts `user` or `project` (default: `project`).

**Tool name conflicts** across multiple MCP servers are resolved automatically by prefixing with the server alias: `serverAlias__toolName`.

Sources:
- https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html
- https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md
- https://developers.googleblog.com/gemini-cli-fastmcp-simplifying-mcp-server-development/

---

### 2. Tool / Extension Registration

Gemini CLI tools are registered through two mechanisms:

**a) MCP servers** (primary extension mechanism): Any MCP server registered under `mcpServers` in `settings.json` exposes its tools automatically. The CLI discovers them at startup.

**b) Built-in tools** (controlled via `tools` config key):
```json
{
  "tools": {
    "sandbox": true,
    "shell.enableInteractiveShell": true,
    "core": ["ReadFileTool", "WriteFileTool"],
    "exclude": ["ShellTool"],
    "allowed": ["specific-tool"],
    "discoveryCommand": "path/to/tool-discovery-script",
    "callCommand": "path/to/tool-call-handler"
  }
}
```

The `discoveryCommand` and `callCommand` fields suggest a plugin-style custom tool registration capability beyond MCP.

Within an interactive session, `/mcp` shows detailed server status and all available tools.

Sources:
- https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html

---

### 3. Config File Location and Format

**Locations (in precedence order, lowest to highest):**
1. Hardcoded defaults
2. System defaults: `/Library/Application Support/GeminiCli/system-defaults.json` (macOS)
3. User settings: `~/.gemini/settings.json`
4. Project settings: `.gemini/settings.json` (relative to cwd)
5. System settings: `/Library/Application Support/GeminiCli/settings.json` (macOS)
6. Environment variables
7. Command-line arguments

**Format:** JSON (with comments stripped via `strip-json-comments`).

**Key environment variables:**
- `GEMINI_API_KEY` — API authentication
- `GEMINI_MODEL` — Default model override
- `GOOGLE_CLOUD_PROJECT` — GCP project ID
- `GOOGLE_APPLICATION_CREDENTIALS` — Path to service account JSON

**Context file:** `GEMINI.md` — analogous to Claude Code's `CLAUDE.md`. Searched hierarchically from the project root upward. Filename is configurable via `context.fileName` in `settings.json`.

**`.env` file support:** Searched in current directory, parent directories, and `~/.gemini/`.

Sources:
- https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html
- https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/configuration.md
- https://medium.com/google-cloud/gemini-cli-tutorial-series-part-3-configuration-settings-via-settings-json-and-env-files-669c6ab6fd44

---

### 4. Non-Interactive / Programmatic Mode

Gemini CLI has a documented "Headless Mode" that is the direct equivalent of `claude -p`.

**Activation methods:**
```bash
# Method 1: --prompt / -p flag
gemini --prompt "Your question here"
gemini -p "Your question here"

# Method 2: Positional argument (triggers headless automatically)
gemini "Your question here"

# Method 3: Stdin piping
echo "Your question" | gemini
cat file.txt | gemini --prompt "Summarize this"

# Method 4: Non-TTY environment (auto-detected)
gemini < input.txt
```

**Output format flag:**
```bash
# Default text output
gemini -p "query"

# Single JSON object at completion
gemini -p "query" --output-format json

# NDJSON streaming (analogous to claude -p --output-format stream-json)
gemini -p "query" --output-format stream-json
```

**JSON output structure:**
```json
{
  "response": "The AI-generated answer",
  "stats": { "tokens": 123, "latency_ms": 456 },
  "error": null
}
```

**Stream-JSON (NDJSON) event types:**
| Event type | Description |
|---|---|
| `init` | Session metadata |
| `message` | User and assistant message chunks |
| `tool_use` | Tool call requests |
| `tool_result` | Tool execution output |
| `error` | Non-fatal warnings |
| `result` | Final outcome with aggregated statistics |

**Other relevant headless flags:**
- `--model` / `-m`: Selects model
- `--yolo` / `-y`: Auto-approves all tool actions (equivalent to `--dangerously-skip-permissions` in Claude Code)
- `--approval-mode`: Sets approval behavior
- `--all-files` / `-a`: Includes all files in context
- `--include-directories`: Adds specific directories to context
- `--debug` / `-d`: Enables debug output

**Exit codes:**
- `0`: Success
- `1`: General error or API failure
- `42`: Input error
- `53`: Turn limit exceeded

Sources:
- https://google-gemini.github.io/gemini-cli/docs/cli/headless.html
- https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md
- https://geminicli.com/docs/cli/headless/

---

### 5. CLI Command Name and Installation

- **Command name**: `gemini`
- **npm package**: `@google/gemini-cli`
- **Installation:**
  ```bash
  # npm global install
  npm install -g @google/gemini-cli

  # Homebrew (macOS)
  brew install gemini-cli

  # One-shot without install
  npx @google/gemini-cli
  ```

Sources:
- https://github.com/google-gemini/gemini-cli
- https://github.com/google-gemini/gemini-cli/issues/2077

---

## Relevance Notes for Loopsy

- **MCP integration**: Gemini CLI supports MCP identically to Claude Code in terms of transport options (stdio, SSE, HTTP). A Loopsy MCP server configured for Claude Code would work with Gemini CLI as well, requiring only a `settings.json` `mcpServers` entry.
- **Programmatic/AI task spawning**: `gemini -p "prompt" --output-format stream-json` is the direct equivalent of `claude -p --output-format stream-json`. Loopsy's AI task system (`/api/v1/ai-tasks`) currently spawns Claude CLI via node-pty; a parallel Gemini implementation would use the same NDJSON stream-parsing logic.
- **Permission/approval mode**: `--yolo` flag auto-approves tool use (like Claude Code's `--dangerously-skip-permissions`). The `--approval-mode` flag may allow finer-grained control similar to Claude Code's `acceptEdits` mode.
- **Context file**: `GEMINI.md` is the equivalent of `CLAUDE.md`. Loopsy could maintain both files in repo root for dual-agent compatibility.
- **Trust flag for MCP**: `"trust": true` on an MCP server entry bypasses tool-call confirmation, analogous to Claude Code's permission hooks accepting all requests.

---

## Conflicts / Uncertainties

- **`stream-json` exact flag**: The flag `--output-format stream-json` is confirmed by GitHub issue #8203 ("Add `stream-json` output format") and multiple documentation pages, but the exact issue date is unclear — it may have been added after initial release. Verify with `gemini --help` at runtime.
- **`--approval-mode` values**: The exact accepted values for `--approval-mode` are not documented in the sources found. It is analogous to Claude Code's `--permission-mode` but the accepted strings are unconfirmed.
- **`tools.discoveryCommand` / `tools.callCommand`**: These settings appear in the schema but are not documented with examples. It is unclear if they represent a stable plugin API or an internal/experimental feature.
- **FastMCP integration**: As of FastMCP v2.12.3, `fastmcp install gemini-cli` installs local stdio MCP servers directly into Gemini CLI's config. This is a third-party convenience wrapper, not a native Gemini CLI feature.
