# Enterprise Cross-Platform LAN Communication Daemon - Research Brief

**Date**: 2026-02-21
**Scope**: Node.js/TypeScript production-ready LAN daemon (macOS + Windows)

---

## TL;DR

Fastify is the recommended HTTP server framework for a Node.js LAN daemon due to its first-class TypeScript support, 3-4x performance advantage over Express, and rich official plugin ecosystem. Use `bonjour-service` (pure TypeScript, built on `multicast-dns`) for peer discovery, `ws` for WebSocket bidirectional channels, mTLS with an internal CA for security, and platform-native daemon management (launchd on macOS, node-windows/NSSM on Windows).

---

## 1. Node.js HTTP/REST Server Libraries

### Key Findings

- **Fastify** is the clear production winner for daemon use cases: 70,000-80,000 req/s vs Express's 20,000-30,000 req/s in benchmarks. It ships with built-in TypeScript types, JSON schema validation via Ajv, structured logging via Pino, and an official plugin ecosystem (`@fastify/*`).
- **Express** remains the safest choice for team familiarity but has no built-in TypeScript support and significantly worse performance. Use it only if the team already has deep Express knowledge.
- **Hono** is purpose-built for edge/serverless runtimes and is the fastest of the three (3x Express throughput), but its primary value proposition (running on Cloudflare Workers, Deno, Bun) is irrelevant for a long-running LAN daemon on Node.js. Acceptable as an option if maximum future portability is required.

### Recommendation: Fastify

```typescript
// Minimal production Fastify setup with TypeScript
import Fastify, { FastifyInstance } from 'fastify'

const server: FastifyInstance = Fastify({
  logger: true,        // Built-in Pino structured logging
  https: {             // TLS for LAN security (see Section 3)
    key: fs.readFileSync('server.key'),
    cert: fs.readFileSync('server.cert'),
    ca: fs.readFileSync('ca.cert'),
    requestCert: true, // Enable mTLS
    rejectUnauthorized: true,
  },
})

await server.listen({ port: 8443, host: '0.0.0.0' })
```

### Official Plugin Ecosystem (relevant plugins)

| Plugin | Purpose |
|---|---|
| `@fastify/multipart` | File uploads (wraps busboy) |
| `@fastify/jwt` | JWT authentication |
| `@fastify/rate-limit` | Rate limiting |
| `@fastify/websocket` | WebSocket integration (wraps `ws`) |
| `@fastify/cors` | CORS headers |
| `@fastify/static` | Static file serving |

### Sources

