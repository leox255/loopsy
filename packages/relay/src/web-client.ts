/**
 * Inline HTML+JS web client for the Loopsy relay.
 *
 * Served at `/app` on the Worker. Loads xterm.js from a CDN, redeems any
 * pair token in the URL fragment, then opens a WebSocket session. Designed
 * to run on iOS Safari + Android Chrome with no install.
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
      --muted: #6b7280;
      --bar: #14171c;
      --border: #1f242b;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0;
      width: 100%; height: 100%;
      background: var(--bg); color: var(--fg);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      overflow: hidden;
      overscroll-behavior: none;
    }
    body { display: flex; flex-direction: column; padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }
    .bar {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px;
      background: var(--bar);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .bar select, .bar button, .bar input {
      background: #1d2128; color: var(--fg);
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
    .bar .status.ok { color: #9ece6a; }
    .bar .status.err { color: #f7768e; }
    #term {
      flex: 1; min-height: 0;
      padding: 4px 6px;
    }
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
    .modal input { width: 100%; padding: 10px; font-size: 14px; background: #1d2128; color: var(--fg); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 12px; }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .modal-actions button { padding: 9px 14px; }
    /* iOS Safari focus zoom prevention */
    @supports (-webkit-touch-callout: none) {
      input, select { font-size: 16px !important; }
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
    <button id="open" class="primary">Open</button>
    <button id="close" disabled>Close</button>
    <div class="spacer"></div>
    <span id="status" class="status">disconnected</span>
    <button id="reset" title="Forget pairing">⟲</button>
  </div>
  <div id="term"></div>

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

    let pairing = null;
    let ws = null;
    let sessionId = null;
    let connecting = false;

    function loadPairing() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
    }
    function savePairing(p) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    }
    function clearPairing() {
      localStorage.removeItem(STORAGE_KEY);
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
      // Accept either 'loopsy://pair?u=...&t=...' or a full URL with query.
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
      const r = await fetch(\`\${parsed.relayUrl}/pair/redeem\`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: parsed.token, label: navigator.userAgent.slice(0, 80) }),
      });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(\`Pair failed: \${r.status} \${txt}\`);
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
      term.writeln(\`\\r\\n[paired with device \${p.deviceId.slice(0, 8)}…]\`);
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
      try {
        await redeem(parsed);
      } catch (e) {
        setStatus('error', 'err');
        term.writeln(\`\\r\\n[error] \${e.message}\`);
        showModal();
      }
    };

    $('reset').onclick = () => {
      if (!confirm('Forget this pairing?')) return;
      clearPairing();
      pairing = null;
      if (ws) try { ws.close(1000, 'reset'); } catch {}
      term.reset();
      setStatus('disconnected');
      showModal();
    };

    $('open').onclick = () => connect();
    $('close').onclick = () => {
      if (ws) try { ws.close(1000, 'user-close'); } catch {}
    };

    function connect() {
      if (!pairing) { showModal(); return; }
      if (connecting || (ws && ws.readyState !== 3)) return;
      connecting = true;
      sessionId = uuidV4();
      const wsUrl = pairing.relayUrl.replace(/^http/, 'ws')
        + \`/phone/connect/\${pairing.deviceId}?phone_id=\${encodeURIComponent(pairing.phoneId)}&session_id=\${sessionId}&token=\${encodeURIComponent(pairing.phoneSecret)}\`;
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      setStatus('connecting...');
      $('open').disabled = true;
      $('close').disabled = false;

      ws.addEventListener('open', () => {
        connecting = false;
        setStatus('connected', 'ok');
        const cols = term.cols, rows = term.rows;
        ws.send(JSON.stringify({
          type: 'session-open',
          agent: $('agent').value,
          cols, rows,
        }));
      });
      ws.addEventListener('message', (e) => {
        if (typeof e.data === 'string') {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'session-ready') return;
            if (msg.type === 'device-disconnected') {
              term.writeln('\\r\\n[device disconnected]');
            }
          } catch {}
          return;
        }
        const buf = new Uint8Array(e.data);
        term.write(buf);
      });
      ws.addEventListener('close', (e) => {
        connecting = false;
        setStatus(\`closed (\${e.code})\`);
        $('open').disabled = false;
        $('close').disabled = true;
      });
      ws.addEventListener('error', () => {
        setStatus('error', 'err');
      });
    }

    term.onData((data) => {
      if (!ws || ws.readyState !== 1) return;
      ws.send(new TextEncoder().encode(data));
    });
    term.onResize(({ cols, rows }) => {
      if (!ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });
    window.addEventListener('resize', () => {
      try { fit.fit(); } catch {}
    });

    // Kickoff: parse #<token-url>, restore localStorage, or show modal.
    (async () => {
      pairing = loadPairing();
      const hash = window.location.hash.replace(/^#/, '');
      if (hash) {
        const parsed = parsePairUrl(decodeURIComponent(hash));
        if (parsed) {
          history.replaceState(null, '', window.location.pathname);
          try {
            await redeem(parsed);
          } catch (e) {
            term.writeln(\`\\r\\n[error] \${e.message}\`);
            showModal();
            return;
          }
        }
      }
      if (!pairing) {
        showModal();
        return;
      }
      setStatus('paired', 'ok');
      term.writeln(\`Paired with device \${pairing.deviceId.slice(0, 8)}…  Tap "Open" to start.\`);
    })();
  </script>
</body>
</html>`;
