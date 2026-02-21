# Research: Claude Code MCP Server Development

**Date**: 2026-02-21
**Purpose**: Practical guide for building a custom MCP server that gives Claude Code the ability to send commands to a remote machine over HTTP.

---

## TL;DR

The Model Context Protocol (MCP) is an open standard for connecting AI assistants to external tools. Claude Code supports three MCP transports: stdio (local subprocess), Streamable HTTP (remote/network, current standard), and SSE (deprecated). For a remote HTTP command-dispatch server, you build an HTTP server using `@modelcontextprotocol/sdk` v1.x (npm package: `@modelcontextprotocol/sdk`), expose it over the network, and register it in Claude Code with `claude mcp add --transport http <name> <url>`.

---

## Key Findings

### 1. MCP SDK Package

- **Primary package**: `@modelcontextprotocol/sdk` on npm
- **Current production branch**: v1.x (v2 is pre-alpha, targeting Q1 2026 stable)
- **Install**: `npm install @modelcontextprotocol/sdk zod`
- **Zod version**: Must use zod v3 with v1.x SDK (zod v4 is for the v2 SDK)
- **Optional framework packages** (v2 branch only currently):
  - `@modelcontextprotocol/node` - raw Node.js HTTP
  - `@modelcontextprotocol/express` - Express adapter
  - `@modelcontextprotocol/hono` - Hono adapter
- **Source**: [npmjs.com](https://www.npmjs.com/package/@modelcontextprotocol/sdk), [GitHub TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

### 2. Transport Types

Three transports exist in the MCP spec (2025-03-26):

| Transport | Use Case | Status |
|-----------|----------|--------|
| stdio | Local subprocess, Claude launches as child process | Current, recommended for local |
| Streamable HTTP | Remote server over HTTP POST/GET, optional SSE streaming | Current, recommended for remote |
| HTTP+SSE (legacy) | Old SSE-only transport | Deprecated since 2025-03-26 |

**For a remote machine use case: Streamable HTTP is the correct choice.**

- Source: [MCP Transports Spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)

### 3. Streamable HTTP Transport - How It Works

The server exposes a **single endpoint** (e.g., `https://your-server.com/mcp`) that handles three HTTP methods:

- **POST /mcp**: Client sends JSON-RPC requests/notifications here. Server responds with either:
  - `Content-Type: application/json` for a single synchronous response
  - `Content-Type: text/event-stream` to open an SSE stream for multiple events
- **GET /mcp**: Client opens an SSE stream for server-initiated messages (notifications, server-to-client requests). Server returns 405 if not supported.
- **DELETE /mcp**: Client terminates its session.

**Session management** (optional but recommended for stateful servers):
- Server sends `Mcp-Session-Id` header in the InitializeResult response
- Client includes this header on all subsequent requests
- Session ID must be globally unique and cryptographically secure (e.g., a UUID)
- Server responds 404 if session expired, client must re-initialize

**Security requirements** per spec:
- Servers MUST validate the `Origin` header to prevent DNS rebinding attacks
- Local servers SHOULD bind to localhost only (127.0.0.1)
- Servers SHOULD implement proper authentication for all connections

- Source: [MCP Transports Spec - Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)

### 4. Building an MCP Server in TypeScript - Complete Pattern

#### Project Setup

```bash
mkdir my-mcp-server && cd my-mcp-server
npm init -y
npm install @modelcontextprotocol/sdk zod@3
npm install -D @types/node typescript
```

**package.json additions:**
```json
{
  "type": "module",
  "scripts": {
    "build": "tsc && chmod 755 build/index.js"
  }
}
```

**tsconfig.json:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

#### stdio Server (local subprocess, simplest for testing)

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// CRITICAL: Never use console.log() in stdio mode - it corrupts the JSON-RPC stream
// Use console.error() for logging (goes to stderr)

const server = new McpServer({
  name: "remote-command-server",
  version: "1.0.0",
});

// Register a tool using registerTool()
server.registerTool(
  "run_command",
  {
    description: "Run a command on the remote machine",
    inputSchema: {
      command: z.string().describe("Shell command to execute"),
      timeout_ms: z.number().optional().describe("Timeout in milliseconds"),
    },
  },
  async ({ command, timeout_ms }) => {
    try {
      const result = await sendCommandToRemoteMachine(command, timeout_ms);
      return {
        content: [{ type: "text", text: result }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
```

#### Streamable HTTP Server (remote, using Express)

This is the pattern for a server that Claude Code reaches over the network:

```typescript
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const app = express();
app.use(express.json());

// Session storage: maps session ID -> transport instance
const sessions = new Map<string, StreamableHTTPServerTransport>();

// Helper: create and configure a new McpServer instance
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "remote-command-server",
    version: "1.0.0",
  });

  // Register your tools here
  server.registerTool(
    "run_command",
    {
      description: "Execute a command on the remote machine",
      inputSchema: {
        command: z.string().describe("Command to run"),
      },
    },
    async ({ command }) => {
      const result = await dispatchToRemoteMachine(command);
      return { content: [{ type: "text", text: result }] };
    }
  );

  return server;
}

// POST /mcp - handle all client-to-server JSON-RPC messages
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  let transport: StreamableHTTPServerTransport;

  if (sessionId && sessions.has(sessionId)) {
    // Existing session: reuse transport
    transport = sessions.get(sessionId)!;
  } else if (!sessionId && isInitializeRequest(req.body)) {
    // New session: create transport and server
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        sessions.set(newSessionId, transport);
      },
    });

    // Clean up on transport close
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    const server = createMcpServer();
    await server.connect(transport);
  } else {
    res.status(400).json({ error: "Bad request: missing or invalid session" });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// GET /mcp - open SSE stream for server-initiated messages
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }
  const transport = sessions.get(sessionId)!;
  await transport.handleRequest(req, res);
});

