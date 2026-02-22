// ═══════════════════════════════════════════
// LOOPSY // DASHBOARD — App Router
// ═══════════════════════════════════════════

// --- API Helpers ---

function extractError(body, status) {
  if (typeof body.error === 'string') return body.error;
  if (typeof body.message === 'string') return body.message;
  if (body.error) return JSON.stringify(body.error);
  return `HTTP ${status}`;
}

export async function api(port, path, opts = {}) {
  const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(`/dashboard/api/proxy/${port}/api/v1${path}`, {
    headers,
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(extractError(body, res.status));
  }
  return res.json();
}

export async function dashboardApi(path, opts = {}) {
  const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(`/dashboard/api${path}`, {
    headers,
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(extractError(body, res.status));
  }
  return res.json();
}

export function formatUptime(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function formatTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString();
}

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- View Registry ---

const views = {};
let currentView = null;
let currentViewName = null;

export function registerView(name, view) {
  views[name] = view;
}

function navigate(viewName) {
  if (currentView && currentView.unmount) currentView.unmount();

  // Update nav
  document.querySelectorAll('.nav-item, .mobile-nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === viewName);
  });

  const main = document.getElementById('main');
  main.innerHTML = '';
  currentView = views[viewName];
  currentViewName = viewName;

  if (currentView && currentView.mount) {
    currentView.mount(main);
  }

  history.replaceState(null, '', `#${viewName}`);
}

// --- Clock ---

function updateClock() {
  const el = document.getElementById('header-time');
  if (el) el.textContent = new Date().toLocaleTimeString();
}

// --- Init ---

async function init() {
  // Load view modules
  await Promise.all([
    import('./views/overview.js'),
    import('./views/terminal.js'),
    import('./views/context.js'),
    import('./views/messages.js'),
    import('./views/peers.js'),
    import('./views/ai-tasks.js'),
  ]);

  // Nav click handlers
  document.querySelectorAll('.nav-item, .mobile-nav-item').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.view));
  });

  // Clock
  updateClock();
  setInterval(updateClock, 1000);

  // Navigate to hash or default
  const hash = location.hash.replace('#', '') || 'overview';
  navigate(hash);
}

init();
