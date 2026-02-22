import { registerView, api, dashboardApi, escapeHtml, formatTime } from '../app.js';

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
let allPeers = []; // cached peer list for selection
let selectedPeers = new Set(); // nodeIds of selected peers

function mount(container) {
  container.innerHTML = `
    <div class="section-header">Peer Network</div>

    <div class="form-row mb-1">
      <div class="form-group">
        <select class="input" id="peers-session"></select>
      </div>
      <div class="flex gap-sm items-center">
        <button class="btn btn-primary btn-sm" id="btn-peers-refresh">Refresh</button>
        <button class="btn btn-danger btn-sm" id="btn-delete-peers" style="display:none">Delete Selected</button>
      </div>
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
  document.getElementById('btn-delete-peers').addEventListener('click', deleteSelectedPeers);

  refreshTimer = setInterval(loadPeers, 15000);
}

function unmount() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  selectedPeers.clear();
  allPeers = [];
}

async function loadSessions() {
  try {
    const { main, sessions } = await dashboardApi('/sessions');
    const sel = document.getElementById('peers-session');
    const all = [];
    if (main && main.status === 'running') all.push(main);
    all.push(...sessions.filter(s => s.status === 'running'));
    sel.innerHTML =
      '<option value="all">All Sessions (deduplicated)</option>' +
      all.map(s => `<option value="${s.port}">${escapeHtml(s.hostname || s.name)} :${s.port} (raw)</option>`).join('');
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

    allPeers = peers;

    // Clean up selected peers that no longer exist
    const currentNodeIds = new Set(peers.map(p => p.nodeId));
    for (const id of selectedPeers) {
      if (!currentNodeIds.has(id)) selectedPeers.delete(id);
    }

    if (peers.length === 0) {
      grid.innerHTML = '<div class="empty">No peers discovered</div>';
      updateDeleteButton();
      return;
    }

    grid.innerHTML = peers.map(p => {
      const dotClass = p.status === 'online' ? 'online' : p.status === 'offline' ? 'offline' : 'unknown';
      const platformIcon = platformSvg(p.platform);
      const isSelected = selectedPeers.has(p.nodeId);
      const displayName = p.hostname || p.nodeId || p.address || 'unknown';

      return `
        <div class="peer-card ${isSelected ? 'peer-selected' : ''}" data-node-id="${escapeHtml(p.nodeId)}" onclick="window.__togglePeer('${escapeHtml(p.nodeId)}')">
          <div class="flex items-center justify-between mb-1">
            <div class="flex items-center gap-sm">
              <input type="checkbox" class="peer-check" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); window.__togglePeer('${escapeHtml(p.nodeId)}')">
              <span class="status-dot ${dotClass}"></span>
              <span class="font-mono text-sm" style="font-weight:600">${escapeHtml(displayName)}</span>
            </div>
            ${platformIcon}
          </div>
          <div class="font-mono text-xs text-muted" style="line-height:1.7">
            ${escapeHtml(p.address)}:${p.port}<br>
            version ${escapeHtml(p.version || '?')}<br>
            last seen ${p.lastSeen ? formatTime(p.lastSeen) : 'never'}<br>
            ${p.nodeId ? `<span class="text-xs text-muted">${escapeHtml(p.nodeId)}</span><br>` : ''}
            ${p.manuallyAdded ? '<span class="badge badge-amber">manual</span>' : ''}
            ${p.capabilities?.length ? p.capabilities.map(c => `<span class="badge badge-cyan">${escapeHtml(c)}</span>`).join(' ') : ''}
          </div>
        </div>
      `;
    }).join('');

    updateDeleteButton();
  } catch (err) {
    grid.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
}

function updateDeleteButton() {
  const btn = document.getElementById('btn-delete-peers');
  if (!btn) return;
  if (selectedPeers.size > 0) {
    btn.style.display = '';
    btn.textContent = `Delete Selected (${selectedPeers.size})`;
  } else {
    btn.style.display = 'none';
  }
}

window.__togglePeer = (nodeId) => {
  if (selectedPeers.has(nodeId)) {
    selectedPeers.delete(nodeId);
  } else {
    selectedPeers.add(nodeId);
  }
  // Update UI without full reload
  const card = document.querySelector(`[data-node-id="${nodeId}"]`);
  if (card) {
    card.classList.toggle('peer-selected', selectedPeers.has(nodeId));
    const check = card.querySelector('.peer-check');
    if (check) check.checked = selectedPeers.has(nodeId);
  }
  updateDeleteButton();
};

async function deleteSelectedPeers() {
  if (selectedPeers.size === 0) return;
  if (!confirm(`Delete ${selectedPeers.size} peer(s) from all sessions?`)) return;

  const btn = document.getElementById('btn-delete-peers');
  if (btn) btn.disabled = true;

  const peersToDelete = allPeers
    .filter(p => selectedPeers.has(p.nodeId))
    .map(p => ({ nodeId: p.nodeId, address: p.address, port: p.port, _seenBySessions: p._seenBySessions }));

  try {
    await dashboardApi('/peers/delete', {
      method: 'POST',
      body: JSON.stringify({ peers: peersToDelete }),
    });
    selectedPeers.clear();
    await loadPeers();
  } catch (err) {
    alert('Failed: ' + err.message);
  }

  if (btn) btn.disabled = false;
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