- [Fastify vs Express vs Hono - Better Stack](https://betterstack.com/community/guides/scaling-nodejs/hono-vs-fastify/)
- [Fastify official benchmarks](https://fastify.dev/benchmarks/)
- [Fastify TypeScript reference](https://fastify.dev/docs/latest/Reference/TypeScript/)
- [Express or Fastify in 2025 - Medium](https://medium.com/codetodeploy/express-or-fastify-in-2025-whats-the-right-node-js-framework-for-you-6ea247141a86)

---

## 2. mDNS/Bonjour/DNS-SD Peer Discovery

### Key Findings

There are two distinct categories of mDNS npm packages: those requiring native bindings (avoid for cross-platform) and those implemented in pure JavaScript.

#### Native Binding Packages (AVOID for cross-platform daemons)

- **`mdns`** (agnat/node_mdns): Requires `avahi-compat` on Linux, "Bonjour SDK" on Windows (a separate Apple installer), and native compilation via `node-gyp`. Historically unmaintained. This is a significant operational burden for a cross-platform installer.

#### Pure JavaScript Packages (RECOMMENDED)

| Package | Description | Weekly Downloads | Notes |
|---|---|---|---|
| `bonjour-service` | TypeScript rewrite of `bonjour`. Built on `multicast-dns`. Maintained by ON LX Ltd | Active | Best option: TypeScript-native, no native deps |
| `bonjour` | Original pure-JS Bonjour implementation | High | JavaScript only, older codebase |
| `multicast-dns` | Low-level mDNS in pure JS by @mafintosh | Very high | Foundation that `bonjour-service` builds on |
| `mdns-js` | Pure JS mDNS + DNS-SD discovery | Moderate | Good fallback |
| `node-dns-sd` | Pure JS mDNS/DNS-SD browser + packet parser | Lower | Good for packet-level inspection |

### Recommendation: `bonjour-service`

`bonjour-service` is a TypeScript rewrite of the original `bonjour` project maintained by ON LX Limited. It requires zero native binaries, works identically on Windows and macOS through Node.js UDP sockets, and is the correct foundation for a TypeScript daemon.

```typescript
import { Bonjour, Service } from 'bonjour-service'

const bonjour = new Bonjour()

// Advertise this daemon on the LAN
const service: Service = bonjour.publish({
  name: 'MyDaemon-' + os.hostname(),
  type: 'myapp',        // Becomes _myapp._tcp.local.
  port: 8443,
  txt: { version: '1.0.0', tlsEnabled: 'true' },
})

// Discover peer daemons
const browser = bonjour.find({ type: 'myapp' }, (service) => {
  console.log('Found peer:', service.name, service.addresses, service.port)
})

// Clean shutdown
process.on('SIGTERM', () => {
  bonjour.unpublishAll(() => bonjour.destroy())
})
```

### Important Caveats

- mDNS operates on UDP multicast (224.0.0.251:5353). Many corporate switches/routers block multicast traffic by default. For enterprise environments, consider a fallback: a central peer registry over unicast HTTP/TCP.
- Do NOT run multiple mDNS stacks simultaneously on the same host (they conflict with system Avahi/Bonjour services).
- mDNS is LAN-segment-scoped. It does not cross routers. This is usually desired behavior for a local daemon.

### Sources

- [bonjour-service npm](https://www.npmjs.com/package/bonjour-service)
- [bonjour-service GitHub (ON LX)](https://github.com/onlxltd/bonjour-service)
- [multicast-dns GitHub (mafintosh)](https://github.com/mafintosh/multicast-dns)
- [node-dns-sd GitHub](https://github.com/futomi/node-dns-sd)

---

## 3. Security: mTLS, API Key Auth, Token-Based Auth

### Key Findings

A layered security model is recommended for LAN daemons. The LAN is not a trust boundary; treat it as hostile.

### Layer 1: Transport Security (mTLS)

Mutual TLS (mTLS) is the strongest transport-level security option. Both client and server present X.509 certificates signed by a shared internal CA. This eliminates password-based authentication at the transport level entirely.

**Internal CA Setup (openssl):**

```bash
# 1. Generate the internal CA (do once, store key offline)
openssl genrsa -out ca.key 4096
openssl req -new -x509 -key ca.key -sha256 -subj "/CN=MyApp Internal CA" \
  -days 3650 -out ca.cert

# 2. Generate server certificate signed by internal CA
openssl genrsa -out server.key 2048
openssl req -new -key server.key -subj "/CN=daemon.local" -out server.csr
openssl x509 -req -in server.csr -CA ca.cert -CAkey ca.key \
  -CAcreateserial -sha256 -days 365 -out server.cert

# 3. Generate client certificate for each peer daemon
openssl genrsa -out client.key 2048
openssl req -new -key client.key -subj "/CN=peer-hostname" -out client.csr
openssl x509 -req -in client.csr -CA ca.cert -CAkey ca.key \
  -CAcreateserial -sha256 -days 365 -out client.cert
```

**Node.js TLS Options:**

```typescript
import tls from 'tls'
import fs from 'fs'

const tlsOptions = {
  key: fs.readFileSync('server.key'),
  cert: fs.readFileSync('server.cert'),
  ca: fs.readFileSync('ca.cert'),       // Internal CA to verify client certs
  requestCert: true,                     // Require client certificate
  rejectUnauthorized: true,              // Reject clients without valid cert
  minVersion: 'TLSv1.2' as const,       // Enforce minimum TLS 1.2
}
```

**npm alternative for programmatic cert generation:**
- `selfsigned` npm package: Generates self-signed X.509 certs using Node.js native crypto. Can sign with an existing CA. Useful for bootstrapping peer certificates on first run without requiring openssl.

### Layer 2: Application Authentication (API Keys / JWT)

Even with mTLS, add application-layer auth as defense-in-depth (identifies which service is calling, not just that a valid cert was presented).

**Option A: Static Pre-shared API Keys (simplest for daemon-to-daemon)**

```typescript
// Fastify hook for API key auth
fastify.addHook('onRequest', async (request, reply) => {
  const key = request.headers['x-api-key']
  if (!VALID_KEYS.has(key)) {
    reply.code(401).send({ error: 'Unauthorized' })
  }
})
```

**Option B: JWT with @fastify/jwt (recommended for user-facing calls)**

```typescript
import fastifyJwt from '@fastify/jwt'

fastify.register(fastifyJwt, {
  secret: process.env.JWT_SECRET!, // Min 256-bit secret
  sign: { expiresIn: '1h' },
})

fastify.addHook('onRequest', async (request, reply) => {
  try {
    await request.jwtVerify()
  } catch (err) {
    reply.send(err)
  }
})
```

### Security Architecture Recommendation

```
Client Daemon ─── mTLS (cert validation) ──► Server Daemon
                  + API Key Header (X-Api-Key)
                  + HTTPS only (TLS 1.2+)
                  + Rate limiting (@fastify/rate-limit)
                  + Input validation (Fastify JSON schema)
```

For daemon-to-daemon: mTLS + pre-shared API key is sufficient and avoids token expiry management complexity.
For user-originated calls: mTLS + JWT (short-lived tokens) is the enterprise standard.

### Sources

- [Node.js TLS documentation](https://nodejs.org/api/tls.html)
- [Zero Trust Networking: mTLS over API Keys - Medium](https://medium.com/beyond-localhost/zero-trust-networking-replacing-api-keys-with-mutual-tls-mtls-b073d79f3b60)
- [fastify-jwt GitHub](https://github.com/fastify/fastify-jwt)
- [selfsigned npm](https://www.npmjs.com/package/selfsigned)
- [mTLS deep dive - Medium](https://medium.com/@LukV/mutual-tls-mtls-a-deep-dive-into-secure-client-server-communication-bbb83f463292)

---

## 4. Running as a Background Daemon

### macOS: launchd

launchd is the macOS init system and the correct way to run persistent background services. Two modes exist:

| Mode | Location | Runs as | When |
|---|---|---|---|
| LaunchDaemon | `/Library/LaunchDaemons/` | root | System boot, before login |
| LaunchAgent | `~/Library/LaunchAgents/` | user | User login |

For a LAN daemon that should survive reboots and not require a logged-in user, use **LaunchDaemon**.

**Example plist (`/Library/LaunchDaemons/com.myapp.daemon.plist`):**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.myapp.daemon</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/opt/myapp/dist/daemon.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/opt/myapp</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PORT</key>
    <string>8443</string>
  </dict>

  <key>KeepAlive</key>
  <true/>                    <!-- Restart on crash -->

  <key>RunAtLoad</key>
  <true/>                    <!-- Start at boot -->

  <key>StandardOutPath</key>
  <string>/var/log/myapp/daemon.log</string>

  <key>StandardErrorPath</key>
  <string>/var/log/myapp/daemon-error.log</string>

  <key>ThrottleInterval</key>
  <integer>10</integer>      <!-- Min 10s between restarts -->

  <key>UserName</key>
  <string>_myapp</string>    <!-- Run as dedicated service user, not root -->
</dict>
</plist>
```

**Management commands:**

```bash
# Install and start
sudo launchctl load /Library/LaunchDaemons/com.myapp.daemon.plist

# Check status
sudo launchctl list | grep com.myapp

# Stop and remove
sudo launchctl unload /Library/LaunchDaemons/com.myapp.daemon.plist
```

**npm helper: `node-mac`** (GitHub: coreybutler/node-mac) automates plist generation and `launchctl` calls from Node.js code. Useful for installer scripts.

### Windows: node-windows / NSSM

Two mature options exist for Windows:

#### Option A: node-windows (npm package, programmatic)

`node-windows` wraps WinSW (Windows Service Wrapper) to register a Node.js script as a Windows Service. It handles auto-restart on crash, Windows Event Log integration, and does not require native modules.

```typescript
import { Service } from 'node-windows'

const svc = new Service({
  name: 'MyApp Daemon',
  description: 'MyApp LAN communication daemon',
  script: 'C:\\opt\\myapp\\dist\\daemon.js',
  nodeOptions: ['--harmony', '--max_old_space_size=4096'],
  env: [
    { name: 'NODE_ENV', value: 'production' },
    { name: 'PORT', value: '8443' },
  ],
})

svc.on('install', () => svc.start())
svc.install()
```

**Status of `node-windows`**: Latest version is `1.0.0-beta.8`, last published ~3 years ago. The core functionality is stable (WinSW handles the heavy lifting), but the package is not actively developed. It remains the most widely used programmatic option.

#### Option B: NSSM (Non-Sucking Service Manager, external binary)

NSSM is a standalone exe that wraps any executable as a Windows Service. It is battle-tested, actively maintained, and more configurable than node-windows. It is the preferred choice when distributing a daemon installer with full control.

```batch
:: Install
nssm install "MyApp Daemon" "C:\Program Files\nodejs\node.exe" "C:\opt\myapp\dist\daemon.js"
nssm set "MyApp Daemon" AppDirectory "C:\opt\myapp"
nssm set "MyApp Daemon" AppEnvironmentExtra "NODE_ENV=production" "PORT=8443"
nssm set "MyApp Daemon" AppStdout "C:\logs\myapp\daemon.log"
nssm set "MyApp Daemon" AppStderr "C:\logs\myapp\daemon-error.log"
nssm set "MyApp Daemon" Start SERVICE_AUTO_START

:: Start
nssm start "MyApp Daemon"

:: Status
nssm status "MyApp Daemon"
```

#### Comparison Table

| | node-windows | NSSM |
|---|---|---|
| Type | npm package | External binary |
| Programmatic install | Yes | No (CLI/batch) |
| Active maintenance | Low (stable) | Active |
| Native dependencies | None | Standalone exe |
| Windows Event Log | Yes | Yes |
| Crash recovery | Yes | Yes |
| Best for | npm installer scripts | Standalone installers |

### Cross-Platform Daemon Strategy

A recommended pattern is to write a single `install-service.ts` script that branches on `process.platform`:

```typescript
if (process.platform === 'darwin') {
  // Write plist + launchctl load
} else if (process.platform === 'win32') {
  // Use node-windows Service API or shell NSSM
} else {
  // systemd unit file for Linux (future)
}
```

### Sources

- [Apple: Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- [launchd.info tutorial](https://www.launchd.info/)
- [node-mac GitHub](https://github.com/coreybutler/node-mac)
- [node-windows GitHub](https://github.com/coreybutler/node-windows)
- [node-windows npm](https://www.npmjs.com/package/node-windows)
- [NSSM with Node.js - Brian Pedersen](https://briancaos.wordpress.com/2022/12/01/run-node-js-on-windows-server-using-nssm/)
- [Cross-platform background service in Node.js - Medium](https://medium.com/craftsmenltd/building-a-cross-platform-background-service-in-node-js-791cfcd3be60)

---

## 5. Real-Time Communication: WebSocket vs SSE vs Long-Polling

### Comparison Matrix

| | WebSocket | Server-Sent Events (SSE) | HTTP Long-Polling |
|---|---|---|---|
| Direction | Full-duplex (bidirectional) | Server → Client only | Server → Client (simulated) |
| Protocol | Custom WS protocol (ws://, wss://) | HTTP/HTTPS | HTTP/HTTPS |
| Firewall/proxy friendly | Sometimes blocked | Always works | Always works |
| Auto-reconnect | Manual (client-side) | Built into protocol | Manual |
| Binary data | Yes | Text only | Yes (in body) |
| Overhead per message | Low (no HTTP headers) | Low (event stream) | High (full HTTP round-trip) |
| Browser support | Universal | Universal (except IE) | Universal |
| Server complexity | Moderate | Low | Low |
| Ideal for | Chat, games, bidirectional RPC | Notifications, logs, feeds | Legacy fallback only |

### Recommendation for LAN Daemon-to-Daemon Communication

**Use WebSocket (`ws` package) as the primary real-time channel.**

For a daemon communicating with other daemons on a LAN (not a browser), WebSocket is the correct choice:
- Full-duplex is required: daemons need to both send commands and receive acknowledgements
- Firewall concerns are minimal on a controlled LAN
- No browser SSE limitations apply
- `ws` is the most downloaded WebSocket library in the npm ecosystem (~35M weekly downloads)

```typescript
import { WebSocketServer, WebSocket } from 'ws'
import https from 'https'

// Create HTTPS server first (for mTLS)
const httpsServer = https.createServer(tlsOptions)

// Attach WebSocket server to HTTPS server
const wss = new WebSocketServer({ server: httpsServer })

wss.on('connection', (ws: WebSocket, req) => {
  // req.socket.getPeerCertificate() for mTLS peer identity
  const peerCert = (req.socket as tls.TLSSocket).getPeerCertificate()
  const peerId = peerCert.subject.CN

  ws.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString())
    // Handle incoming message from peer
  })

  ws.on('close', () => {
    console.log(`Peer disconnected: ${peerId}`)
  })

  // Send a message to this peer
  ws.send(JSON.stringify({ type: 'hello', from: os.hostname() }))
})

httpsServer.listen(8443)
```

**Use SSE for daemon-to-UI (browser) streaming:**

If the daemon also serves a local web UI that needs live updates (logs, status), SSE is simpler than WebSocket for that specific one-directional case:

```typescript
fastify.get('/events', async (request, reply) => {
  reply.raw.setHeader('Content-Type', 'text/event-stream')
  reply.raw.setHeader('Cache-Control', 'no-cache')
  reply.raw.setHeader('Connection', 'keep-alive')
  reply.raw.flushHeaders()

  const interval = setInterval(() => {
    reply.raw.write(`data: ${JSON.stringify({ ts: Date.now() })}\n\n`)
  }, 1000)

  reply.raw.on('close', () => clearInterval(interval))
})
```

**Long-Polling**: Do not use. It is now considered legacy and is unsuitable for high-frequency LAN communication.

### Sources

- [WebSockets vs SSE vs Long-Polling vs WebRTC - RxDB](https://rxdb.info/articles/websockets-sse-polling-webrtc-webtransport.html)
- [WebSockets vs SSE - Ably](https://ably.com/blog/websockets-vs-sse)
- [ws npm package](https://www.npmjs.com/package/ws)
- [ws GitHub](https://github.com/websockets/ws)

---

## 6. File Transfer Over HTTP

### Key Findings

Node.js file transfer falls into three patterns depending on file size and reliability requirements:

### Pattern A: Streaming Multipart Upload (general purpose, <1GB)

Use `@fastify/multipart` which wraps `busboy` internally. Data is processed in chunks; files are never fully buffered in memory.

```typescript
import fastifyMultipart from '@fastify/multipart'

fastify.register(fastifyMultipart, {
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024, // 10GB limit
    files: 5,                            // Max concurrent files per request
  },
})

fastify.post('/transfer', async (request, reply) => {
  const parts = request.parts()

  for await (const part of parts) {
    if (part.type === 'file') {
      const destPath = path.join(UPLOAD_DIR, part.filename)
      const writeStream = fs.createWriteStream(destPath)

      // Stream directly to disk - no memory buffering
      await pipeline(part.file, writeStream)

      console.log(`Received: ${part.filename} (${part.mimetype})`)
    }
  }

  reply.send({ status: 'ok' })
})
```

### Pattern B: Chunked Resumable Upload (large files, unreliable networks)

For very large files (>100MB on a potentially lossy connection), implement chunked uploads with server-side reassembly. This is the TUS protocol pattern.

**Client-side chunking:**

```typescript
const CHUNK_SIZE = 5 * 1024 * 1024 // 5MB chunks
const fileId = crypto.randomUUID()
const totalChunks = Math.ceil(file.size / CHUNK_SIZE)

for (let i = 0; i < totalChunks; i++) {
  const chunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
  const form = new FormData()
  form.append('chunk', chunk)
  form.append('fileId', fileId)
  form.append('chunkIndex', String(i))
  form.append('totalChunks', String(totalChunks))

  await fetch(`https://peer:8443/transfer/chunk`, {
    method: 'POST',
    body: form,
  })
}
```

**Server-side reassembly (Fastify):**

```typescript
// Tracks received chunks per fileId
const chunkTracker = new Map<string, Set<number>>()

fastify.post('/transfer/chunk', async (request, reply) => {
  const parts = request.parts()
  let fileId: string, chunkIndex: number, totalChunks: number

  for await (const part of parts) {
    if (part.type === 'field') {
      if (part.fieldname === 'fileId') fileId = part.value as string
      if (part.fieldname === 'chunkIndex') chunkIndex = Number(part.value)
      if (part.fieldname === 'totalChunks') totalChunks = Number(part.value)
    } else if (part.type === 'file') {
      const chunkPath = path.join(CHUNK_DIR, `${fileId}-${chunkIndex}`)
      await pipeline(part.file, fs.createWriteStream(chunkPath))
    }
  }

  // Track and reassemble when complete
  if (!chunkTracker.has(fileId!)) chunkTracker.set(fileId!, new Set())
  chunkTracker.get(fileId!)!.add(chunkIndex!)

  if (chunkTracker.get(fileId!)!.size === totalChunks!) {
    await reassembleChunks(fileId!, totalChunks!)
    chunkTracker.delete(fileId!)
  }

  reply.send({ received: chunkIndex, total: totalChunks })
})
```

### Pattern C: Raw HTTP Streaming (daemon-to-daemon, binary protocol)

For very high-throughput daemon-to-daemon transfer on a trusted LAN, bypass multipart overhead entirely:

```typescript
// Sender
const readStream = fs.createReadStream('/path/to/largefile.bin')
await fetch(`https://peer:8443/transfer/raw`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/octet-stream',
    'X-Filename': encodeURIComponent('largefile.bin'),
    'X-File-Size': String(fs.statSync('/path/to/largefile.bin').size),
  },
  body: readStream,
  duplex: 'half', // Required for streaming request body in fetch
})

// Receiver (Fastify)
fastify.post('/transfer/raw', async (request, reply) => {
  const filename = decodeURIComponent(request.headers['x-filename'] as string)
  const destPath = path.join(UPLOAD_DIR, path.basename(filename))
  await pipeline(request.raw, fs.createWriteStream(destPath))
  reply.send({ status: 'ok' })
})
```

### HTTP/2 Note

HTTP/2 (h2) supersedes chunked transfer encoding. If you implement an HTTP/2 server (Node.js `http2` module, or Fastify with `http2: true`), request body streaming is handled natively without `Transfer-Encoding: chunked`. This is worth considering for a greenfield daemon since HTTP/2 also multiplexes multiple streams over a single TCP connection.

### Pattern Decision Guide

| Scenario | Recommended Pattern |
|---|---|
| General files, <100MB | Pattern A: Streaming multipart |
| Large files, >100MB, LAN | Pattern B: Chunked resumable |
| Very large files, daemon-to-daemon | Pattern C: Raw HTTP streaming |
| High throughput, modern stack | Pattern C over HTTP/2 |

### Sources

- [File Uploads with Fastify - Better Stack](https://betterstack.com/community/guides/scaling-nodejs/fastify-file-uploads/)
- [Streaming files between services - Medium](https://medium.com/@odedlevy02/streaming-files-between-services-in-node-and-express-c17cf346edd4)
- [How to Handle File Uploads at Scale - OneUptime](https://oneuptime.com/blog/post/2026-01-06-nodejs-file-uploads-scale/view)
- [huge-uploader-nodejs GitHub](https://github.com/Buzut/huge-uploader-nodejs)
- [HTTP Transfer Large Files - Medium](https://medium.com/frontend-canteen/http-transfer-large-files-can-consider-these-three-solutions-24b03d1e2931)
- [Transfer-Encoding MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Transfer-Encoding)

---

## Conflicts and Uncertainties

1. **`node-windows` maintenance**: Latest npm version is `1.0.0-beta.8` from ~3 years ago. The package is stable but not actively developed. For a production installer, NSSM may be more reliable long-term. Monitor for a v1.0 stable release.

2. **mDNS on corporate networks**: Multicast traffic (224.0.0.251) is commonly blocked by managed switches and enterprise firewalls. Any LAN daemon that relies solely on mDNS for discovery MUST have a unicast fallback (e.g., manual IP entry or a central discovery registry). This is a significant deployment risk that needs a design decision.

3. **Hono maturity for daemons**: Hono is primarily tested in edge/serverless contexts. Its Node.js adapter (`@hono/node-server`) exists but is less battle-tested than Fastify for long-running daemon scenarios. Fastify's 10+ year production track record makes it the safer choice.

4. **mTLS certificate distribution**: The mechanics of distributing and rotating client certificates to peer daemons across a LAN is an operational challenge not addressed by any single npm package. This requires either: a) a PKI management script bundled with the daemon, or b) acceptance of a simpler API key scheme with periodic rotation.

---

## Recommended Architecture Summary

```
┌─────────────────────────────────────────────────────┐
│                  LAN Daemon (Node.js/TypeScript)     │
│                                                       │
│  ┌─────────────────┐   ┌─────────────────────────┐  │
│  │  Peer Discovery │   │   HTTP/WS Server         │  │
│  │  bonjour-service│   │   Fastify + @fastify/ws  │  │
│  │  (mDNS/DNS-SD)  │   │   TLS 1.2+ + mTLS       │  │
│  └────────┬────────┘   └──────────┬──────────────┘  │
│           │                       │                   │
│           └───────────┬───────────┘                   │
│                       │                               │
│              ┌────────▼────────┐                      │
│              │   API Routes    │                      │
│              │  /transfer      │ ← multipart upload   │
│              │  /ws            │ ← WebSocket channel  │
│              │  /events        │ ← SSE (UI only)      │
│              │  /health        │ ← status endpoint    │
│              └─────────────────┘                      │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │           Daemon Manager                         │  │
│  │  macOS: launchd plist (LaunchDaemon)             │  │
│  │  Windows: node-windows / NSSM                   │  │
│  └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

**Core npm dependencies:**

```json
{
  "dependencies": {
    "fastify": "^5.x",
    "@fastify/multipart": "^9.x",
    "@fastify/websocket": "^10.x",
    "@fastify/jwt": "^9.x",
    "@fastify/rate-limit": "^10.x",
    "bonjour-service": "^1.x",
    "ws": "^8.x"
  },
  "optionalDependencies": {
    "node-windows": "^1.0.0-beta.8",
    "node-mac": "^1.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "@types/ws": "^8.x",
    "@types/node": "^22.x"
  }
}
```
