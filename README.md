# Loopsy

Cross-machine communication for Claude Code. Enables Claude Code instances on different machines to run commands, transfer files, share context, and send messages to each other over a LAN.

## How It Works

Each machine runs a **Loopsy daemon** (Fastify HTTP server on port 19532) and an **MCP server** (stdio process that exposes tools to Claude Code). Daemons communicate directly over HTTP. Peers discover each other via mDNS or manual configuration.

```
Machine A (macOS)                    Machine B (Windows)
┌──────────────┐                     ┌──────────────┐
│  Claude Code  │                     │  Claude Code  │
│  + MCP Server │                     │  + MCP Server │
│       │       │                     │       │       │
│  Loopsy Daemon│◄───── HTTP/LAN ────►│  Loopsy Daemon│
│  :19532       │                     │  :19532       │
└──────────────┘                     └──────────────┘
```

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+

### Setup

**macOS / Linux:**
```bash
git clone https://github.com/leox255/loopsy.git
cd loopsy
./setup.sh
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/leox255/loopsy.git
cd loopsy
.\setup.ps1
```

**Manual setup:**
```bash
pnpm install
pnpm build
loopsy init       # generates ~/.loopsy/config.yaml with API key
loopsy start      # starts the daemon
```

### Connect Two Machines

1. Run setup on both machines
2. On Machine A, run `loopsy connect` and follow the interactive wizard, OR:
   - Copy Machine B's API key and add it to Machine A's `~/.loopsy/config.yaml` under `auth.allowedKeys`
   - Copy Machine A's API key and add it to Machine B's config
   - Add each machine as a manual peer: `loopsy peers add <ip>`
3. Verify: `loopsy status` should show peers

## CLI Commands

```bash
loopsy init                        # Initialize config and generate API key
loopsy connect                     # Interactive wizard to connect to a peer
loopsy start                       # Start the daemon
loopsy stop                        # Stop the daemon
loopsy status                      # Show daemon status

loopsy peers                       # List known peers
loopsy peers add <ip> [port]       # Add a manual peer
loopsy peers remove <nodeId>       # Remove a peer

loopsy exec <peer> <cmd..>         # Execute command on remote peer
loopsy send <peer> <src> <dest>    # Push a file to a peer
loopsy pull <peer> <src> <dest>    # Pull a file from a peer

loopsy context set <key> <value>   # Set a context value
loopsy context get <key>           # Get a context value
loopsy context list                # List all context entries
loopsy context delete <key>        # Delete a context entry

loopsy key show                    # Show current API key
loopsy key generate                # Generate a new API key
loopsy logs [-f]                   # View audit logs

# Multi-session commands
loopsy session start <name>        # Start a named session
loopsy session start-fleet -c N    # Start N worker sessions
loopsy session stop <name>         # Stop a session
loopsy session stop-all            # Stop all sessions
loopsy session list                # List all sessions
loopsy session status <name>       # Show session status
```

## MCP Tools

When the MCP server is configured in Claude Code, these tools are available:

| Tool | Description |
|------|-------------|
| `loopsy_list_peers` | List all peers with status |
| `loopsy_peer_status` | Detailed status for a peer |
| `loopsy_execute` | Run a command on a remote peer |
| `loopsy_transfer_file` | Push/pull files between machines |
| `loopsy_list_remote_files` | Browse files on a remote peer |
| `loopsy_context_set` | Store a key-value pair on a peer |
| `loopsy_context_get` | Retrieve a value from a peer |
| `loopsy_context_list` | List context entries with optional prefix filter |
| `loopsy_context_delete` | Delete a context entry |
| `loopsy_broadcast_context` | Set a value on ALL peers |
| `loopsy_send_message` | Send a protocol-compliant message |
| `loopsy_check_inbox` | Check inbox for new messages |
| `loopsy_ack_message` | Acknowledge a received message |
| `loopsy_check_ack` | Check if a peer acknowledged your messages |

