/**
 * Marketing landing page served at `/`.
 *
 * Same design tokens as the Flutter app and the web client. The CSP nonce
 * placeholder `__CSP_NONCE__` is replaced per-request before sending.
 */

import { BRAND_NAME, BRAND_TAGLINE, GITHUB_URL, ICONS, TOKENS_CSS } from './design.js';

export const LANDING_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <meta name="theme-color" content="#0B0D10" />
  <title>${BRAND_NAME} — ${BRAND_TAGLINE}</title>
  <meta name="description" content="Control Claude Code, Cursor, Codex, or any shell on your laptop from your phone. Open source, self-hosted on Cloudflare Workers." />
  <meta property="og:title" content="${BRAND_NAME} — ${BRAND_TAGLINE}" />
  <meta property="og:description" content="Control your laptop's terminal from your phone. Open source." />
  <meta property="og:type" content="website" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600;700;800&display=swap" />
  <style>
    ${TOKENS_CSS}
    body {
      min-height: 100dvh;
      display: flex; flex-direction: column;
      background: radial-gradient(ellipse at top, rgba(122,162,247,0.08), transparent 60%), var(--bg);
    }
    main { flex: 1; }
    .container { max-width: 920px; margin: 0 auto; padding: 0 24px; }

    header.nav {
      padding: 18px 0;
      border-bottom: 1px solid var(--border);
      backdrop-filter: blur(8px);
    }
    header.nav .container {
      display: flex; align-items: center; justify-content: space-between;
    }
    .brand {
      display: flex; align-items: center; gap: 10px;
      font-weight: 700; font-size: 17px;
      letter-spacing: -0.2px;
    }
    .brand .logo {
      width: 32px; height: 32px;
      display: grid; place-items: center;
      border-radius: 9px;
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%);
      color: white;
    }
    .brand .logo svg { width: 18px; height: 18px; }
    nav.links { display: flex; gap: 6px; align-items: center; }
    nav.links a {
      padding: 8px 12px;
      border-radius: var(--radius-button);
      color: var(--fg);
      font-size: 14px; font-weight: 500;
    }
    nav.links a:hover { background: var(--surface); text-decoration: none; }
    nav.links a.icon { display: inline-grid; place-items: center; padding: 8px; }
    nav.links a.icon svg { width: 18px; height: 18px; color: var(--muted); }
    nav.links a.icon:hover svg { color: var(--fg); }
    nav.links a.cta {
      background: var(--accent); color: var(--bg);
      font-weight: 600;
    }
    nav.links a.cta:hover { background: #8eb0fa; text-decoration: none; }

    /* Hero */
    section.hero { padding: 96px 0 64px; text-align: center; }
    .eyebrow {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 6px 12px;
      border-radius: var(--radius-chip);
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--muted);
      font-size: 12px; font-weight: 500;
      margin-bottom: 24px;
    }
    .eyebrow .dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--good); box-shadow: 0 0 8px var(--good);
    }
    h1 {
      font-size: clamp(36px, 6vw, 56px);
      line-height: 1.05;
      letter-spacing: -0.02em;
      font-weight: 800;
      margin: 0 0 20px;
    }
    h1 .accent {
      background: linear-gradient(135deg, var(--accent) 0%, #BB9AF7 100%);
      -webkit-background-clip: text; background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .lead {
      font-size: 17px; line-height: 1.55;
      color: var(--muted);
      max-width: 600px; margin: 0 auto 32px;
    }
    .cta-row {
      display: flex; gap: 12px; justify-content: center;
      flex-wrap: wrap;
    }
    .os-note {
      margin-top: 28px;
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0.04em;
    }
    .os-note .mono { font-family: var(--font-mono); }
    .btn {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 12px 18px;
      border-radius: var(--radius-button);
      font-weight: 600; font-size: 15px;
      transition: transform 100ms ease, background 100ms ease;
      cursor: pointer;
    }
    .btn:hover { text-decoration: none; transform: translateY(-1px); }
    .btn.primary { background: var(--accent); color: var(--bg); }
    .btn.primary:hover { background: #8eb0fa; }
    .btn.secondary {
      background: var(--surface); color: var(--fg);
      border: 1px solid var(--border);
    }
    .btn.secondary:hover { background: var(--surface-alt); }
    .btn svg { width: 16px; height: 16px; }

    /* Section header */
    h2 {
      font-size: 26px;
      letter-spacing: -0.02em;
      font-weight: 700;
      margin: 0 0 12px;
    }
    .section { padding: 56px 0; border-top: 1px solid var(--border); }
    .section-lead { color: var(--muted); margin: 0 0 32px; max-width: 560px; font-size: 15px; line-height: 1.55; }

    /* Card grid */
    .grid { display: grid; gap: 16px; }
    .grid.cols-2 { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
    .grid.cols-3 { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    .card {
      padding: 20px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-card);
    }
    .card .icon-tile {
      width: 40px; height: 40px;
      display: grid; place-items: center;
      border-radius: var(--radius-button);
      background: var(--surface-alt);
      border: 1px solid var(--border);
      margin-bottom: 14px;
      color: var(--accent);
    }
    .card .icon-tile svg { width: 22px; height: 22px; }
    .card h3 { margin: 0 0 6px; font-size: 16px; font-weight: 600; }
    .card p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }

    /* App badges */
    .badges { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .badge {
      display: flex; align-items: center; gap: 12px;
      padding: 14px 16px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-card);
      opacity: 0.85;
    }
    .badge .icon { color: var(--fg); }
    .badge .icon svg { width: 26px; height: 26px; }
    .badge .meta { display: flex; flex-direction: column; gap: 2px; }
    .badge .meta .where { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
    .badge .meta .what { font-weight: 600; font-size: 14px; }
    .badge .pill {
      margin-left: auto;
      padding: 3px 8px;
      background: var(--surface-alt);
      border: 1px solid var(--border);
      border-radius: var(--radius-chip);
      font-size: 11px; color: var(--muted); font-weight: 500;
    }

    /* Code block */
    .codeblock {
      position: relative;
      padding: 18px 20px;
      background: #0a0c0f;
      border: 1px solid var(--border);
      border-radius: var(--radius-card);
      overflow-x: auto;
    }
    .codeblock pre {
      margin: 0; font-family: var(--font-mono); font-size: 14px;
      color: var(--fg); white-space: pre;
    }
    .codeblock .prompt { color: var(--muted); user-select: none; }
    .copy-btn {
      position: absolute; top: 12px; right: 12px;
      padding: 6px 10px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--muted); font-size: 11px;
      cursor: pointer; font-family: var(--font-sans);
    }
    .copy-btn:hover { color: var(--fg); }
    .copy-btn.copied { color: var(--good); border-color: var(--good); }

    /* How it works */
    ol.steps {
      list-style: none; padding: 0; margin: 0;
      display: grid; gap: 12px;
    }
    ol.steps li {
      display: flex; gap: 14px;
      padding: 16px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-card);
      align-items: flex-start;
    }
    ol.steps .num {
      width: 28px; height: 28px;
      display: grid; place-items: center;
      border-radius: 8px;
      background: var(--surface-alt);
      border: 1px solid var(--border);
      color: var(--accent);
      font-family: var(--font-mono); font-weight: 700; font-size: 13px;
      flex-shrink: 0;
    }
    ol.steps .body h3 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
    ol.steps .body p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
    ol.steps .body code {
      background: var(--surface-alt); padding: 1px 6px; border-radius: 4px;
      font-size: 12px; color: var(--fg);
    }

    /* Footer */
    footer.foot {
      padding: 32px 0;
      border-top: 1px solid var(--border);
      color: var(--muted); font-size: 13px;
    }
    footer.foot .container {
      display: flex; align-items: center; justify-content: space-between; gap: 16px;
      flex-wrap: wrap;
    }
    footer.foot a { color: var(--muted); }
    footer.foot a:hover { color: var(--fg); text-decoration: none; }
    footer.foot .links { display: flex; gap: 16px; }

    @media (max-width: 600px) {
      section.hero { padding: 56px 0 40px; }
      .section { padding: 40px 0; }
      nav.links a:not(.icon):not(.cta) { display: none; }
    }
  </style>
</head>
<body>
  <header class="nav">
    <div class="container">
      <div class="brand">
        <span class="logo">${ICONS.loopArrow}</span>
        <span>${BRAND_NAME}</span>
      </div>
      <nav class="links">
        <a href="#how">How it works</a>
        <a href="#self-host">Self-host</a>
        <a href="${GITHUB_URL}" class="icon" aria-label="GitHub" target="_blank" rel="noopener">${ICONS.github}</a>
        <a href="/app" class="cta">Open web app</a>
      </nav>
    </div>
  </header>

  <main>
    <section class="hero">
      <div class="container">
        <span class="eyebrow"><span class="dot"></span>Open source · Self-hosted</span>
        <h1>Your terminal,<br/><span class="accent">in your pocket.</span></h1>
        <p class="lead">
          Control Claude Code, Cursor, Codex, or any shell on your laptop
          from your phone. Self-hosted on Cloudflare Workers.
        </p>
        <div class="cta-row">
          <a href="/app" class="btn primary">${ICONS.bolt}Open web app</a>
          <a href="${GITHUB_URL}" class="btn secondary" target="_blank" rel="noopener">${ICONS.github}View on GitHub</a>
        </div>
        <p class="os-note"><span class="mono">macOS</span> · <span class="mono">Linux</span> · <span class="mono">Windows</span></p>
      </div>
    </section>

    <section class="section" id="features">
      <div class="container">
        <div class="grid cols-3">
          <div class="card">
            <div class="icon-tile">${ICONS.cmd}</div>
            <h3>Real terminal</h3>
            <p>Full PTY. ANSI, scrollback, resize. TUIs render.</p>
          </div>
          <div class="card">
            <div class="icon-tile">${ICONS.bolt}</div>
            <h3>Persistent sessions</h3>
            <p>Switch tabs. Lock your phone. Lose signal. Pick up where you left off.</p>
          </div>
          <div class="card">
            <div class="icon-tile">${ICONS.shield}</div>
            <h3>Self-hosted</h3>
            <p>Bearer auth, 4-digit pair codes, secrets hashed at rest. No accounts. No middleman.</p>
          </div>
        </div>
      </div>
    </section>

    <section class="section" id="apps">
      <div class="container">
        <h2>Native apps</h2>
        <p class="section-lead">
          iOS Safari and Android Chrome work today — open <a href="/app">/app</a>
          on your phone. Native apps on the way.
        </p>
        <div class="badges">
          <div class="badge">
            <span class="icon">${ICONS.apple}</span>
            <div class="meta">
              <span class="where">App Store</span>
              <span class="what">iOS &amp; iPadOS</span>
            </div>
            <span class="pill">Coming soon</span>
          </div>
          <div class="badge">
            <span class="icon">${ICONS.android}</span>
            <div class="meta">
              <span class="where">Google Play</span>
              <span class="what">Android</span>
            </div>
            <span class="pill">Coming soon</span>
          </div>
        </div>
      </div>
    </section>

    <section class="section" id="self-host">
      <div class="container">
        <h2>Self-host in 30 seconds.</h2>
        <p class="section-lead">
          One command deploys a relay to your own Cloudflare Workers account on the free tier.
        </p>
        <div class="codeblock">
          <button class="copy-btn" id="copy-cmd" type="button">Copy</button>
          <pre><span class="prompt">$ </span>npx @loopsy/deploy-relay</pre>
        </div>
        <p class="section-lead" style="margin-top: 16px;">
          Already have a relay? <a href="${GITHUB_URL}#configuration">Configure your daemon</a>.
        </p>
      </div>
    </section>

    <section class="section" id="how">
      <div class="container">
        <h2>How it works.</h2>
        <p class="section-lead">Three pieces. Your laptop runs a daemon, your phone runs a client, a Cloudflare Worker brokers the connection.</p>
        <ol class="steps">
          <li>
            <div class="num">1</div>
            <div class="body">
              <h3>Install</h3>
              <p>Run <code>npm i -g loopsy &amp;&amp; loopsy start</code> on your laptop. Daemon connects to the relay and waits.</p>
            </div>
          </li>
          <li>
            <div class="num">2</div>
            <div class="body">
              <h3>Pair</h3>
              <p>Run <code>loopsy mobile pair</code>. Scan the QR with your phone, enter the 4-digit code.</p>
            </div>
          </li>
          <li>
            <div class="num">3</div>
            <div class="body">
              <h3>Use it</h3>
              <p>Open <a href="/app">/app</a> on your phone. Pick the agent. Type, dictate, commit code. Your laptop runs it.</p>
            </div>
          </li>
        </ol>
      </div>
    </section>
  </main>

  <footer class="foot">
    <div class="container">
      <div class="brand">
        <span class="logo">${ICONS.loopArrow}</span>
        <span>${BRAND_NAME}</span>
      </div>
      <div class="links">
        <a href="${GITHUB_URL}" target="_blank" rel="noopener">GitHub</a>
        <a href="${GITHUB_URL}/issues" target="_blank" rel="noopener">Issues</a>
        <a href="/app">Web app</a>
      </div>
    </div>
  </footer>

  <script nonce="__CSP_NONCE__">
    'use strict';
    var btn = document.getElementById('copy-cmd');
    if (btn) {
      btn.addEventListener('click', function () {
        var cmd = 'npx @loopsy/deploy-relay';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(cmd).then(function () {
            btn.textContent = 'Copied';
            btn.classList.add('copied');
            setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1400);
          });
        }
      });
    }
  </script>
</body>
</html>`;
