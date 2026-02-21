import { registerView, api, dashboardApi, escapeHtml, formatTime } from '/app.js';

let refreshTimer = null;
let activeTab = 'inbox';
let expandedMsgIdx = null;

function mount(container) {
  container.innerHTML = `
    <div class="section-header">Messages</div>

    <div class="form-row mb-1">
      <div class="form-group">
        <select class="input" id="msg-session"></select>
      </div>
    </div>

    <div class="tabs">
      <div class="tab active" data-tab="inbox">Inbox</div>
      <div class="tab" data-tab="outbox">Outbox</div>
      <div class="tab" data-tab="compose">Compose</div>
    </div>

    <div id="msg-content"></div>
  `;

  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      activeTab = t.dataset.tab;
      expandedMsgIdx = null;
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
      renderTab();
    });
  });

  loadSessions();
  refreshTimer = setInterval(loadMessages, 10000);
}

function unmount() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

async function loadSessions() {
  try {
    const { main, sessions } = await dashboardApi('/sessions');
    const sel = document.getElementById('msg-session');
    const all = [];
    if (main && main.status === 'running') all.push(main);
    all.push(...sessions.filter(s => s.status === 'running'));
    sel.innerHTML =
      '<option value="all">All Sessions</option>' +
      all.map(s => `<option value="${s.port}" data-hostname="${escapeHtml(s.hostname)}">${escapeHtml(s.hostname)} :${s.port}</option>`).join('');
    sel.addEventListener('change', () => { expandedMsgIdx = null; loadMessages(); });
    renderTab();
  } catch {}
}

async function renderTab() {
  if (activeTab === 'compose') {
    renderCompose();
  } else {
    await loadMessages();
  }
}

