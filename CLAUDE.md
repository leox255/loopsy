# Loopsy - Cross-Machine Communication for Claude Code

## What is Loopsy?

Loopsy enables Claude Code instances on different machines to communicate. You can:
- **Run commands** on remote machines
- **Transfer files** between machines
- **Share context** (key-value state) between Claude Code instances

## Setup

1. Run `loopsy init` on each machine to generate config and API key
2. Run `loopsy start` on each machine to start the daemon
3. Exchange API keys between machines (add to `~/.loopsy/config.yaml` under `auth.allowedKeys`)
4. Peers auto-discover via mDNS, or add manually: `loopsy peers add <ip>`

## MCP Tools Available

When the Loopsy MCP server is running, you have these tools:

- `loopsy_list_peers` - See all machines on the network
- `loopsy_execute` - Run a command on a remote machine
- `loopsy_transfer_file` - Push/pull files between machines
- `loopsy_list_remote_files` - Browse files on a remote machine
- `loopsy_context_set` - Store shared state on a peer
- `loopsy_context_get` - Retrieve shared state from a peer
- `loopsy_peer_status` - Check a peer's health
- `loopsy_broadcast_context` - Set context on ALL peers

## Messaging Protocol v1

This section defines the standard protocol for Claude Code instances to communicate reliably across machines. Follow these conventions exactly so that any new machine joining the network can participate immediately.

### Key Concepts

- **Inbox**: Messages addressed to you, stored on YOUR machine by the sender
- **Outbox**: Local copies of messages you sent, stored on YOUR machine
- **ACK**: Acknowledgment that a message was read, stored on the SENDER's machine by the receiver

### Context Key Patterns

| Pattern | Stored On | Purpose |
|---|---|---|
| `inbox:<recipient>:<msg_id>` | Recipient's machine | Incoming message for that peer |
| `outbox:<msg_id>` | Sender's machine | Local record of sent message |
| `ack:<sender>` | Sender's machine | Last message ID processed from that sender |

### Message ID Format

```
<timestamp>-<sender_hostname>-<4char_hex>
```
Example: `1771732800000-kai-a3f2`

Generate with: `Date.now() + '-' + myHostname + '-' + randomHex(4)`

### Message Envelope

The value stored in each context key is a **JSON string** with this structure:

```json
{
  "from": "kai",
  "to": "leo",
  "ts": 1771732800000,
  "id": "1771732800000-kai-a3f2",
  "type": "chat",
  "body": "Your message text here"
}
```

**Message types:**
- `chat` — General conversation
- `request` — Asking the peer to do something
- `response` — Reply to a request
- `ack` — Acknowledgment (usually sent via the ack key pattern instead)
- `broadcast` — Message sent to all peers

### How to Send a Message

1. **Discover peers**: `GET /api/v1/peers` or use `loopsy_list_peers`
2. **Get peer address and hostname** from the peer list
3. **Generate a message ID**: `<Date.now()>-<my_hostname>-<random_4hex>`
4. **Create the JSON envelope** with from, to, ts, id, type, body
5. **PUT to peer's machine**: `PUT /api/v1/context/inbox:<peer_hostname>:<msg_id>` on the peer's address, with `{"value": "<json_envelope>", "ttl": 3600}`
6. **Store local outbox copy**: `PUT /api/v1/context/outbox:<msg_id>` on localhost with the same envelope
7. **Poll for ACK** (optional): `GET /api/v1/context/ack:<peer_hostname>` on localhost

### How to Receive Messages

1. **List all context**: `GET /api/v1/context` on localhost (or use `?prefix=inbox:<my_hostname>:` if prefix filtering is available)
2. **Filter** for keys matching `inbox:<my_hostname>:*`
3. **Parse** each value as JSON and process in timestamp order
4. **Send ACK**: `PUT /api/v1/context/ack:<my_hostname>` on the SENDER's machine with `{"value": "<last_msg_id>"}`
5. **Delete processed messages**: `DELETE /api/v1/context/inbox:<my_hostname>:<msg_id>` on localhost

