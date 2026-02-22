import { registerView, dashboardApi, formatUptime, escapeHtml } from '../app.js';

function platformSvg(platform) {
  const s = (d) => `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary)">${d}</svg>`;
  switch (platform) {
    case 'darwin': return s('<path d="M12.5 3C11 3 10 4 9 4S7 3 5.5 3C3.5 3 2 5 2 7.5c0 4 4.5 8 7 8.5 2.5-.5 7-4.5 7-8.5C16 5 14.5 3 12.5 3z"/>');
    case 'win32': return s('<rect x="2" y="2" width="6" height="6" rx="0.5"/><rect x="10" y="2" width="6" height="6" rx="0.5"/><rect x="2" y="10" width="6" height="6" rx="0.5"/><rect x="10" y="10" width="6" height="6" rx="0.5"/>');
    case 'linux': return s('<circle cx="9" cy="5" r="3"/><path d="M4 16c0-3 2.5-5 5-5s5 2 5 5"/>');
    default: return s('<circle cx="9" cy="9" r="6"/><path d="M8.5 12h1"/><path d="M9 6a2 2 0 011.5 3.5L9 11"/>');
  }
}

let refreshTimer = null;

function mount(container) {
  container.innerHTML = `
    <div class="section-header">Command Center</div>
    <div class="stats-row" id="stats-row">
      <div class="stat-card"><div class="stat-value" id="stat-sessions">—</div><div class="stat-label">Sessions</div></div>
      <div class="stat-card"><div class="stat-value" id="stat-peers">—</div><div class="stat-label">Network Peers</div></div>
      <div class="stat-card"><div class="stat-value" id="stat-context">—</div><div class="stat-label">Context Entries</div></div>
      <div class="stat-card"><div class="stat-value" id="stat-jobs">—</div><div class="stat-label">Active Jobs</div></div>
    </div>

    <div class="flex items-center justify-between flex-wrap gap-sm mb-1">
      <div class="section-header" style="margin-bottom:0">Sessions</div>
      <div class="flex gap-sm items-center">
        <input type="number" class="input" id="fleet-count" value="3" min="1" max="10" style="width:60px">
        <button class="btn btn-primary" id="btn-fleet">Start Fleet</button>
        <button class="btn btn-warning btn-sm" id="btn-restart-all">Restart All</button>
        <button class="btn btn-danger btn-sm" id="btn-stop-all">Stop All</button>
      </div>
    </div>

    <div class="session-grid" id="session-grid"></div>

    <div class="section-header" style="margin-top:1.5rem;margin-bottom:0.75rem">Network Peers</div>
    <div class="peer-grid" id="network-peer-grid"></div>
  `;

  document.getElementById('btn-fleet').addEventListener('click', startFleet);
  document.getElementById('btn-restart-all').addEventListener('click', restartAll);
  document.getElementById('btn-stop-all').addEventListener('click', stopAll);

  refresh();
  refreshTimer = setInterval(refresh, 5000);
}

function unmount() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

