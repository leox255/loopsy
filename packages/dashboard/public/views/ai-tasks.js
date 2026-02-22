import { registerView, dashboardApi, escapeHtml, formatTime } from '/app.js';

let refreshTimer = null;
let selectedTask = null; // { taskId, port, address }
let eventSource = null;
let taskFinished = false; // true once we receive an exit event

function mount(container) {
  container.innerHTML = `
    <div class="section-header">AI Tasks</div>

    <div class="tabs">
      <div class="tab active" data-tab="dispatch">Dispatch</div>
      <div class="tab" data-tab="tasks">Active Tasks</div>
    </div>

    <div id="ai-content"></div>
  `;

  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
      if (t.dataset.tab === 'dispatch') {
        closeStream();
        selectedTask = null;
        renderDispatch();
      } else {
        renderTasks();
      }
    });
  });

  renderDispatch();
  refreshTimer = setInterval(refreshTasksIfVisible, 5000);
}

function unmount() {
  closeStream();
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

// ── Dispatch Form ──

async function renderDispatch() {
  const content = document.getElementById('ai-content');
  content.innerHTML = `
    <div class="form-row">
      <div class="form-group" style="flex:1">
        <div class="form-label">Target Peer</div>
        <select class="input" id="ai-target">
          <option value="">Loading peers...</option>
        </select>
      </div>
      <div class="form-group">
        <div class="form-label">Permission Mode</div>
        <select class="input" id="ai-perm-mode">
          <option value="default">Default (Human Approves)</option>
          <option value="acceptEdits">Accept Edits</option>
          <option value="bypassPermissions">Bypass All</option>
          <option value="dontAsk">Don't Ask (Skip)</option>
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group" style="flex:1">
        <div class="form-label">Model (optional)</div>
        <input class="input" id="ai-model" placeholder="e.g. sonnet, opus, haiku">
      </div>
      <div class="form-group">
        <div class="form-label">Max Budget USD (optional)</div>
        <input class="input" id="ai-budget" type="number" step="0.01" min="0" placeholder="e.g. 1.00">
      </div>
      <div class="form-group">
        <div class="form-label">Working Dir (optional)</div>
        <input class="input" id="ai-cwd" placeholder="e.g. /home/user/project">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group" style="flex:1">
        <div class="form-label">Prompt</div>
        <textarea class="textarea input" id="ai-prompt" rows="5" placeholder="Describe the task for Claude..."></textarea>
      </div>
    </div>
    <button class="btn btn-primary" id="btn-dispatch">Dispatch Task</button>
    <div id="dispatch-status" class="mt-1 text-sm"></div>
  `;

  loadPeers();
  document.getElementById('btn-dispatch').addEventListener('click', dispatchTask);
}

async function loadPeers() {
  const sel = document.getElementById('ai-target');
  if (!sel) return;
  try {
    const data = await dashboardApi('/peers/all');
    const peers = (data.peers || []).filter(p => p.status === 'online');
    // Also add local sessions
    const sessData = await dashboardApi('/sessions');
    const localSessions = [];
    if (sessData.main && sessData.main.status === 'running') localSessions.push(sessData.main);
    localSessions.push(...(sessData.sessions || []).filter(s => s.status === 'running'));

    let options = '';
    // Local sessions first
    options += '<optgroup label="Local Sessions">';
    for (const s of localSessions) {
      options += `<option value="${s.port}|127.0.0.1">${escapeHtml(s.hostname)} :${s.port}</option>`;
    }
    options += '</optgroup>';

    // Remote peers (exclude local ones)
    const remotePeers = peers.filter(p => p.address !== '127.0.0.1' && p.address !== 'localhost');
    if (remotePeers.length > 0) {
      options += '<optgroup label="Remote Peers">';
      for (const p of remotePeers) {
        options += `<option value="${p.port}|${escapeHtml(p.address)}">${escapeHtml(p.hostname)} (${escapeHtml(p.address)}:${p.port})</option>`;
      }
      options += '</optgroup>';
    }

    sel.innerHTML = options || '<option value="">No peers online</option>';
  } catch {
    sel.innerHTML = '<option value="">Failed to load</option>';
  }
}

async function dispatchTask() {
  const targetVal = document.getElementById('ai-target').value;
  const prompt = document.getElementById('ai-prompt').value.trim();
  const permissionMode = document.getElementById('ai-perm-mode').value;
  const model = document.getElementById('ai-model').value.trim();
  const budget = document.getElementById('ai-budget').value;
  const cwd = document.getElementById('ai-cwd').value.trim();
  const statusEl = document.getElementById('dispatch-status');

  if (!targetVal || !prompt) {
    statusEl.innerHTML = '<span class="text-red">Select a target and enter a prompt</span>';
    return;
  }

  const [port, address] = targetVal.split('|');

  statusEl.innerHTML = '<span class="text-muted">Dispatching...</span>';

  try {
    const body = {
      targetPort: parseInt(port),
      targetAddress: address,
      prompt,
      permissionMode,
    };
    if (model) body.model = model;
    if (budget) body.maxBudgetUsd = parseFloat(budget);
    if (cwd) body.cwd = cwd;

    const result = await dashboardApi('/ai-tasks/dispatch', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (result.taskId) {
      statusEl.innerHTML = `<span class="text-green">Dispatched! Task: ${escapeHtml(result.taskId.slice(0, 8))}...</span>`;
      // Switch to tasks tab and open the stream
      selectedTask = { taskId: result.taskId, port: parseInt(port), address };
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === 'tasks'));
      renderTaskStream();
    } else {
      statusEl.innerHTML = `<span class="text-red">${escapeHtml(result.error || 'Unknown error')}</span>`;
    }
  } catch (err) {
    statusEl.innerHTML = `<span class="text-red">Failed: ${escapeHtml(err.message)}</span>`;
  }
}

