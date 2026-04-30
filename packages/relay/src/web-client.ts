/**
 * Inline HTML+JS web client for the Loopsy relay.
 *
 * Served at `/app` on the Worker. Loads xterm.js from CDN, implements a
 * three-view router (#pair, #home, #session/<id>) that mirrors the Flutter
 * mobile app screen flow. All design tokens come from design.ts.
 *
 * JS module structure (single IIFE):
 *   Storage.*          — localStorage read/write for pairing, sessions, token
 *   Modal.*            — showLoopsyDialog / showLoopsySheet helpers (Promise-based)
 *   Router.*           — hash-based view router; calls mount/unmount on view objs
 *   RelayConn          — WebSocket wrapper; survives view transitions
 *   PairView           — #pair: redeem token from hash, persist pairing
 *   HomeView           — #home: paired-device card + sessions list
 *   SessionView        — #session/<id>: xterm.js terminal + compose + voice
 */

import { BRAND_NAME, FAVICON_LINKS, ICONS, TOKENS_CSS } from './design.js';

export const WEB_CLIENT_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="theme-color" content="#0B0D10" />
  <title>${BRAND_NAME}</title>
  ${FAVICON_LINKS}
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
    /* ── Shared topbar ────────────────────────────────────────────── */
    .topbar {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .topbar-title {
      font-weight: 600; font-size: 17px; letter-spacing: -0.2px;
      flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .brand-logo {
      width: 28px; height: 28px;
      display: grid; place-items: center;
      border-radius: 8px;
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%);
      color: white; flex-shrink: 0;
    }
    .brand-logo svg { width: 16px; height: 16px; }
    .icon-btn {
      display: inline-grid; place-items: center;
      width: 36px; height: 36px;
      background: var(--surface-alt);
      border: 1px solid var(--border);
      border-radius: var(--radius-button);
      color: var(--fg); cursor: pointer; padding: 0; flex-shrink: 0;
    }
    .icon-btn svg { width: 18px; height: 18px; }
    .icon-btn:hover { background: var(--border); }
    .icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .icon-btn.danger { color: var(--bad); }
    /* ── Status chip ──────────────────────────────────────────────── */
    .status-chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 10px;
      background: var(--surface-alt); border: 1px solid var(--border);
      border-radius: var(--radius-chip);
      font-size: 11px; color: var(--muted); font-weight: 500;
      max-width: 38vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .status-chip .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); flex-shrink: 0; }
    .status-chip.ok { color: var(--good); }
    .status-chip.ok .dot { background: var(--good); box-shadow: 0 0 6px var(--good); }
    .status-chip.err { color: var(--bad); }
    .status-chip.err .dot { background: var(--bad); }
    /* ── Agent icon badge ─────────────────────────────────────────── */
    .agent-badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 8px;
      background: var(--surface-alt);
      border-radius: 6px;
      font-family: var(--font-mono); font-size: 11px; color: var(--muted);
    }
    /* ── Scrollable content area ──────────────────────────────────── */
    #view {
      flex: 1; min-height: 0; overflow-y: auto;
      overscroll-behavior: contain;
    }
    /* ── Home view ────────────────────────────────────────────────── */
    .home-body {
      padding: 8px 16px 96px;
      display: flex; flex-direction: column; gap: 0;
    }
    /* Paired device card */
    .device-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-card);
      padding: 16px;
      margin-bottom: 24px;
    }
    .device-card-row {
      display: flex; align-items: center; gap: 12px;
    }
    .icon-tile {
      flex-shrink: 0;
      display: grid; place-items: center;
      border-radius: 10px;
      background: var(--surface-alt);
      border: 1px solid var(--border);
    }
    .icon-tile.sz36 { width: 36px; height: 36px; }
    .icon-tile.sz36 svg { width: 18px; height: 18px; }
    .icon-tile.sz40 { width: 40px; height: 40px; }
    .icon-tile.sz40 svg { width: 20px; height: 20px; }
    .icon-tile.accent { color: var(--accent); }
    .device-card-info { flex: 1; overflow: hidden; }
    .device-card-label { color: var(--muted); font-size: 12px; }
    .device-card-id {
      font-family: var(--font-mono); font-size: 12px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .device-card-url-row {
      display: flex; align-items: center; gap: 6px; margin-top: 10px;
      color: var(--muted); font-size: 11px; overflow: hidden;
    }
    .device-card-url-row svg { width: 14px; height: 14px; flex-shrink: 0; }
    .device-card-url-row span {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* Sessions section */
    .section-header {
      padding: 4px 4px 8px;
      font-size: 13px; font-weight: 600; color: var(--muted);
    }
    .empty-sessions {
      display: flex; flex-direction: column; align-items: center;
      gap: 12px; padding: 24px 0; color: var(--muted); text-align: center;
    }
    .empty-sessions svg { width: 36px; height: 36px; opacity: 0.5; }
    .empty-sessions p { margin: 0; font-size: 12px; }
    /* Session card */
    .session-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-card);
      margin-bottom: 10px;
      cursor: pointer;
      transition: background 120ms ease;
      overflow: hidden;
    }
    .session-card:hover { background: #1a1d23; }
    .session-card-inner {
      display: flex; align-items: flex-start; gap: 14px;
      padding: 14px;
    }
    .session-card-body { flex: 1; overflow: hidden; }
    .session-card-name {
      font-weight: 600; font-size: 15px;
      overflow: hidden; text-overflow: ellipsis;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    }
    .session-card-meta {
      display: flex; align-items: center; gap: 8px; margin-top: 4px;
      flex-wrap: wrap;
    }
    .session-id-mono { font-family: var(--font-mono); font-size: 11px; color: var(--muted); }
    .session-summary-text {
      font-size: 11px; color: var(--muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
    }
    /* FAB */
    .fab {
      position: fixed; bottom: calc(20px + env(safe-area-inset-bottom)); right: 20px;
      display: inline-flex; align-items: center; gap: 8px;
      padding: 14px 20px;
      background: var(--accent); color: var(--bg);
      border: none; border-radius: 14px;
      font-weight: 600; font-size: 15px; cursor: pointer;
      box-shadow: 0 4px 20px rgba(122,162,247,0.35);
      font-family: var(--font-sans);
      z-index: 10;
    }
    .fab svg { width: 18px; height: 18px; }
    .fab:hover { background: #8eb0fa; }
    /* ── Terminal view ────────────────────────────────────────────── */
    #term-wrap {
      flex: 1; min-height: 0;
      padding: 6px 10px;
      display: none;
    }
    #term-wrap.active { display: block; }
    .xterm-viewport { background: var(--bg) !important; }
    .xterm-viewport::-webkit-scrollbar { width: 6px; }
    .xterm-viewport::-webkit-scrollbar-thumb { background: var(--surface-alt); border-radius: 3px; }
    /* ── Session chips (terminal view) ───────────────────────────── */
    .chips {
      display: flex; gap: 6px;
      padding: 6px 14px 10px;
      overflow-x: auto; flex-shrink: 0;
      scrollbar-width: none;
    }
    .chips::-webkit-scrollbar { display: none; }
    .chips:empty { display: none; }
    .chip {
      flex-shrink: 0;
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 10px;
      background: var(--surface-alt); border: 1px solid var(--border);
      border-radius: var(--radius-chip);
      font-size: 12px; font-family: var(--font-mono);
      color: var(--fg); cursor: pointer; white-space: nowrap;
    }
    .chip:hover { background: var(--border); }
    .chip.active { border-color: var(--accent); background: rgba(122,162,247,0.12); }
    .chip .live { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
    .chip.live-on .live { background: var(--good); box-shadow: 0 0 4px var(--good); }
    /* ── Compose bar ──────────────────────────────────────────────── */
    .compose {
      display: flex; align-items: flex-end; gap: 8px;
      padding: 10px 14px;
      background: var(--surface); border-top: 1px solid var(--border);
      flex-shrink: 0;
    }
    .compose textarea {
      flex: 1; min-height: 38px; max-height: 96px;
      padding: 9px 12px;
      background: var(--surface-alt); color: var(--fg);
      border: 1px solid var(--border);
      border-radius: var(--radius-button);
      font-family: var(--font-mono); font-size: 14px;
      resize: none; line-height: 1.4;
    }
    .compose textarea:focus { outline: none; border-color: var(--accent); }
    .icon-btn.recording { background: var(--bad); border-color: var(--bad); color: white; }
    .icon-btn.send-btn { background: var(--accent); border-color: var(--accent); color: var(--bg); }
    .icon-btn.send-btn:hover { background: #8eb0fa; }
    /* ── Pair view ────────────────────────────────────────────────── */
    .pair-body {
      padding: 32px 20px 20px;
      display: flex; flex-direction: column; align-items: center; gap: 24px;
      max-width: 480px; margin: 0 auto;
    }
    .pair-hero {
      display: flex; flex-direction: column; align-items: center; gap: 14px;
      text-align: center;
    }
    .pair-hero-icon {
      width: 64px; height: 64px;
      display: grid; place-items: center;
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%);
      border-radius: 18px; color: white;
    }
    .pair-hero-icon svg { width: 32px; height: 32px; }
    .pair-hero h1 { margin: 0; font-size: 22px; font-weight: 700; }
    .pair-hero p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.5; max-width: 320px; }
    .pair-card {
      width: 100%;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--radius-card); padding: 20px;
    }
    .pair-card-label {
      font-size: 12px; font-weight: 600; color: var(--muted);
      text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 10px;
    }
    .pair-cmd {
      background: var(--surface-alt); border: 1px solid var(--border);
      border-radius: var(--radius-button);
      padding: 12px 14px;
      font-family: var(--font-mono); font-size: 14px;
      margin-bottom: 12px;
    }
    .pair-input {
      width: 100%;
      padding: 11px 12px;
      background: var(--surface-alt); color: var(--fg);
      border: 1px solid var(--border); border-radius: var(--radius-button);
      font-family: var(--font-mono); font-size: 14px;
      margin-bottom: 12px;
    }
    .pair-input:focus { outline: none; border-color: var(--accent); }
    .pair-error { color: var(--bad); font-size: 13px; margin-top: 8px; }
    .btn-primary {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 11px 18px;
      background: var(--accent); color: var(--bg);
      border: none; border-radius: var(--radius-button);
      font-weight: 600; font-size: 14px; cursor: pointer;
      font-family: var(--font-sans); width: 100%; justify-content: center;
    }
    .btn-primary svg { width: 16px; height: 16px; }
    .btn-primary:hover { background: #8eb0fa; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    /* ── Modal system ─────────────────────────────────────────────── */
    .modal-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.7);
      backdrop-filter: blur(6px);
      display: flex; align-items: center; justify-content: center;
      z-index: 200; padding: 20px;
    }
    .modal-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 20px; padding: 20px;
      max-width: 460px; width: 100%;
      max-height: calc(100dvh - 80px); overflow-y: auto;
    }
    .sheet-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.7);
      backdrop-filter: blur(6px);
      display: flex; align-items: flex-end; justify-content: center;
      z-index: 200; padding: 12px;
    }
    .sheet-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 20px; padding: 20px;
      max-width: 460px; width: 100%;
      max-height: 85dvh; overflow-y: auto;
      animation: slideUp 140ms ease;
    }
    @keyframes slideUp {
      from { transform: translateY(40px); opacity: 0; }
      to   { transform: translateY(0);    opacity: 1; }
    }
    .modal-icon {
      width: 44px; height: 44px;
      display: grid; place-items: center;
      background: var(--surface-alt); border: 1px solid var(--border);
      border-radius: 12px; color: var(--accent); margin-bottom: 14px;
    }
    .modal-icon svg { width: 22px; height: 22px; }
    .modal-title { margin: 0 0 6px; font-size: 18px; font-weight: 700; letter-spacing: -0.01em; }
    .modal-subtitle { margin: 0 0 16px; color: var(--muted); font-size: 13.5px; line-height: 1.45; }
    .modal-body { margin-bottom: 18px; }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
    /* modal action button variants */
    .mbtn {
      padding: 10px 16px; border-radius: var(--radius-button);
      font-weight: 600; font-size: 13px; cursor: pointer;
      font-family: var(--font-sans); border: 1px solid transparent;
      white-space: nowrap;
    }
    .mbtn-text { background: transparent; color: var(--muted); border-color: transparent; }
    .mbtn-text:hover { background: var(--surface-alt); }
    .mbtn-outlined { background: transparent; color: var(--fg); border-color: var(--border); }
    .mbtn-outlined:hover { background: var(--surface-alt); }
    .mbtn-primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
    .mbtn-primary:hover { background: #8eb0fa; }
    .mbtn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .mbtn-danger { background: var(--bad); color: #fff; border-color: var(--bad); }
    .mbtn-danger:hover { background: #f98da1; }
    /* modal input */
    .modal-input {
      width: 100%; padding: 11px 12px;
      background: var(--surface-alt); color: var(--fg);
      border: 1px solid var(--border); border-radius: var(--radius-button);
      font-family: var(--font-mono); font-size: 14px;
    }
    .modal-input:focus { outline: none; border-color: var(--accent); }
    .modal-input.pw-input { padding-right: 44px; }
    .pw-wrap { position: relative; }
    .pw-toggle {
      position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
      background: none; border: none; cursor: pointer;
      color: var(--muted); padding: 4px; display: grid; place-items: center;
    }
    .pw-toggle svg { width: 16px; height: 16px; }
    /* menu tiles */
    .menu-tile {
      display: flex; align-items: center; gap: 14px;
      padding: 12px 4px; border-radius: 12px; cursor: pointer;
    }
    .menu-tile:hover { background: var(--surface-alt); }
    .menu-tile-icon {
      width: 36px; height: 36px; flex-shrink: 0;
      display: grid; place-items: center;
      background: var(--surface-alt); border: 1px solid var(--border);
      border-radius: 10px;
    }
    .menu-tile-icon svg { width: 18px; height: 18px; }
    .menu-tile-body { flex: 1; }
    .menu-tile-title { font-size: 15px; font-weight: 600; }
    .menu-tile-sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
    /* code snippet in auto-approve dialog */
    .code-block {
      background: var(--surface-alt); border: 1px solid var(--border);
      border-radius: 8px; padding: 10px 12px;
      font-family: var(--font-mono); font-size: 12.5px; color: var(--fg);
      margin-bottom: 12px;
    }
    .warn-row {
      display: flex; align-items: flex-start; gap: 8px;
      color: var(--warn); font-size: 12.5px; line-height: 1.4;
    }
    .warn-row svg { width: 16px; height: 16px; flex-shrink: 0; margin-top: 1px; }
    /* helper text below modal inputs */
    .modal-helper { font-size: 12px; color: var(--muted); margin-top: 6px; }
    .modal-helper.bad { color: var(--bad); }
    /* iOS Safari focus zoom prevention */
    @supports (-webkit-touch-callout: none) {
      input, select, textarea { font-size: 16px !important; }
    }
  </style>
</head>
<body>
  <!-- topbar is rendered by each view into this slot -->
  <div id="topbar-slot"></div>
  <!-- chips strip: only visible in session view -->
  <div id="chips" class="chips" style="display:none"></div>
  <!-- main scrollable view area -->
  <div id="view"></div>
  <!-- xterm terminal node: lives outside #view so it can flex-fill properly -->
  <div id="term-wrap"></div>
  <!-- compose bar: only in session view -->
  <div id="compose-slot"></div>
  <!-- modal layer (managed by Modal.*) -->
  <div id="modal-layer"></div>

  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"
          integrity="sha384-xjfWUeCWdMtvpAb/SmM6lMzS6pQGcQa0loOl1d97j6Odw0vjK9nW3+dTb/bn/mwH"
          crossorigin="anonymous"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"
          integrity="sha384-dpjGwSSISUTz2taP54Bor7qkyMR20sSO9oe11UVYnGs2/YdUBf7HW30XKQx9PCzn"
          crossorigin="anonymous"></script>
  <script nonce="__CSP_NONCE__">
  'use strict';
  (function () {

  // ── CDN guard ────────────────────────────────────────────────────────────
  if (!window.Terminal || !window.FitAddon) {
    document.body.insertAdjacentHTML('afterbegin',
      '<div style="background:#f7768e;color:#fff;padding:10px 14px;font-family:monospace;position:fixed;top:0;left:0;right:0;z-index:999">' +
      'xterm failed to load from CDN. Check network and reload.</div>');
  }
  const Terminal = window.Terminal;
  const FitAddon = window.FitAddon && window.FitAddon.FitAddon;

  // ── Storage ──────────────────────────────────────────────────────────────
  // Keys mirror apps/mobile/lib/services/storage.dart exactly.
  const PAIRING_KEY  = 'loopsy.pairing.v1';
  const SESSIONS_KEY = 'loopsy.sessions.v1';
  const APPROVE_KEY  = 'loopsy.auto_approve.v1';

  const Storage = {
    readPairing() {
      try { return JSON.parse(localStorage.getItem(PAIRING_KEY) || 'null'); } catch { return null; }
    },
    writePairing(p) { localStorage.setItem(PAIRING_KEY, JSON.stringify(p)); },
    /** Also wipes sessions + approve token, mirrors Storage.deletePairing(). */
    deletePairing() {
      localStorage.removeItem(PAIRING_KEY);
      localStorage.removeItem(SESSIONS_KEY);
      localStorage.removeItem(APPROVE_KEY);
    },
    readSessions() {
      try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]'); } catch { return []; }
    },
    writeSessions(list) { localStorage.setItem(SESSIONS_KEY, JSON.stringify(list)); },
    updateSession(id, fn) {
      const list = Storage.readSessions().map(s => s.id === id ? fn(s) : s);
      Storage.writeSessions(list);
    },
    readApproveToken() { return localStorage.getItem(APPROVE_KEY) || null; },
    writeApproveToken(t) { localStorage.setItem(APPROVE_KEY, t); },
    deleteApproveToken() { localStorage.removeItem(APPROVE_KEY); },
  };

  // ── Utilities ────────────────────────────────────────────────────────────
  function uuidV4() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
  }

  function parsePairUrl(input) {
    // Accepts any of:
    //   loopsy://pair?u=<encoded relay>&t=<token>
    //   https://relay.example/app#loopsy%3A%2F%2Fpair%3Fu%3D...   (the form
    //     the CLI prints — what people actually copy-paste)
    //   https://relay.example/app#loopsy://pair?u=...              (already
    //     hash-decoded)
    // Anything else returns null and the caller shows the parse-error modal.
    try {
      let s = (input || '').trim();
      // If they pasted the full web URL, peel off everything before the
      // hash and URL-decode the inner pair link.
      const hashIdx = s.indexOf('#');
      if (hashIdx >= 0) s = s.slice(hashIdx + 1);
      if (/^loopsy%3a/i.test(s)) {
        try { s = decodeURIComponent(s); } catch { /* leave as-is */ }
      }
      const cleaned = s.replace(/^loopsy:\\/\\//i, 'https://');
      const u = new URL(cleaned);
      const token = u.searchParams.get('t');
      const relayUrl = decodeURIComponent(u.searchParams.get('u') || '');
      if (!token || !relayUrl) return null;
      return { token, relayUrl };
    } catch { return null; }
  }

  function agentFlag(agent) {
    if (agent === 'claude') return '--dangerously-skip-permissions';
    if (agent === 'gemini') return '-y';
    if (agent === 'codex')  return '--full-auto';
    return '';
  }

  // ── Modal helpers ────────────────────────────────────────────────────────
  // Port of loopsy_modal.dart. showLoopsyDialog/showLoopsySheet return a
  // Promise that resolves to the value passed to resolve() by an action button.
  const Modal = (() => {
    const layer = document.getElementById('modal-layer');

    function buildCard(opts, isSheet) {
      const card = document.createElement('div');
      card.className = isSheet ? 'sheet-card' : 'modal-card';
      // icon
      if (opts.icon) {
        const ic = document.createElement('div');
        ic.className = 'modal-icon';
        if (opts.iconColor) ic.style.color = opts.iconColor;
        ic.innerHTML = opts.icon;
        card.appendChild(ic);
      }
      // title
      const h = document.createElement('h2');
      h.className = 'modal-title'; h.textContent = opts.title;
      card.appendChild(h);
      // subtitle
      if (opts.subtitle) {
        const p = document.createElement('p');
        p.className = 'modal-subtitle'; p.textContent = opts.subtitle;
        card.appendChild(p);
      }
      // body (HTML string or DOM node)
      if (opts.body) {
        const bd = document.createElement('div');
        bd.className = 'modal-body';
        if (typeof opts.body === 'string') bd.innerHTML = opts.body;
        else bd.appendChild(opts.body);
        card.appendChild(bd);
      }
      return card;
    }

    function show(opts, isSheet) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = isSheet ? 'sheet-overlay' : 'modal-overlay';
        const card = buildCard(opts, isSheet);
        // actions
        const actRow = document.createElement('div');
        actRow.className = 'modal-actions';
        (opts.actions || []).forEach(a => {
          const btn = document.createElement('button');
          btn.className = 'mbtn ' + (a.variant || 'mbtn-text');
          btn.textContent = a.label;
          if (a.disabled) btn.disabled = true;
          btn.onclick = () => {
            // if action has a custom click, it drives the value
            const val = a.onClick ? a.onClick() : a.value;
            overlay.remove();
            resolve(val);
          };
          actRow.appendChild(btn);
        });
        card.appendChild(actRow);
        // close on overlay click unless barrierDismissible=false
        if (opts.barrierDismissible !== false) {
          overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { overlay.remove(); resolve(undefined); }
          });
        }
        overlay.appendChild(card);
        layer.appendChild(overlay);
        // auto-focus first input
        requestAnimationFrame(() => {
          const inp = card.querySelector('input,textarea');
          if (inp) inp.focus();
        });
      });
    }

    return {
      dialog: (opts) => show(opts, false),
      sheet:  (opts) => show(opts, true),
    };
  })();

  // ── RelayConn ─────────────────────────────────────────────────────────────
  // Single WebSocket per session. Multiple sessions each have their own conn.
  // Mirrors RelaySession in relay_client.dart.
  class RelayConn {
    constructor({ pairing, sessionId, onPty, onControl, onClose }) {
      this._pairing = pairing;
      this._sessionId = sessionId;
      this._onPty = onPty;
      this._onControl = onControl;
      this._onClose = onClose;
      this._ws = null;
      this._closed = false;
    }
    get isOpen() { return this._ws !== null && this._ws.readyState === 1 && !this._closed; }

    connect() {
      const p = this._pairing;
      const wsBase = p.relayUrl.replace(/^http/, 'ws');
      const url = wsBase
        + '/phone/connect/' + encodeURIComponent(p.deviceId)
        + '?phone_id=' + encodeURIComponent(p.phoneId)
        + '&session_id=' + encodeURIComponent(this._sessionId);
      // CSO #3: secret in subprotocol header, not URL.
      const ws = new WebSocket(url, ['loopsy.bearer.' + p.phoneSecret]);
      ws.binaryType = 'arraybuffer';
      this._ws = ws;
      ws.addEventListener('message', (e) => {
        if (typeof e.data === 'string') {
          try { this._onControl && this._onControl(JSON.parse(e.data)); } catch {}
        } else {
          this._onPty && this._onPty(new Uint8Array(e.data));
        }
      });
      ws.addEventListener('close', (e) => {
        if (this._closed) return;
        this._closed = true;
        this._onClose && this._onClose(e.code, e.reason);
      });
      ws.addEventListener('error', () => {
        if (this._closed) return;
        this._closed = true;
        this._onClose && this._onClose(null, null);
      });
    }

    sendOpen({ agent, cols, rows, auto, approveToken, sudoPassword, phoneId }) {
      const msg = { type: 'session-open', agent, cols, rows };
      if (auto)           msg.auto = true;
      if (phoneId)        msg.phoneId = phoneId;
      if (approveToken)   msg.approveToken = approveToken;
      if (sudoPassword)   msg.sudoPassword = sudoPassword;
      this._send(JSON.stringify(msg));
    }
    sendStdin(data) { if (this.isOpen) this._ws.send(data); }
    sendControl(msg) { this._send(JSON.stringify(msg)); }
    resize(cols, rows) { this.sendControl({ type: 'resize', cols, rows }); }
    kill() { this.sendControl({ type: 'session-close' }); this.close(); }
    close(code = 1000, reason = 'user-close') {
      if (this._closed) return;
      this._closed = true;
      try { this._ws && this._ws.close(code, reason); } catch {}
    }
    _send(data) { if (this.isOpen) { try { this._ws.send(data); } catch {} } }
  }

  // ── xterm singleton ──────────────────────────────────────────────────────
  // We create xterm once and move it around so it doesn't re-init on navigation.
  let _term = null, _fit = null;
  function getTerm() {
    if (!_term) {
      _term = new Terminal({
        cursorBlink: true,
        fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Monaco, monospace",
        fontSize: 13,
        theme: {
          background: '#0B0D10', foreground: '#E7EAEE', cursor: '#7AA2F7',
          selectionBackground: 'rgba(122,162,247,0.32)',
          black: '#1A1B26', red: '#F7768E', green: '#9ECE6A', yellow: '#E0AF68',
          blue: '#7AA2F7', magenta: '#BB9AF7', cyan: '#7DCFFF', white: '#C0CAF5',
          brightBlack: '#414868', brightRed: '#FF7A93', brightGreen: '#B9F27C',
          brightYellow: '#FF9E64', brightBlue: '#7DA6FF', brightMagenta: '#BB9AF7',
          brightCyan: '#0DB9D7', brightWhite: '#D8E0F2',
        },
        convertEol: true, allowProposedApi: true,
      });
      _fit = new FitAddon();
      _term.loadAddon(_fit);
    }
    return { term: _term, fit: _fit };
  }

  // ── Summary capture (mirrors terminal_screen.dart _captureSummary) ───────
  function makeSummaryCapturer(sessionId) {
    let captured = false;
    let buf = '';
    return function capture(bytes) {
      if (captured) return;
      for (const b of bytes) {
        if (b === 0x0d || b === 0x0a) {
          const s = buf.trim();
          buf = '';
          if (!s) continue;
          captured = true;
          Storage.updateSession(sessionId, m => ({ ...m, summary: s }));
          return;
        }
        if (b === 0x7f) { buf = buf.slice(0, -1); continue; }
        if (b < 0x20) continue;
        buf += String.fromCharCode(b);
        if (buf.length > 200) {
          captured = true;
          Storage.updateSession(sessionId, m => ({ ...m, summary: buf.trim() }));
          return;
        }
      }
    };
  }

  // ── Router ───────────────────────────────────────────────────────────────
  let _currentUnmount = null;

  const Router = {
    init() {
      window.addEventListener('hashchange', () => Router.render());
      Router.render();
    },
    navigate(hash) {
      window.location.hash = hash;
    },
    render() {
      if (_currentUnmount) { _currentUnmount(); _currentUnmount = null; }
      const hash = window.location.hash.replace(/^#/, '');
      // Pair hash: loopsy://pair?u=...&t=...
      if (hash.startsWith('loopsy%3A') || hash.startsWith('loopsy:')) {
        _currentUnmount = PairView.mount(decodeURIComponent(hash));
        return;
      }
      if (hash === 'pair' || !hash) {
        // check for existing pairing
        const p = Storage.readPairing();
        if (p) { Router.navigate('home'); return; }
        _currentUnmount = PairView.mount(null);
        return;
      }
      if (hash === 'home') {
        const p = Storage.readPairing();
        if (!p) { Router.navigate('pair'); return; }
        _currentUnmount = HomeView.mount(p);
        return;
      }
      if (hash.startsWith('session/')) {
        const id = hash.slice('session/'.length);
        const p = Storage.readPairing();
        if (!p) { Router.navigate('pair'); return; }
        const sessions = Storage.readSessions();
        const meta = sessions.find(s => s.id === id) || null;
        _currentUnmount = SessionView.mount(p, id, meta);
        return;
      }
      // fallback
      Router.navigate('home');
    },
  };

  // ── PairView ─────────────────────────────────────────────────────────────
  // Renders an empty page (just the brand topbar) and immediately opens a
  // dialog popup asking for the pair URL — matching the WIP design. The dialog
  // can't be dismissed; pair is the only way out of this view.
  const PairView = {
    mount(rawHash) {
      const topbar = document.getElementById('topbar-slot');
      const view   = document.getElementById('view');
      const chips  = document.getElementById('chips');
      const cSlot  = document.getElementById('compose-slot');
      const termW  = document.getElementById('term-wrap');
      chips.style.display = 'none';
      cSlot.innerHTML = '';
      termW.classList.remove('active');
      view.style.display = '';
      view.style.overflowY = 'auto';

      // Topbar — brand only.
      topbar.innerHTML = '';
      const tb = document.createElement('div');
      tb.className = 'topbar';
      tb.innerHTML = '<div class="brand-logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4l4 4-4 4"/><path d="M3.5 11.5V10a2 2 0 0 1 2-2H18.5"/><path d="M9.5 20l-4-4 4-4"/><path d="M20.5 12.5V14a2 2 0 0 1-2 2H5.5"/></svg></div>'
        + '<span class="topbar-title">${BRAND_NAME}</span>';
      topbar.appendChild(tb);

      // Empty body — the dialog is the page.
      view.innerHTML = '';

      // Strip the raw hash from the address bar so back/refresh don't
      // re-trigger pairing with a stale token; we already captured it.
      const initialPair = rawHash ? parsePairUrl(rawHash) : null;
      if (rawHash) {
        history.replaceState(null, '', window.location.pathname + '#pair');
      }

      const linkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/></svg>';
      const lockIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
      const errIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';

      let cancelled = false;

      // Step 1: get a parsed pair URL. Skip the URL dialog entirely when the
      // page hash already carries a valid pair URL — there's no reason to
      // make the user re-paste what we already have.
      async function getParsedPair() {
        if (cancelled) return null;
        if (initialPair) return initialPair;

        // No hash → prompt for paste. Loop until parse succeeds or cancelled.
        while (!cancelled) {
          const result = await Modal.dialog({
            icon: linkIcon,
            title: 'Connect to your laptop',
            subtitle: 'Run "loopsy mobile pair" on your laptop, then paste the link below.',
            body: '<input id="_pair_url" class="modal-input" type="text" placeholder="https://&lt;relay&gt;/app#loopsy%3A..." autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" /><div id="_pair_err" class="modal-error" style="display:none"></div>',
            barrierDismissible: false,
            actions: [
              { label: 'Continue', variant: 'mbtn-primary', onClick: () => {
                const el = document.getElementById('_pair_url');
                const value = el ? el.value.trim() : '';
                return parsePairUrl(value);
              }},
            ],
          });
          if (cancelled) return null;
          if (result) return result;
          // Parse failed — show an error toast-style dialog and loop.
          await Modal.dialog({
            icon: errIcon,
            title: 'Could not parse pair URL',
            subtitle: 'Make sure you copied the full link printed by "loopsy mobile pair".',
            actions: [{ label: 'OK', variant: 'mbtn-primary', value: true }],
          });
        }
        return null;
      }

      // Step 2: SAS prompt + redeem. Loops on bad SAS so the user can retry
      // without re-entering the URL.
      async function redeemLoop(parsed) {
        while (!cancelled) {
          const sas = await Modal.dialog({
            icon: lockIcon,
            title: 'Enter 4-digit code',
            subtitle: 'Read the verification code shown on your laptop next to the QR.',
            body: '<input id="_sas" class="modal-input" type="text" inputmode="numeric" maxlength="4" placeholder="&bull;&bull;&bull;&bull;" autocomplete="off" style="letter-spacing:10px;text-align:center;font-size:26px" />',
            barrierDismissible: false,
            actions: [
              { label: 'Pair', variant: 'mbtn-primary', onClick: () => {
                const el = document.getElementById('_sas');
                const v = el ? el.value.trim() : '';
                return v.length === 4 ? v : null;
              }},
            ],
          });
          if (cancelled) return;
          if (!sas) continue;

          try {
            const r = await fetch(parsed.relayUrl.replace(/\\/+$/, '') + '/pair/redeem', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token: parsed.token, sas, label: navigator.userAgent.slice(0, 80) }),
            });
            if (!r.ok) { const t = await r.text(); throw new Error('Pair failed: ' + r.status + ' ' + t); }
            const j = await r.json();
            Storage.writePairing({
              relayUrl: parsed.relayUrl,
              deviceId: j.device_id,
              phoneId: j.phone_id,
              phoneSecret: j.phone_secret,
            });
            Router.navigate('home');
            return;
          } catch (e) {
            const retry = await Modal.dialog({
              icon: errIcon,
              title: 'Pairing failed',
              subtitle: e.message,
              actions: [
                { label: 'Cancel', variant: 'mbtn-text', value: false },
                { label: 'Try again', variant: 'mbtn-primary', value: true },
              ],
            });
            if (!retry) return;
            // Loop back to SAS prompt.
          }
        }
      }

      (async () => {
        const parsed = await getParsedPair();
        if (cancelled || !parsed) return;
        await redeemLoop(parsed);
      })();

      return function unmount() {
        cancelled = true;
        topbar.innerHTML = '';
        view.innerHTML = '';
      };
    },
  };

  // ── HomeView ──────────────────────────────────────────────────────────────
  const HomeView = {
    mount(pairing) {
      const topbar = document.getElementById('topbar-slot');
      const view   = document.getElementById('view');
      const chips  = document.getElementById('chips');
      const cSlot  = document.getElementById('compose-slot');
      const termW  = document.getElementById('term-wrap');
      chips.style.display = 'none';
      cSlot.innerHTML = '';
      termW.classList.remove('active');
      view.style.display = '';
      view.style.overflowY = 'auto';

      // topbar
      topbar.innerHTML = '';
      const tb = document.createElement('div');
      tb.className = 'topbar';
      const logo = document.createElement('span');
      logo.className = 'brand-logo';
      logo.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4l4 4-4 4"/><path d="M3.5 11.5V10a2 2 0 0 1 2-2H18.5"/><path d="M9.5 20l-4-4 4-4"/><path d="M20.5 12.5V14a2 2 0 0 1-2 2H5.5"/></svg>';
      const title = document.createElement('span');
      title.className = 'topbar-title'; title.textContent = '${BRAND_NAME}';
      const settingsBtn = document.createElement('button');
      settingsBtn.className = 'icon-btn'; settingsBtn.title = 'Settings';
      settingsBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06-.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>';
      tb.appendChild(logo); tb.appendChild(title); tb.appendChild(settingsBtn);
      topbar.appendChild(tb);

      let sessions = Storage.readSessions();

      function render() {
        view.innerHTML = '';
        const body = document.createElement('div');
        body.className = 'home-body';

        // ── Device card ──────────────────────────────────────────────
        const dc = document.createElement('div');
        dc.className = 'device-card';
        const dcRow = document.createElement('div');
        dcRow.className = 'device-card-row';
        const tile = document.createElement('div');
        tile.className = 'icon-tile sz36 accent';
        tile.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/></svg>';
        const info = document.createElement('div');
        info.className = 'device-card-info';
        const lbl = document.createElement('div');
        lbl.className = 'device-card-label'; lbl.textContent = 'Paired laptop';
        const idEl = document.createElement('div');
        idEl.className = 'device-card-id'; idEl.textContent = pairing.deviceId;
        info.appendChild(lbl); info.appendChild(idEl);
        dcRow.appendChild(tile); dcRow.appendChild(info);
        const urlRow = document.createElement('div');
        urlRow.className = 'device-card-url-row';
        urlRow.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/></svg>';
        const urlSpan = document.createElement('span');
        urlSpan.textContent = pairing.relayUrl;
        urlRow.appendChild(urlSpan);
        dc.appendChild(dcRow); dc.appendChild(urlRow);
        body.appendChild(dc);

        // ── Sessions header ──────────────────────────────────────────
        const sh = document.createElement('div');
        sh.className = 'section-header'; sh.textContent = 'Sessions';
        body.appendChild(sh);

        // ── Session list ─────────────────────────────────────────────
        if (sessions.length === 0) {
          const es = document.createElement('div');
          es.className = 'empty-sessions';
          es.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17 9 12 4 7"/><path d="M12 19h8"/></svg>'
            + '<p>No sessions yet. Tap + to start one.</p>';
          body.appendChild(es);
        } else {
          sessions.forEach(s => {
            const card = _buildSessionCard(s, pairing, () => {
              sessions = Storage.readSessions();
              render();
            });
            body.appendChild(card);
          });
        }

        // ── FAB ──────────────────────────────────────────────────────
        const fab = document.createElement('button');
        fab.className = 'fab';
        fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>New session';
        fab.onclick = () => _newSession(pairing, () => { sessions = Storage.readSessions(); render(); });
        body.appendChild(fab);

        view.appendChild(body);
      }

      settingsBtn.onclick = () => _resetPairing(pairing);
      render();

      return function unmount() { topbar.innerHTML = ''; view.innerHTML = ''; };
    },
  };

  function _sessionDisplayName(s) {
    if (s.name && s.name.trim()) return s.name.trim();
    if (s.summary && s.summary.trim()) {
      const t = s.summary.trim();
      return t.length > 60 ? t.slice(0, 60) + '\\u2026' : t;
    }
    return s.agent + ' session';
  }

  function _agentIconSvg(agent) {
    if (agent === 'claude') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M9 10h.01M12 10h.01M15 10h.01"/></svg>';
    if (agent === 'gemini') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></svg>';
    if (agent === 'codex')  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 17 9 12 4 7"/><path d="M12 19h8"/></svg>';
  }

  function _buildSessionCard(s, pairing, onRefresh) {
    const card = document.createElement('div');
    card.className = 'session-card';
    const inner = document.createElement('div');
    inner.className = 'session-card-inner';

    const tile = document.createElement('div');
    tile.className = 'icon-tile sz40 accent';
    tile.innerHTML = _agentIconSvg(s.agent);

    const bdy = document.createElement('div');
    bdy.className = 'session-card-body';
    const nm = document.createElement('div');
    nm.className = 'session-card-name'; nm.textContent = _sessionDisplayName(s);
    const meta = document.createElement('div');
    meta.className = 'session-card-meta';
    const badge = document.createElement('span');
    badge.className = 'agent-badge'; badge.textContent = s.agent;
    const sid = document.createElement('span');
    sid.className = 'session-id-mono'; sid.textContent = s.id.slice(0, 6);
    meta.appendChild(badge); meta.appendChild(sid);
    // show summary if we also have a custom name
    if (s.name && s.summary) {
      const sumEl = document.createElement('span');
      sumEl.className = 'session-summary-text'; sumEl.textContent = s.summary;
      meta.appendChild(sumEl);
    }
    bdy.appendChild(nm); bdy.appendChild(meta);

    const more = document.createElement('button');
    more.className = 'icon-btn'; more.title = 'More';
    more.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>';

    inner.appendChild(tile); inner.appendChild(bdy); inner.appendChild(more);
    card.appendChild(inner);

    card.onclick = (e) => {
      if (e.target.closest('.icon-btn')) return;
      Router.navigate('session/' + s.id);
    };
    more.onclick = (e) => { e.stopPropagation(); _showSessionMenu(s, pairing, onRefresh); };
    return card;
  }

  async function _newSession(pairing, onRefresh) {
    // 1. pick agent
    const agent = await _pickAgent();
    if (!agent) return;
    // 2. auto-approve dialog (only for non-shell agents)
    let auto = false;
    if (agent !== 'shell') {
      const res = await _promptAutoApprove(agent);
      if (res === undefined || res === null) return; // cancelled
      auto = res;
    }
    // 3. name dialog
    const name = await _promptName('', 'Name this session?');
    // name can be null (skipped) — that's fine
    const id = uuidV4();
    const meta = {
      id, agent,
      lastUsedMs: Date.now(),
      name: (name && name.trim()) ? name.trim() : undefined,
      auto,
    };
    const sessions = Storage.readSessions();
    Storage.writeSessions([meta, ...sessions]);
    if (onRefresh) onRefresh();
    Router.navigate('session/' + id);
  }

  // Agent picker sheet — imperative so tile taps can resolve the promise directly.
  function _pickAgent() {
    return new Promise(resolve => {
      const layer = document.getElementById('modal-layer');
      const overlay = document.createElement('div');
      overlay.className = 'sheet-overlay';
      const card = document.createElement('div');
      card.className = 'sheet-card';
      card.innerHTML = '<div class="modal-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></div>'
        + '<h2 class="modal-title">Start a session</h2>'
        + '<p class="modal-subtitle">Pick an agent. The session lives on your laptop and you can switch back to it anytime.</p>';

      const agents = [
        { agent: 'shell',  label: 'shell',  sub: 'Bash on your laptop',  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 17 9 12 4 7"/><path d="M12 19h8"/></svg>', color: 'var(--fg)' },
        { agent: 'claude', label: 'claude', sub: 'Claude Code',           icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M9 10h.01M12 10h.01M15 10h.01"/></svg>', color: 'var(--accent)' },
        { agent: 'gemini', label: 'gemini', sub: 'Gemini CLI',            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></svg>', color: 'var(--accent)' },
        { agent: 'codex',  label: 'codex',  sub: 'OpenAI Codex CLI',      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>', color: 'var(--accent)' },
      ];
      agents.forEach(({ agent, label, sub, icon, color }) => {
        const tile = document.createElement('div');
        tile.className = 'menu-tile';
        tile.innerHTML = '<div class="menu-tile-icon" style="color:' + color + '">' + icon + '</div>'
          + '<div class="menu-tile-body"><div class="menu-tile-title">' + label + '</div>'
          + (sub ? '<div class="menu-tile-sub">' + sub + '</div>' : '') + '</div>';
        tile.onclick = () => { overlay.remove(); resolve(agent); };
        card.appendChild(tile);
      });
      const actRow = document.createElement('div');
      actRow.className = 'modal-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'mbtn mbtn-text'; cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = () => { overlay.remove(); resolve(null); };
      actRow.appendChild(cancelBtn);
      card.appendChild(actRow);
      overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
      overlay.appendChild(card);
      layer.appendChild(overlay);
    });
  }

  async function _promptAutoApprove(agent) {
    const flag = agentFlag(agent);
    const bodyEl = document.createElement('div');
    bodyEl.innerHTML = '<div class="code-block">' + agent + (flag ? ' ' + flag : '') + '</div>'
      + '<div class="warn-row"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
      + '<span>The agent will run file edits and shell commands without asking. Trust the prompt.</span></div>';
    return Modal.dialog({
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>',
      title: 'Auto-approve actions?',
      subtitle: "Skip the agent's confirmation prompts. The first auto-approve session will ask for your macOS password once.",
      body: bodyEl,
      actions: [
        { label: 'Cancel', variant: 'mbtn-text', value: undefined },
        { label: 'Stay safe', variant: 'mbtn-outlined', value: false },
        { label: 'Auto-approve', variant: 'mbtn-primary', value: true },
      ],
    });
  }

  async function _promptName(initial, title) {
    return new Promise(resolve => {
      const layer = document.getElementById('modal-layer');
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const card = document.createElement('div');
      card.className = 'modal-card';
      card.innerHTML = '<div class="modal-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z"/></svg></div>'
        + '<h2 class="modal-title">' + title + '</h2>'
        + '<p class="modal-subtitle">Pick a name to spot it on the home list.</p>';
      const inp = document.createElement('input');
      inp.className = 'modal-input'; inp.type = 'text';
      inp.placeholder = 'e.g. fix logging bug';
      inp.value = initial || '';
      inp.autocomplete = 'off';
      inp.style.marginBottom = '18px';
      const actRow = document.createElement('div');
      actRow.className = 'modal-actions';
      const skip = document.createElement('button');
      skip.className = 'mbtn mbtn-text'; skip.textContent = 'Skip';
      skip.onclick = () => { overlay.remove(); resolve(null); };
      const save = document.createElement('button');
      save.className = 'mbtn mbtn-primary'; save.textContent = 'Save';
      save.onclick = () => { overlay.remove(); resolve(inp.value); };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { overlay.remove(); resolve(inp.value); } });
      actRow.appendChild(skip); actRow.appendChild(save);
      card.appendChild(inp); card.appendChild(actRow);
      overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
      overlay.appendChild(card);
      layer.appendChild(overlay);
      requestAnimationFrame(() => inp.focus());
    });
  }

  async function _showSessionMenu(s, pairing, onRefresh) {
    const action = await new Promise(resolve => {
      const layer = document.getElementById('modal-layer');
      const overlay = document.createElement('div');
      overlay.className = 'sheet-overlay';
      const card = document.createElement('div');
      card.className = 'sheet-card';
      card.innerHTML = '<div class="modal-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg></div>'
        + '<h2 class="modal-title">' + _sessionDisplayName(s) + '</h2>'
        + '<p class="modal-subtitle">session ' + s.id.slice(0,6) + ' &bull; ' + s.agent + '</p>';

      const menuItems = [
        { key: 'rename', label: 'Rename', sub: null, color: 'var(--fg)', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z"/></svg>' },
        { key: 'remove', label: 'Remove from list', sub: 'Keeps the laptop session running.', color: 'var(--warn)', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M3 12h12"/><path d="M3 18h9"/><path d="M17 16l4 4m0-4l-4 4"/></svg>' },
        { key: 'delete', label: 'Delete', sub: 'Stops the laptop session and removes it.', color: 'var(--bad)', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>' },
      ];
      menuItems.forEach(({ key, label, sub, color, icon }) => {
        const tile = document.createElement('div');
        tile.className = 'menu-tile';
        tile.innerHTML = '<div class="menu-tile-icon" style="color:' + color + '">' + icon + '</div>'
          + '<div class="menu-tile-body"><div class="menu-tile-title" style="color:' + color + '">' + label + '</div>'
          + (sub ? '<div class="menu-tile-sub">' + sub + '</div>' : '') + '</div>';
        tile.onclick = () => { overlay.remove(); resolve(key); };
        card.appendChild(tile);
      });
      const actRow = document.createElement('div');
      actRow.className = 'modal-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'mbtn mbtn-text'; cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = () => { overlay.remove(); resolve(null); };
      actRow.appendChild(cancelBtn); card.appendChild(actRow);
      overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
      overlay.appendChild(card);
      layer.appendChild(overlay);
    });

    if (action === 'rename') {
      const name = await _promptName(s.name || s.summary || '', 'Rename session');
      if (name !== null) {
        Storage.updateSession(s.id, m => ({ ...m, name: name.trim() || undefined }));
        if (onRefresh) onRefresh();
      }
    } else if (action === 'remove') {
      const sessions = Storage.readSessions().filter(e => e.id !== s.id);
      Storage.writeSessions(sessions);
      if (onRefresh) onRefresh();
    } else if (action === 'delete') {
      // best-effort kill via WS
      try {
        const conn = new RelayConn({
          pairing, sessionId: s.id,
          onPty: () => {}, onControl: () => {}, onClose: () => {},
        });
        conn.connect();
        setTimeout(() => { try { conn.kill(); } catch {} }, 100);
      } catch {}
      const sessions = Storage.readSessions().filter(e => e.id !== s.id);
      Storage.writeSessions(sessions);
      if (onRefresh) onRefresh();
    }
  }

  async function _resetPairing(pairing) {
    const ok = await Modal.dialog({
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
      iconColor: 'var(--bad)',
      title: 'Forget pairing?',
      subtitle: "You'll need to re-paste a pair link to reconnect. Your auto-approve token will be wiped too.",
      actions: [
        { label: 'Cancel', variant: 'mbtn-text', value: false },
        { label: 'Forget', variant: 'mbtn-danger', value: true },
      ],
    });
    if (!ok) return;
    // CSO #8: revoke server-side (best-effort)
    try {
      await fetch(
        pairing.relayUrl.replace(/\\/+$/, '') + '/device/' + encodeURIComponent(pairing.deviceId) + '/phones/self?phone_id=' + encodeURIComponent(pairing.phoneId),
        { method: 'DELETE', headers: { Authorization: 'Bearer ' + pairing.phoneSecret } },
      );
    } catch {}
    Storage.deletePairing();
    Router.navigate('pair');
  }

  // ── SessionView ───────────────────────────────────────────────────────────
  const SessionView = {
    mount(pairing, sessionId, meta) {
      const topbar = document.getElementById('topbar-slot');
      const view   = document.getElementById('view');
      const chipsEl = document.getElementById('chips');
      const cSlot  = document.getElementById('compose-slot');
      const termW  = document.getElementById('term-wrap');

      // Hide scrollable view; show terminal node
      view.style.display = 'none';
      chipsEl.style.display = 'none'; // session view uses topbar status only
      termW.classList.add('active');

      // ── xterm ────────────────────────────────────────────────────────
      const { term, fit } = getTerm();
      // Detach from any previous parent
      if (term.element && term.element.parentNode && term.element.parentNode !== termW) {
        term.element.parentNode.removeChild(term.element);
      }
      if (!term.element) {
        term.open(termW);
      } else if (!termW.contains(term.element)) {
        termW.appendChild(term.element);
      }
      termW.style.flex = '1';
      termW.style.minHeight = '0';

      const agent = meta ? meta.agent : 'shell';
      const auto  = meta ? !!meta.auto : false;

      let status = 'connecting...';
      let statusErr = false;

      // ── Topbar ───────────────────────────────────────────────────────
      topbar.innerHTML = '';
      const tb = document.createElement('div');
      tb.className = 'topbar';

      const backBtn = document.createElement('button');
      backBtn.className = 'icon-btn'; backBtn.title = 'Back';
      backBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>';
      backBtn.onclick = () => Router.navigate('home');

      const titleEl = document.createElement('span');
      titleEl.className = 'topbar-title';
      const titleInner = document.createElement('span');
      titleInner.style.cssText = 'display:flex;align-items:center;gap:8px';
      titleInner.innerHTML = '<span style="color:var(--accent)">' + _agentIconSvg(agent) + '</span>'
        + '<span style="font-family:var(--font-mono);font-size:14px">' + agent + '</span>'
        + '<span style="width:4px;height:4px;border-radius:50%;background:var(--muted);display:inline-block"></span>'
        + '<span style="font-family:var(--font-mono);font-size:12px;color:var(--muted)">' + sessionId.slice(0,6) + '</span>';
      titleEl.appendChild(titleInner);

      const statusChip = document.createElement('span');
      statusChip.className = 'status-chip';
      const dot = document.createElement('span'); dot.className = 'dot';
      const statusText = document.createElement('span'); statusText.textContent = status;
      statusChip.appendChild(dot); statusChip.appendChild(statusText);

      const moreBtn = document.createElement('button');
      moreBtn.className = 'icon-btn'; moreBtn.title = 'Session menu';
      moreBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>';
      moreBtn.onclick = () => {
        if (meta) _showSessionMenu(meta, pairing, () => {});
      };

      tb.appendChild(backBtn); tb.appendChild(titleEl); tb.appendChild(statusChip); tb.appendChild(moreBtn);
      topbar.appendChild(tb);

      function setStatus(text, kind) {
        status = text; statusErr = (kind === 'err');
        statusText.textContent = text;
        statusChip.className = 'status-chip' + (kind ? ' ' + kind : '');
      }

      // ── Compose ──────────────────────────────────────────────────────
      cSlot.innerHTML = '';
      const compose = document.createElement('div');
      compose.className = 'compose';
      const micBtn = document.createElement('button');
      micBtn.className = 'icon-btn'; micBtn.title = 'Voice input';
      micBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10a7 7 0 0 1-14 0"/><path d="M12 17v4"/></svg>';
      const textarea = document.createElement('textarea');
      textarea.rows = 1;
      textarea.placeholder = 'Type or dictate, Enter sends...';
      textarea.autocomplete = 'off'; textarea.autocapitalize = 'none';
      textarea.autocorrect = 'off'; textarea.spellcheck = false;
      const sendBtn = document.createElement('button');
      sendBtn.className = 'icon-btn send-btn'; sendBtn.title = 'Send';
      sendBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/></svg>';
      compose.appendChild(micBtn); compose.appendChild(textarea); compose.appendChild(sendBtn);
      cSlot.appendChild(compose);

      // ── WS + session open ────────────────────────────────────────────
      const capturer = makeSummaryCapturer(sessionId);
      let conn = null;

      function openConn(sudoPassword, approveToken) {
        conn = new RelayConn({
          pairing, sessionId,
          onPty: (bytes) => {
            term.write(bytes);
          },
          onControl: handleControl,
          onClose: (code) => {
            setStatus('closed (' + (code ?? '?') + ')', code !== 1000 ? 'err' : '');
          },
        });
        conn.connect();
        conn._ws.addEventListener('open', () => {
          setStatus('connected', 'ok');
          const cols = term.cols || 120, rows = term.rows || 40;
          conn.sendOpen({ agent, cols, rows, auto, approveToken, sudoPassword, phoneId: pairing.phoneId });
          fit.fit();
        });
      }

      async function handleControl(msg) {
        if (msg.type === 'device-disconnected') {
          setStatus('device disconnected', 'err');
        } else if (msg.type === 'auto-approve-granted') {
          const token = msg.token;
          if (token) {
            Storage.writeApproveToken(token);
            // Brief toast: write to terminal
            term.writeln('\\r\\n\\x1b[32mAuto-approve enabled. Future sessions skip the password.\\x1b[0m\\r\\n');
          }
        } else if (msg.type === 'auto-approve-denied') {
          Storage.deleteApproveToken();
          setStatus('auto-approve denied', 'err');
          const reason = msg.message || 'Auto-approve denied.';
          // Show password dialog again with error inline
          const pw = await _askSudoPassword(agent, reason);
          if (!pw) return;
          // Reconnect with new password
          conn.close();
          openConn(pw, null);
        }
      }

      // bootstrap: for auto sessions, check cached token
      async function bootstrap() {
        term.reset();
        fit.fit();
        if (auto) {
          const cached = Storage.readApproveToken();
          if (cached) {
            openConn(null, cached);
          } else {
            const pw = await _askSudoPassword(agent, null);
            if (!pw) {
              setStatus('cancelled', 'err');
              return;
            }
            openConn(pw, null);
          }
        } else {
          openConn(null, null);
        }
      }

      bootstrap();

      // ── xterm I/O wiring ─────────────────────────────────────────────
      const onData = term.onData((data) => {
        if (!conn || !conn.isOpen) return;
        const bytes = new TextEncoder().encode(data);
        conn.sendStdin(bytes);
        capturer(bytes);
      });
      const onResize = term.onResize(({ cols, rows }) => {
        if (conn && conn.isOpen) conn.resize(cols, rows);
      });

      // ── Send compose ──────────────────────────────────────────────────
      function sendCompose() {
        const text = textarea.value;
        if (!text) return;
        if (!conn || !conn.isOpen) {
          term.writeln('\\r\\n\\x1b[33mNo active session\\x1b[0m');
          return;
        }
        const bytes = new TextEncoder().encode(text + '\\r');
        conn.sendStdin(bytes);
        capturer(bytes);
        textarea.value = '';
        textarea.style.height = 'auto';
      }
      sendBtn.onclick = sendCompose;
      textarea.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCompose(); }
      });
      textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 96) + 'px';
      });

      // ── Voice input ───────────────────────────────────────────────────
      // Web Speech API: Chrome desktop + Safari (incl. iOS 14.5+) yes;
      // Firefox + Chrome on iOS no. On unsupported browsers we hide the
      // button entirely instead of greying it out — a disabled mic icon
      // sitting next to the textarea just confuses people.
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      let recog = null;
      let recordingActive = false;
      let micPermissionAsked = false;

      function setMicError(msg) {
        // Steal the textarea placeholder for a beat to surface the error,
        // then restore on next interaction.
        textarea.placeholder = msg;
        clearTimeout(setMicError._t);
        setMicError._t = setTimeout(() => {
          textarea.placeholder = 'Type or dictate, Enter sends...';
        }, 4000);
      }

      if (!SpeechRecognition) {
        micBtn.style.display = 'none';
      } else {
        recog = new SpeechRecognition();
        recog.continuous = false; recog.interimResults = true;
        recog.lang = navigator.language || 'en-US';
        recog.onresult = (e) => {
          let final = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i];
            if (r.isFinal) final += r[0].transcript;
            else textarea.placeholder = 'Listening: ' + r[0].transcript;
          }
          if (final) textarea.value = (textarea.value + ' ' + final).trim();
        };
        recog.onerror = (e) => {
          // Specific error codes per the W3C SpeechRecognition spec.
          // Translating each one because "no-speech" and "not-allowed" are
          // very different bugs from the user's perspective.
          const code = e && e.error ? e.error : 'unknown';
          let msg = 'Mic error: ' + code;
          if (code === 'not-allowed' || code === 'service-not-allowed') {
            msg = 'Mic permission denied — allow microphone in your browser settings.';
          } else if (code === 'audio-capture') {
            msg = 'No microphone detected on this device.';
          } else if (code === 'no-speech') {
            msg = 'No speech heard — try again.';
          } else if (code === 'network') {
            msg = 'Mic network error — check your connection.';
          }
          setMicError(msg);
        };
        recog.onend = () => {
          recordingActive = false;
          micBtn.classList.remove('recording');
        };
      }

      micBtn.onclick = async () => {
        if (!recog) return;
        if (recordingActive) { try { recog.stop(); } catch {} return; }
        // Force the browser permission prompt up-front via getUserMedia
        // on first click. Without this, some browsers start the recognition
        // session and silently fail with not-allowed if mic isn't granted,
        // and the user has no way to retrigger the OS permission dialog.
        if (!micPermissionAsked && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          micPermissionAsked = true;
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            // Got mic access — close the stream immediately, recog will
            // open its own internally.
            stream.getTracks().forEach(t => t.stop());
          } catch (err) {
            const name = err && err.name ? err.name : 'unknown';
            if (name === 'NotAllowedError' || name === 'SecurityError') {
              setMicError('Mic permission denied — allow microphone in your browser settings.');
            } else if (name === 'NotFoundError') {
              setMicError('No microphone detected on this device.');
            } else {
              setMicError('Mic unavailable: ' + name);
            }
            return;
          }
        }
        try {
          recordingActive = true;
          micBtn.classList.add('recording');
          textarea.placeholder = 'Listening...';
          recog.start();
        } catch (err) {
          recordingActive = false;
          micBtn.classList.remove('recording');
          setMicError('Could not start dictation: ' + (err && err.message || 'unknown'));
        }
      };

      // ── Resize handling ───────────────────────────────────────────────
      function handleResize() { try { fit.fit(); } catch {} }
      window.addEventListener('resize', handleResize);
      if (window.visualViewport) window.visualViewport.addEventListener('resize', handleResize);
      requestAnimationFrame(() => fit.fit());

      return function unmount() {
        window.removeEventListener('resize', handleResize);
        if (window.visualViewport) window.visualViewport.removeEventListener('resize', handleResize);
        onData.dispose(); onResize.dispose();
        if (recog) { try { recog.stop(); } catch {} }
        if (conn) conn.close();
        topbar.innerHTML = '';
        cSlot.innerHTML = '';
        view.style.display = '';
        termW.classList.remove('active');
      };
    },
  };

  // ── Auto-approve password prompt ─────────────────────────────────────────
  function _askSudoPassword(agent, errorMsg) {
    return new Promise(resolve => {
      const layer = document.getElementById('modal-layer');
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const card = document.createElement('div');
      card.className = 'modal-card';
      card.innerHTML = '<div class="modal-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>'
        + '<h2 class="modal-title">Enable auto-approve</h2>'
        + '<p class="modal-subtitle">Auto-approve runs ' + agent + ' with permission prompts skipped. Enter the macOS password for your laptop. Asked once per pairing.</p>';

      const pwWrap = document.createElement('div');
      pwWrap.className = 'pw-wrap';
      const inp = document.createElement('input');
      inp.className = 'modal-input pw-input'; inp.type = 'password';
      inp.placeholder = 'macOS password'; inp.autocomplete = 'off';
      const toggle = document.createElement('button');
      toggle.type = 'button'; toggle.className = 'pw-toggle';
      toggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>';
      let obscure = true;
      toggle.onclick = () => {
        obscure = !obscure;
        inp.type = obscure ? 'password' : 'text';
        toggle.innerHTML = obscure
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
      };
      pwWrap.appendChild(inp); pwWrap.appendChild(toggle);
      card.appendChild(pwWrap);

      if (errorMsg) {
        const helper = document.createElement('div');
        helper.className = 'modal-helper bad'; helper.textContent = errorMsg;
        helper.style.marginTop = '6px';
        card.appendChild(helper);
      }

      const actRow = document.createElement('div');
      actRow.className = 'modal-actions';
      actRow.style.marginTop = '18px';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'mbtn mbtn-text'; cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = () => { overlay.remove(); resolve(null); };
      const enableBtn = document.createElement('button');
      enableBtn.className = 'mbtn mbtn-primary'; enableBtn.textContent = 'Enable auto-approve';
      enableBtn.onclick = () => { overlay.remove(); resolve(inp.value); };
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { overlay.remove(); resolve(inp.value); }
      });
      actRow.appendChild(cancelBtn); actRow.appendChild(enableBtn);
      card.appendChild(actRow);
      overlay.appendChild(card);
      layer.appendChild(overlay);
      requestAnimationFrame(() => inp.focus());
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  Router.init();

  })();
  </script>
</body>
</html>`;
