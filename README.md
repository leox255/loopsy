# Loopsy

Cross-machine communication for Claude Code. Run commands, transfer files, share context, and send messages between Claude Code instances on different machines over your LAN.

```
Machine A (macOS)                    Machine B (Windows)
┌──────────────┐                     ┌──────────────┐
│  Claude Code  │                     │  Claude Code  │
│  + MCP Server │                     │  + MCP Server │
│       │       │                     │       │       │
│  Loopsy Daemon│◄── HTTP(S)/LAN ───►│  Loopsy Daemon│
│  :19532       │                     │  :19532       │
└──────────────┘                     └──────────────┘
```

## Install

```bash
npm install -g loopsy
```

Requires Node.js 20+. That's it — no cloning, no build step.

## Quick Start

```bash
# 1. Initialize (generates config + API key, registers MCP with Claude Code)
loopsy init

# 2. Start the daemon
loopsy start

# 3. Pair with another machine
loopsy pair              # on Machine A (displays invite code)
loopsy pair 192.168.1.50 # on Machine B (enters invite code)

# 4. Verify
loopsy doctor
```

After pairing, restart both daemons (`loopsy stop && loopsy start`). Open Claude Code and the `loopsy_*` MCP tools are available immediately.

### Auto-Start on Login

```bash
loopsy enable   # registers as a system service (launchd / systemd / Task Scheduler)
loopsy disable  # removes the system service
```

## How It Works

Each machine runs a **Loopsy daemon** — a Fastify HTTP server on port 19532. Daemons communicate directly over HTTP (or HTTPS with TLS enabled). An **MCP server** exposes the daemon's capabilities as tools inside Claude Code.

Peers discover each other via mDNS or manual configuration. The `loopsy pair` command automates key exchange using ECDH with a 6-digit verification code — no manual copying of 64-character API keys.

## CLI Reference

### Setup & Status

| Command | Description |
|---|---|
| `loopsy init` | Generate config and API key; auto-registers MCP with Claude Code |
| `loopsy start` | Start the daemon |
| `loopsy stop` | Stop the daemon |
| `loopsy status` | Show daemon status (peers, jobs, context) |
| `loopsy doctor` | Health check — config, daemon, MCP, TLS, peers, service |

### Networking

| Command | Description |
|---|---|
| `loopsy pair [address]` | Secure pairing (no address = wait for peer; with address = connect) |
| `loopsy connect` | Interactive wizard for manual peer setup |
| `loopsy peers` | List known peers |
| `loopsy peers add <ip> [port]` | Add a manual peer |
| `loopsy peers remove <nodeId>` | Remove a peer |

### Remote Operations

| Command | Description |
|---|---|
| `loopsy exec <peer> <cmd..>` | Execute a command on a remote peer |
| `loopsy send <peer> <src> <dest>` | Push a file to a peer |
| `loopsy pull <peer> <src> <dest>` | Pull a file from a peer |

### Context Store

| Command | Description |
|---|---|
| `loopsy context set <key> <value>` | Set a shared value (optional `--ttl`) |
| `loopsy context get <key>` | Get a value |
| `loopsy context list` | List all entries |
| `loopsy context delete <key>` | Delete an entry |

### System Service

| Command | Description |
|---|---|
| `loopsy enable` | Auto-start daemon on login (launchd / systemd / Task Scheduler) |
| `loopsy disable` | Remove auto-start |
| `loopsy service-status` | Check registration status |

### MCP Management

| Command | Description |
|---|---|
| `loopsy mcp add` | Register MCP server with Claude Code |
| `loopsy mcp remove` | Unregister MCP server |
| `loopsy mcp status` | Check registration |

### Multi-Session

Run multiple daemon instances per machine, each as an independent peer:

```bash
loopsy session start-fleet --count 3   # starts worker-1, worker-2, worker-3
loopsy session list                     # show all sessions
loopsy session stop-all                 # stop everything
```

Each session gets a unique port (19533+), hostname (`<host>-worker-N`), and isolated data directory (`~/.loopsy/sessions/<name>/`).

| Command | Description |
|---|---|
| `loopsy session start <name>` | Start a named session |
| `loopsy session start-fleet -c N` | Start N worker sessions |
| `loopsy session stop <name>` | Stop a session |
| `loopsy session stop-all` | Stop all sessions |
| `loopsy session list` | List sessions with status |
| `loopsy session status <name>` | Detailed session status |

### Other

| Command | Description |
|---|---|
| `loopsy dashboard` | Start the web dashboard (default port 19540) |
| `loopsy key show` | Show current API key |
| `loopsy key generate` | Generate a new API key |
| `loopsy logs [-f]` | View audit logs |

