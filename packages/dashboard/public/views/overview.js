import { registerView, dashboardApi, formatUptime, escapeHtml } from '/app.js';

let refreshTimer = null;

function mount(container) {
  container.innerHTML = `
    <div class="section-header">Command Center</div>
    <div class="stats-row" id="stats-row">
      <div class="stat-card"><div class="stat-value" id="stat-sessions">—</div><div class="stat-label">Sessions</div></div>
      <div class="stat-card"><div class="stat-value" id="stat-peers">—</div><div class="stat-label">Total Peers</div></div>
      <div class="stat-card"><div class="stat-value" id="stat-context">—</div><div class="stat-label">Context Entries</div></div>
      <div class="stat-card"><div class="stat-value" id="stat-jobs">—</div><div class="stat-label">Active Jobs</div></div>
    </div>

    <div class="flex items-center justify-between flex-wrap gap-sm mb-1">
      <div class="section-header" style="margin-bottom:0">Sessions</div>
      <div class="flex gap-sm items-center">
        <input type="number" class="input" id="fleet-count" value="3" min="1" max="10" style="width:60px">
        <button class="btn btn-primary" id="btn-fleet">Start Fleet</button>
        <button class="btn btn-danger btn-sm" id="btn-stop-all">Stop All</button>
      </div>
    </div>

    <div class="session-grid" id="session-grid"></div>
  `;

  document.getElementById('btn-fleet').addEventListener('click', startFleet);
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
    renderStats(data.sessions);
    renderGrid(data.sessions);
  } catch (err) {
    document.getElementById('session-grid').innerHTML = `<div class="empty">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderStats(sessions) {
  const running = sessions.filter(s => s.status === 'running' && !s.error);
  const totalPeers = running.reduce((a, s) => a + (s.peers?.total ?? 0), 0);
  const totalCtx = running.reduce((a, s) => a + (s.context?.entries ?? 0), 0);
  const totalJobs = running.reduce((a, s) => a + (s.jobs?.active ?? 0), 0);

  document.getElementById('stat-sessions').textContent = running.length;
  document.getElementById('stat-peers').textContent = totalPeers;
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
            ? `<button class="btn btn-danger btn-sm" onclick="window.__stopSession('${escapeHtml(s.name)}')">Stop</button>`
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

window.__startSession = async (name) => {
  try {
    await dashboardApi('/sessions', { method: 'POST', body: JSON.stringify({ name }) });
    await new Promise(r => setTimeout(r, 500));
    await refresh();
  } catch (err) { alert('Failed: ' + err.message); }
};

registerView('overview', { mount, unmount });
