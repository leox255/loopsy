# Loopsy

**Your terminal, in your pocket.**

Control Claude Code, Cursor, Codex, or any shell on your laptop from your phone. Self-hosted on Cloudflare Workers.

[![npm](https://img.shields.io/npm/v/loopsy.svg)](https://www.npmjs.com/package/loopsy)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
`macOS` · `Linux` · `Windows`

→ [loopsy.dev](https://loopsy.dev)

---

## Try it

```bash
# 1. Install on your laptop (any OS)
npm install -g loopsy

# 2. Deploy your own relay to Cloudflare Workers (~30s, free tier)
npx @loopsy/deploy-relay
# prompts for worker name + optional custom domain
# outputs: https://<your-relay>.workers.dev

# 3. Wire the daemon to it and start
loopsy init
loopsy relay configure https://<your-relay>.workers.dev
loopsy start

# 4. Pair your phone
loopsy mobile pair
# scan the QR with your phone camera, enter the 4-digit code

# 5. Open https://<your-relay>.workers.dev/app on your phone
```

That's the whole thing. Pick any agent, type or dictate, the laptop runs it.

## How it works

```
┌─────────────┐         ┌──────────────────────┐         ┌─────────┐
│   Laptop    │◄──WSS──►│ Cloudflare Worker    │◄──WSS──►│  Phone  │
│   loopsy    │         │ Durable Object       │         │  /app   │
│   daemon    │         │ (your account)       │         │         │
└─────────────┘         └──────────────────────┘         └─────────┘
```

The daemon opens an outbound WebSocket to a small Cloudflare Worker. Your phone connects to the same Worker. The Worker splices the two together. No port forwarding, no public IP, no VPN.

The relay is yours: pair tokens are HMAC-signed, secrets are SHA-256 hashed at rest, and bearer tokens travel in `Sec-WebSocket-Protocol` headers — never query strings.

## What you get

- **Real terminal.** Full PTY, ANSI, scrollback, resize. TUIs render properly.
- **Persistent sessions.** Switch tabs, lock your phone, lose signal, pick up where you left off.
- **Voice input.** Dictate via Web Speech API, edit before sending.
- **Per-session auto-approve.** Opt in to skip confirmation prompts (`--dangerously-skip-permissions`, `-y`, `--full-auto`) on a per-session basis. Default: off, with a macOS confirmation dialog the first time.

## Self-host the relay

```bash
npx @loopsy/deploy-relay
```

The CLI:
1. Prompts for a worker name and optional custom domain.
2. Generates a fresh `PAIR_TOKEN_SECRET` (32 random bytes).
3. Runs `wrangler deploy` — opens your browser for OAuth on first run.
4. Sets the secret via stdin (never appears on your clipboard or in process args).
5. Saves the relay URL to `~/.loopsy/relay.json`.

Cloudflare Workers free tier covers personal use comfortably. SQLite-backed Durable Objects are also free-tier eligible.

## Phone client

The web client at `/app` runs on iOS Safari and Android Chrome with no install. Native iOS & Android apps are in submission review.

| Feature | Status |
|---|---|
| Web app (`/app`) | ✅ Live |
| iOS / iPadOS native | ⏳ App Store review |
| Android native | ⏳ Play Store review |

## CLI

### Phone control

| Command | Description |
|---|---|
| `loopsy mobile pair [--ttl <seconds>]` | Issue a pair token. Prints QR + 4-digit verification code. |
| `loopsy phone list` | List paired phones for this device. |
| `loopsy phone revoke <id>` | Revoke a paired phone server-side. |
| `loopsy relay configure <url>` | Point the daemon at a different relay. |

### Daemon

| Command | Description |
|---|---|
| `loopsy init` | Generate config + API key. |
| `loopsy start` | Start the daemon. |
| `loopsy stop` | Stop the daemon. |
| `loopsy status` | Show daemon status. |
| `loopsy doctor` | Health check across config, daemon, MCP, peers. |
| `loopsy enable` | Auto-start on login (launchd / systemd / Task Scheduler). |
| `loopsy disable` | Remove auto-start. |

### Logs & keys

| Command | Description |
|---|---|
| `loopsy logs [-f]` | View audit logs. |
| `loopsy key show` | Show current API key. |
| `loopsy key generate` | Rotate the API key. |

## Agent-to-agent on a LAN

This is the original Loopsy. Phone control was built on top of it.

Run a daemon on every machine you own. The daemons find each other on your local network via mDNS, you pair them once, and after that each machine exposes a small set of capabilities to the others: run a command, transfer a file, store and read shared key/value state, send and receive messages. Those same capabilities are also exposed to whatever AI coding agent you have installed (Claude Code, Codex CLI, Gemini CLI, Opencode) through MCP, so an agent on one machine can drive another machine directly.

### Setup

```bash
# On every machine
npm i -g loopsy
loopsy init
loopsy start

# Pair two machines
loopsy pair                  # on machine A, prints a 6-digit code
loopsy pair 192.168.1.50     # on machine B, paste the code
```

Pairing uses ECDH (P-256) with a 6-digit short authentication string that you compare visually. After pairing, restart both daemons; the `loopsy_*` MCP tools become available to your AI coding agent automatically.

If mDNS doesn't reach (cross-subnet, locked-down corp networks), add a peer manually:

```bash
loopsy peers add 192.168.1.50
```

### MCP tools your agent gets

When the Loopsy MCP server is wired into your agent, the agent gains:

| Tool | What it does |
|---|---|
| `loopsy_list_peers` | Enumerate machines on the network with online/offline status. |
| `loopsy_peer_status` | Health check a specific peer. |
| `loopsy_execute` | Run a command on a remote machine. |
| `loopsy_session_start` / `_stop` / `_list` / `_remove` | Long-lived PTY sessions on a peer. Spawn, poll, tear down. |
| `loopsy_transfer_file` | Push a local file to a peer, or pull a peer's file. |
| `loopsy_list_remote_files` | Browse a peer's filesystem (within configured allowed paths). |
| `loopsy_context_set` / `_get` / `_list` / `_delete` | Shared key/value store on a peer. |
| `loopsy_broadcast_context` | Same key/value, written to every online peer at once. |
| `loopsy_send_message` | Protocol-compliant message to a peer's inbox, with envelope, outbox copy, TTL. |
| `loopsy_check_inbox` | Pull pending messages addressed to this machine. |
| `loopsy_check_ack` / `_ack_message` | Read receipts. |

### What it actually looks like in practice

A few real scenarios:

- **Worker machine.** I have a Mac Studio sitting in another room. I tell Claude on my laptop, "kick off the iOS build on kai and let me know when it finishes." Claude calls `loopsy_session_start` against kai with the build command, polls until it exits, and reports back. My laptop stays cool and responsive.
- **Long-running agent tasks on bigger hardware.** Spawn a Claude session on the Mac Studio, hand it a multi-file refactor, walk away. Check in from your laptop or phone hours later via `loopsy_session_list` (or the iOS app's session picker).
- **Multi-agent pipelines.** Agent on machine A writes results into `loopsy_context_set` under a known key. Agent on machine B polls `loopsy_context_get` and picks up the work. Both agents are blissfully unaware of each other's existence beyond the shared key/value protocol.
- **Pair programming with another developer's machine.** They run `loopsy peers add <your_ip>`, paste API keys, and now both your agents can transfer files and share context.

### Messaging protocol

There's a standard for AI agents to message each other across machines reliably (delivery, ACKs, retries). It uses the context store as the medium so any new machine can join without coordinating clients. Convention:

| Pattern | Stored on | Purpose |
|---|---|---|
| `inbox:<recipient>:<msg_id>` | recipient's machine | message addressed to that peer |
| `outbox:<msg_id>` | sender's machine | local copy of sent message |
| `ack:<sender>` | sender's machine | last message id the recipient processed |

Full envelope schema, polling intervals, TTL defaults, and the task queue protocol are in [AGENTS.md](AGENTS.md). It works the same whether there are 2 peers or 20.

### LAN path security

LAN agent-to-agent traffic does **not** go through the relay. Daemons talk directly over your local network. Bearer-auth on every request, API keys exchanged at pair time. If you want the daemon visible on the LAN you have to opt in (`loopsy start --lan`); the default is localhost-only.

## Security

### Threat model, read this first

Loopsy is a control surface for your own machine, accessed by your own phone, routed through a relay you can self-host. Some sharp edges fall out of that:

- **The relay can read your terminal content.** The phone↔daemon connection is TLS-protected on the wire, but TLS terminates at the relay (your own Cloudflare Worker if you self-host, or `relay.loopsy.dev` if you use the default). Whoever operates that relay can see every byte of PTY input and output, including any password you type at a `sudo` prompt or any secret a script echoes. End-to-end encryption between phone and daemon is on the v1.1 roadmap. Until then, **if you don't fully trust the relay operator, self-host with `@loopsy/deploy-relay` — it takes about 30 seconds.** Or skip the mobile path entirely and use only `loopsy shell` over the local Unix socket.

- **A paired phone is a credential.** Anyone holding your unlocked phone with the Loopsy app installed can run commands on your machine. The app itself doesn't add a passcode beyond iOS's lock screen. If auto-approve is enabled for a session, that session can run `claude --dangerously-skip-permissions` (or the equivalent for Codex / Gemini), meaning the agent will edit files and run shell commands without asking. Auto-approve defaults OFF and requires your macOS user password to enable; revoke a phone with `loopsy phone revoke <id>` if you lose it.

- **Auto-approve sends your macOS password through the relay** (TLS-encrypted, but visible at the relay). Only enable auto-approve on a relay you trust. Self-hosting is again the answer here.

- **The pair URL is the pairing.** It contains a one-time pair token plus a 4-digit SAS code shown on your laptop. Anyone who sees the URL *and* the SAS within an hour can pair as a phone. Don't paste pair URLs into shared channels. The TTL is 1 hour on the public relay and 30 minutes by default for self-hosters.

- **Default daemon binding is `127.0.0.1`.** The relay handles WAN access for mobile and the local Unix socket handles `loopsy shell`, so most installs don't need LAN exposure. If you want peer-to-peer over your local network, opt in with `loopsy start --lan` (or set `server.host: 0.0.0.0` in `~/.loopsy/config.yaml`) and make sure you trust the network.

- **Custom commands pin arbitrary binaries.** Anyone with phone access can pin `/bin/sh -c '...'` to the picker as a one-tap shortcut. Same trust model as having the phone, but worth knowing if multiple people share a paired phone.

We ran a comprehensive `/cso` audit over the codebase. 23 findings, 20 closed, 3 deferred to v2 (E2E phone↔daemon encryption, forward secrecy, per-session ephemeral keys).

### Hardening highlights

- Bearer auth uses constant-time compare (`crypto.timingSafeEqual`).
- 4-digit SAS verification on every pair. Defends against QR-leak / OCR-bot redeem races.
- Phone secret is sent in the WebSocket subprotocol header, not the URL.
- Secrets are SHA-256 hashed at rest in Durable Object storage.
- Per-IP rate limit on `/device/register` (5/min) plus optional `REGISTRATION_SECRET`.
- Per-phone auto-approve token, revocable with `loopsy phone revoke`.
- npm provenance via Trusted Publisher (OIDC) on every release.
- `pnpm audit --prod` clean. CI gates the publish on any high CVE.

For private security disclosure, open a security advisory on GitHub.

## Configuration

Config: `~/.loopsy/config.yaml`. Generated by `loopsy init`.

```yaml
server:
  port: 19532
  host: 127.0.0.1            # bind localhost only by default
auth:
  apiKey: <auto>
  allowedKeys: {}
relay:
  url: https://<your-relay>.workers.dev
execution:
  denylist: [rm, rmdir, format, mkfs, dd, shutdown, reboot]
  maxConcurrent: 10
transfer:
  allowedPaths: [/Users/you]
  deniedPaths: [/Users/you/.ssh, /Users/you/.gnupg]
rateLimits:
  execute: 30
  transfer: 10
  context: 60
```

Data lives in `~/.loopsy/`:

| Path | Purpose |
|---|---|
| `config.yaml` | Daemon configuration |
| `context.json` | Local key-value store |
| `peers.json` | Paired LAN peer registry |
| `logs/audit.jsonl` | Request audit log |
| `relay.json` | Last deployed relay URL (from `npx @loopsy/deploy-relay`) |

## Project structure

```
packages/
  protocol/       Shared types, schemas, constants
  discovery/      mDNS peer discovery (LAN mode)
  daemon/         Fastify server — the laptop side
  relay/          Cloudflare Worker (Durable Object) — the phone-control relay
  deploy-relay/   npx CLI for one-command Worker deploy
  cli/            loopsy binary
  mcp-server/     MCP server for AI coding agents (LAN mode)
  dashboard/      Local web dashboard
apps/
  mobile/         Flutter iOS/Android app (in submission review)
```

## Development

```bash
git clone https://github.com/leox255/loopsy.git
cd loopsy
pnpm install
pnpm build
node packages/cli/dist/index.js init
node packages/cli/dist/index.js start
```

Releases are tag-driven. Pushing a `v*` tag publishes both `loopsy` and `@loopsy/deploy-relay` to npm via OIDC Trusted Publisher with provenance attestations.

## License

Apache 2.0 — see [LICENSE](LICENSE).