## MCP Tools

When the MCP server is registered with Claude Code (done automatically by `loopsy init`), these tools are available:

| Tool | Description |
|---|---|
| `loopsy_list_peers` | List all peers with online/offline status |
| `loopsy_peer_status` | Detailed status for a specific peer |
| `loopsy_execute` | Run a command on a remote peer |
| `loopsy_transfer_file` | Push or pull files between machines |
| `loopsy_list_remote_files` | Browse a directory on a remote peer |
| `loopsy_context_set` | Store a key-value pair locally or on a peer |
| `loopsy_context_get` | Retrieve a value |
| `loopsy_context_list` | List entries with optional prefix filter |
| `loopsy_context_delete` | Delete an entry |
| `loopsy_broadcast_context` | Set a value on ALL online peers |
| `loopsy_send_message` | Send a protocol-compliant message (auto-handles envelope, inbox key, outbox copy, TTL) |
| `loopsy_check_inbox` | Check inbox for new messages |
| `loopsy_ack_message` | Acknowledge a received message |
| `loopsy_check_ack` | Check if a peer acknowledged your messages |

The MCP server also exposes resources (`loopsy://peers`, `loopsy://status`, `loopsy://context`) and prompts (`loopsy_help`, `loopsy_coordinate`).

### Manual MCP Registration

If `loopsy init` didn't auto-register (e.g., Claude Code wasn't installed yet):

```bash
loopsy mcp add
```

Or manually:

```bash
claude mcp add loopsy -- node $(npm root -g)/loopsy/dist/mcp-server/index.js
```

## Pairing Protocol

`loopsy pair` replaces manual API key exchange with a secure ECDH handshake:

1. **Machine A** runs `loopsy pair` — daemon generates a 6-digit invite code
2. **Machine B** runs `loopsy pair <A's IP>` — enters the invite code
3. Both machines perform ECDH key exchange (P-256) and derive a Short Authentication String (SAS)
4. Both users confirm the 6-digit SAS matches on their screens
5. API keys and TLS certificate fingerprints are exchanged automatically
6. Both configs are updated — restart daemons to connect

The pairing session expires after 5 minutes. No secrets are transmitted in plaintext.

## TLS

Loopsy supports optional HTTPS for all peer-to-peer communication:

1. Enable in `~/.loopsy/config.yaml`:
   ```yaml
   tls:
     enabled: true
   ```
2. Restart the daemon — a self-signed EC certificate is generated at `~/.loopsy/tls/`
3. When pairing, certificate fingerprints are exchanged and pinned automatically

The daemon falls back to HTTP for peers that don't support TLS. Local connections (MCP server, dashboard) always use HTTP on localhost.

## Web Dashboard

A browser-based UI for monitoring and control:

```bash
loopsy dashboard          # opens on port 19540
loopsy dashboard -p 8080  # custom port
```

The dashboard provides:
- **Overview** — aggregate status across all sessions and peers
- **Peers** — deduplicated peer list with health status
- **Context** — browse and manage the key-value store
- **Messages** — unified inbox/outbox, compose and send messages
- **AI Tasks** — dispatch, monitor, stream output, approve/deny permissions, and cancel tasks
- **Terminal** — execute streaming commands on any local session

The dashboard proxies requests to all local daemon sessions, giving a unified view even with multiple workers running.

## AI Task Dispatch

Loopsy can dispatch Claude Code tasks to run on any machine:

```bash
# Via REST API
curl -X POST http://localhost:19532/api/v1/ai-tasks \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "List all TODO comments in this repo", "cwd": "/path/to/project"}'
```

Tasks run Claude CLI via PTY for real-time streaming. Permission requests (tool approvals) are surfaced through the dashboard or API. Up to 3 concurrent AI tasks per daemon (configurable).

## REST API

Base URL: `http(s)://<host>:19532/api/v1`

All endpoints except `/health` require `Authorization: Bearer <api_key>`.

### Health & Status

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check (no auth required) |
| GET | `/status` | Daemon status with peer/job/context counts |
| GET | `/identity` | Node identity (nodeId, hostname, platform, capabilities) |

### Peers

| Method | Path | Description |
|---|---|---|
| GET | `/peers` | List all known peers |
| POST | `/peers` | Add a manual peer |
| DELETE | `/peers/:nodeId` | Remove a peer |
| POST | `/peers/handshake` | Peer registration handshake |

### Remote Execution

| Method | Path | Description |
|---|---|---|
| POST | `/execute` | Run a command; returns stdout, stderr, exitCode |
| POST | `/execute/stream` | Run with SSE streaming |
| DELETE | `/execute/:jobId` | Cancel a running job |
| GET | `/execute/jobs` | List active jobs |

