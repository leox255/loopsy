/**
 * Inline HTML+JS web client for the Loopsy relay.
 *
 * Served at `/app` on the Worker. Loads xterm.js from a CDN, redeems any
 * pair token in the URL fragment, then opens a WebSocket session. Designed
 * to run on iOS Safari + Android Chrome with no install.
 *
 * Design parity: tokens come from `design.ts` and match the Flutter app's
 * `LoopsyColors` (apps/mobile/lib/theme.dart). Icons are inline SVG
 * (HugeIcons stroke style) so we don't pull a font for ~6 glyphs.
 */

import { BRAND_NAME, ICONS, TOKENS_CSS } from './design.js';

export const WEB_CLIENT_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="theme-color" content="#0B0D10" />
  <title>${BRAND_NAME}</title>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css" />
  <style>
    ${TOKENS_CSS}
    html, body {
      width: 100%; height: 100dvh;
      overflow: hidden; overscroll-behavior: none;
    }
    body {
      display: flex; flex-direction: column;
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    }
    /* ── Top bar ──────────────────────────────────────────────────────── */
    .topbar {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .brand {
      display: flex; align-items: center; gap: 10px;
      font-weight: 700; font-size: 15px;
      letter-spacing: -0.2px;
    }
    .brand .logo {
      width: 28px; height: 28px;
      display: grid; place-items: center;
      border-radius: 8px;
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%);
      color: white;
    }
    .brand .logo svg { width: 16px; height: 16px; }
    .topbar .spacer { flex: 1; }
    .status {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px;
      background: var(--surface-alt);
      border: 1px solid var(--border);
      border-radius: var(--radius-chip);
      font-size: 11px; color: var(--muted);
      font-weight: 500;
      max-width: 38vw;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .status .dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--muted);
    }
    .status.ok { color: var(--good); }
    .status.ok .dot { background: var(--good); box-shadow: 0 0 6px var(--good); }
    .status.err { color: var(--bad); }
    .status.err .dot { background: var(--bad); }
    .icon-btn {
      display: inline-grid; place-items: center;
      width: 36px; height: 36px;
      background: var(--surface-alt);
      border: 1px solid var(--border);
      border-radius: var(--radius-button);
      color: var(--fg);
      cursor: pointer;
      padding: 0;
    }
    .icon-btn svg { width: 16px; height: 16px; }
    .icon-btn:hover { background: var(--border); }
    .icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .icon-btn.danger { color: var(--bad); }
    /* ── Action row (agent + new) ──────────────────────────────────────── */
    .actions {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 14px 6px;
      flex-shrink: 0;
    }
    .agent-select {
      flex: 1;
      background: var(--surface-alt); color: var(--fg);
      border: 1px solid var(--border);
      border-radius: var(--radius-button);
      padding: 9px 12px;
      font-family: var(--font-mono);
      font-size: 13px;
      font-weight: 500;
      appearance: none;
      -webkit-appearance: none;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>");
      background-repeat: no-repeat;
      background-position: right 10px center;
      padding-right: 30px;
    }
    .btn-primary {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 9px 14px;
      background: var(--accent); color: var(--bg);
      border: none; border-radius: var(--radius-button);
      font-weight: 600; font-size: 13px;
      cursor: pointer;
      font-family: var(--font-sans);
    }
    .btn-primary svg { width: 14px; height: 14px; }
    .btn-primary:hover { background: #8eb0fa; }
    .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
    /* ── Sessions chips ────────────────────────────────────────────────── */
    .chips {
      display: flex; gap: 6px;
      padding: 6px 14px 10px;
      overflow-x: auto;
      flex-shrink: 0;
      scrollbar-width: none;
    }
    .chips::-webkit-scrollbar { display: none; }
    .chips:empty { display: none; }
    .chip {
      flex-shrink: 0;
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 10px;
      background: var(--surface-alt);
      border: 1px solid var(--border);
      border-radius: var(--radius-chip);
      font-size: 12px;
      font-family: var(--font-mono);
      color: var(--fg);
      cursor: pointer;
      white-space: nowrap;
      transition: background 100ms ease, border-color 100ms ease;
    }
    .chip:hover { background: var(--border); }
    .chip.active { border-color: var(--accent); color: var(--fg); background: rgba(122, 162, 247, 0.12); }
    .chip .live { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
    .chip.live-on .live { background: var(--good); box-shadow: 0 0 4px var(--good); }
    .chip .x {
      color: var(--muted); margin-left: 2px;
      width: 14px; height: 14px;
      display: grid; place-items: center;
      border-radius: 50%;
    }
    .chip .x:hover { color: var(--bad); background: rgba(247,118,142,0.16); }
    /* ── Terminal ──────────────────────────────────────────────────────── */
    #term {
      flex: 1; min-height: 0;
      padding: 6px 10px;
    }
    .xterm-viewport { background: var(--bg) !important; }
    .xterm-viewport::-webkit-scrollbar { width: 6px; }
    .xterm-viewport::-webkit-scrollbar-thumb { background: var(--surface-alt); border-radius: 3px; }
    .empty-state {
      display: flex; flex-direction: column; align-items: center;
      gap: 10px; padding: 32px 20px;
      color: var(--muted); text-align: center;
    }
    .empty-state svg { width: 32px; height: 32px; opacity: 0.6; }
    .empty-state h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--fg); }
    .empty-state p { margin: 0; font-size: 13px; line-height: 1.5; max-width: 280px; }
    /* ── Custom on-screen keyboard ─────────────────────────────────────── */
    /*
     * Bytes-first soft keyboard for terminals. Sends raw control sequences
     * (DEL, CR, ESC, ^C, etc.) directly to the active PTY rather than going
     * through the OS IME — which mangles backspace and turns Return into LF.
     * Layout mirrors apps/mobile/lib/widgets/terminal_keyboard.dart so muscle
     * memory carries between the native app and the web client.
     */
    .kb {
      background: var(--surface);
      border-top: 1px solid var(--border);
      padding: 6px 2px calc(6px + env(safe-area-inset-bottom));
      flex-shrink: 0;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
    }
    .kb-row {
      display: flex;
      padding: 0 2px;
      gap: 5px;
      margin-bottom: 5px;
    }
    .kb-row:last-child { margin-bottom: 0; }
    .kb-row .pad { flex: 0.5; }
    .kb-row .pad-sm { flex: 0.3; }
    .key {
      flex: 1 0 0;
      height: 38px;
      background: var(--surface-alt);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 7px;
      font-family: var(--font-mono);
      font-size: 16px;
      font-weight: 500;
      cursor: pointer;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      -webkit-tap-highlight-color: transparent;
      /* manipulation = allow tap + pan, but no double-tap zoom (which
         introduces a 300ms delay before click on iOS). */
      touch-action: manipulation;
      transition: transform 60ms ease-out, background 80ms ease-out;
    }
    .key:active { background: var(--border); transform: scale(0.96); }
    .key.selected {
      background: var(--accent);
      color: var(--bg);
      border-color: var(--accent);
    }
    .key.small { font-size: 13px; }
    .key svg { width: 16px; height: 16px; pointer-events: none; }
    .key.accent { color: var(--accent); }

    /* ── Voice / dictation bottom sheet ────────────────────────────────── */
    .sheet {
      position: fixed; inset: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(6px);
      z-index: 200;
      display: flex; align-items: flex-end;
    }
    .sheet.hidden { display: none; }
    .sheet-card {
      width: 100%;
      background: var(--surface);
      border-top-left-radius: 18px;
      border-top-right-radius: 18px;
      padding: 18px 20px calc(20px + env(safe-area-inset-bottom));
      border-top: 1px solid var(--border);
    }
    .sheet-header {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: 14px;
    }
    .sheet-header svg { width: 22px; height: 22px; color: var(--muted); }
    .sheet-header.listening svg { color: var(--bad); }
    .sheet-title { font-weight: 600; font-size: 16px; }
    .sheet-textarea {
      width: 100%;
      min-height: 100px; max-height: 180px;
      padding: 14px;
      background: var(--surface-alt); color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 12px;
      font-family: var(--font-mono);
      font-size: 15px;
      resize: vertical;
      line-height: 1.4;
    }
    .sheet-textarea:focus { outline: none; border-color: var(--accent); }
    .sheet-hint { margin: 8px 0 14px; color: var(--muted); font-size: 11px; }
    .sheet-actions { display: flex; align-items: center; gap: 8px; }
    .sheet-actions .spacer { flex: 1; }
    .sheet-btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 10px 14px;
      background: var(--surface-alt); color: var(--fg);
      border: 1px solid var(--border);
      border-radius: var(--radius-button);
      font-weight: 600; font-size: 13px;
      cursor: pointer;
      font-family: var(--font-sans);
    }
    .sheet-btn:hover { background: var(--border); }
    .sheet-btn.primary {
      background: var(--accent); color: var(--bg); border-color: var(--accent);
    }
    .sheet-btn.primary:hover { background: #8eb0fa; }
    .sheet-btn.primary:disabled { opacity: 0.4; cursor: not-allowed; }
    .sheet-btn.danger {
      background: var(--bad); color: white; border-color: var(--bad);
    }
    .sheet-btn svg { width: 14px; height: 14px; }
    /* ── Modal ─────────────────────────────────────────────────────────── */
    .modal {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.7);
      backdrop-filter: blur(6px);
      display: flex; align-items: center; justify-content: center;
      z-index: 100; padding: 20px;
    }
    .modal.hidden { display: none; }
    .modal-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-card);
      padding: 24px;
      max-width: 420px; width: 100%;
    }
    .modal-card .modal-icon {
      width: 44px; height: 44px;
      display: grid; place-items: center;
      border-radius: 12px;
      background: var(--surface-alt);
      border: 1px solid var(--border);
      color: var(--accent);
      margin-bottom: 14px;
    }
    .modal-card .modal-icon svg { width: 22px; height: 22px; }
    .modal-card h2 { margin: 0 0 6px; font-size: 18px; font-weight: 700; letter-spacing: -0.01em; }
    .modal-card p { margin: 0 0 16px; color: var(--muted); font-size: 14px; line-height: 1.5; }
    .modal-card input {
      width: 100%;
      padding: 11px 12px;
      background: var(--surface-alt);
      border: 1px solid var(--border);
      border-radius: var(--radius-button);
      color: var(--fg);
      font-family: var(--font-mono);
      font-size: 14px;
      margin-bottom: 16px;
    }
    .modal-card input:focus { outline: none; border-color: var(--accent); }
    .modal-actions {
      display: flex; gap: 8px; justify-content: flex-end;
    }
    .modal-error {
      margin: 0 0 12px;
      padding: 10px 12px;
      background: rgba(247, 118, 142, 0.10);
      border: 1px solid rgba(247, 118, 142, 0.4);
      border-radius: var(--radius-button);
      color: var(--bad);
      font-size: 13px;
      line-height: 1.45;
      word-break: break-word;
    }
    .modal-actions button {
      padding: 10px 16px;
      border-radius: var(--radius-button);
      font-weight: 600; font-size: 13px;
      cursor: pointer; border: 1px solid var(--border);
      background: var(--surface-alt); color: var(--fg);
      font-family: var(--font-sans);
    }
    .modal-actions button.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
    .modal-actions button.primary:hover { background: #8eb0fa; }
    /* iOS Safari focus zoom prevention */
    @supports (-webkit-touch-callout: none) {
      input, select, textarea { font-size: 16px !important; }
    }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="brand">
      <span class="logo">${ICONS.loopArrow}</span>
      <span>${BRAND_NAME}</span>
    </div>
    <div class="spacer"></div>
    <span id="status" class="status"><span class="dot"></span><span id="status-text">disconnected</span></span>
    <button id="reset" class="icon-btn" title="Forget pairing" aria-label="Reset">${ICONS.refresh}</button>
  </div>

  <div class="actions">
    <select id="agent" class="agent-select" aria-label="Agent">
      <option value="shell">shell</option>
      <option value="claude">claude</option>
      <option value="gemini">gemini</option>
      <option value="codex">codex</option>
    </select>
    <button id="open" class="btn-primary">${ICONS.add}<span>New</span></button>
    <button id="close" class="icon-btn danger" disabled aria-label="Close session">${ICONS.power}</button>
  </div>

  <div id="chips" class="chips"></div>
  <div id="term"></div>

  <div class="kb" id="kb">
    <div class="kb-row" id="kb-strip"></div>
    <div class="kb-row" id="kb-r1"></div>
    <div class="kb-row" id="kb-r2"></div>
    <div class="kb-row" id="kb-r3"></div>
    <div class="kb-row" id="kb-bot"></div>
  </div>

  <!-- Voice / dictation sheet — auto-listens, you can edit before sending -->
  <div id="voice-sheet" class="sheet hidden" role="dialog" aria-modal="true" aria-label="Voice input">
    <div class="sheet-card">
      <div class="sheet-header" id="voice-header">
        <span id="voice-icon">${ICONS.micOff}</span>
        <span class="sheet-title" id="voice-title">Tap mic to start</span>
      </div>
      <textarea id="voice-text" class="sheet-textarea" placeholder="Speak now, then edit before sending…"
                autocomplete="off" autocapitalize="sentences" autocorrect="on" spellcheck="true"></textarea>
      <p class="sheet-hint" id="voice-hint">Edit freely. Tap the mic to dictate again.</p>
      <div class="sheet-actions">
        <button id="voice-toggle" class="sheet-btn">${ICONS.mic}<span id="voice-toggle-label">Listen</span></button>
        <button id="voice-clear" class="sheet-btn" aria-label="Clear">${ICONS.trash}</button>
        <span class="spacer"></span>
        <button id="voice-cancel" class="sheet-btn">Cancel</button>
        <button id="voice-send" class="sheet-btn primary" disabled>${ICONS.send}<span>Send</span></button>
      </div>
    </div>
  </div>

  <div id="modal" class="modal hidden">
    <div class="modal-card">
      <div class="modal-icon">${ICONS.loopArrow}</div>

      <!-- Step 1: paste pair URL -->
      <div id="step-link">
        <h2>Pair your phone</h2>
        <p>Run <code style="font-family:var(--font-mono);background:var(--surface-alt);padding:1px 5px;border-radius:4px">loopsy mobile pair</code> on your laptop. Scan the QR with your phone camera, or paste the printed link.</p>
        <input id="link-input" type="text" placeholder="https://&lt;your-relay&gt;/app#loopsy%3A..." autocomplete="off" autocapitalize="off" autocorrect="off" />
        <div id="link-error" class="modal-error" style="display:none"></div>
        <div class="modal-actions">
          <button id="link-ok" class="primary">Next</button>
        </div>
      </div>

      <!-- Step 2: enter the 4-digit SAS code shown on the laptop -->
      <div id="step-sas" style="display:none">
        <h2>Enter verification code</h2>
        <p>The 4-digit code shown on your laptop next to the QR.</p>
        <input id="sas-input" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="••••" autocomplete="one-time-code" autocapitalize="off" autocorrect="off" style="font-family:var(--font-mono); font-size:24px; letter-spacing:14px; text-align:center; padding:14px 12px;" />
        <div id="sas-error" class="modal-error" style="display:none"></div>
        <div class="modal-actions">
          <button id="sas-back">Back</button>
          <button id="sas-ok" class="primary">Pair</button>
        </div>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"
          integrity="sha384-xjfWUeCWdMtvpAb/SmM6lMzS6pQGcQa0loOl1d97j6Odw0vjK9nW3+dTb/bn/mwH"
          crossorigin="anonymous"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"
          integrity="sha384-dpjGwSSISUTz2taP54Bor7qkyMR20sSO9oe11UVYnGs2/YdUBf7HW30XKQx9PCzn"
          crossorigin="anonymous"></script>
  <script nonce="__CSP_NONCE__">
    'use strict';
    if (!window.Terminal || !window.FitAddon) {
      document.body.insertAdjacentHTML('afterbegin',
        '<div style="background:#f7768e;color:#fff;padding:10px;font-family:monospace">' +
        'xterm failed to load from CDN. Check network and reload.</div>');
    }
    const Terminal = window.Terminal;
    const FitAddon = window.FitAddon && window.FitAddon.FitAddon;

    const STORAGE_KEY = 'loopsy.pairing';
    const SESSIONS_KEY = 'loopsy.sessions';

    const $ = (id) => document.getElementById(id);
    const setStatus = (text, kind = '') => {
      const el = $('status');
      el.className = 'status' + (kind ? ' ' + kind : '');
      $('status-text').textContent = text;
    };

    // Tokyo Night palette mirrored from theme.dart's loopsyTerminalTheme.
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', ui-monospace, SF Mono, Menlo, Monaco, monospace",
      fontSize: 13,
      theme: {
        background: '#0B0D10',
        foreground: '#E7EAEE',
        cursor: '#7AA2F7',
        selectionBackground: 'rgba(122,162,247,0.32)',
        black: '#1A1B26', red: '#F7768E', green: '#9ECE6A', yellow: '#E0AF68',
        blue: '#7AA2F7', magenta: '#BB9AF7', cyan: '#7DCFFF', white: '#C0CAF5',
        brightBlack: '#414868', brightRed: '#FF7A93', brightGreen: '#B9F27C',
        brightYellow: '#FF9E64', brightBlue: '#7DA6FF', brightMagenta: '#BB9AF7',
        brightCyan: '#0DB9D7', brightWhite: '#D8E0F2',
      },
      convertEol: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open($('term'));

    // Suppress the OS soft keyboard. xterm.js renders a hidden helper textarea
    // that catches IME input — on iOS Safari / Android Chrome, focusing it
    // pops up the native keyboard. We have our own on-screen keyboard, so
    // tell the browser not to render one for that element. Physical
    // keystrokes on desktop still flow through normally.
    (function suppressOsKeyboard() {
      const helper = $('term').querySelector('.xterm-helper-textarea');
      if (!helper) return;
      helper.setAttribute('inputmode', 'none');
      helper.setAttribute('autocapitalize', 'off');
      helper.setAttribute('autocorrect', 'off');
      helper.setAttribute('spellcheck', 'false');
    })();

    fit.fit();
    term.writeln('\\x1b[2m${BRAND_NAME} web client.\\x1b[0m Pair your phone or restore a saved pairing.');

    /**
     * Refit on layout changes that move the bottom edge of #term — keyboard
     * layer toggle (letters ↔ symbols changes height by 5–10px), iOS visual
     * viewport shifts, etc. Without this, xterm's canvas keeps its initial
     * row count and overlaps the keyboard panel below.
     */
    function refitTerm() { try { fit.fit(); } catch {} }
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(refitTerm);
      ro.observe($('term'));
      ro.observe($('kb'));
    }

    // ─── State ─────────────────────────────────────────────────────────
    let pairing = null;
    /** Map<sessionId, { agent, ws, lastSeen }> */
    const sessions = new Map();
    let activeSessionId = null;

    function loadPairing() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
    }
    function savePairing(p) { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); }
    function clearPairing() { localStorage.removeItem(STORAGE_KEY); }

    function loadSessions() {
      try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]'); } catch { return []; }
    }
    function saveSessions(list) { localStorage.setItem(SESSIONS_KEY, JSON.stringify(list)); }
    function persistSessions() {
      const list = Array.from(sessions.entries()).map(([id, s]) => ({
        id, agent: s.agent, lastSeen: s.lastSeen,
      }));
      saveSessions(list);
    }

    function uuidV4() {
      if (crypto.randomUUID) return crypto.randomUUID();
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
      return h.slice(0,8) + '-' + h.slice(8,12) + '-' + h.slice(12,16) + '-' + h.slice(16,20) + '-' + h.slice(20,32);
    }

    function parsePairUrl(input) {
      // Three input shapes the user might paste:
      //   1. loopsy://pair?u=<relay>&t=<token>            (raw inner pair URL)
      //   2. https://<relay>/app#loopsy%3A%2F%2Fpair%3F…  (printed by \`loopsy mobile pair\`)
      //   3. https://<relay>/app#loopsy://pair?u=…&t=…    (raw, unencoded fragment)
      // Strategy: peel any /app#... wrapper first, then strip a loopsy:// prefix,
      // then parse as a URL.
      try {
        let s = String(input || '').trim();
        if (!s) return null;
        const hashIdx = s.indexOf('#');
        if (hashIdx >= 0 && /\\/app(\\/?|\\/$)/.test(s.slice(0, hashIdx))) {
          s = s.slice(hashIdx + 1);
          // Fragments are typically URL-encoded once when included in the printed link.
          try { s = decodeURIComponent(s); } catch { /* keep as-is */ }
        }
        const cleaned = s.replace(/^loopsy:\\/\\//i, 'https://');
        const u = new URL(cleaned);
        const token = u.searchParams.get('t');
        const relayUrlRaw = u.searchParams.get('u') || '';
        // The CLI single-encodes \`u\`; if a user pastes a doubly-encoded
        // copy (some clipboards mangle), try decoding twice.
        let relayUrl = '';
        try { relayUrl = decodeURIComponent(relayUrlRaw); } catch { relayUrl = relayUrlRaw; }
        if (relayUrl.startsWith('https%3A') || relayUrl.startsWith('http%3A')) {
          try { relayUrl = decodeURIComponent(relayUrl); } catch { /* keep */ }
        }
        if (!token || !relayUrl) return null;
        return { token, relayUrl };
      } catch {
        return null;
      }
    }

    /**
     * Compare the relay's origin to this page's origin. If they differ, the
     * browser will block the redeem POST under CSP \`connect-src 'self'\` —
     * shows up as "Load failed" on iOS Safari with no other detail. Detect
     * early and redirect the user to the correct origin so the flow works.
     */
    function relayOriginMismatch(parsed) {
      try {
        var pageOrigin = window.location.origin;
        var relayOrigin = new URL(parsed.relayUrl).origin;
        return pageOrigin !== relayOrigin;
      } catch { return false; }
    }

    /** Build the printable pair link from a parsed { token, relayUrl }. */
    function buildPairLink(parsed) {
      var inner = 'loopsy://pair?u=' + encodeURIComponent(parsed.relayUrl) + '&t=' + encodeURIComponent(parsed.token);
      return parsed.relayUrl.replace(/\\/+$/, '') + '/app#' + encodeURIComponent(inner);
    }

    /**
     * Redeem a pair token for a permanent phone_secret. The relay enforces
     * single-use semantics: once consumed, the token can't be re-used. Errors
     * surface inline in the modal — see CSO #14 for why we always require SAS.
     */
    async function redeemWith(parsed, sas) {
      setStatus('redeeming...');
      var redeemUrl = parsed.relayUrl.replace(/\\/+$/, '') + '/pair/redeem';
      let r;
      try {
        r = await fetch(redeemUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: parsed.token, sas: sas.trim(), label: navigator.userAgent.slice(0, 80) }),
        });
      } catch (netErr) {
        // iOS Safari surfaces CSP / TLS / DNS issues as a generic
        // "Load failed". Make the URL explicit so we can debug.
        throw new Error('Network error reaching ' + redeemUrl + ' — ' + (netErr && netErr.message ? netErr.message : 'fetch blocked'));
      }
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        let msg = 'Pair failed (' + r.status + ')';
        if (r.status === 401) msg = 'Wrong code, expired token, or token already used.';
        else if (r.status === 403) msg = 'Forbidden — relay rejected this pair.';
        else if (txt) msg += ' — ' + txt.slice(0, 120);
        throw new Error(msg);
      }
      const j = await r.json();
      const p = {
        relayUrl: parsed.relayUrl,
        deviceId: j.device_id,
        phoneId: j.phone_id,
        phoneSecret: j.phone_secret,
      };
      savePairing(p);
      pairing = p;
      setStatus('paired', 'ok');
      term.writeln('\\r\\n\\x1b[32m✓\\x1b[0m paired with device \\x1b[1m' + p.deviceId.slice(0, 8) + '\\x1b[0m…');
      // Auto-open a shell session so the keyboard works without an extra tap.
      // The user can switch agents from the dropdown and tap New for another.
      try { openNewSession($('agent').value || 'shell'); } catch {}
    }

    /** Two-step pair modal driver. Step 1: paste link. Step 2: enter SAS. */
    let pendingPair = null;  // parsed { token, relayUrl } between steps

    function showModal()  { $('modal').classList.remove('hidden'); resetModal(); $('link-input').focus(); }
    function hideModal()  { $('modal').classList.add('hidden'); resetModal(); }
    function resetModal() {
      $('step-link').style.display = '';
      $('step-sas').style.display = 'none';
      $('link-error').style.display = 'none';
      $('sas-error').style.display = 'none';
      $('link-input').value = '';
      $('sas-input').value = '';
      pendingPair = null;
    }
    function showLinkErr(msg) { var e = $('link-error'); e.textContent = msg; e.style.display = ''; }
    function showSasErr(msg)  { var e = $('sas-error');  e.textContent = msg; e.style.display = ''; }

    function goStepSas(parsed) {
      pendingPair = parsed;
      $('step-link').style.display = 'none';
      $('step-sas').style.display = '';
      $('sas-error').style.display = 'none';
      $('sas-input').value = '';
      setTimeout(function () { try { $('sas-input').focus(); } catch {} }, 80);
    }

    function goStepLink() {
      $('step-sas').style.display = 'none';
      $('step-link').style.display = '';
    }

    $('link-ok').onclick = () => {
      const v = $('link-input').value.trim();
      const parsed = parsePairUrl(v);
      if (!parsed) {
        showLinkErr('Could not parse that. Expected the link printed by "loopsy mobile pair" (starts with https:// and contains #loopsy%3A...).');
        return;
      }
      if (relayOriginMismatch(parsed)) {
        // Page origin and relay origin differ. The redeem fetch would be
        // blocked by our \`connect-src 'self'\` CSP. Redirect to the relay's
        // own /app so the rest of the flow runs same-origin.
        window.location.replace(buildPairLink(parsed));
        return;
      }
      goStepSas(parsed);
    };

    $('sas-back').onclick = () => goStepLink();

    $('sas-ok').onclick = async () => {
      const sas = $('sas-input').value.trim();
      if (!/^\\d{4}$/.test(sas)) {
        showSasErr('Enter the 4-digit code shown on your laptop.');
        return;
      }
      if (!pendingPair) { goStepLink(); return; }
      try {
        await redeemWith(pendingPair, sas);
        hideModal();
      } catch (e) {
        showSasErr(e && e.message ? e.message : String(e));
        setStatus('error', 'err');
      }
    };

    // Submit on Enter for both inputs.
    $('link-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('link-ok').click(); } });
    $('sas-input').addEventListener('keydown',  (e) => { if (e.key === 'Enter') { e.preventDefault(); $('sas-ok').click(); } });

    $('reset').onclick = () => {
      if (!confirm('Forget this pairing and close all sessions?')) return;
      for (const s of sessions.values()) try { s.ws.close(1000, 'reset'); } catch {}
      sessions.clear();
      activeSessionId = null;
      localStorage.removeItem(SESSIONS_KEY);
      clearPairing();
      pairing = null;
      term.reset();
      term.writeln('Pairing cleared.');
      renderChips();
      updateButtons();
      setStatus('disconnected');
      showModal();
    };

    $('open').onclick = () => openNewSession($('agent').value);
    $('close').onclick = () => closeActive();

    // ─── Custom on-screen keyboard ──────────────────────────────────────
    /*
     * Mirrors apps/mobile/lib/widgets/terminal_keyboard.dart so muscle memory
     * carries between native and web. Sends raw bytes (DEL=0x7f, CR=0x0d,
     * ESC=0x1b, arrows=ESC[A/B/C/D, Ctrl+letter=0x01..0x1A) so backspace and
     * Return do the right thing in shells and TUIs.
     */
    const KB_ICONS = {
      arrowUp:    ${JSON.stringify(ICONS.arrowUp)},
      arrowDown:  ${JSON.stringify(ICONS.arrowDown)},
      arrowLeft:  ${JSON.stringify(ICONS.arrowLeft)},
      arrowRight: ${JSON.stringify(ICONS.arrowRight)},
      arrowUpDouble: ${JSON.stringify(ICONS.arrowUpDouble)},
      mic:        ${JSON.stringify(ICONS.mic)},
      del:        ${JSON.stringify(ICONS.deleteKey)},
    };
    const KB = {
      layer: 'letters',  // 'letters' | 'symbols'
      shift: false,
      capsLock: false,
      ctrl: false,
      alt: false,
    };

    function kbSendBytes(bytes) {
      const s = activeSessionId ? sessions.get(activeSessionId) : null;
      if (!s) {
        // No session yet. If we're paired, auto-spawn one so the next tap
        // works immediately; otherwise nudge the user to pair first.
        if (pairing) {
          try { openNewSession($('agent').value || 'shell'); } catch {}
        } else {
          term.writeln('\\r\\n\\x1b[33m⚠ pair your phone first\\x1b[0m');
          return;
        }
        // Re-resolve after openNewSession set activeSessionId synchronously.
        const ns = activeSessionId ? sessions.get(activeSessionId) : null;
        if (!ns) return;
        // Queue bytes until the WebSocket is open.
        if (ns.ws.readyState !== 1) {
          ns.ws.addEventListener('open', () => { try { ns.ws.send(new Uint8Array(bytes)); } catch {} }, { once: true });
        } else {
          ns.ws.send(new Uint8Array(bytes));
        }
        try { if (navigator.vibrate) navigator.vibrate(8); } catch {}
        return;
      }
      if (s.ws.readyState !== 1) {
        // Mid-reconnect — queue until the socket is open.
        s.ws.addEventListener('open', () => { try { s.ws.send(new Uint8Array(bytes)); } catch {} }, { once: true });
      } else {
        s.ws.send(new Uint8Array(bytes));
      }
      try { if (navigator.vibrate) navigator.vibrate(8); } catch {}
    }

    function kbSendStr(str) {
      // Ctrl+letter → 0x01..0x1A
      if (KB.ctrl && str.length === 1) {
        const code = str.toLowerCase().charCodeAt(0);
        if (code >= 97 && code <= 122) {
          kbSendBytes([code - 96]);
        } else if (str === '[') {
          kbSendBytes([0x1b]);
        } else {
          kbSendBytes(Array.from(new TextEncoder().encode(str)));
        }
        KB.ctrl = false;  // one-shot
        renderKeyboard();
        return;
      }
      // Alt+x → ESC then x
      if (KB.alt && str.length === 1) {
        kbSendBytes([0x1b, ...new TextEncoder().encode(str)]);
        KB.alt = false;
        renderKeyboard();
        return;
      }
      let out = str;
      if (KB.layer === 'letters' && (KB.shift || KB.capsLock)) {
        out = str.toUpperCase();
      }
      kbSendBytes(Array.from(new TextEncoder().encode(out)));
      if (KB.shift && !KB.capsLock) {
        KB.shift = false;
        renderKeyboard();
      }
    }

    function makeKey(opts) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'key' + (opts.cls ? ' ' + opts.cls : '');
      if (opts.flex !== undefined) el.style.flex = String(opts.flex);
      if (opts.icon) el.innerHTML = opts.icon;
      else el.textContent = opts.label || '';

      /*
       * Use pointerdown for the action (works across mouse + touch + pen,
       * fires immediately with no 300ms tap delay). The previous version
       * preventDefault'd touchstart, which on iOS Safari ALSO suppresses
       * the synthesized click event — meaning the first tap worked but
       * subsequent ones never fired.
       *
       * preventDefault on pointerdown stops the browser from moving focus to
       * xterm's helper textarea (which would otherwise re-trigger the OS
       * keyboard despite inputmode=none).
       */
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        opts.onTap();
      });
      // Suppress the synthesized click so we don't double-fire.
      el.addEventListener('click', (e) => e.preventDefault());
      return el;
    }

    function makePad(flex) {
      const el = document.createElement('div');
      el.style.flex = String(flex);
      return el;
    }

    function dispLetter(c) { return (KB.shift || KB.capsLock) ? c.toUpperCase() : c; }

    const KB_R1 = ['q','w','e','r','t','y','u','i','o','p'];
    const KB_R2 = ['a','s','d','f','g','h','j','k','l'];
    const KB_R3 = ['z','x','c','v','b','n','m'];
    const KB_S1 = ['1','2','3','4','5','6','7','8','9','0'];
    const KB_S2 = ['-','/',':',';','(',')','$','&','@','"'];
    const KB_S3 = ['.',',','?','!',"'",'~','|'];

    function renderKeyboard() {
      const strip = $('kb-strip');
      const r1 = $('kb-r1');
      const r2 = $('kb-r2');
      const r3 = $('kb-r3');
      const bot = $('kb-bot');
      [strip, r1, r2, r3, bot].forEach((el) => { el.innerHTML = ''; });

      // Control strip: ctrl alt esc tab ↑ ↓ ← → mic
      strip.append(
        makeKey({ label: 'ctrl', cls: 'small' + (KB.ctrl ? ' selected' : ''), flex: 3,
                  onTap: () => { KB.ctrl = !KB.ctrl; renderKeyboard(); } }),
        makeKey({ label: 'alt',  cls: 'small' + (KB.alt ? ' selected' : ''),  flex: 3,
                  onTap: () => { KB.alt = !KB.alt; renderKeyboard(); } }),
        makeKey({ label: 'esc',  cls: 'small', flex: 3, onTap: () => kbSendBytes([0x1b]) }),
        makeKey({ label: 'tab',  cls: 'small', flex: 3, onTap: () => kbSendBytes([0x09]) }),
        makeKey({ icon: KB_ICONS.arrowUp,    cls: 'small', flex: 2, onTap: () => kbSendBytes([0x1b, 0x5b, 0x41]) }),
        makeKey({ icon: KB_ICONS.arrowDown,  cls: 'small', flex: 2, onTap: () => kbSendBytes([0x1b, 0x5b, 0x42]) }),
        makeKey({ icon: KB_ICONS.arrowLeft,  cls: 'small', flex: 2, onTap: () => kbSendBytes([0x1b, 0x5b, 0x44]) }),
        makeKey({ icon: KB_ICONS.arrowRight, cls: 'small', flex: 2, onTap: () => kbSendBytes([0x1b, 0x5b, 0x43]) }),
        makeKey({ icon: KB_ICONS.mic, cls: 'small accent', flex: 3, onTap: openVoiceSheet }),
      );

      if (KB.layer === 'letters') {
        KB_R1.forEach((c) => r1.append(makeKey({ label: dispLetter(c), flex: 1, onTap: () => kbSendStr(c) })));
        r2.append(makePad(0.5));
        KB_R2.forEach((c) => r2.append(makeKey({ label: dispLetter(c), flex: 1, onTap: () => kbSendStr(c) })));
        r2.append(makePad(0.5));
        // Row 3: shift, letters, delete
        r3.append(makeKey({
          icon: KB.capsLock ? KB_ICONS.arrowUpDouble : KB_ICONS.arrowUp,
          cls: 'small' + ((KB.shift || KB.capsLock) ? ' selected' : ''),
          flex: 1.6,
          onTap: () => {
            if (KB.shift) { KB.shift = false; KB.capsLock = !KB.capsLock; }
            else { KB.shift = true; }
            renderKeyboard();
          },
        }));
        KB_R3.forEach((c) => r3.append(makeKey({ label: dispLetter(c), flex: 1, onTap: () => kbSendStr(c) })));
        r3.append(makeKey({ icon: KB_ICONS.del, cls: 'small', flex: 1.6, onTap: () => kbSendBytes([0x7f]) }));
      } else {
        KB_S1.forEach((c) => r1.append(makeKey({ label: c, cls: 'small', flex: 1, onTap: () => kbSendStr(c) })));
        r2.append(makePad(0.3));
        KB_S2.forEach((c) => r2.append(makeKey({ label: c, cls: 'small', flex: 1, onTap: () => kbSendStr(c) })));
        r2.append(makePad(0.3));
        // Row 3: spacer label, more symbols, delete
        r3.append(makeKey({ label: '#+=', cls: 'small', flex: 1.6, onTap: () => {} }));
        KB_S3.forEach((c) => r3.append(makeKey({ label: c, cls: 'small', flex: 1, onTap: () => kbSendStr(c) })));
        r3.append(makeKey({ icon: KB_ICONS.del, cls: 'small', flex: 1.6, onTap: () => kbSendBytes([0x7f]) }));
      }

      // Bottom row: layer toggle, space, return
      bot.append(
        makeKey({ label: KB.layer === 'letters' ? '123' : 'ABC', cls: 'small', flex: 1.6,
                  onTap: () => { KB.layer = KB.layer === 'letters' ? 'symbols' : 'letters'; renderKeyboard(); } }),
        makeKey({ label: '', flex: 6, onTap: () => kbSendStr(' ') }),
        makeKey({ label: 'return', cls: 'small', flex: 2, onTap: () => kbSendBytes([0x0d]) }),
      );
    }
    renderKeyboard();
    // Keyboard rows are populated dynamically; rerun fit so xterm sizes
    // against the actual remaining height, not the empty initial panel.
    requestAnimationFrame(refitTerm);

    // ─── Sessions ───────────────────────────────────────────────────────

    function renderChips() {
      const c = $('chips');
      c.innerHTML = '';
      for (const [id, s] of sessions) {
        const chip = document.createElement('span');
        const live = s.ws.readyState === 1;
        chip.className = 'chip' + (id === activeSessionId ? ' active' : '') + (live ? ' live-on' : '');
        const dot = document.createElement('span');
        dot.className = 'live';
        chip.appendChild(dot);
        const label = document.createElement('span');
        label.textContent = s.agent + ' · ' + id.slice(0, 4);
        chip.appendChild(label);
        const x = document.createElement('span');
        x.className = 'x';
        x.textContent = '×';
        x.onclick = (ev) => { ev.stopPropagation(); closeSession(id); };
        chip.appendChild(x);
        chip.onclick = () => switchTo(id);
        c.appendChild(chip);
      }
    }

    function updateButtons() {
      $('close').disabled = !activeSessionId;
    }

    /**
     * Switch the visible terminal to another session. We replay the saved
     * byte buffer so output that arrived while this session was in the
     * background is visible — without that, the terminal would look empty
     * after a switch. If the WebSocket has been closed (idle timeout, network
     * blip), reattach instead — the daemon reuses the live PTY for this
     * session_id if one still exists, otherwise spawns a fresh one.
     */
    function switchTo(id) {
      if (!sessions.has(id)) return;
      const s = sessions.get(id);
      if (s.ws.readyState === WebSocket.CLOSED || s.ws.readyState === WebSocket.CLOSING) {
        attachSession(id, s.agent, /* fresh */ false);
        return;
      }
      activeSessionId = id;
      term.reset();
      // Replay buffered output so the user sees what the session looked like
      // when they last had it open.
      let any = false;
      if (s.buffer && s.buffer.length) {
        for (const chunk of s.buffer) { term.write(chunk); any = true; }
      }
      if (!any) {
        term.writeln('\\x1b[2m── ' + s.agent + ' (' + id.slice(0,8) + ') ──\\x1b[0m');
      }
      renderChips();
      updateButtons();
      // SIGWINCH so TUIs (vim, htop, …) redraw to current viewport size.
      try { s.ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch {}
    }

    function closeSession(id) {
      const s = sessions.get(id);
      if (!s) return;
      try { s.ws.send(JSON.stringify({ type: 'session-close' })); } catch {}
      try { s.ws.close(1000, 'user-close'); } catch {}
      sessions.delete(id);
      persistSessions();
      if (activeSessionId === id) {
        activeSessionId = sessions.keys().next().value || null;
        if (activeSessionId) switchTo(activeSessionId);
        else { term.reset(); term.writeln('\\x1b[2mNo active sessions. Tap New.\\x1b[0m'); }
      }
      renderChips();
      updateButtons();
    }

    function closeActive() {
      if (activeSessionId) closeSession(activeSessionId);
    }

    function openNewSession(agent) {
      if (!pairing) { showModal(); return; }
      const id = uuidV4();
      attachSession(id, agent, /* fresh */ true);
    }

    /** Cap the per-session output buffer so memory stays bounded on long-lived
     *  sessions. 256 KiB is plenty of scrollback for a screenful of TUI/agent
     *  output. Older chunks are dropped FIFO. */
    const SESSION_BUFFER_MAX = 256 * 1024;
    function appendBuffer(s, bytes) {
      s.buffer.push(bytes);
      s.bufferBytes += bytes.length;
      while (s.bufferBytes > SESSION_BUFFER_MAX && s.buffer.length > 1) {
        const dropped = s.buffer.shift();
        s.bufferBytes -= dropped.length;
      }
    }

    function attachSession(id, agent, fresh) {
      // CSO #3: never put the bearer in the URL. Browsers can pass
      // subprotocols, which travel in the Sec-WebSocket-Protocol header and
      // are NOT logged in CF Worker URL/query-string log paths.
      const wsUrl = pairing.relayUrl.replace(/^http/, 'ws')
        + '/phone/connect/' + pairing.deviceId
        + '?phone_id=' + encodeURIComponent(pairing.phoneId)
        + '&session_id=' + id;
      const ws = new WebSocket(wsUrl, ['loopsy.bearer.' + pairing.phoneSecret]);
      ws.binaryType = 'arraybuffer';

      // If reattaching, preserve the existing byte buffer so the user sees
      // their previous output continue from where it left off rather than
      // starting from a blank screen.
      const prev = sessions.get(id);
      if (prev && prev.ws && prev.ws !== ws) {
        try { prev.ws.close(1000, 'reattach'); } catch {}
      }
      const buffer = (prev && prev.buffer) ? prev.buffer : [];
      const bufferBytes = (prev && prev.bufferBytes) ? prev.bufferBytes : 0;
      const s = { agent, ws, lastSeen: Date.now(), buffer, bufferBytes };
      sessions.set(id, s);
      activeSessionId = id;
      term.reset();
      // Replay any buffered output before showing the new banner.
      if (s.buffer.length) {
        for (const chunk of s.buffer) term.write(chunk);
        term.writeln('\\x1b[2m── ' + (fresh ? 'opening' : 'reattaching') + ' ' + agent + ' (' + id.slice(0,8) + ') ──\\x1b[0m');
      } else {
        term.writeln('\\x1b[2m── ' + (fresh ? 'opening' : 'reattaching') + ' ' + agent + ' (' + id.slice(0,8) + ') ──\\x1b[0m');
      }
      renderChips();
      updateButtons();
      setStatus('connecting...');

      ws.addEventListener('open', () => {
        setStatus('connected', 'ok');
        const cols = term.cols, rows = term.rows;
        if (fresh) {
          ws.send(JSON.stringify({ type: 'session-open', agent, cols, rows }));
        } else {
          // SIGWINCH the daemon's PTY so it redraws to our current viewport.
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
        persistSessions();
        renderChips();
      });
      ws.addEventListener('message', (e) => {
        if (typeof e.data === 'string') {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'device-disconnected') term.writeln('\\r\\n\\x1b[33m⚠ device disconnected\\x1b[0m');
          } catch {}
          return;
        }
        const bytes = new Uint8Array(e.data);
        // Buffer ALWAYS — even when this session is in the background — so
        // switching to it later replays what arrived in the meantime.
        appendBuffer(s, bytes);
        if (id === activeSessionId) term.write(bytes);
      });
      ws.addEventListener('close', (e) => {
        s.lastSeen = Date.now();
        if (id === activeSessionId) setStatus('closed (' + e.code + ')');
        renderChips();
      });
      ws.addEventListener('error', () => {
        if (id === activeSessionId) setStatus('error', 'err');
      });
    }

    // ─── PTY ↔ xterm wiring ────────────────────────────────────────────

    term.onData((data) => {
      const s = activeSessionId ? sessions.get(activeSessionId) : null;
      if (!s || s.ws.readyState !== 1) return;
      s.ws.send(new TextEncoder().encode(data));
    });
    term.onResize(({ cols, rows }) => {
      const s = activeSessionId ? sessions.get(activeSessionId) : null;
      if (!s || s.ws.readyState !== 1) return;
      s.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    // ─── Voice / dictation sheet (Web Speech API) ──────────────────────
    /*
     * Mirrors the Flutter terminal_screen voice sheet: speech recognition
     * feeds a textarea, but if the user manually edits, we stop overwriting
     * with new speech results so their edits stick. On Send, the text is
     * shipped to the active PTY as bytes (with a trailing CR).
     */
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    let voiceRecog = null;
    let voiceListening = false;
    let voiceUserEdited = false;
    let voiceLastSpeech = '';

    function setVoiceState(state) {
      // state: 'idle' | 'listening' | 'edited'
      const header = $('voice-header');
      const icon = $('voice-icon');
      const title = $('voice-title');
      const hint = $('voice-hint');
      const toggleBtn = $('voice-toggle');
      const toggleLabel = $('voice-toggle-label');
      header.classList.toggle('listening', state === 'listening');
      if (state === 'listening') {
        icon.innerHTML = ${JSON.stringify(ICONS.mic)};
        title.textContent = 'Listening… tap text to edit';
        hint.textContent = 'Tip: tap the text to edit — listening pauses on tap.';
        toggleBtn.classList.add('danger');
        toggleBtn.innerHTML = ${JSON.stringify(ICONS.stopCircle)} + '<span>Stop</span>';
      } else {
        icon.innerHTML = ${JSON.stringify(ICONS.micOff)};
        toggleBtn.classList.remove('danger');
        toggleBtn.innerHTML = ${JSON.stringify(ICONS.mic)} + '<span>Listen</span>';
        if (state === 'edited') {
          title.textContent = 'Edited — review and send';
          hint.textContent = 'Edit freely. Tap the mic to dictate again.';
        } else {
          title.textContent = 'Tap mic to start';
          hint.textContent = 'Edit freely. Tap the mic to dictate again.';
        }
      }
      $('voice-send').disabled = !$('voice-text').value.trim();
    }

    function startListening() {
      if (!voiceRecog) return;
      voiceUserEdited = false;
      try { voiceRecog.start(); voiceListening = true; setVoiceState('listening'); }
      catch { voiceListening = false; setVoiceState('idle'); }
    }
    function stopListening() {
      if (!voiceRecog) return;
      try { voiceRecog.stop(); } catch {}
      voiceListening = false;
      setVoiceState(voiceUserEdited ? 'edited' : 'idle');
    }

    if (SpeechRecognition) {
      voiceRecog = new SpeechRecognition();
      voiceRecog.continuous = true;
      voiceRecog.interimResults = true;
      voiceRecog.lang = navigator.language || 'en-US';
      voiceRecog.onresult = (e) => {
        if (voiceUserEdited) return;  // stop overwriting once the user edits
        let combined = '';
        for (let i = 0; i < e.results.length; i++) combined += e.results[i][0].transcript;
        voiceLastSpeech = combined.trim();
        const ta = $('voice-text');
        ta.value = voiceLastSpeech;
        $('voice-send').disabled = !ta.value.trim();
      };
      voiceRecog.onerror = () => { voiceListening = false; setVoiceState(voiceUserEdited ? 'edited' : 'idle'); };
      voiceRecog.onend = () => { voiceListening = false; setVoiceState(voiceUserEdited ? 'edited' : 'idle'); };
    }

    function openVoiceSheet() {
      if (!SpeechRecognition) {
        term.writeln('\\r\\n\\x1b[33m⚠ speech recognition not supported in this browser\\x1b[0m');
        return;
      }
      const ta = $('voice-text');
      ta.value = '';
      voiceLastSpeech = '';
      voiceUserEdited = false;
      $('voice-send').disabled = true;
      $('voice-sheet').classList.remove('hidden');
      setVoiceState('idle');
      // Auto-start listening when the sheet opens.
      setTimeout(startListening, 60);
    }
    function closeVoiceSheet() {
      stopListening();
      $('voice-sheet').classList.add('hidden');
    }
    $('voice-toggle').onclick = () => { if (voiceListening) stopListening(); else startListening(); };
    $('voice-cancel').onclick = closeVoiceSheet;
    $('voice-clear').onclick  = () => {
      $('voice-text').value = '';
      voiceLastSpeech = '';
      voiceUserEdited = false;
      $('voice-send').disabled = true;
      setVoiceState(voiceListening ? 'listening' : 'idle');
    };
    $('voice-send').onclick   = () => {
      const txt = $('voice-text').value;
      if (!txt.trim()) return;
      stopListening();
      kbSendBytes(Array.from(new TextEncoder().encode(txt + '\\r')));
      closeVoiceSheet();
    };
    $('voice-text').addEventListener('input', () => {
      const v = $('voice-text').value;
      if (v !== voiceLastSpeech) {
        voiceUserEdited = true;
        if (voiceListening) stopListening();
        else setVoiceState('edited');
      }
      $('voice-send').disabled = !v.trim();
    });
    $('voice-text').addEventListener('focus', () => {
      // Tapping the text pauses recognition (Flutter parity).
      if (voiceListening) stopListening();
    });

    // ─── Soft-keyboard / viewport handling ─────────────────────────────
    function handleResize() { try { fit.fit(); } catch {} }
    window.addEventListener('resize', handleResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleResize);
    }

    // ─── Kickoff ────────────────────────────────────────────────────────
    (async () => {
      pairing = loadPairing();
      const hash = window.location.hash.replace(/^#/, '');
      if (hash) {
        const parsed = parsePairUrl(decodeURIComponent(hash));
        if (parsed) {
          if (relayOriginMismatch(parsed)) {
            // Same reason as above — redirect to the relay's own /app so the
            // pair POST and subsequent WSS run same-origin.
            window.location.replace(buildPairLink(parsed));
            return;
          }
          // The hash gave us a valid link. Strip it from the URL so a refresh
          // doesn't try to redeem an already-consumed token, then jump
          // straight to the SAS step inside the modal.
          history.replaceState(null, '', window.location.pathname);
          showModal();
          goStepSas(parsed);
          return;
        } else {
          // Hash was present but unparseable — keep going to the empty modal
          // so the user can paste the right link. Surface the issue inline.
          history.replaceState(null, '', window.location.pathname);
          showModal();
          showLinkErr('The link in this URL did not parse. Re-run "loopsy mobile pair" and try again.');
          return;
        }
      }
      if (!pairing) { showModal(); return; }
      setStatus('paired', 'ok');
      const stored = loadSessions();
      if (stored.length === 0) {
        term.writeln('\\x1b[32m✓\\x1b[0m paired with device \\x1b[1m' + pairing.deviceId.slice(0, 8) + '\\x1b[0m…');
        // Auto-open a shell so taps on the keyboard go somewhere. Saved
        // pairing + zero saved sessions usually means a fresh pair on a
        // device that already has a paired record (e.g., re-opening /app).
        try { openNewSession($('agent').value || 'shell'); } catch {}
      } else {
        term.writeln('\\x1b[2mReattaching ' + stored.length + ' session(s)...\\x1b[0m');
        for (const meta of stored) {
          attachSession(meta.id, meta.agent, /* fresh */ false);
        }
      }
    })();
  </script>
</body>
</html>`;