// ── Active Tasks List ──

async function renderTasks() {
  if (selectedTask) {
    renderTaskStream();
    return;
  }

  const content = document.getElementById('ai-content');
  content.innerHTML = '<div class="text-muted text-sm">Loading tasks...</div>';

  try {
    const data = await dashboardApi('/ai-tasks/all');
    const tasks = data.tasks || [];

    if (tasks.length === 0) {
      content.innerHTML = '<div class="empty">No AI tasks dispatched yet</div>';
      return;
    }

    content.innerHTML = tasks.map(t => {
      const badgeClass = statusBadgeClass(t.status);
      const promptPreview = t.prompt.length > 100 ? t.prompt.slice(0, 100) + '...' : t.prompt;
      const needsAttention = t.status === 'waiting_approval';

      return `
        <div class="msg-row${needsAttention ? ' needs-attention' : ''}" onclick="window.__selectTask('${escapeHtml(t.taskId)}', ${t._sourcePort || 19532})">
          <div class="msg-header">
            <span class="badge ${badgeClass}${needsAttention ? ' pulse' : ''}">${escapeHtml(t.status)}</span>
            <span class="msg-from">${escapeHtml(t._sourceHostname || 'unknown')}</span>
            <span class="msg-time">${formatTime(t.startedAt)}</span>
          </div>
          <div class="msg-body">${escapeHtml(promptPreview)}</div>
          ${t.model ? `<div class="text-xs text-muted mt-1">Model: ${escapeHtml(t.model)}</div>` : ''}
        </div>
      `;
    }).join('');
  } catch (err) {
    content.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
}

function refreshTasksIfVisible() {
  const activeTab = document.querySelector('.tab.active');
  if (activeTab?.dataset.tab === 'tasks' && !selectedTask) {
    renderTasks();
  }
}

// ── Task Stream + Approval ──

function renderTaskStream() {
  if (!selectedTask) return;
  const content = document.getElementById('ai-content');
  const { taskId, port } = selectedTask;

  content.innerHTML = `
    <div class="flex justify-between items-center mb-1">
      <button class="btn btn-sm" id="btn-back-tasks" style="border-color:var(--text-muted)">&#8592; Back</button>
      <span class="text-xs font-mono text-muted">Task: ${escapeHtml(taskId.slice(0, 12))}...</span>
      <button class="btn btn-sm btn-danger" id="btn-cancel-task">Cancel</button>
    </div>
    <div class="ai-terminal" id="ai-output"></div>
    <div id="ai-approval" style="display:none"></div>
  `;

  document.getElementById('btn-back-tasks').addEventListener('click', () => {
    closeStream();
    selectedTask = null;
    renderTasks();
  });
  document.getElementById('btn-cancel-task').addEventListener('click', cancelTask);

  connectStream(taskId, port);
}

async function connectStream(taskId, port) {
  closeStream();
  taskFinished = false;

  // Check if task is already finished before connecting — prevents
  // stale permission_request events from showing the approval banner
  try {
    const data = await dashboardApi('/ai-tasks/all');
    const task = (data.tasks || []).find(t => t.taskId === taskId);
    if (task && (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')) {
      taskFinished = true;
    }
  } catch {}

  const url = `/dashboard/api/ai-tasks/stream/${port}/${encodeURIComponent(taskId)}`;
  eventSource = new EventSource(url);

  eventSource.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      handleStreamEvent(event);
    } catch {}
  };

  eventSource.onerror = () => {
    appendLine('system', '[Connection closed]');
    closeStream();
  };
}

