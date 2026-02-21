# Loopsy Protocol Specification v1.0

## Overview

Loopsy (Loop System) is a cross-machine communication protocol for Claude Code. It enables Claude Code instances on different machines within a LAN to execute commands, transfer files, and share context.

## Architecture

Each machine runs:
1. **Loopsy Daemon** - A Fastify HTTP server on port 19532
2. **MCP Server** - A stdio process that talks to the local daemon

Daemons communicate directly over HTTP within the LAN.

## Discovery

Peers are discovered via mDNS (Bonjour/Zeroconf):
- Service type: `_loopsy._tcp`
- TXT records: `nodeId`, `version`, `platform`, `capabilities`

Manual peer configuration is supported as fallback.

## Authentication

All API requests require a Bearer token:
```
Authorization: Bearer <64-char-hex-api-key>
```

Keys are pre-shared and configured in `~/.loopsy/config.yaml`.

## API Endpoints

Base URL: `http://<host>:19532/api/v1`

### Health & Status

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no auth required) |
| GET | `/status` | Detailed daemon status |
| GET | `/identity` | Node identity |

### Peers

| Method | Path | Description |
|--------|------|-------------|
| GET | `/peers` | List all known peers |
| POST | `/peers` | Add a manual peer |
| POST | `/peers/handshake` | Peer handshake |
| DELETE | `/peers/:nodeId` | Remove a peer |

### Command Execution

| Method | Path | Description |
|--------|------|-------------|
| POST | `/execute` | Execute a command |
| POST | `/execute/stream` | Execute with SSE streaming |
| DELETE | `/execute/:jobId` | Cancel a running job |
| GET | `/execute/jobs` | List active jobs |

#### Execute Request Body
```json
{
  "command": "ls",
  "args": ["-la", "/tmp"],
  "cwd": "/home/user",
  "timeout": 30000
}
```

#### Execute Response
```json
{
  "jobId": "uuid",
  "exitCode": 0,
  "stdout": "...",
  "stderr": "",
  "duration": 150,
  "killed": false
}
```

### File Transfer

| Method | Path | Description |
|--------|------|-------------|
| POST | `/transfer/push` | Receive a file (multipart) |
| POST | `/transfer/pull` | Send a file to requester |
| POST | `/transfer/list` | List directory contents |

### Context (Shared State)

| Method | Path | Description |
|--------|------|-------------|
| PUT | `/context/:key` | Set a context value |
| GET | `/context/:key` | Get a context value |
| DELETE | `/context/:key` | Delete a context value |
| GET | `/context` | List all context entries |

#### Context Set Body
```json
{
  "value": "any string value",
  "ttl": 3600
}
```

## Error Codes

| Range | Category |
|-------|----------|
| 1xxx | Authentication |
| 2xxx | Peer |
| 3xxx | Execution |
| 4xxx | Transfer |
| 5xxx | Context |
| 9xxx | Internal |

Error response format:
```json
{
  "error": {
    "code": 1002,
    "message": "Invalid API key"
  }
}
```

## Security

- Commands are validated against a denylist (configurable)
- File transfers are restricted to allowed paths
- Rate limiting per category: 30 exec/min, 10 transfer/min, 60 context/min
- All requests are logged to `~/.loopsy/logs/audit.jsonl`

## Configuration

File: `~/.loopsy/config.yaml`

```yaml
server:
  port: 19532
  host: 0.0.0.0
auth:
  apiKey: <your-64-char-hex-key>
  allowedKeys:
    windows-pc: <peer-api-key>
execution:
  denylist: [rm, rmdir, format, mkfs, dd, shutdown, reboot]
  maxConcurrent: 10
  defaultTimeout: 300000
transfer:
  allowedPaths: [/Users/you]
  deniedPaths: [/Users/you/.ssh, /Users/you/.gnupg]
  maxFileSize: 1073741824
discovery:
  enabled: true
  manualPeers:
    - address: 192.168.1.100
      port: 19532
logging:
  level: info
```

## Data Storage

- Config: `~/.loopsy/config.yaml`
- Peers: `~/.loopsy/peers.json`
- Context: `~/.loopsy/context.json`
- Audit logs: `~/.loopsy/logs/audit.jsonl`
- PID file: `~/.loopsy/daemon.pid`
