/**
 * Marketing landing page served at `/`.
 *
 * Visual language mirrors the Loopsy dashboard's AI-task detail view: a
 * browser-chrome sub-bar at the top, mono-caps section labels, "task card"
 * panels with status pills and metadata strips, italic muted preambles, and
 * green-bordered output blocks for results.
 *
 * The CSP nonce placeholder `__CSP_NONCE__` is replaced per-request before
 * sending.
 */

import { BRAND_NAME, BRAND_TAGLINE, FAVICON_LINKS, GITHUB_URL, ICONS, TOKENS_CSS } from './design.js';

export const LANDING_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <meta name="theme-color" content="#0B0D10" />
  <title>${BRAND_NAME} — ${BRAND_TAGLINE}</title>
  <meta name="description" content="Control Claude Code, Cursor, Codex, or any shell on your laptop from your phone. Open source. Maintainer-run public relay or self-host on Cloudflare." />
  <meta property="og:title" content="${BRAND_NAME} — ${BRAND_TAGLINE}" />
  <meta property="og:description" content="Control your laptop's terminal from your phone. Open source." />
  <meta property="og:type" content="website" />
  ${FAVICON_LINKS}
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap" />
  <style>
    ${TOKENS_CSS}
    body {
      min-height: 100dvh;
      display: flex; flex-direction: column;
      padding-bottom: 76px;  /* space for fixed bottom tabs */
    }
    .container { max-width: 760px; margin: 0 auto; padding: 0 16px; width: 100%; }

    /* ── Top bar: brand + GitHub link ─────────────────────────────────── */
    .topbar {
      padding: 14px 0;
      border-bottom: 1px solid var(--border);
    }
    .topbar .container {
      display: flex; align-items: center; justify-content: space-between;
    }
    .brand {
      display: flex; align-items: center; gap: 10px;
      font-weight: 700; font-size: 15px; letter-spacing: -0.2px;
    }
    .brand .logo {
      width: 28px; height: 28px;
      display: grid; place-items: center;
      border-radius: 8px;
      background: linear-gradient(135deg, var(--accent), var(--accent-dark));
      color: white;
    }
    .brand .logo svg { width: 16px; height: 16px; }
    .topbar a.icon {
      display: inline-grid; place-items: center;
      width: 32px; height: 32px;
      color: var(--muted);
      border-radius: 8px;
    }
    .topbar a.icon:hover { color: var(--fg); background: var(--surface); text-decoration: none; }
    .topbar a.icon svg { width: 16px; height: 16px; }

    /* ── Browser-chrome sub-bar — \`LOOPSY // SECTION   12:00:00\` ─────── */
    .chrome {
      padding: 10px 0;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      font-family: var(--font-mono);
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .chrome .container {
      display: flex; align-items: center; gap: 14px;
    }
    .chrome .brand-id { color: var(--accent); font-weight: 600; }
    .chrome .sep { color: var(--muted); }
    .chrome .section-id { color: var(--fg); font-weight: 600; }
    .chrome .clock { margin-left: auto; color: var(--muted); }

    /* ── Section ──────────────────────────────────────────────────────── */
    section.panel { padding: 20px 0 8px; }
    .section-label {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
      margin: 0 0 14px;
      padding: 0 4px;
    }

    /* ── Task card (the dashboard task-detail panel) ──────────────────── */
    .task {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 18px;
      margin-bottom: 14px;
    }
    .task-header {
      display: flex; align-items: center; gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .pill {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 9px;
      border-radius: 999px;
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .pill.live    { background: rgba(122,162,247,0.14); color: var(--accent); border: 1px solid rgba(122,162,247,0.4); }
    .pill.live .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 6px var(--accent); }
    .pill.done    { background: rgba(158,206,106,0.12); color: var(--good); border: 1px solid rgba(158,206,106,0.4); }
    .pill.done svg { width: 11px; height: 11px; }
    .pill.queued  { background: var(--surface-alt); color: var(--muted); border: 1px solid var(--border); }
    .pill.warn    { background: rgba(224,175,104,0.14); color: var(--warn); border: 1px solid rgba(224,175,104,0.4); }

    .task-id {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--muted);
      letter-spacing: 0.04em;
    }
    .task-title {
      margin: 0 0 8px;
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.01em;
      line-height: 1.25;
    }
    .task-title.hero {
      font-size: clamp(28px, 5vw, 36px);
      line-height: 1.05;
      margin: 6px 0 4px;
    }
    .task-title .accent {
      background: linear-gradient(135deg, var(--accent), #BB9AF7);
      -webkit-background-clip: text; background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .task-meta {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--muted);
      letter-spacing: 0.02em;
      margin-bottom: 14px;
    }
    .task-meta .key { color: var(--fg); opacity: 0.7; }
    .task-meta .sep { color: var(--border); padding: 0 4px; }

    /* Italic muted preamble — agent's "intent" block from Design 2 */
    .preamble {
      font-style: italic;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
      padding: 10px 12px;
      background: rgba(158,206,106,0.04);
      border-left: 2px solid rgba(158,206,106,0.4);
      border-radius: 4px;
      margin-bottom: 12px;
    }

    /* Green-bordered output block — the "result" panel */
    .output {
      padding: 12px 14px;
      background: rgba(158,206,106,0.06);
      border: 1px solid rgba(158,206,106,0.4);
      border-radius: 8px;
      font-size: 13.5px;
      line-height: 1.55;
    }
    .output strong { color: var(--good); font-weight: 600; }
    .output code {
      background: rgba(0,0,0,0.3);
      padding: 1px 5px; border-radius: 4px;
      font-size: 12px;
    }
    .output ul { margin: 6px 0 0; padding-left: 18px; }
    .output li { margin: 2px 0; }

    /* Stat strip — \`Cost: $0 · Setup: 30s\` */
    .stats {
      margin-top: 12px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--muted);
      letter-spacing: 0.02em;
    }
    .stats .key { opacity: 0.7; }
    .stats .sep { padding: 0 6px; color: var(--border); }

    /* ── Buttons / actions ────────────────────────────────────────────── */
    .actions {
      display: flex; gap: 8px; flex-wrap: wrap;
      padding: 0 4px 8px;
    }
    .btn {
      display: inline-flex; align-items: center; gap: 7px;
      padding: 10px 14px;
      border-radius: 10px;
      font-weight: 600; font-size: 13px;
      font-family: var(--font-mono);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      cursor: pointer;
      border: 1px solid var(--border);
      transition: transform 100ms ease, background 100ms ease;
    }
    .btn:hover { text-decoration: none; transform: translateY(-1px); }
    .btn.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
    .btn.primary:hover { background: #8eb0fa; }
    .btn.secondary { background: var(--surface); color: var(--fg); }
    .btn.secondary:hover { background: var(--surface-alt); }
    .btn svg { width: 13px; height: 13px; }

    /* ── Code / terminal block ────────────────────────────────────────── */
    .terminal {
      position: relative;
      background: #0a0c0f;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 8px;
      overflow-x: auto;
    }
    .terminal pre { margin: 0; font-family: var(--font-mono); font-size: 13px; line-height: 1.6; }
    .terminal .prompt { color: var(--muted); user-select: none; }
    .terminal .out { color: var(--good); }
    .copy-btn {
      position: absolute; top: 10px; right: 10px;
      padding: 4px 9px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--muted);
      font-family: var(--font-mono);
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
    }
    .copy-btn:hover { color: var(--fg); }
    .copy-btn.copied { color: var(--good); border-color: var(--good); }

    /* ── Bottom tab navigation ────────────────────────────────────────── */
    /*
     * Mobile browsers collapse their URL bar on scroll. \`position: fixed;
     * bottom: 0\` anchors to the LAYOUT viewport (which stays the original
     * size), so as the visual viewport grows, a gap opens below the tabbar.
     * Fix: pin the top edge to a JS-tracked \`--vv-bottom\` (visual viewport
     * bottom in layout-viewport coordinates). CSS fallback below uses
     * \`bottom: 0\` for browsers without visualViewport support.
     */
    .tabbar {
      position: fixed;
      left: 0; right: 0;
      bottom: 0;  /* fallback */
      top: var(--tabbar-top, auto);  /* JS sets this on browsers w/ visualViewport */
      background: rgba(11,13,16,0.92);
      backdrop-filter: blur(12px);
      border-top: 1px solid var(--border);
      z-index: 50;
      padding-bottom: env(safe-area-inset-bottom);
      will-change: top;
    }
    .tabbar .tabs {
      max-width: 760px; margin: 0 auto;
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      padding: 8px 4px;
    }
    .tabbar a {
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      padding: 8px 4px;
      color: var(--muted);
      font-family: var(--font-mono);
      font-size: 9.5px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-weight: 600;
      border-radius: 8px;
    }
    .tabbar a:hover { color: var(--fg); text-decoration: none; }
    .tabbar a svg { width: 18px; height: 18px; }
    .tabbar a.active { color: var(--accent); }
    .tabbar a.active::before {
      content: "";
      position: absolute; top: 0;
      width: 28px; height: 2px;
      background: var(--accent);
      border-radius: 1px;
    }
    .tabbar a { position: relative; }

    /* OS row */
    .os-row {
      display: flex; gap: 6px; flex-wrap: wrap;
      padding: 0 4px 4px;
      font-family: var(--font-mono);
      font-size: 10.5px;
      color: var(--muted);
      letter-spacing: 0.06em;
    }
    .os-row .os {
      padding: 3px 8px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
    }

    /* App-status rows */
    .status-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
    }
    .status-row:last-child { border-bottom: none; }
    .status-row .label {
      display: flex; align-items: center; gap: 10px;
      font-size: 14px; font-weight: 500;
    }
    .status-row .label svg { width: 18px; height: 18px; color: var(--muted); }

    /* Steps (How it works) */
    .step {
      display: flex; gap: 12px;
      padding: 12px 0;
      border-bottom: 1px solid var(--border);
    }
    .step:last-child { border-bottom: none; }
    .step .num {
      flex-shrink: 0;
      width: 26px; height: 26px;
      display: grid; place-items: center;
      background: var(--surface-alt);
      border: 1px solid var(--border);
      border-radius: 7px;
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 700;
      color: var(--accent);
    }
    .step .body h4 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
    .step .body p { margin: 0; font-size: 13px; color: var(--muted); line-height: 1.5; }
    .step .body code {
      background: var(--surface-alt); padding: 1px 5px; border-radius: 4px;
      font-family: var(--font-mono); font-size: 11.5px; color: var(--fg);
    }

    @media (max-width: 480px) {
      section.panel { padding: 16px 0 4px; }
      .task { padding: 14px; }
      .task-title { font-size: 16px; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="container">
      <div class="brand">
        <span class="logo">${ICONS.loopArrow}</span>
        <span>${BRAND_NAME}</span>
      </div>
      <a href="${GITHUB_URL}" class="icon" aria-label="GitHub" target="_blank" rel="noopener">${ICONS.github}</a>
    </div>
  </header>

  <div class="chrome">
    <div class="container">
      <span class="brand-id">${BRAND_NAME}</span>
      <span class="sep">//</span>
      <span class="section-id" id="chrome-section">About</span>
      <span class="clock" id="clock">--:--:--</span>
    </div>
  </div>

  <main class="container">
    <!-- ───── About / Hero ───── -->
    <section class="panel" id="about">
      <p class="section-label">Product</p>

      <div class="task">
        <div class="task-header">
          <span class="pill live"><span class="dot"></span>Live</span>
          <span class="task-id">task: 0xa9671aac…</span>
        </div>

        <h1 class="task-title hero">Your terminal,<br/><span class="accent">in your pocket.</span></h1>

        <p class="task-meta">
          <span class="key">License:</span> Apache-2.0
          <span class="sep">·</span>
          <span class="key">Cost:</span> $0
          <span class="sep">·</span>
          <span class="key">Setup:</span> ~2 min
        </p>

        <p class="preamble">
          The user wants to control their laptop's terminal from their phone —
          including Claude Code, Cursor, and Codex agents — over the public
          internet, on their own Cloudflare Worker.
        </p>

        <div class="output">
          <strong>✓ Pair phone. Open <code>/app</code>. Run code.</strong><br/>
          The laptop runs it. The Worker brokers the connection.
          No port forwarding. No public IP. No VPN.
        </div>

        <p class="stats">
          <span class="key">Model:</span> open-source
          <span class="sep">·</span>
          <span class="key">Host:</span> your Cloudflare account
          <span class="sep">·</span>
          <span class="key">Tokens:</span> ∞
        </p>
      </div>

      <div class="actions">
        <a href="/app" class="btn primary">${ICONS.bolt}Open web app</a>
        <a href="${GITHUB_URL}" class="btn secondary" target="_blank" rel="noopener">${ICONS.github}GitHub</a>
      </div>

      <div class="os-row">
        <span class="os">macOS</span>
        <span class="os">Linux</span>
        <span class="os">Windows</span>
      </div>
    </section>

    <!-- ───── Features ───── -->
    <section class="panel" id="features">
      <p class="section-label">Features</p>

      <div class="task">
        <div class="task-header">
          <span class="pill done">${ICONS.check}Shipped</span>
          <span class="task-id">feat: real-terminal</span>
        </div>
        <h3 class="task-title">Real terminal</h3>
        <p class="task-meta">
          <span class="key">Type:</span> PTY
          <span class="sep">·</span>
          <span class="key">Backend:</span> node-pty
        </p>
        <div class="output">
          Full ANSI, scrollback, resize. <code>vim</code>, <code>tmux</code>,
          <code>htop</code> render properly.
        </div>
      </div>

      <div class="task">
        <div class="task-header">
          <span class="pill done">${ICONS.check}Shipped</span>
          <span class="task-id">feat: persistent-sessions</span>
        </div>
        <h3 class="task-title">Persistent sessions</h3>
        <p class="task-meta">
          <span class="key">Idle:</span> 10 min
          <span class="sep">·</span>
          <span class="key">Reconnect:</span> instant
        </p>
        <div class="output">
          Switch tabs. Lock your phone. Lose signal. Pick up where you left off.
        </div>
      </div>

      <div class="task">
        <div class="task-header">
          <span class="pill done">${ICONS.check}Shipped</span>
          <span class="task-id">feat: voice-input</span>
        </div>
        <h3 class="task-title">Voice input</h3>
        <p class="task-meta">
          <span class="key">API:</span> Web Speech
          <span class="sep">·</span>
          <span class="key">Edit:</span> before send
        </p>
        <div class="output">
          Dictate via the Web Speech API. Edit before you hit send.
        </div>
      </div>

      <div class="task">
        <div class="task-header">
          <span class="pill done">${ICONS.check}Shipped</span>
          <span class="task-id">feat: hardened</span>
        </div>
        <h3 class="task-title">Self-hosted &amp; hardened</h3>
        <p class="task-meta">
          <span class="key">CSO:</span> 23 findings closed
          <span class="sep">·</span>
          <span class="key">Audit:</span> clean
        </p>
        <div class="output">
          Bearer auth, 4-digit pair codes, secrets hashed at rest, npm provenance.
          No accounts. No middleman.
        </div>
      </div>
    </section>

    <!-- ───── Apps ───── -->
    <section class="panel" id="apps">
      <p class="section-label">Apps</p>

      <div class="task">
        <div class="task-header">
          <span class="pill live"><span class="dot"></span>Status</span>
          <span class="task-id">platforms</span>
        </div>
        <h3 class="task-title">Native apps</h3>
        <p class="task-meta">Web works today. Native apps in submission review.</p>

        <div style="margin-top: 8px;">
          <div class="status-row">
            <div class="label">${ICONS.globe}<span>Web app — <code style="font-family:var(--font-mono);font-size:12px">/app</code></span></div>
            <span class="pill done">${ICONS.check}Live</span>
          </div>
          <div class="status-row">
            <div class="label">${ICONS.apple}<span>iOS · iPadOS</span></div>
            <span class="pill queued">Submitted</span>
          </div>
          <div class="status-row">
            <div class="label">${ICONS.android}<span>Android</span></div>
            <span class="pill queued">Submitted</span>
          </div>
        </div>
      </div>
    </section>

    <!-- ───── Self-host ───── -->
    <section class="panel" id="host">
      <p class="section-label">Self-host</p>

      <div class="task">
        <div class="task-header">
          <span class="pill live"><span class="dot"></span>Run</span>
          <span class="task-id">deploy-relay</span>
        </div>
        <h3 class="task-title">Self-host in 30 seconds</h3>
        <p class="task-meta">One command. Your Cloudflare account. Free tier.</p>

        <div class="terminal">
          <button class="copy-btn" id="copy-cmd" type="button">Copy</button>
<pre><span class="prompt">$ </span>npx @loopsy/deploy-relay

<span class="out">✓</span> Worker deployed
<span class="out">✓</span> PAIR_TOKEN_SECRET set
<span class="out">✓</span> Saved to ~/.loopsy/relay.json</pre>
        </div>

        <div class="output">
          <strong>You keep the secret.</strong> The relay runs on your account,
          not ours. We never see your traffic.
        </div>

        <p class="stats">
          <span class="key">Tier:</span> Cloudflare Workers free
          <span class="sep">·</span>
          <span class="key">DO storage:</span> SQLite
          <span class="sep">·</span>
          <span class="key">Provenance:</span> npm OIDC
        </p>
      </div>
    </section>

    <!-- ───── How it works ───── -->
    <section class="panel" id="how">
      <p class="section-label">How it works</p>

      <div class="task">
        <div class="task-header">
          <span class="pill done">${ICONS.check}3 pieces</span>
          <span class="task-id">architecture</span>
        </div>
        <h3 class="task-title">Three pieces.</h3>
        <p class="task-meta">Laptop daemon. Cloudflare Worker (ours or yours). Phone client.</p>

        <div class="step">
          <div class="num">1</div>
          <div class="body">
            <h4>Install</h4>
            <p>Run <code>npm i -g loopsy &amp;&amp; loopsy start</code> on your laptop. Daemon connects to the relay and waits.</p>
          </div>
        </div>
        <div class="step">
          <div class="num">2</div>
          <div class="body">
            <h4>Pair</h4>
            <p>Run <code>loopsy mobile pair</code>. Scan the QR with your phone. Enter the 4-digit code.</p>
          </div>
        </div>
        <div class="step">
          <div class="num">3</div>
          <div class="body">
            <h4>Use it</h4>
            <p>Open <a href="/app">/app</a>. Pick the agent. Type, dictate, commit code. Your laptop runs it.</p>
          </div>
        </div>
      </div>
    </section>
  </main>

  <!-- ───── Bottom tab nav ───── -->
  <nav class="tabbar" aria-label="Sections">
    <div class="tabs">
      <a href="#about" class="active" data-section="about">${ICONS.home}<span>About</span></a>
      <a href="#features" data-section="features">${ICONS.bolt}<span>Features</span></a>
      <a href="#apps" data-section="apps">${ICONS.phone}<span>Apps</span></a>
      <a href="#host" data-section="host">${ICONS.cloud}<span>Host</span></a>
      <a href="${GITHUB_URL}" target="_blank" rel="noopener">${ICONS.github}<span>Code</span></a>
    </div>
  </nav>

  <script nonce="__CSP_NONCE__">
    'use strict';

    // ── Pin the bottom tabbar to the visual viewport's bottom ──
    // On mobile Safari/Chrome, \`position: fixed; bottom: 0\` is anchored to
    // the layout viewport, which stays the same size when the URL bar
    // collapses. The visible area grows below it and the body shows through
    // the gap. We use the visualViewport API to compute the correct top so
    // the tabbar tracks the actual visible bottom regardless of chrome state.
    (function () {
      var tabbar = document.querySelector('.tabbar');
      if (!tabbar || !window.visualViewport) return;
      function update() {
        var vv = window.visualViewport;
        // Top edge of the tabbar = (visual top in layout coords) + (visual height) - tabbar height.
        var top = (vv.offsetTop + vv.height) - tabbar.offsetHeight;
        tabbar.style.top = top + 'px';
        tabbar.style.bottom = 'auto';
      }
      window.visualViewport.addEventListener('resize', update);
      window.visualViewport.addEventListener('scroll', update);
      window.addEventListener('resize', update);
      // Re-run after layout settles + after fonts/icons load (tabbar height
      // can shift by a couple of pixels once the icon SVG sizes resolve).
      update();
      requestAnimationFrame(update);
      window.addEventListener('load', update);
    })();

    // ── Live clock in the chrome bar ──
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function tick() {
      var d = new Date();
      var el = document.getElementById('clock');
      if (el) el.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }
    tick();
    setInterval(tick, 1000);

    // ── Copy install command ──
    var copyBtn = document.getElementById('copy-cmd');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var cmd = 'npx @loopsy/deploy-relay';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(cmd).then(function () {
            copyBtn.textContent = 'Copied';
            copyBtn.classList.add('copied');
            setTimeout(function () { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 1400);
          });
        }
      });
    }

    // ── Bottom-nav active state + chrome section label tracks scroll ──
    var sectionTitles = { about: 'About', features: 'Features', apps: 'Apps', host: 'Self-host', how: 'How it works' };
    var sectionTabMap = { about: 'about', features: 'features', apps: 'apps', host: 'host', how: 'host' };
    var sections = ['about', 'features', 'apps', 'host', 'how'].map(function (id) {
      var el = document.getElementById(id);
      return el ? { id: id, el: el } : null;
    }).filter(Boolean);
    var tabs = Array.from(document.querySelectorAll('.tabbar a[data-section]'));
    var chromeSection = document.getElementById('chrome-section');

    function updateActive() {
      var y = window.scrollY + 120;  // bias toward what's visible top-of-screen
      var current = sections[0];
      for (var i = 0; i < sections.length; i++) {
        if (sections[i].el.offsetTop <= y) current = sections[i];
      }
      var activeTab = sectionTabMap[current.id] || 'about';
      tabs.forEach(function (t) {
        t.classList.toggle('active', t.getAttribute('data-section') === activeTab);
      });
      if (chromeSection) chromeSection.textContent = sectionTitles[current.id] || 'About';
    }
    window.addEventListener('scroll', updateActive, { passive: true });
    updateActive();
  </script>
</body>
</html>`;
