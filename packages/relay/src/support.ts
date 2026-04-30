/**
 * Support page served at `/support`.
 *
 * Apple flagged the GitHub-issues link as not satisfying the "functional
 * webpage with support information" requirement (guideline 1.5). This page
 * is the official support landing for the iOS app: contact email, FAQ,
 * troubleshooting, and a link out to GitHub for bug reports.
 *
 * Visual language matches /privacy and the marketing landing.
 */

import { BRAND_NAME, FAVICON_LINKS, GITHUB_URL, ICONS, TOKENS_CSS } from './design.js';

export const SUPPORT_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <meta name="theme-color" content="#0B0D10" />
  <title>${BRAND_NAME} — Support</title>
  <meta name="description" content="Support and help for Loopsy — phone-to-machine terminal bridge." />
  ${FAVICON_LINKS}
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" />
  <style>
    ${TOKENS_CSS}
    body { min-height: 100dvh; }
    .container { max-width: 720px; margin: 0 auto; padding: 0 16px; width: 100%; }
    .topbar { padding: 14px 0; border-bottom: 1px solid var(--border); }
    .topbar .container { display: flex; align-items: center; justify-content: space-between; }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 15px; letter-spacing: -0.2px; }
    .brand a { color: inherit; text-decoration: none; display: flex; align-items: center; gap: 10px; }
    .brand .logo { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px;
      background: linear-gradient(135deg, var(--accent), var(--accent-dark)); color: white; }
    .brand .logo svg { width: 16px; height: 16px; }
    main { padding: 32px 0 80px; }
    h1 { font-size: 26px; letter-spacing: -0.4px; margin: 0 0 6px; }
    .meta { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
    h2 { font-size: 15px; font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.1em;
      color: var(--muted); margin: 28px 0 10px; font-weight: 600; }
    p { line-height: 1.55; color: var(--fg); margin: 0 0 12px; font-size: 15px; }
    ul { line-height: 1.55; color: var(--fg); padding-left: 20px; margin: 0 0 12px; }
    li { margin-bottom: 6px; font-size: 15px; }
    code, pre { font-family: var(--font-mono); font-size: 13px; background: var(--surface);
      padding: 1px 6px; border-radius: 4px; border: 1px solid var(--border); }
    pre { display: block; padding: 12px 14px; overflow-x: auto; line-height: 1.5; margin: 0 0 12px; }
    a { color: var(--accent); }
    .contact-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
      padding: 18px; margin: 0 0 24px; }
    .contact-card .row { display: flex; justify-content: space-between; align-items: center; gap: 14px;
      flex-wrap: wrap; }
    .contact-card .label { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase;
      letter-spacing: 0.1em; color: var(--muted); }
    .contact-card .value { font-size: 15px; font-weight: 600; }
    details { background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
      padding: 12px 16px; margin: 0 0 10px; }
    details summary { cursor: pointer; font-weight: 600; font-size: 15px; color: var(--fg);
      list-style: none; }
    details summary::-webkit-details-marker { display: none; }
    details summary::before { content: '+ '; color: var(--accent); font-weight: 700; }
    details[open] summary::before { content: '− '; }
    details p, details ul { margin-top: 10px; font-size: 14px; line-height: 1.5; }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="container">
      <span class="brand">
        <a href="/"><span class="logo">${ICONS.loopArrow}</span><span>${BRAND_NAME}</span></a>
      </span>
    </div>
  </header>

  <main class="container">
    <h1>Support</h1>
    <p class="meta">Help, troubleshooting, and how to reach us.</p>

    <div class="contact-card">
      <div class="row">
        <div>
          <div class="label">Email</div>
          <div class="value"><a href="mailto:anzacloud@gmail.com">anzacloud@gmail.com</a></div>
        </div>
        <div>
          <div class="label">Response time</div>
          <div class="value">Within 1 business day</div>
        </div>
      </div>
    </div>

    <p>Loopsy is open source. For bug reports and feature requests you can
    also open an issue at
    <a href="${GITHUB_URL}/issues">${GITHUB_URL}/issues</a>.
    For private support — questions about your specific setup, account, or
    anything you'd rather not share publicly — email us directly.</p>

    <h2>Getting started</h2>

    <details>
      <summary>How do I pair the iOS app with my machine?</summary>
      <ol>
        <li>Install the Loopsy CLI on your machine:
        <pre>npm install -g @loopsy/cli</pre></li>
        <li>Run <code>loopsy mobile pair</code>. The CLI prints a QR code and a
        4-digit verification code.</li>
        <li>Open Loopsy on your iPhone, tap <strong>Pair</strong>, scan the QR
        code, and enter the 4-digit code from your machine.</li>
        <li>You're paired. The home screen now shows your machine.</li>
      </ol>
    </details>

    <details>
      <summary>What if I do not have a Mac/Linux machine to pair with?</summary>
      <p>The Loopsy iOS app is a remote control surface — it has no value
      without a machine running the daemon. If you only have a phone, the
      app can't do its job. You can still browse the pair screen and the
      open-source code, but session functionality requires a paired
      machine.</p>
    </details>

    <details>
      <summary>Camera does not work / pair screen is black</summary>
      <p>iOS may have denied the Camera permission for Loopsy. Open
      <strong>Settings → Loopsy → Camera</strong> and turn it on. Reopen
      the app. The QR scanner should now show the live viewfinder.</p>
    </details>

    <details>
      <summary>The QR pair scan says "401 invalid or expired token"</summary>
      <p>Pair tokens issued by <code>loopsy mobile pair</code> last 5
      minutes. If you waited too long between scanning and entering the
      4-digit code, the token expired. Run the command again on your
      machine and rescan.</p>
    </details>

    <details>
      <summary>Sessions disconnect when the phone screen locks</summary>
      <p>Sessions live on your machine. When you reopen the app, the
      session resumes from where it left off — Loopsy reuses the same PTY
      on the daemon for that session id.</p>
    </details>

    <h2>Self-hosting</h2>

    <details>
      <summary>How do I run Loopsy on my own Cloudflare relay?</summary>
      <ol>
        <li><pre>npm install -g @loopsy/deploy-relay</pre></li>
        <li><pre>loopsy-deploy-relay</pre>
        Follow the prompts. The CLI signs into Cloudflare on your behalf
        and deploys a Worker with a Durable Object backing the WebSocket
        relay. Free tier is enough for personal use.</li>
        <li>Point the iOS app at your relay during pairing — the URL
        printed by <code>loopsy mobile pair --relay https://your-relay.example</code>
        embeds your relay address in the QR.</li>
      </ol>
    </details>

    <details>
      <summary>Where is the source code?</summary>
      <p>Everything — iOS app, CLI, daemon, relay, MCP server — is open
      source at <a href="${GITHUB_URL}">${GITHUB_URL}</a>.</p>
    </details>

    <h2>Privacy &amp; data</h2>

    <details>
      <summary>What data does Loopsy collect?</summary>
      <p>None from the app itself. We do not have user accounts and we do
      not run analytics. The relay routes WebSocket frames between your
      paired devices over TLS and does not retain message contents. See
      our <a href="/privacy">privacy policy</a> for the full statement.</p>
    </details>

    <details>
      <summary>How do I revoke a paired phone?</summary>
      <p>Run <code>loopsy phone list</code> on your machine to see paired
      phones, then <code>loopsy phone revoke &lt;id&gt;</code>. The phone
      loses access immediately — its WebSocket gets dropped and the
      pairing token is invalidated server-side.</p>
    </details>

    <h2>Still stuck?</h2>
    <p>Email <a href="mailto:anzacloud@gmail.com">anzacloud@gmail.com</a>
    with what you tried, the iOS version, and (if relevant) the output of
    <code>loopsy doctor</code> on your machine. We'll get back to you
    within a business day.</p>
  </main>
</body>
</html>`;