// DELETE /mcp - terminate session
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && sessions.has(sessionId)) {
    const transport = sessions.get(sessionId)!;
    await transport.close();
    sessions.delete(sessionId);
  }
  res.status(200).send();
});

app.listen(3000, () => {
  console.log("MCP HTTP server listening on port 3000");
});
```

- Source: [Official TypeScript SDK - simpleStreamableHttp.ts example](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/examples/server/simpleStreamableHttp.ts)
- Source: [MCP Build Server Guide](https://modelcontextprotocol.io/docs/develop/build-server)

### 5. Claude Code Configuration Format

#### Adding an HTTP MCP Server (recommended for remote)

```bash
# Via CLI (stores in ~/.claude.json by default - "local" scope)
claude mcp add --transport http my-remote-server https://your-machine:3000/mcp

# With Bearer token authentication
claude mcp add --transport http my-remote-server https://your-machine:3000/mcp \
  --header "Authorization: Bearer YOUR_SECRET_TOKEN"

# With API key header
claude mcp add --transport http my-remote-server https://your-machine:3000/mcp \
  --header "X-API-Key: YOUR_SECRET_KEY"

# Explicit scope flags:
# --scope local  (default) = private to you in current project, stored in ~/.claude.json
# --scope project          = team-shared, stored in .mcp.json at project root
# --scope user             = available across all your projects, stored in ~/.claude.json
```

#### .mcp.json Format (project scope, checked into git)

```json
{
  "mcpServers": {
    "my-remote-server": {
      "type": "http",
      "url": "https://your-machine:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}"
      }
    }
  }
}
```

Environment variable expansion is supported with `${VAR}` and `${VAR:-default}` syntax.

#### stdio Server Format (for local subprocess)

```json
{
  "mcpServers": {
    "my-local-server": {
      "command": "node",
      "args": ["/absolute/path/to/build/index.js"],
      "env": {
        "REMOTE_HOST": "http://192.168.1.100:8080"
      }
    }
  }
}
```

#### Adding via CLI (stdio transport)

```bash
claude mcp add --transport stdio my-local-server \
  --env REMOTE_HOST=http://192.168.1.100:8080 \
  -- node /absolute/path/to/build/index.js
```

- Source: [Claude Code MCP Docs](https://code.claude.com/docs/en/mcp)
- Source: [MCPcat Guide](https://mcpcat.io/guides/adding-an-mcp-server-to-claude-code/)

### 6. Configuration File Locations Summary

| Scope | Location | Sharing |
|-------|----------|---------|
| local (default) | `~/.claude.json` (under project key) | Private to you, this project |
| project | `.mcp.json` at project root | Checked into git, shared with team |
| user | `~/.claude.json` (global section) | Private to you, all projects |

**Note**: `~/.claude/settings.json` is NOT where MCP servers go - that file is for Claude Code settings only.

- Source: [GitHub issue on config location](https://github.com/anthropics/claude-code/issues/4976)

### 7. Tool Return Value Format

MCP tools must return a content array. Supported content types:

```typescript
// Text response
return {
  content: [{ type: "text", text: "Command output here" }]
};

// Error response (Claude sees this as a tool failure)
return {
  content: [{ type: "text", text: "Error: connection refused" }],
  isError: true
};

// Multiple content items
return {
  content: [
    { type: "text", text: "stdout: hello world" },
    { type: "text", text: "stderr: (empty)" },
  ]
};
```

### 8. Authentication for Remote HTTP Servers

For a server on a remote machine, protect it with an API key or Bearer token:

**Express middleware pattern:**
```typescript
const API_KEY = process.env.MCP_API_KEY;

