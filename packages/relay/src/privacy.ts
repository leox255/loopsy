/**
 * Privacy policy served at `/privacy`.
 *
 * Loopsy is a phone-to-laptop terminal bridge: the relay only routes
 * encrypted WebSocket frames between paired devices. The relay itself does
 * not retain message contents, does not track users across sites, and does
 * not share data with third parties.
 *
 * Visual language matches the marketing landing — same topbar + container
 * grid + section labels. Linked from App Store Connect.
 */

import { BRAND_NAME, FAVICON_LINKS, GITHUB_URL, ICONS, TOKENS_CSS } from './design.js';

export const PRIVACY_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <meta name="theme-color" content="#0B0D10" />
  <title>${BRAND_NAME} — Privacy Policy</title>
  <meta name="description" content="Privacy policy for Loopsy — phone-to-laptop terminal bridge." />
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
    code { font-family: var(--font-mono); font-size: 13px; background: var(--surface);
      padding: 1px 6px; border-radius: 4px; border: 1px solid var(--border); }
    a { color: var(--accent); }
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
    <h1>Privacy Policy</h1>
    <p class="meta">Last updated: 29 April 2026 · Anza Cloud Limited</p>

    <p>Loopsy is a phone-to-laptop terminal bridge. The mobile app, the
    desktop daemon, and this relay together let you control a terminal on
    your laptop from your phone. This policy describes what data Loopsy
    handles and what it does not.</p>

    <h2>Data we do not collect</h2>
    <ul>
      <li>We do not collect your name, email, phone number, address, or any
      account profile information. Loopsy has no user accounts.</li>
      <li>We do not collect analytics, telemetry, or usage statistics from
      the mobile app.</li>
      <li>We do not track you across other apps or websites and we do not
      use third-party advertising networks.</li>
      <li>We do not sell, rent, or share data with third parties.</li>
    </ul>

    <h2>Data the app stores on your device</h2>
    <ul>
      <li><strong>Pairing token</strong> — a credential bound to a single
      laptop, stored in the iOS Keychain so the app can reconnect.</li>
      <li><strong>Session list</strong> — the names of terminal sessions you
      have opened, stored locally so they survive an app restart.</li>
      <li><strong>Relay URL</strong> — the address of the relay you paired
      against. Defaults to <code>relay.loopsy.dev</code>; you can point at
      your own self-hosted relay at any time.</li>
    </ul>
    <p>This data lives on your device. It is not uploaded anywhere unless
    you trigger a sync (which Loopsy does not currently offer).</p>

    <h2>Camera</h2>
    <p>The app requests camera access for one purpose: scanning the QR code
    your laptop displays during pairing. Camera frames are processed
    on-device by <code>mobile_scanner</code> and discarded; nothing is
    uploaded.</p>

    <h2>Data the relay sees</h2>
    <p>To carry your terminal session between phone and laptop, the relay
    routes WebSocket frames over TLS. The relay needs to look at frame
    metadata (which session, which device) to route correctly, but it does
    not persist the contents of those frames. Cloudflare may log standard
    HTTP request metadata (IP, timestamp, status code) for abuse prevention
    on its own infrastructure; see Cloudflare's privacy policy at
    <a href="https://www.cloudflare.com/privacypolicy/">cloudflare.com/privacypolicy</a>.</p>

    <h2>Self-hosting</h2>
    <p>Loopsy is open source. You can deploy your own relay to your own
    Cloudflare account and configure the app to use it; in that case Anza
    Cloud Limited has no visibility into your traffic at all. See the
    project on GitHub: <a href="${GITHUB_URL}">${GITHUB_URL}</a>.</p>

    <h2>Children</h2>
    <p>Loopsy is not directed to children under 13 and does not knowingly
    collect personal data from anyone.</p>

    <h2>Changes</h2>
    <p>If this policy materially changes we will update the date at the top
    of this page and, where appropriate, surface the change in the app.</p>

    <h2>Contact</h2>
    <p>Questions about this policy: open an issue at
    <a href="${GITHUB_URL}">${GITHUB_URL}</a> or email
    <a href="mailto:hello@anzacloud.com">hello@anzacloud.com</a>.</p>
  </main>
</body>
</html>`;
