import { registerView, api, dashboardApi, escapeHtml, formatTime } from '/app.js';

let refreshTimer = null;
let activeTab = 'inbox';

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
    sel.innerHTML = all.map(s => `<option value="${s.port}" data-hostname="${escapeHtml(s.hostname)}">${escapeHtml(s.hostname)} :${s.port}</option>`).join('');
    sel.addEventListener('change', loadMessages);
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
  const port = document.getElementById('msg-session').value;
  if (!port || activeTab === 'compose') return;

  const content = document.getElementById('msg-content');
  try {
    const prefix = activeTab === 'inbox' ? 'inbox:' : 'outbox:';
    const data = await api(port, `/context?prefix=${encodeURIComponent(prefix)}`);
    const entries = (data.entries || []).sort((a, b) => b.updatedAt - a.updatedAt);

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

      return `
        <div class="msg-row" onclick="window.__toggleMsg(${i})">
          <div class="msg-header">
            <span class="msg-from">${escapeHtml(from)}</span>
            <span class="badge ${badgeClass}">${escapeHtml(type)}</span>
            <span class="msg-time">${formatTime(ts)}</span>
          </div>
          <div class="msg-body" id="msg-body-${i}">${escapeHtml(truncate(body, 80))}</div>
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
        <div class="form-label">Peer Hostname</div>
        <input class="input" id="compose-peer" placeholder="e.g. kai">
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

  document.getElementById('btn-send').addEventListener('click', sendMessage);
}

async function sendMessage() {
  const port = document.getElementById('msg-session').value;
  const peerHostname = document.getElementById('compose-peer').value.trim();
  const type = document.getElementById('compose-type').value;
  const body = document.getElementById('compose-body').value.trim();
  const statusEl = document.getElementById('compose-status');

  if (!port || !peerHostname || !body) {
    statusEl.innerHTML = '<span class="text-red">Fill in all fields</span>';
    return;
  }

  // Get the session's hostname for 'from' field
  const sel = document.getElementById('msg-session');
  const opt = sel.options[sel.selectedIndex];
  const myHostname = opt?.dataset?.hostname || 'unknown';

  // Create message envelope
  const id = `${Date.now()}-${myHostname}-${Math.random().toString(16).slice(2, 6)}`;
  const envelope = { from: myHostname, to: peerHostname, ts: Date.now(), id, type, body };
  const value = JSON.stringify(envelope);
  const inboxKey = `inbox:${peerHostname}:${id}`;

  // We need to find the peer's port — check context for peer info, or try direct
  // For now, store in outbox locally and set inbox on same session (local messaging)
  try {
    // Store outbox
    await api(port, `/context/${encodeURIComponent('outbox:' + id)}`, {
      method: 'PUT',
      body: JSON.stringify({ value, ttl: 3600 }),
    });

    // Try to set inbox on same port (works for local sessions)
    await api(port, `/context/${encodeURIComponent(inboxKey)}`, {
      method: 'PUT',
      body: JSON.stringify({ value, ttl: 3600 }),
    });

    statusEl.innerHTML = `<span class="text-green">Sent! ID: ${escapeHtml(id)}</span>`;
    document.getElementById('compose-body').value = '';
  } catch (err) {
    statusEl.innerHTML = `<span class="text-red">Failed: ${escapeHtml(err.message)}</span>`;
  }
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + '...' : str;
}

window.__toggleMsg = (idx) => {
  const el = document.getElementById(`msg-body-${idx}`);
  const entry = window.__msgEntries?.[idx];
  if (!el || !entry) return;

  if (el.classList.contains('expanded')) {
    el.classList.remove('expanded');
    let body = entry.value;
    try { body = JSON.parse(entry.value).body || body; } catch {}
    el.textContent = truncate(body, 80);
  } else {
    el.classList.add('expanded');
    try {
      const env = JSON.parse(entry.value);
      el.textContent = env.body || entry.value;
    } catch {
      el.textContent = entry.value;
    }
  }
};

registerView('messages', { mount, unmount });
