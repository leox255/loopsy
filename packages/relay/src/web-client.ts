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
    /* ── Compose ───────────────────────────────────────────────────────── */
    .compose {
      display: flex; align-items: flex-end; gap: 8px;
      padding: 10px 14px;
      background: var(--surface);
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }
    .compose textarea {
      flex: 1; min-height: 38px; max-height: 96px;
      padding: 9px 12px;
      background: var(--surface-alt); color: var(--fg);
      border: 1px solid var(--border);
      border-radius: var(--radius-button);
      font-family: var(--font-mono);
      font-size: 14px;
      resize: none;
      line-height: 1.4;
    }
    .compose textarea:focus { outline: none; border-color: var(--accent); }
    .compose .icon-btn.recording { background: var(--bad); border-color: var(--bad); color: white; }
    .compose .icon-btn.send { background: var(--accent); border-color: var(--accent); color: var(--bg); }
    .compose .icon-btn.send:hover { background: #8eb0fa; }
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

  <div class="compose">
    <button id="mic" class="icon-btn" title="Voice input" aria-label="Voice input">${ICONS.mic}</button>
    <textarea id="composeText" rows="1" placeholder="Type or dictate, Enter sends..."
              autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"></textarea>
    <button id="send" class="icon-btn send" aria-label="Send">${ICONS.send}</button>
  </div>

  <div id="modal" class="modal hidden">
    <div class="modal-card">
      <div class="modal-icon">${ICONS.loopArrow}</div>
      <h2 id="modal-title">Pair your phone</h2>
      <p id="modal-body">Run <code style="font-family:var(--font-mono);background:var(--surface-alt);padding:1px 5px;border-radius:4px">loopsy mobile pair</code> on your Mac and paste the URL below.</p>
      <input id="modal-input" type="text" placeholder="loopsy://pair?u=...&t=..." autocomplete="off" autocapitalize="off" autocorrect="off" />
      <div class="modal-actions">
        <button id="modal-ok" class="primary">Pair</button>
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
    fit.fit();
    term.writeln('\\x1b[2m${BRAND_NAME} web client.\\x1b[0m Pair your phone or restore a saved pairing.');

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
      try {
        const cleaned = input.replace(/^loopsy:\\/\\//, 'https://');
        const u = new URL(cleaned);
        const token = u.searchParams.get('t');
        const relayUrl = decodeURIComponent(u.searchParams.get('u') || '');
        if (!token || !relayUrl) return null;
        return { token, relayUrl };
      } catch {
        return null;
      }
    }

    async function redeem(parsed) {
      // CSO #14: always prompt for the 4-digit verification code shown on the
      // laptop. Without it the relay rejects the redeem.
      const sas = window.prompt('Enter the 4-digit code shown on your laptop:') || '';
      if (!sas) throw new Error('Verification code required');
      setStatus('redeeming...');
      const r = await fetch(parsed.relayUrl + '/pair/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: parsed.token, sas: sas.trim(), label: navigator.userAgent.slice(0, 80) }),
      });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error('Pair failed: ' + r.status + ' ' + txt);
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
    }

    function showModal() { $('modal').classList.remove('hidden'); $('modal-input').focus(); }
    function hideModal() { $('modal').classList.add('hidden'); }

    $('modal-ok').onclick = async () => {
      const v = $('modal-input').value.trim();
      const parsed = parsePairUrl(v);
      if (!parsed) {
        alert('Could not parse pair URL. Expected loopsy://pair?u=...&t=...');
        return;
      }
      hideModal();
      try { await redeem(parsed); } catch (e) {
        setStatus('error', 'err');
        term.writeln('\\r\\n\\x1b[31m✗\\x1b[0m ' + e.message);
        showModal();
      }
    };

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
    $('send').onclick = () => sendCompose();
    $('composeText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendCompose();
      }
    });

    function sendCompose() {
      const t = $('composeText');
      const text = t.value;
      if (!text) return;
      const s = activeSessionId ? sessions.get(activeSessionId) : null;
      if (!s || s.ws.readyState !== 1) {
        term.writeln('\\r\\n\\x1b[33m⚠\\x1b[0m no active session — tap New');
        return;
      }
      s.ws.send(new TextEncoder().encode(text + '\\r'));
      t.value = '';
      t.style.height = 'auto';
    }

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

    function switchTo(id) {
      if (!sessions.has(id)) return;
      activeSessionId = id;
      term.reset();
      term.writeln('\\x1b[2m── ' + sessions.get(id).agent + ' (' + id.slice(0,8) + ') ──\\x1b[0m');
      renderChips();
      updateButtons();
      const s = sessions.get(id);
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
      const s = { agent, ws, lastSeen: Date.now() };
      sessions.set(id, s);
      activeSessionId = id;
      term.reset();
      term.writeln('\\x1b[2m── ' + (fresh ? 'opening' : 'reattaching') + ' ' + agent + ' (' + id.slice(0,8) + ') ──\\x1b[0m');
      renderChips();
      updateButtons();
      setStatus('connecting...');

      ws.addEventListener('open', () => {
        setStatus('connected', 'ok');
        const cols = term.cols, rows = term.rows;
        if (fresh) {
          ws.send(JSON.stringify({ type: 'session-open', agent, cols, rows }));
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
        if (id !== activeSessionId) return;
        term.write(new Uint8Array(e.data));
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

    // ─── Voice input (Web Speech API) ──────────────────────────────────
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recog = null;
    let recordingActive = false;
    if (SpeechRecognition) {
      recog = new SpeechRecognition();
      recog.continuous = false;
      recog.interimResults = true;
      recog.lang = navigator.language || 'en-US';
      recog.onresult = (e) => {
        let interim = '';
        let final = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) final += r[0].transcript;
          else interim += r[0].transcript;
        }
        const t = $('composeText');
        if (final) {
          t.value = (t.value + ' ' + final).trim();
        }
        if (interim) {
          t.placeholder = '🎙 ' + interim;
        }
      };
      recog.onerror = () => {
        recordingActive = false;
        $('mic').classList.remove('recording');
        $('composeText').placeholder = 'Type or dictate, Enter sends...';
      };
      recog.onend = () => {
        recordingActive = false;
        $('mic').classList.remove('recording');
        $('composeText').placeholder = 'Type or dictate, Enter sends...';
      };
    } else {
      $('mic').disabled = true;
      $('mic').title = 'Speech recognition not supported in this browser';
    }
    $('mic').onclick = () => {
      if (!recog) return;
      if (recordingActive) {
        try { recog.stop(); } catch {}
        return;
      }
      try {
        recordingActive = true;
        $('mic').classList.add('recording');
        $('composeText').placeholder = '🎙 listening...';
        recog.start();
      } catch {
        recordingActive = false;
        $('mic').classList.remove('recording');
      }
    };

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
          history.replaceState(null, '', window.location.pathname);
          try { await redeem(parsed); } catch (e) {
            term.writeln('\\r\\n\\x1b[31m✗\\x1b[0m ' + e.message);
            showModal();
            return;
          }
        }
      }
      if (!pairing) { showModal(); return; }
      setStatus('paired', 'ok');
      const stored = loadSessions();
      if (stored.length === 0) {
        term.writeln('\\x1b[32m✓\\x1b[0m paired with device \\x1b[1m' + pairing.deviceId.slice(0, 8) + '\\x1b[0m…  Tap "New" to open a session.');
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
