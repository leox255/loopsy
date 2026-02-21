import { registerView, api, dashboardApi, escapeHtml, formatTime } from '/app.js';

let refreshTimer = null;

function mount(container) {
  container.innerHTML = `
    <div class="section-header">Context Browser</div>

    <div class="form-row mb-1">
      <div class="form-group">
        <select class="input" id="ctx-session"></select>
      </div>
      <div class="form-group">
        <input class="input" id="ctx-filter" placeholder="Filter by key prefix...">
      </div>
      <button class="btn btn-primary btn-sm" id="btn-ctx-refresh">Refresh</button>
    </div>

    <div id="ctx-table-wrap"></div>

    <div class="mt-1" style="border-top:1px solid var(--border-dim);padding-top:0.75rem">
      <div class="form-label mb-1">New Entry</div>
      <div class="form-row">
        <div class="form-group"><input class="input" id="ctx-new-key" placeholder="Key"></div>
        <div class="form-group"><input class="input" id="ctx-new-ttl" type="number" placeholder="TTL (sec)" style="width:100px"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><textarea class="textarea input" id="ctx-new-value" placeholder="Value" rows="2"></textarea></div>
        <button class="btn btn-success" id="btn-ctx-set">Set</button>
      </div>
    </div>
  `;

  loadSessions();
  document.getElementById('btn-ctx-refresh').addEventListener('click', loadEntries);
  document.getElementById('btn-ctx-set').addEventListener('click', setEntry);
  document.getElementById('ctx-filter').addEventListener('input', loadEntries);
  document.getElementById('ctx-session').addEventListener('change', loadEntries);

  refreshTimer = setInterval(loadEntries, 15000);
}

function unmount() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

async function loadSessions() {
  try {
    const { main, sessions } = await dashboardApi('/sessions');
    const sel = document.getElementById('ctx-session');
    const all = [];
    if (main && main.status === 'running') all.push(main);
    all.push(...sessions.filter(s => s.status === 'running'));
    sel.innerHTML = all.map(s => `<option value="${s.port}">${escapeHtml(s.hostname)} :${s.port}</option>`).join('');
    loadEntries();
  } catch {}
}

async function loadEntries() {
  const port = document.getElementById('ctx-session').value;
  const prefix = document.getElementById('ctx-filter').value.trim();
  if (!port) return;

  try {
    const path = prefix ? `/context?prefix=${encodeURIComponent(prefix)}` : '/context';
    const data = await api(port, path);
    renderTable(data.entries || []);
  } catch (err) {
    document.getElementById('ctx-table-wrap').innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
}

function renderTable(entries) {
  if (entries.length === 0) {
    document.getElementById('ctx-table-wrap').innerHTML = '<div class="empty">No context entries</div>';
    return;
  }

  const sorted = entries.sort((a, b) => a.key.localeCompare(b.key));
  document.getElementById('ctx-table-wrap').innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Key</th>
          <th>Value</th>
          <th class="hide-mobile">TTL</th>
          <th class="hide-mobile">Updated</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map((e, i) => `
          <tr>
            <td><span class="data-key" onclick="window.__toggleCtx(${i})">${escapeHtml(e.key)}</span></td>
            <td><div class="data-value" id="ctx-val-${i}">${escapeHtml(truncate(e.value, 60))}</div></td>
            <td class="hide-mobile text-muted text-xs">${e.ttl ? e.ttl + 's' : '—'}</td>
            <td class="hide-mobile text-muted text-xs">${formatTime(e.updatedAt)}</td>
            <td><button class="btn btn-danger btn-sm" onclick="window.__deleteCtx('${escapeHtml(e.key)}')">Del</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  // Store full values for expansion
  window.__ctxEntries = sorted;
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + '...' : str;
}

window.__toggleCtx = (idx) => {
  const el = document.getElementById(`ctx-val-${idx}`);
  const entry = window.__ctxEntries?.[idx];
  if (!el || !entry) return;

  if (el.classList.contains('expanded')) {
    el.classList.remove('expanded');
    el.textContent = truncate(entry.value, 60);
  } else {
    el.classList.add('expanded');
    // Try JSON pretty-print
    try {
      const parsed = JSON.parse(entry.value);
      el.textContent = JSON.stringify(parsed, null, 2);
    } catch {
      el.textContent = entry.value;
    }
  }
};

window.__deleteCtx = async (key) => {
  const port = document.getElementById('ctx-session').value;
  if (!port) return;
  try {
    await api(port, `/context/${encodeURIComponent(key)}`, { method: 'DELETE' });
    await loadEntries();
  } catch (err) {
    alert('Failed: ' + err.message);
  }
};

async function setEntry() {
  const port = document.getElementById('ctx-session').value;
  const key = document.getElementById('ctx-new-key').value.trim();
  const value = document.getElementById('ctx-new-value').value;
  const ttlStr = document.getElementById('ctx-new-ttl').value;
  const ttl = ttlStr ? parseInt(ttlStr) : undefined;

  if (!port || !key || !value) return;

  try {
    await api(port, `/context/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value, ttl }),
    });
    document.getElementById('ctx-new-key').value = '';
    document.getElementById('ctx-new-value').value = '';
    document.getElementById('ctx-new-ttl').value = '';
    await loadEntries();
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

registerView('context', { mount, unmount });
