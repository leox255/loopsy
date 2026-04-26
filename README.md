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

Loopsy also includes a mode for direct daemon-to-daemon communication on a LAN — exposing remote command execution, file transfer, and shared key/value state to AI coding agents (Claude Code, Gemini CLI, Codex CLI) via MCP. This is the original use case; the phone-control mode is built on top.

```bash
loopsy pair                # on Machine A — displays invite code
loopsy pair 192.168.1.50   # on Machine B — enters invite code
```

Pairing uses ECDH (P-256) with a 6-digit short authentication string. After pairing, restart both daemons. The `loopsy_*` MCP tools become available in your AI coding agent automatically.

See [AGENTS.md](AGENTS.md) for the full messaging protocol, task queue, and MCP tool reference.

## Security

We ran a comprehensive security audit (`/cso`) over the codebase. 23 findings, 20 closed, 3 deferred to v2. Highlights:

- Bearer auth uses constant-time compare (`crypto.timingSafeEqual`).
- 4-digit SAS verification on every pair. Defends against QR-leak / OCR-bot redeem races.
- Phone secret is sent in the WebSocket subprotocol header, not the URL.
- Secrets are SHA-256 hashed at rest in Durable Object storage.
- Per-IP rate limit on `/device/register` (5/min) plus optional `REGISTRATION_SECRET`.
- macOS dialog gate before auto-approve sessions; Linux/Windows fall back to terminal prompt.
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
