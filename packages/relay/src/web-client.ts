/**
 * Inline HTML+JS web client for the Loopsy relay.
 *
 * Served at `/app` on the Worker. Loads xterm.js from a CDN, redeems any
 * pair token in the URL fragment, then opens a WebSocket session. Designed
 * to run on iOS Safari + Android Chrome with no install.
 *
 * Features:
 *   - QR-pair via URL fragment, persisted in localStorage
 *   - Multiple persistent sessions (chip switcher across chats)
 *   - Voice input via Web Speech API (mic button → live dictation)
 *   - Compose box that sends text + Enter to the active session's PTY
 *   - Soft-keyboard-aware viewport using visualViewport API
 */

export const WEB_CLIENT_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <title>Loopsy</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css" />
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0d10;
      --fg: #e7eaee;
      --accent: #7aa2f7;
      --good: #9ece6a;
      --bad: #f7768e;
      --muted: #6b7280;
      --bar: #14171c;
      --border: #1f242b;
      --chip-bg: #1d2128;
      --chip-active: #2a3340;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0;
      width: 100%; height: 100dvh;
      background: var(--bg); color: var(--fg);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      overflow: hidden;
      overscroll-behavior: none;
    }
    body {
      display: flex; flex-direction: column;
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    }
    .bar {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px;
      background: var(--bar);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .bar select, .bar button, .bar input {
      background: var(--chip-bg); color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 7px 10px;
      font-size: 14px;
      font-family: inherit;
    }
    .bar button { cursor: pointer; }
    .bar button.primary { background: var(--accent); color: #0b0d10; border-color: var(--accent); font-weight: 600; }
    .bar button:disabled { opacity: 0.5; cursor: not-allowed; }
    .bar .spacer { flex: 1; }
    .bar .status {
      font-size: 12px; color: var(--muted);
      max-width: 30vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .bar .status.ok { color: var(--good); }
    .bar .status.err { color: var(--bad); }
    .bar .icon-btn {
      padding: 7px 9px; min-width: 36px;
    }
    /* Sessions chip row */
    .chips {
      display: flex; gap: 6px;
      padding: 6px 10px;
      background: #0f1217;
      border-bottom: 1px solid var(--border);
      overflow-x: auto;
      flex-shrink: 0;
    }
    .chips:empty { display: none; }
    .chip {
      flex-shrink: 0;
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 9px;
      background: var(--chip-bg);
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .chip.active { background: var(--chip-active); border-color: var(--accent); color: #fff; }
    .chip .x { color: var(--muted); margin-left: 4px; }
    .chip .x:hover { color: var(--bad); }
    .chip .live { width: 6px; height: 6px; border-radius: 50%; background: var(--good); }
    #term {
      flex: 1; min-height: 0;
      padding: 4px 6px;
    }
    /* Compose row */
    .compose {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 10px;
      background: var(--bar);
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }
    .compose textarea {
      flex: 1; min-height: 36px; max-height: 96px;
      padding: 8px 10px;
      background: var(--chip-bg); color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 8px;
      font-family: ui-monospace, SF Mono, Menlo, Monaco, monospace;
      font-size: 14px;
      resize: none;
    }
    .compose button {
      background: var(--chip-bg); color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 10px; min-width: 40px;
      cursor: pointer;
    }
    .compose button.primary { background: var(--accent); color: #0b0d10; border-color: var(--accent); font-weight: 600; }
    .compose button.recording { background: var(--bad); border-color: var(--bad); color: #fff; }
    .modal {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.85);
      display: flex; align-items: center; justify-content: center;
      z-index: 100; padding: 24px;
    }
    .modal.hidden { display: none; }
    .modal-inner {
      background: #14171c; border: 1px solid var(--border); border-radius: 12px;
      padding: 20px; max-width: 420px; width: 100%;
    }
    .modal h2 { margin: 0 0 12px; font-size: 18px; }
    .modal p { margin: 0 0 12px; color: var(--muted); font-size: 14px; line-height: 1.5; }
    .modal input { width: 100%; padding: 10px; font-size: 14px; background: var(--chip-bg); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 12px; }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .modal-actions button { padding: 9px 14px; }
    /* iOS Safari focus zoom prevention */
    @supports (-webkit-touch-callout: none) {
      input, select, textarea { font-size: 16px !important; }
    }
  </style>
</head>
<body>
  <div class="bar">
    <select id="agent" aria-label="Agent">
      <option value="shell">shell</option>
      <option value="claude">claude</option>
      <option value="gemini">gemini</option>
      <option value="codex">codex</option>
    </select>
    <button id="open" class="primary">New</button>
    <button id="close" class="icon-btn" disabled aria-label="Close session">⏻</button>
    <div class="spacer"></div>
    <span id="status" class="status">disconnected</span>
    <button id="reset" class="icon-btn" title="Forget pairing" aria-label="Reset">⟲</button>
  </div>
  <div id="chips" class="chips"></div>
  <div id="term"></div>
  <div class="compose">
    <button id="mic" class="icon-btn" title="Voice input" aria-label="Voice input">🎤</button>
    <textarea id="composeText" rows="1" placeholder="Type or dictate, Enter sends..."
              autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"></textarea>
    <button id="send" class="primary" aria-label="Send">▶</button>
  </div>

  <div id="modal" class="modal hidden">
    <div class="modal-inner">
      <h2 id="modal-title">Pair your phone</h2>
      <p id="modal-body">Enter the pair URL from <code>loopsy mobile pair</code>.</p>
      <input id="modal-input" type="text" placeholder="loopsy://pair?u=...&t=..." autocomplete="off" autocapitalize="off" autocorrect="off" />
      <div class="modal-actions">
        <button id="modal-ok" class="primary">Pair</button>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
  <script>
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
      el.textContent = text;
      el.className = 'status' + (kind ? ' ' + kind : '');
    };

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SF Mono, Menlo, Monaco, monospace',
      fontSize: 13,
      theme: { background: '#0b0d10', foreground: '#e7eaee', cursor: '#7aa2f7' },
      convertEol: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open($('term'));
    fit.fit();
    term.writeln('Loopsy web client. Pair your phone or restore a saved pairing.');

    // ─── State ─────────────────────────────────────────────────────────
    let pairing = null;
    /** Map<sessionId, { agent, ws, lastSeen }> */
    const sessions = new Map();
    /** Persistent metadata mirror written to localStorage. */
    let activeSessionId = null;

    function loadPairing() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
    }
    function savePairing(p) { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); }
    function clearPairing() { localStorage.removeItem(STORAGE_KEY); }

    function loadSessions() {
      try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]'); } catch { return []; }
    }
    function saveSessions(list) {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
    }
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
      setStatus('redeeming...');
      const r = await fetch(parsed.relayUrl + '/pair/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: parsed.token, label: navigator.userAgent.slice(0, 80) }),
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
      term.writeln('\\r\\n[paired with device ' + p.deviceId.slice(0, 8) + '…]');
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
        term.writeln('\\r\\n[error] ' + e.message);
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
        term.writeln('\\r\\n[no active session — tap New]');
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
        chip.className = 'chip' + (id === activeSessionId ? ' active' : '');
        const dot = document.createElement('span');
        dot.className = 'live';
        dot.style.background = s.ws.readyState === 1 ? 'var(--good)' : 'var(--muted)';
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
      term.writeln('--- switched to ' + sessions.get(id).agent + ' (' + id.slice(0,8) + ') ---');
      renderChips();
      updateButtons();
      // Trigger a redraw by sending a no-op resize so the laptop re-emits
      // current screen state via PTY's own redraw (some TUIs respond to SIGWINCH).
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
        else { term.reset(); term.writeln('No active sessions. Tap New.'); }
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
      const wsUrl = pairing.relayUrl.replace(/^http/, 'ws')
        + '/phone/connect/' + pairing.deviceId
        + '?phone_id=' + encodeURIComponent(pairing.phoneId)
        + '&session_id=' + id
        + '&token=' + encodeURIComponent(pairing.phoneSecret);
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      const s = { agent, ws, lastSeen: Date.now() };
      sessions.set(id, s);
      activeSessionId = id;
      term.reset();
      term.writeln('--- ' + (fresh ? 'opening' : 'reattaching') + ' ' + agent + ' (' + id.slice(0,8) + ') ---');
      renderChips();
      updateButtons();
      setStatus('connecting...');

      ws.addEventListener('open', () => {
        setStatus('connected', 'ok');
        const cols = term.cols, rows = term.rows;
        if (fresh) {
          ws.send(JSON.stringify({ type: 'session-open', agent, cols, rows }));
        }
        // For reattach, the daemon will replay scrollback automatically when
        // the relay forwards its session-attach control frame.
        persistSessions();
        renderChips();
      });
      ws.addEventListener('message', (e) => {
        if (typeof e.data === 'string') {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'device-disconnected') term.writeln('\\r\\n[device disconnected]');
            // session-ready, session-attach, session-detach all ignorable on phone
          } catch {}
          return;
        }
        if (id !== activeSessionId) return; // background sessions still consume buffer on daemon
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
        // Show interim above the existing user text via placeholder hack.
        if (final) {
          t.value = (t.value + ' ' + final).trim();
        }
        if (interim) {
          t.placeholder = '🎙 ' + interim;
        }
      };
      recog.onerror = (e) => {
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
      } catch (e) {
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
            term.writeln('\\r\\n[error] ' + e.message);
            showModal();
            return;
          }
        }
      }
      if (!pairing) { showModal(); return; }
      setStatus('paired', 'ok');
      // Reattach known sessions (PTYs that may still be alive on the daemon).
      const stored = loadSessions();
      if (stored.length === 0) {
        term.writeln('Paired with device ' + pairing.deviceId.slice(0, 8) + '…  Tap "New" to open a session.');
      } else {
        term.writeln('Reattaching ' + stored.length + ' session(s)...');
        for (const meta of stored) {
          attachSession(meta.id, meta.agent, /* fresh */ false);
        }
      }
    })();
  </script>
</body>
</html>`;