async function loadMessages() {
  const portVal = document.getElementById('msg-session').value;
  if (!portVal || activeTab === 'compose') return;

  const content = document.getElementById('msg-content');
  try {
    let entries;
    if (portVal === 'all') {
      const data = await dashboardApi(`/messages/all?tab=${activeTab}`);
      entries = (data.entries || []).sort((a, b) => b.updatedAt - a.updatedAt);
    } else {
      const prefix = activeTab === 'inbox' ? 'inbox:' : 'outbox:';
      const data = await api(portVal, `/context?prefix=${encodeURIComponent(prefix)}`);
      entries = (data.entries || []).sort((a, b) => b.updatedAt - a.updatedAt);
    }

    if (entries.length === 0) {
      content.innerHTML = `<div class="empty">No ${activeTab} messages</div>`;
      return;
    }

    content.innerHTML = entries.map((e, i) => {
      let from = '?', body = e.value, type = '?', ts = e.updatedAt;
      try {
        const env = JSON.parse(e.value);
        from = env.from || '?';
        body = env.body || e.value;
        type = env.type || '?';
        ts = env.ts || e.updatedAt;
      } catch {}

      const badgeClass = type === 'chat' ? 'badge-cyan' : type === 'request' ? 'badge-amber' : type === 'response' ? 'badge-green' : 'badge-red';
      const isExpanded = expandedMsgIdx === i;
      const displayBody = isExpanded ? body : truncate(body, 80);

      return `
        <div class="msg-row" onclick="window.__toggleMsg(${i})">
          <div class="msg-header">
            <span class="msg-from">${escapeHtml(from)}</span>
            <span class="badge ${badgeClass}">${escapeHtml(type)}</span>
            <span class="msg-time">${formatTime(ts)}</span>
          </div>
          <div class="msg-body${isExpanded ? ' expanded' : ''}" id="msg-body-${i}">${escapeHtml(displayBody)}</div>
        </div>
      `;
    }).join('');

    window.__msgEntries = entries;
  } catch (err) {
    content.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
}

function renderCompose() {
  const content = document.getElementById('msg-content');
  content.innerHTML = `
    <div class="form-row">
      <div class="form-group">
        <div class="form-label">Send From</div>
        <select class="input" id="compose-from"></select>
      </div>
      <div class="form-group">
        <div class="form-label">Send To</div>
        <select class="input" id="compose-peer">
          <option value="">Loading peers...</option>
        </select>
      </div>
      <div class="form-group">
        <div class="form-label">Type</div>
        <select class="input" id="compose-type">
          <option value="chat">Chat</option>
          <option value="request">Request</option>
          <option value="response">Response</option>
          <option value="broadcast">Broadcast</option>
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <div class="form-label">Message</div>
        <textarea class="textarea input" id="compose-body" rows="3" placeholder="Type your message..."></textarea>
      </div>
    </div>
    <button class="btn btn-primary" id="btn-send">Send Message</button>
    <div id="compose-status" class="mt-1 text-sm"></div>
  `;

  // Populate "from" dropdown with specific sessions (no "all")
  const msgSel = document.getElementById('msg-session');
  const fromSel = document.getElementById('compose-from');
  fromSel.innerHTML = Array.from(msgSel.options)
    .filter(o => o.value !== 'all')
    .map(o => `<option value="${o.value}" data-hostname="${o.dataset?.hostname || ''}">${o.text}</option>`)
    .join('');

  loadPeersForCompose();
  document.getElementById('btn-send').addEventListener('click', sendMessage);
}

async function loadPeersForCompose() {
  const sel = document.getElementById('compose-peer');
  if (!sel) return;
  try {
    const data = await dashboardApi('/peers/all');
    const peers = (data.peers || []).filter(p => p.status === 'online');
    if (peers.length === 0) {
      sel.innerHTML = '<option value="">No online peers</option>';
    } else {
      sel.innerHTML = peers.map(p =>
        `<option value="${escapeHtml(p.hostname)}">${escapeHtml(p.hostname)} (${escapeHtml(p.address)}:${p.port})</option>`
      ).join('');
    }
  } catch {
    sel.innerHTML = '<option value="">Failed to load peers</option>';
  }
}

async function sendMessage() {
  const fromPort = document.getElementById('compose-from').value;
  const toHostname = document.getElementById('compose-peer').value;
  const type = document.getElementById('compose-type').value;
  const body = document.getElementById('compose-body').value.trim();
  const statusEl = document.getElementById('compose-status');

  if (!fromPort || !toHostname || !body) {
    statusEl.innerHTML = '<span class="text-red">Fill in all fields</span>';
    return;
  }

  statusEl.innerHTML = '<span class="text-muted">Sending...</span>';
  try {
    const result = await dashboardApi('/messages/send', {
      method: 'POST',
      body: JSON.stringify({ fromPort: parseInt(fromPort), toHostname, body, type }),
    });
    if (result.success) {
      statusEl.innerHTML = `<span class="text-green">Sent! ID: ${escapeHtml(result.id)}</span>`;
      document.getElementById('compose-body').value = '';
    } else {
      statusEl.innerHTML = `<span class="text-red">${escapeHtml(result.error || 'Unknown error')}</span>`;
    }
  } catch (err) {
    statusEl.innerHTML = `<span class="text-red">Failed: ${escapeHtml(err.message)}</span>`;
  }
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + '...' : str;
}

window.__toggleMsg = (idx) => {
  const entry = window.__msgEntries?.[idx];
  if (!entry) return;

  if (expandedMsgIdx === idx) {
    expandedMsgIdx = null;
  } else {
    if (expandedMsgIdx !== null) {
      const prevEl = document.getElementById(`msg-body-${expandedMsgIdx}`);
      const prevEntry = window.__msgEntries?.[expandedMsgIdx];
      if (prevEl && prevEntry) {
        prevEl.classList.remove('expanded');
        let prevBody = prevEntry.value;
        try { prevBody = JSON.parse(prevEntry.value).body || prevBody; } catch {}
        prevEl.textContent = truncate(prevBody, 80);
      }
    }
    expandedMsgIdx = idx;
  }

  const el = document.getElementById(`msg-body-${idx}`);
  if (!el) return;

  if (expandedMsgIdx === idx) {
    el.classList.add('expanded');
    try {
      const env = JSON.parse(entry.value);
      el.textContent = env.body || entry.value;
    } catch {
      el.textContent = entry.value;
    }
  } else {
    el.classList.remove('expanded');
    let body = entry.value;
    try { body = JSON.parse(entry.value).body || body; } catch {}
    el.textContent = truncate(body, 80);
  }
};

registerView('messages', { mount, unmount });