app.use("/mcp", (req, res, next) => {
  const authHeader = req.headers["authorization"] ?? req.headers["x-api-key"];
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  if (!token || token !== API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});
```

Then add it to Claude Code with:
```bash
claude mcp add --transport http my-server https://your-host:3000/mcp \
  --header "Authorization: Bearer YOUR_KEY"
```

- Source: [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/authorization)
- Source: [Stainless API Key Best Practices](https://www.stainless.com/mcp/mcp-server-api-key-management-best-practices)

### 9. Key Best Practices

1. **Never use `console.log()` in stdio mode** - it corrupts the JSON-RPC stream. Use `console.error()` instead.
2. **For HTTP mode, `console.log()` is fine** since it doesn't touch the HTTP response body.
3. **Use absolute paths** when configuring stdio servers in Claude Code configs.
4. **Validate Origin header** in HTTP servers to prevent DNS rebinding attacks.
5. **Store API keys in environment variables**, never hardcode them.
6. **Use zod v3 with SDK v1.x** - the main branch now targets zod v4 for v2.
7. **Build before configuring** - run `npm run build` so Claude Code has a compiled JS file to execute.
8. **Tool descriptions matter** - Claude uses the description field to decide when to call a tool, so be descriptive.
9. **Return `isError: true`** for tool failures so Claude understands something went wrong.
10. **Restart Claude Code** after adding or changing MCP server configuration.

---

## Architecture Recommendation for Remote Command Dispatch

For your use case (Claude Code sending commands to a remote machine over HTTP), there are two viable architectures:

### Option A: stdio proxy (simplest)
Build a stdio MCP server that Claude Code runs locally. The local server makes HTTP calls to a daemon running on the remote machine. Claude Code only knows about the local subprocess.

```
Claude Code
    -> launches local MCP server (stdio)
    -> local server makes HTTP requests -> remote machine daemon (any HTTP server)
```

**Pros**: Simple, no authentication complexity on the MCP layer, remote daemon can be any HTTP server.
**Cons**: Requires local MCP server to be installed on the Claude Code machine.

### Option B: Remote HTTP MCP server
Deploy a full Streamable HTTP MCP server directly on the remote machine. Claude Code connects to it directly over HTTP.

```
Claude Code
    -> HTTP POST/GET -> MCP server running on remote machine (port 3000)
```

**Pros**: No local software needed beyond Claude Code itself, remote-first design.
**Cons**: The remote machine must run the full MCP SDK stack (Node.js required), must handle authentication and TLS.

**Recommendation**: For a LAN scenario, Option A (stdio proxy) is simpler and more robust. The local proxy can be a thin wrapper that just forwards commands to the remote machine's HTTP API, and the remote machine's daemon does not need to implement MCP at all - just a plain HTTP API.

---

## Conflicts/Uncertainties

1. **SDK version split**: The npm package `@modelcontextprotocol/sdk` is currently in a transition. The v1.x branch is production-stable and uses `@modelcontextprotocol/sdk` as a single package with subpath imports (e.g., `sdk/server/mcp.js`). The v2 branch (pre-alpha) splits into separate `@modelcontextprotocol/server` and `@modelcontextprotocol/client` packages. Use v1.x for production. Check npm with `npm view @modelcontextprotocol/sdk version` to confirm the version you are installing.

2. **Claude Code vs Claude Desktop config paths differ**: Claude Desktop uses `~/Library/Application Support/Claude/claude_desktop_config.json`, while Claude Code uses `~/.claude.json` and `.mcp.json`. Do not mix these up.

3. **SSE deprecation**: The HTTP+SSE transport (the old style with a separate `/sse` GET endpoint for initialization and a separate `/message` POST endpoint) is deprecated as of March 2025. Streamable HTTP uses a single endpoint for both. Some tutorials online still show the old pattern.

---

## Sources

- [Connect Claude Code to tools via MCP - Official Docs](https://code.claude.com/docs/en/mcp)
- [Build an MCP Server - Official Guide](https://modelcontextprotocol.io/docs/develop/build-server)
- [MCP Transports Specification (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [MCP TypeScript SDK - GitHub (v1.x branch)](https://github.com/modelcontextprotocol/typescript-sdk)
- [@modelcontextprotocol/sdk on npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [Configuring MCP Tools in Claude Code - Scott Spence](https://scottspence.com/posts/configuring-mcp-tools-in-claude-code)
- [MCP Server API Key Best Practices - Stainless](https://www.stainless.com/mcp/mcp-server-api-key-management-best-practices)
- [Understanding Authorization in MCP](https://modelcontextprotocol.io/docs/tutorials/security/authorization)
- [MCPcat: Adding MCP Server to Claude Code](https://mcpcat.io/guides/adding-an-mcp-server-to-claude-code/)
- [MCP Transport Types Comparison - MCPcat](https://mcpcat.io/guides/comparing-stdio-sse-streamablehttp/)
- [Claude Code Gains Support for Remote MCP via Streamable HTTP - InfoQ](https://www.infoq.com/news/2025/06/anthropic-claude-remote-mcp/)
- [SitePoint: Building MCP Servers for Claude Code](https://www.sitepoint.com/building-mcp-servers-custom-context-for-claude-code/)