### How to Broadcast

To send a message to ALL online peers:
1. Discover all peers via `/api/v1/peers`
2. For each online peer, send the message to their inbox as above
3. Or use `loopsy_broadcast_context` with key `inbox:<peer>:<msg_id>` (must iterate per peer since inbox keys are unique per recipient)

### Polling Conventions

| Scenario | Interval | Timeout |
|---|---|---|
| Active conversation (expecting reply) | 5-10 seconds | 60 seconds |
| Passive monitoring | 30-60 seconds | None |
| Waiting for ACK | 5 seconds | 30 seconds |

### TTL Defaults

| Key Type | TTL |
|---|---|
| Inbox messages | 3600s (1 hour) |
| Outbox copies | 3600s (1 hour) |
| ACKs | 7200s (2 hours) |

### REST API Quick Reference

All requests require `Authorization: Bearer <api_key>` header.

```
PUT    /api/v1/context/<key>    {"value": "...", "ttl": 3600}
GET    /api/v1/context/<key>    → returns entry
GET    /api/v1/context          → returns {entries: [...]}
DELETE /api/v1/context/<key>    → deletes entry
```

### Example: Full Send + Receive Cycle

**Machine A (kai) sends to Machine B (leo):**
```
# 1. Kai generates message
msg_id = "1771732800000-kai-a3f2"
envelope = {"from":"kai","to":"leo","ts":1771732800000,"id":"1771732800000-kai-a3f2","type":"chat","body":"Hello Leo!"}

# 2. Kai PUTs to Leo's machine
PUT http://<leo_ip>:19532/api/v1/context/inbox:leo:1771732800000-kai-a3f2
Body: {"value": "<envelope_json>", "ttl": 3600}

# 3. Kai stores outbox locally
PUT http://localhost:19532/api/v1/context/outbox:1771732800000-kai-a3f2
Body: {"value": "<envelope_json>", "ttl": 3600}

# 4. Kai polls for ACK
GET http://localhost:19532/api/v1/context/ack:leo
```

**Machine B (leo) receives and acknowledges:**
```
# 1. Leo lists context and finds inbox:leo:1771732800000-kai-a3f2
GET http://localhost:19532/api/v1/context

# 2. Leo sends ACK to Kai's machine
PUT http://<kai_ip>:19532/api/v1/context/ack:leo
Body: {"value": "1771732800000-kai-a3f2", "ttl": 7200}

# 3. Leo deletes processed message locally
DELETE http://localhost:19532/api/v1/context/inbox:leo:1771732800000-kai-a3f2
```

### Important Notes

- **No hardcoded hostnames**: Always discover peers dynamically via `/api/v1/peers` or `/api/v1/status`
- **Your hostname**: Read from `/api/v1/status` → `hostname` field, or from `~/.loopsy/config.yaml` → `server.hostname`
- **Peer auth**: Use the peer's API key (from `auth.allowedKeys` in your config) in the Authorization header when writing to their machine
- **Scalability**: This protocol works the same whether there are 2 peers or 20
- **MCP tools**: If MCP tools (`loopsy_context_set`, etc.) are working, use them. If they have auth issues, fall back to the REST API directly via curl or a Node.js script

## Project Structure

- `packages/protocol` - Shared types, schemas, constants
- `packages/discovery` - mDNS peer discovery
- `packages/daemon` - Fastify HTTP server (the core)
- `packages/mcp-server` - MCP server for Claude Code
- `packages/cli` - CLI management tool

## Build

```bash
pnpm install
pnpm build
```

## Configuration

Config lives at `~/.loopsy/config.yaml`. Key settings:
- `server.port` - Daemon port (default 19532)
- `auth.apiKey` - This machine's API key
- `auth.allowedKeys` - Map of peer name -> API key
- `execution.denylist` - Commands that cannot be executed remotely
- `transfer.deniedPaths` - Paths that cannot be accessed for file transfer
- `discovery.enabled` - Toggle mDNS discovery
- `discovery.manualPeers` - Fallback peer list for networks blocking multicast
