import { registerView, api, dashboardApi, escapeHtml, formatTime } from '/app.js';

let refreshTimer = null;

function mount(container) {
  container.innerHTML = `
    <div class="section-header">Peer Network</div>

    <div class="form-row mb-1">
      <div class="form-group">
        <select class="input" id="peers-session"></select>
      </div>
      <button class="btn btn-primary btn-sm" id="btn-peers-refresh">Refresh</button>
    </div>

    <div class="peer-grid" id="peer-grid"></div>

    <div class="mt-1" style="border-top:1px solid var(--border-dim);padding-top:0.75rem">
      <div class="form-label mb-1">Add Peer</div>
      <div class="form-row">
        <div class="form-group"><input class="input" id="peer-address" placeholder="IP address"></div>
        <div class="form-group"><input class="input" id="peer-port" type="number" placeholder="Port" value="19532" style="width:100px"></div>
        <button class="btn btn-success" id="btn-add-peer">Add</button>
      </div>
    </div>
  `;

  loadSessions();
  document.getElementById('btn-peers-refresh').addEventListener('click', loadPeers);
  document.getElementById('btn-add-peer').addEventListener('click', addPeer);
  document.getElementById('peers-session').addEventListener('change', loadPeers);

  refreshTimer = setInterval(loadPeers, 15000);
}

function unmount() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

async function loadSessions() {
  try {
    const { main, sessions } = await dashboardApi('/sessions');
    const sel = document.getElementById('peers-session');
    const all = [];
    if (main && main.status === 'running') all.push(main);
    all.push(...sessions.filter(s => s.status === 'running'));
    sel.innerHTML =
      '<option value="all">All Sessions</option>' +
      all.map(s => `<option value="${s.port}">${escapeHtml(s.hostname)} :${s.port}</option>`).join('');
    loadPeers();
  } catch {}
}

async function loadPeers() {
  const portVal = document.getElementById('peers-session').value;
  const grid = document.getElementById('peer-grid');

  try {
    let peers;
    if (portVal === 'all') {
      const data = await dashboardApi('/peers/all');
      peers = data.peers || [];
    } else {
      if (!portVal) return;
      const data = await api(portVal, '/peers');
      peers = data.peers || [];
    }

    if (peers.length === 0) {
      grid.innerHTML = '<div class="empty">No peers discovered</div>';
      return;
    }

    grid.innerHTML = peers.map(p => {
      const dotClass = p.status === 'online' ? 'online' : p.status === 'offline' ? 'offline' : 'unknown';
      const platformIcon = p.platform === 'darwin' ? '&#63743;' : p.platform === 'win32' ? '&#8862;' : p.platform === 'linux' ? '&#9881;' : '&#63;';

      return `
        <div class="peer-card">
          <div class="flex items-center justify-between mb-1">
            <div class="flex items-center gap-sm">
              <span class="status-dot ${dotClass}"></span>
              <span class="font-mono text-sm" style="font-weight:600">${escapeHtml(p.hostname)}</span>
            </div>
            <span style="font-size:1.1rem">${platformIcon}</span>
          </div>
          <div class="font-mono text-xs text-muted" style="line-height:1.7">
            ${escapeHtml(p.address)}:${p.port}<br>
            version ${escapeHtml(p.version || '?')}<br>
            last seen ${p.lastSeen ? formatTime(p.lastSeen) : 'never'}<br>
            ${p.manuallyAdded ? '<span class="badge badge-amber">manual</span>' : ''}
            ${p.capabilities?.length ? p.capabilities.map(c => `<span class="badge badge-cyan">${escapeHtml(c)}</span>`).join(' ') : ''}
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    grid.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
}

async function addPeer() {
  const portVal = document.getElementById('peers-session').value;
  if (portVal === 'all') {
    alert('Select a specific session to add a peer');
    return;
  }

  const address = document.getElementById('peer-address').value.trim();
  const peerPort = parseInt(document.getElementById('peer-port').value) || 19532;

  if (!portVal || !address) return;

  try {
    await api(portVal, '/peers', {
      method: 'POST',
      body: JSON.stringify({ address, port: peerPort }),
    });
    document.getElementById('peer-address').value = '';
    await loadPeers();
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

registerView('peers', { mount, unmount });