function handleStreamEvent(event) {
  const { type, data } = event;

  switch (type) {
    case 'text':
      appendLine('stdout', typeof data === 'string' ? data : JSON.stringify(data));
      break;
    case 'thinking':
      appendLine('thinking', typeof data === 'string' ? data : JSON.stringify(data));
      break;
    case 'tool_use':
      appendLine('tool-use', `Using ${data?.name || 'tool'}: ${truncateJson(data?.input)}`);
      break;
    case 'tool_result':
      appendLine('tool-result', formatToolResult(data));
      break;
    case 'permission_request':
      if (!taskFinished) showApprovalBanner(data);
      break;
    case 'status':
      appendLine('system', `Status: ${data?.status || JSON.stringify(data)}`);
      break;
    case 'error':
      appendLine('stderr', typeof data === 'string' ? data : JSON.stringify(data));
      break;
    case 'result':
      appendLine('result', data?.text || JSON.stringify(data));
      if (data?.cost) {
        appendLine('system', `Cost: $${data.cost.input || '?'} in + $${data.cost.output || '?'} out`);
      }
      break;
    case 'exit':
      taskFinished = true;
      appendLine('system', `Exited (code: ${data?.exitCode ?? '?'})`);
      // Hide any stale approval banner
      const approvalEl = document.getElementById('ai-approval');
      if (approvalEl) { approvalEl.style.display = 'none'; approvalEl.innerHTML = ''; }
      closeStream();
      break;
    default:
      appendLine('system', JSON.stringify(event));
  }
}

function showApprovalBanner(approval) {
  const el = document.getElementById('ai-approval');
  if (!el) return;

  el.style.display = 'block';
  el.innerHTML = `
    <div class="approval-banner">
      <div class="approval-header">
        <span class="badge badge-amber pulse">APPROVAL NEEDED</span>
        <span class="text-sm">${escapeHtml(approval.toolName || 'Unknown tool')}</span>
      </div>
      <div class="approval-desc">${escapeHtml(approval.description || 'Claude wants to use a tool')}</div>
      <div class="approval-input">
        <pre>${escapeHtml(typeof approval.toolInput === 'string' ? approval.toolInput : JSON.stringify(approval.toolInput, null, 2))}</pre>
      </div>
      <div class="approval-actions">
        <button class="btn btn-success" id="btn-approve">Approve</button>
        <button class="btn btn-danger" id="btn-deny">Deny</button>
      </div>
    </div>
  `;

  document.getElementById('btn-approve').addEventListener('click', () => {
    sendApproval(approval.requestId, true);
  });
  document.getElementById('btn-deny').addEventListener('click', () => {
    sendApproval(approval.requestId, false);
  });

  // Scroll to make it visible
  el.scrollIntoView({ behavior: 'smooth' });
}

async function sendApproval(requestId, approved) {
  if (!selectedTask) return;
  const { taskId, port } = selectedTask;

  const el = document.getElementById('ai-approval');
  if (el) {
    el.innerHTML = `<div class="text-muted text-sm">${approved ? 'Approving...' : 'Denying...'}</div>`;
  }

  try {
    await dashboardApi(`/ai-tasks/approve/${port}/${encodeURIComponent(taskId)}`, {
      method: 'POST',
      body: JSON.stringify({ requestId, approved }),
    });
    if (el) {
      el.style.display = 'none';
      el.innerHTML = '';
    }
    appendLine('system', approved ? 'Approved — resuming...' : 'Denied');
  } catch (err) {
    appendLine('stderr', `Approval failed: ${err.message}`);
  }
}

async function cancelTask() {
  if (!selectedTask) return;
  const { taskId, port } = selectedTask;
  try {
    await dashboardApi(`/ai-tasks/cancel/${port}/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
    appendLine('system', 'Task cancelled');
  } catch (err) {
    appendLine('stderr', `Cancel failed: ${err.message}`);
  }
}

function closeStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

// ── Terminal Helpers ──

function appendLine(cls, text) {
  const output = document.getElementById('ai-output');
  if (!output) return;
  const line = document.createElement('div');
  line.className = `ai-line ai-${cls}`;
  line.textContent = text;
  output.appendChild(line);
  output.scrollTop = output.scrollHeight;
}

function truncateJson(obj) {
  if (!obj) return '{}';
  const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return str.length > 200 ? str.slice(0, 200) + '...' : str;
}

function formatToolResult(data) {
  if (!data) return '';
  const content = data.content || data.output || '';
  if (typeof content === 'string') return content.length > 500 ? content.slice(0, 500) + '...' : content;
  return JSON.stringify(content).slice(0, 500);
}

function statusBadgeClass(status) {
  switch (status) {
    case 'running': return 'badge-cyan';
    case 'waiting_approval': return 'badge-amber';
    case 'completed': return 'badge-green';
    case 'failed': case 'cancelled': return 'badge-red';
    default: return 'badge-cyan';
  }
}

// ── Global handlers ──

window.__selectTask = (taskId, port) => {
  selectedTask = { taskId, port };
  renderTaskStream();
};

registerView('ai-tasks', { mount, unmount });
