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

## "Chatting" Between Claude Instances

To communicate between Claude Code on different machines:

1. **Send a message**: Use `loopsy_context_set` with a key like `msg_from_mac` and your message as the value
2. **Read messages**: Use `loopsy_context_get` to read messages from the other machine
3. **Ask the other machine to do something**: Use `loopsy_execute` to run commands on it

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