async function refresh() {
  try {
    const data = await dashboardApi('/status/aggregate');
    renderStats(data.sessions, data.network);
    renderGrid(data.sessions);
    renderNetworkPeers(data.network);
  } catch (err) {
    document.getElementById('session-grid').innerHTML = `<div class="empty">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderStats(sessions, network) {
  const running = sessions.filter(s => s.status === 'running' && !s.error);
  const uniquePeers = network?.uniqueCount ?? 0;
  const totalCtx = running.reduce((a, s) => a + (s.context?.entries ?? 0), 0);
  const totalJobs = running.reduce((a, s) => a + (s.jobs?.active ?? 0), 0);

  document.getElementById('stat-sessions').textContent = running.length;
  document.getElementById('stat-peers').textContent = `${network?.onlineCount ?? 0}/${uniquePeers}`;
  document.getElementById('stat-context').textContent = totalCtx;
  document.getElementById('stat-jobs').textContent = totalJobs;
}

function renderGrid(sessions) {
  const grid = document.getElementById('session-grid');
  grid.innerHTML = sessions.map(s => {
    const isRunning = s.status === 'running' && !s.error;
    const dotClass = isRunning ? 'online' : s.status === 'running' ? 'unknown' : 'offline';
    const cardClass = isRunning ? 'running' : 'stopped';

    return `
      <div class="session-card ${cardClass}">
        <div class="session-card-header">
          <div class="session-name">
            <span class="status-dot ${dotClass}"></span>
            ${escapeHtml(s.hostname || s.name)}
          </div>
          ${isRunning
            ? s.name !== 'main'
              ? `<div class="flex gap-sm">
                  <button class="btn btn-warning btn-sm" onclick="window.__restartSession('${escapeHtml(s.name)}')">Restart</button>
                  <button class="btn btn-danger btn-sm" onclick="window.__stopSession('${escapeHtml(s.name)}')">Stop</button>
                </div>`
              : ''
            : s.name !== 'main'
              ? `<button class="btn btn-success btn-sm" onclick="window.__startSession('${escapeHtml(s.name)}')">Start</button>`
              : ''
          }
        </div>
        <div class="session-meta">
          <span>port</span> ${s.port || '—'}
          &nbsp;&middot;&nbsp;
          <span>platform</span> ${s.platform || '—'}
          ${isRunning ? `
            <br>
            <span>peers</span> ${s.peers?.online ?? 0}/${s.peers?.total ?? 0}
            &nbsp;&middot;&nbsp;
            <span>jobs</span> ${s.jobs?.active ?? 0}
            &nbsp;&middot;&nbsp;
            <span>ctx</span> ${s.context?.entries ?? 0}
            <br>
            <span>uptime</span> ${formatUptime(s.uptime)}
          ` : ''}
          ${s.error ? `<br><span class="text-red">unreachable</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function renderNetworkPeers(network) {
  const grid = document.getElementById('network-peer-grid');
  if (!grid) return;
  const peers = network?.peers ?? [];

  if (peers.length === 0) {
    grid.innerHTML = '<div class="empty">No peers discovered</div>';
    return;
  }

  grid.innerHTML = peers.map(p => {
    const dotClass = p.status === 'online' ? 'online' : p.status === 'offline' ? 'offline' : 'unknown';
    const platformIcon = platformSvg(p.platform);

    return `
      <div class="peer-card">
        <div class="flex items-center justify-between mb-1">
          <div class="flex items-center gap-sm">
            <span class="status-dot ${dotClass}"></span>
            <span class="font-mono text-sm" style="font-weight:600">${escapeHtml(p.hostname)}</span>
          </div>
          ${platformIcon}
        </div>
        <div class="font-mono text-xs text-muted" style="line-height:1.7">
          ${escapeHtml(p.address)}:${p.port}<br>
          version ${escapeHtml(p.version || '?')}<br>
          last seen ${p.lastSeen ? new Date(p.lastSeen).toLocaleTimeString() : 'never'}
        </div>
      </div>
    `;
  }).join('');
}

async function startFleet() {
  const count = parseInt(document.getElementById('fleet-count').value) || 3;
  const btn = document.getElementById('btn-fleet');
  btn.disabled = true;
  try {
    await dashboardApi('/sessions', {
      method: 'POST',
      body: JSON.stringify({ fleet: true, count }),
    });
    await refresh();
  } catch (err) {
    alert('Failed: ' + err.message);
  }
  btn.disabled = false;
}

async function restartAll() {
  if (!confirm('Restart all sessions?')) return;
  const btn = document.getElementById('btn-restart-all');
  btn.disabled = true;
  try {
    await dashboardApi('/sessions/restart-all', { method: 'POST' });
    await new Promise(r => setTimeout(r, 1500));
    await refresh();
  } catch (err) {
    alert('Failed: ' + err.message);
  }
  btn.disabled = false;
}

async function stopAll() {
  if (!confirm('Stop all sessions?')) return;
  const btn = document.getElementById('btn-stop-all');
  btn.disabled = true;
  try {
    const { sessions } = await dashboardApi('/sessions');
    for (const s of sessions) {
      if (s.status === 'running') {
        try { await dashboardApi(`/sessions/${s.name}`, { method: 'DELETE' }); } catch {}
      }
    }
    await new Promise(r => setTimeout(r, 500));
    await refresh();
  } catch {}
  btn.disabled = false;
}

// Global handlers for inline onclick
window.__stopSession = async (name) => {
  try {
    await dashboardApi(`/sessions/${name}`, { method: 'DELETE' });
    await new Promise(r => setTimeout(r, 500));
    await refresh();
  } catch (err) { alert('Failed: ' + err.message); }
};

window.__restartSession = async (name) => {
  try {
    await dashboardApi(`/sessions/${name}/restart`, { method: 'POST' });
    await new Promise(r => setTimeout(r, 1500));
    await refresh();
  } catch (err) { alert('Failed: ' + err.message); }
};

window.__startSession = async (name) => {
  try {
    await dashboardApi('/sessions', { method: 'POST', body: JSON.stringify({ name }) });
    await new Promise(r => setTimeout(r, 500));
    await refresh();
  } catch (err) { alert('Failed: ' + err.message); }
};

registerView('overview', { mount, unmount });