### File Transfer

| Method | Path | Description |
|---|---|---|
| POST | `/transfer/push` | Receive a file (multipart upload) |
| POST | `/transfer/pull` | Send a file (octet-stream response) |
| POST | `/transfer/list` | List a directory |

### Context Store

| Method | Path | Description |
|---|---|---|
| PUT | `/context/:key` | Set a value (`{value, ttl?}`) |
| GET | `/context/:key` | Get a value |
| DELETE | `/context/:key` | Delete a value |
| GET | `/context` | List all entries (optional `?prefix=` filter) |

### AI Tasks

| Method | Path | Description |
|---|---|---|
| POST | `/ai-tasks` | Dispatch a new AI task |
| GET | `/ai-tasks` | List all tasks |
| GET | `/ai-tasks/:id` | Get task status |
| GET | `/ai-tasks/:id/stream` | SSE event stream (`?since=` for reconnect) |
| POST | `/ai-tasks/:id/approve` | Approve or deny a permission request |
| DELETE | `/ai-tasks/:id` | Cancel or delete a task |

### Pairing

| Method | Path | Description |
|---|---|---|
| POST | `/pair/start` | Start a pairing session (returns invite code) |
| POST | `/pair/initiate` | Peer sends public key + invite code |
| POST | `/pair/confirm` | Confirm or cancel after SAS verification |
| GET | `/pair/status` | Check pairing session state |

## Configuration

Config file: `~/.loopsy/config.yaml`

```yaml
server:
  port: 19532
  host: 0.0.0.0
  hostname: leo                # optional custom hostname

auth:
  apiKey: <auto-generated>
  allowedKeys:
    peer-name: <peer-api-key>  # added automatically by loopsy pair

tls:
  enabled: false               # set to true for HTTPS
  pinnedCerts:                 # populated by loopsy pair
    peer-name: <sha256-hex>

execution:
  denylist: [rm, rmdir, format, mkfs, dd, shutdown, reboot]
  maxConcurrent: 10
  defaultTimeout: 300000       # 5 minutes

transfer:
  allowedPaths: [/Users/you]
  deniedPaths: [/Users/you/.ssh, /Users/you/.gnupg]
  maxFileSize: 1073741824      # 1 GB

rateLimits:
  execute: 30                  # requests per minute
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

## Data Storage

Default location: `~/.loopsy/`

| Path | Purpose |
|---|---|
| `config.yaml` | Daemon configuration |
| `context.json` | Key-value store |
| `peers.json` | Peer registry |
| `logs/audit.jsonl` | Request audit log |
| `daemon.pid` | Main daemon process ID |
| `tls/cert.pem` | Self-signed TLS certificate |
| `tls/key.pem` | TLS private key |
| `sessions/<name>/` | Per-session data (same structure) |

## Project Structure

```
packages/
  protocol/     Shared types, schemas, constants
  discovery/    mDNS peer discovery + health checking
  daemon/       Fastify HTTP server (the core)
  mcp-server/   MCP server for Claude Code integration
  cli/          CLI tool (the loopsy binary)
  dashboard/    Web UI for monitoring and control
scripts/
  package.mjs   Assembly script for npm packaging
```

## Security

- **Authentication**: Pre-shared API keys validated on every request (except `/health` and pairing endpoints)
- **Secure pairing**: ECDH key exchange with SAS verification — no plaintext secret transmission
- **TLS**: Optional HTTPS with self-signed certificates and cert pinning
- **Command denylist**: Configurable blocked commands (rm, shutdown, etc.)
- **Path restrictions**: File transfers limited to `allowedPaths` with `deniedPaths` exclusions
- **Rate limiting**: Per-category limits (execute: 30/min, transfer: 10/min, context: 60/min)
- **Audit logging**: Every request logged to `~/.loopsy/logs/audit.jsonl`

## Cross-Platform

Validated on macOS (arm64) and Windows 10 (x64, Git Bash).

- **Windows + Git Bash**: The daemon runs in Git Bash, so remote commands use Unix-style paths (`/c/Users/...`)
- **File transfers**: Both source and destination must be within `transfer.allowedPaths`
- **System service**: macOS uses launchd, Linux uses systemd user units, Windows uses Task Scheduler

## Development

For contributing or running from source:

```bash
git clone https://github.com/leox255/loopsy.git
cd loopsy
pnpm install
pnpm build
node packages/cli/dist/index.js init
node packages/cli/dist/index.js start
```

### Packaging

To build the npm package locally:

```bash
pnpm build
node scripts/package.mjs
cd package-dist && npm pack
npm install -g ./loopsy-*.tgz
```

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.