### Configuring MCP in Claude Code

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "loopsy": {
      "command": "node",
      "args": ["/path/to/loopsy/packages/mcp-server/dist/index.js"]
    }
  }
}
```

## Multi-Session Support

Run multiple daemon instances per machine, each acting as an independent peer. This enables a fleet of Claude Code instances to collaborate.

```bash
# Start 3 sessions on this machine
loopsy session start-fleet --count 3

# Each session gets:
#   - Unique port (19533, 19534, 19535, ...)
#   - Unique hostname (leo-worker-1, leo-worker-2, leo-worker-3)
#   - Isolated data directory (~/.loopsy/sessions/<name>/)

# List running sessions
loopsy session list
# NAME            PORT    HOSTNAME                    PID     STATUS
# worker-1        19533   leo-worker-1                12345   running
# worker-2        19534   leo-worker-2                12346   running
# worker-3        19535   leo-worker-3                12347   running

# Stop everything
loopsy session stop-all
```

Sessions share the parent machine's API key and `allowedKeys`, so they authenticate seamlessly with each other and remote peers. To connect an MCP server to a specific session:

```bash
LOOPSY_DATA_DIR=~/.loopsy/sessions/worker-1 node packages/mcp-server/dist/index.js
```

## Configuration

Config file: `~/.loopsy/config.yaml`

```yaml
server:
  port: 19532
  host: 0.0.0.0
  hostname: leo              # optional custom hostname
auth:
  apiKey: <64-char-hex-key>
  allowedKeys:
    remote-device: <peer-api-key>
execution:
  denylist: [rm, rmdir, format, mkfs, dd, shutdown, reboot]
  maxConcurrent: 10
  defaultTimeout: 300000     # 5 minutes
transfer:
  allowedPaths: [/Users/you]
  deniedPaths: [/Users/you/.ssh, /Users/you/.gnupg]
  maxFileSize: 1073741824    # 1GB
rateLimits:
  execute: 30                # per minute
  transfer: 10
  context: 60
discovery:
  enabled: true
  manualPeers:
    - address: 192.168.1.75
      port: 19532
logging:
  level: info
```

## REST API

Base URL: `http://<host>:19532/api/v1`

All endpoints (except `/health`) require `Authorization: Bearer <api_key>`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no auth) |
| GET | `/status` | Daemon status |
| GET | `/identity` | Node identity |
| GET | `/peers` | List peers |
| POST | `/peers` | Add a peer |
| DELETE | `/peers/:nodeId` | Remove a peer |
| POST | `/execute` | Execute a command |
| POST | `/execute/stream` | Execute with SSE streaming |
| DELETE | `/execute/:jobId` | Cancel a job |
| GET | `/execute/jobs` | List active jobs |
| POST | `/transfer/push` | Receive a file (multipart) |
| POST | `/transfer/pull` | Send a file |
| POST | `/transfer/list` | List directory |
| PUT | `/context/:key` | Set context value |
| GET | `/context/:key` | Get context value |
| DELETE | `/context/:key` | Delete context value |
| GET | `/context` | List context (supports `?prefix=`) |

## Project Structure

```
packages/
  protocol/     Shared types, schemas, constants
  discovery/    mDNS peer discovery + health checking
  daemon/       Fastify HTTP server (the core)
  mcp-server/   MCP server for Claude Code
  cli/          CLI management tool
```

## Security

- **Authentication**: Pre-shared API keys, validated on every request
- **Command denylist**: Configurable list of blocked commands (rm, shutdown, etc.)
- **Path restrictions**: File transfers limited to `allowedPaths`, with `deniedPaths` exclusions
- **Rate limiting**: Per-category limits (execute, transfer, context)
- **Audit logging**: All requests logged to `~/.loopsy/logs/audit.jsonl`

## Cross-Platform Notes

Validated on macOS (arm64, Apple Silicon) and Windows 10 (x64, Git Bash).

- **Windows with Git Bash**: Remote execution uses Unix-style paths (`/c/Users/...` not `C:\Users\...`)
- **File transfers**: Both source and destination must be within `transfer.allowedPaths`
- **Shell differences**: Use `pwd` to discover the remote working directory before running commands

## License

MIT
