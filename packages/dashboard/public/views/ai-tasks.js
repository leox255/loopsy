import { registerView, dashboardApi, escapeHtml, formatTime } from '../app.js';

let refreshTimer = null;
let selectedTask = null; // { taskId, port, address }
let eventSource = null;
let taskFinished = false; // true once we receive an exit event
let resolvedRequestIds = new Set(); // track approved/denied requests to skip stale replays
let currentPendingRequestId = null; // the currently active pending request from the daemon

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
        <div class="form-label">Agent</div>
        <select class="input" id="ai-agent">
          <option value="auto">Auto-detect</option>
          <option value="claude">Claude Code</option>
          <option value="gemini">Gemini CLI</option>
          <option value="codex">Codex CLI</option>
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <div class="form-label">Permission Mode</div>
        <select class="input" id="ai-perm-mode">
          <option value="default">Default (Human Approves)</option>
          <option value="acceptEdits">Accept Edits</option>
          <option value="bypassPermissions">Bypass All</option>
          <option value="dontAsk">Don't Ask (Skip)</option>
        </select>
      </div>
      <div class="form-group">
        <div class="form-label">Model</div>
        <select class="input" id="ai-model">
          <option value="">Default</option>
          <option value="sonnet">Sonnet</option>
          <option value="opus">Opus</option>
          <option value="haiku">Haiku</option>
        </select>
      </div>
      <div class="form-group" style="flex:1">
        <div class="form-label">Working Dir (optional)</div>
        <input class="input" id="ai-cwd" placeholder="e.g. /home/user/project">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group" style="flex:1">
        <div class="form-label">Prompt</div>
        <textarea class="textarea input" id="ai-prompt" rows="5" placeholder="Describe the task..."></textarea>
      </div>
    </div>
    <button class="btn btn-primary" id="btn-dispatch">Dispatch Task</button>
    <div id="dispatch-status" class="mt-1 text-sm"></div>
  `;

  loadPeers();
  document.getElementById('btn-dispatch').addEventListener('click', dispatchTask);
  document.getElementById('ai-agent').addEventListener('change', onAgentChange);
  onAgentChange(); // set initial state
}

function onAgentChange() {
  const agent = document.getElementById('ai-agent').value;
  const modelSel = document.getElementById('ai-model');
  const permSel = document.getElementById('ai-perm-mode');

  // Dynamic model options
  const modelOptions = {
    auto: [['', 'Default']],
    claude: [['', 'Default'], ['sonnet', 'Sonnet'], ['opus', 'Opus'], ['haiku', 'Haiku']],
    gemini: [['', 'Default'], ['gemini-2.5-pro', 'Gemini 2.5 Pro'], ['gemini-2.5-flash', 'Gemini 2.5 Flash']],
    codex: [['', 'Default'], ['gpt-5-codex', 'GPT-5 Codex'], ['o3', 'o3']],
  };
  const models = modelOptions[agent] || modelOptions.auto;
  modelSel.innerHTML = models.map(([val, label]) => `<option value="${val}">${escapeHtml(label)}</option>`).join('');

  // Dynamic permission mode options
  if (agent === 'gemini' || agent === 'codex') {
    permSel.innerHTML = `
      <option value="acceptEdits">Accept Edits</option>
      <option value="bypassPermissions">Bypass All</option>
    `;
  } else {
    permSel.innerHTML = `
      <option value="default">Default (Human Approves)</option>
      <option value="acceptEdits">Accept Edits</option>
      <option value="bypassPermissions">Bypass All</option>
      <option value="dontAsk">Don't Ask (Skip)</option>
    `;
  }
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
  const model = document.getElementById('ai-model').value;
  const agent = document.getElementById('ai-agent').value;
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
      agent,
    };
    if (model) body.model = model;
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

      const agentBadge = t.agent ? `<span class="badge badge-muted" style="margin-left:4px;font-size:0.7em">${escapeHtml(t.agent)}</span>` : '';

      return `
        <div class="msg-row${needsAttention ? ' needs-attention' : ''}" onclick="window.__selectTask('${escapeHtml(t.taskId)}', ${t._sourcePort || 19532}, '${escapeHtml(t._sourceAddress || '127.0.0.1')}')">
          <div class="msg-header">
            <span class="badge ${badgeClass}${needsAttention ? ' pulse' : ''}">${escapeHtml(t.status)}</span>${agentBadge}
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

async function renderTaskStream() {
  if (!selectedTask) return;
  const content = document.getElementById('ai-content');
  const { taskId, port } = selectedTask;

  content.innerHTML = `
    <div class="flex justify-between items-center mb-1">
      <button class="btn btn-sm" id="btn-back-tasks" style="border-color:var(--text-secondary);color:var(--text-secondary)"><svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px"><polyline points="12,3 6,9 12,15"/></svg>Back</button>
      <button class="btn btn-sm btn-danger" id="btn-cancel-task">Cancel</button>
    </div>
    <div class="task-info">
      <div class="task-info-header">
        <span class="badge badge-cyan" id="task-status-badge">loading</span>
        <span class="text-xs font-mono text-muted">Task: ${escapeHtml(taskId.slice(0, 12))}...</span>
      </div>
      <div class="task-info-prompt" id="task-prompt">Loading...</div>
      <div class="task-info-meta" id="task-meta"></div>
    </div>
    <div class="ai-terminal" id="ai-output"></div>
    <div id="ai-approval" style="display:none"></div>
    <div id="ai-followup" style="display:none"></div>
  `;

  document.getElementById('btn-back-tasks').addEventListener('click', () => {
    closeStream();
    selectedTask = null;
    renderTasks();
  });
  document.getElementById('btn-cancel-task').addEventListener('click', cancelTask);

  // Fetch task info for header
  try {
    const data = await dashboardApi('/ai-tasks/all');
    const task = (data.tasks || []).find(t => t.taskId === taskId);
    if (task) {
      updateStatusBadge(task.status);
      document.getElementById('task-prompt').textContent = task.prompt;
      const meta = [];
      if (task.agent) meta.push(`Agent: ${task.agent}`);
      if (task.model) meta.push(`Model: ${task.model}`);
      if (task._sourceHostname) meta.push(`Host: ${task._sourceHostname}`);
      if (task.startedAt) meta.push(formatTime(task.startedAt));
      const metaEl = document.getElementById('task-meta');
      if (metaEl) metaEl.textContent = meta.join(' \u00b7 ');
    }
  } catch {}

  connectStream(taskId, port, selectedTask.address);
}

function updateStatusBadge(status) {
  const badge = document.getElementById('task-status-badge');
  if (!badge) return;
  badge.textContent = status;
  badge.className = `badge ${statusBadgeClass(status)}`;
}

async function connectStream(taskId, port, address) {
  closeStream();
  taskFinished = false;
  resolvedRequestIds = new Set();
  currentPendingRequestId = null;

  // Check task state before connecting — detect finished tasks and
  // identify which permission request (if any) is actually pending
  try {
    const data = await dashboardApi('/ai-tasks/all');
    const task = (data.tasks || []).find(t => t.taskId === taskId);
    if (task) {
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        taskFinished = true;
      }
      // Track which request is actually pending right now
      if (task.pendingApproval?.requestId) {
        currentPendingRequestId = task.pendingApproval.requestId;
      }
    }
  } catch {}

  const addrParam = address ? `&address=${encodeURIComponent(address)}` : '';
  const url = `/dashboard/api/ai-tasks/stream/${port}/${encodeURIComponent(taskId)}?since=0${addrParam}`;
  eventSource = new EventSource(url);

  eventSource.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      handleStreamEvent(event);
    } catch {}
  };

  eventSource.onerror = () => {
    closeStream();
    // Auto-reconnect if the task is still running
    if (!taskFinished && selectedTask) {
      appendLine('system', '[Reconnecting...]');
      setTimeout(() => {
        if (!taskFinished && selectedTask && selectedTask.taskId === taskId) {
          connectStream(taskId, port, address);
        }
      }, 2000);
    } else {
      appendLine('system', '[Connection closed]');
    }
  };
}

function handleStreamEvent(event) {
  const { type, data } = event;

  // Filter system init and user echo noise
  if (type === 'text' || type === 'default') {
    if (typeof data === 'object' && data !== null) {
      if (data.type === 'system' && data.subtype === 'init') return;
      if (data.type === 'user') return;
    }
    if (typeof data === 'string') {
      // Try parsing JSON strings that are init/user payloads
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'system' && parsed.subtype === 'init') return;
        if (parsed.type === 'user') return;
      } catch {}
      // Skip empty text
      if (!data.trim()) return;
    }
  }

  switch (type) {
    case 'text':
      appendLine('stdout', typeof data === 'string' ? data : (data?.text || JSON.stringify(data)));
      break;
    case 'thinking':
      appendLine('thinking', typeof data === 'string' ? data : JSON.stringify(data));
      break;
    case 'tool_use': {
      const name = data?.name || 'tool';
      const input = data?.input;
      let desc = '';
      if (input) {
        // Show concise tool description
        if (input.command) desc = input.command;
        else if (input.file_path) desc = input.file_path;
        else if (input.pattern) desc = input.pattern;
        else if (input.query) desc = input.query;
        else if (input.url) desc = input.url;
        else {
          const str = typeof input === 'string' ? input : JSON.stringify(input);
          desc = str.length > 100 ? str.slice(0, 100) + '...' : str;
        }
      }
      appendLine('tool-use', `\u25b6 ${name}${desc ? ': ' + desc : ''}`);
      break;
    }
    case 'tool_result': {
      const result = formatToolResult(data);
      if (result) appendLine('tool-result', result);
      break;
    }
    case 'permission_request': {
      const reqId = data?.requestId;
      if (!taskFinished && reqId && !resolvedRequestIds.has(reqId)) {
        // Only show if this is the actually pending request (or a new live one)
        if (!currentPendingRequestId || reqId === currentPendingRequestId) {
          showApprovalBanner(data);
        }
      }
      break;
    }
    case 'status':
      updateStatusBadge(data?.status || 'running');
      // When a permission is resolved, hide the banner and track it
      if (data?.approved !== undefined) {
        const approvalEl = document.getElementById('ai-approval');
        if (approvalEl) { approvalEl.style.display = 'none'; approvalEl.innerHTML = ''; }
        // After seeing an approval status, any prior permission_request is resolved
        currentPendingRequestId = null;
      }
      break;
    case 'error':
      appendLine('stderr', typeof data === 'string' ? data : JSON.stringify(data));
      break;
    case 'result': {
      const parts = [];
      if (data?.cost) {
        parts.push(`Cost: $${data.cost.input || '?'} in + $${data.cost.output || '?'} out`);
      }
      if (data?.duration) parts.push(`Duration: ${formatDuration(data.duration)}`);
      if (parts.length > 0) appendLine('result', parts.join('  \u00b7  '));
      updateStatusBadge('completed');
      showFollowUpInput();
      break;
    }
    case 'exit':
      taskFinished = true;
      updateStatusBadge(data?.exitCode === 0 ? 'completed' : 'failed');
      if (data?.exitCode !== 0) {
        appendLine('stderr', `Exited with code ${data?.exitCode ?? '?'}`);
      }
      // Hide any stale approval banner
      const approvalEl = document.getElementById('ai-approval');
      if (approvalEl) { approvalEl.style.display = 'none'; approvalEl.innerHTML = ''; }
      // Show follow-up input for completed tasks
      if (data?.exitCode === 0) showFollowUpInput();
      closeStream();
      break;
    default:
      // Skip unknown event types silently instead of dumping raw JSON
      break;
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
  const { taskId, port, address } = selectedTask;
  const addrParam = address ? `?address=${encodeURIComponent(address)}` : '';

  const el = document.getElementById('ai-approval');
  if (el) {
    el.innerHTML = `<div class="text-muted text-sm">${approved ? 'Approving...' : 'Denying...'}</div>`;
  }

  try {
    await dashboardApi(`/ai-tasks/approve/${port}/${encodeURIComponent(taskId)}${addrParam}`, {
      method: 'POST',
      body: JSON.stringify({ requestId, approved }),
    });
    resolvedRequestIds.add(requestId);
    currentPendingRequestId = null;
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
  const { taskId, port, address } = selectedTask;
  const addrParam = address ? `?address=${encodeURIComponent(address)}` : '';
  try {
    await dashboardApi(`/ai-tasks/cancel/${port}/${encodeURIComponent(taskId)}${addrParam}`, { method: 'DELETE' });
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

// ── Follow-up Input ──

function showFollowUpInput() {
  if (!selectedTask) return;
  const el = document.getElementById('ai-followup');
  if (!el) return;
  el.style.display = 'block';
  el.innerHTML = `
    <div class="followup-bar">
      <textarea class="textarea input" id="followup-prompt" rows="2" placeholder="Send a follow-up message..."></textarea>
      <div class="followup-actions"><button class="btn btn-primary btn-sm" id="btn-followup">Send</button></div>
    </div>
  `;
  document.getElementById('btn-followup').addEventListener('click', sendFollowUp);
  document.getElementById('followup-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFollowUp(); }
  });
  el.scrollIntoView({ behavior: 'smooth' });
}

function collectConversationHistory() {
  const output = document.getElementById('ai-output');
  if (!output) return '';
  const lines = [];
  for (const el of output.children) {
    if (el.classList.contains('ai-stdout')) {
      lines.push(`Assistant: ${el.textContent}`);
    } else if (el.classList.contains('ai-tool-use')) {
      lines.push(`[Tool: ${el.textContent}]`);
    }
  }
  return lines.join('\n');
}

async function sendFollowUp() {
  if (!selectedTask) return;
  const promptEl = document.getElementById('followup-prompt');
  const prompt = promptEl?.value?.trim();
  if (!prompt) return;

  const { port, address } = selectedTask;
  const btnEl = document.getElementById('btn-followup');
  if (btnEl) btnEl.disabled = true;

  // Build context-enriched prompt with conversation history
  const history = collectConversationHistory();
  const contextPrompt = history
    ? `Here is our conversation so far:\n\n${history}\n\nUser follow-up: ${prompt}`
    : prompt;

  try {
    const body = {
      targetPort: port,
      targetAddress: address,
      prompt: contextPrompt,
      permissionMode: 'default',
    };

    const result = await dashboardApi('/ai-tasks/dispatch', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (result.taskId) {
      // Hide follow-up bar, switch to new task stream
      const el = document.getElementById('ai-followup');
      if (el) { el.style.display = 'none'; el.innerHTML = ''; }
      selectedTask = { taskId: result.taskId, port, address };
      appendLine('system', `Follow-up dispatched: ${result.taskId.slice(0, 8)}...`);
      taskFinished = false;
      connectStream(result.taskId, port, address);
    }
  } catch (err) {
    appendLine('stderr', `Follow-up failed: ${err.message}`);
    if (btnEl) btnEl.disabled = false;
  }
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// ── Terminal Helpers ──

function renderMarkdown(text) {
  // Escape HTML first, then apply markdown transformations
  let html = escapeHtml(text);
  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold (**text** or __text__)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  // Italic (*text* or _text_) — but not inside words with underscores
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Headers (# text)
  html = html.replace(/^### (.+)$/gm, '<strong style="font-size:1em">$1</strong>');
  html = html.replace(/^## (.+)$/gm, '<strong style="font-size:1.05em">$1</strong>');
  html = html.replace(/^# (.+)$/gm, '<strong style="font-size:1.1em">$1</strong>');
  // Bullet lists
  html = html.replace(/^[-*] (.+)$/gm, '&bull; $1');
  // Numbered lists
  html = html.replace(/^\d+\. (.+)$/gm, '&middot; $1');
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  return html;
}

function appendLine(cls, text, isResult = false) {
  const output = document.getElementById('ai-output');
  if (!output) return;
  const line = document.createElement('div');
  line.className = `ai-line ai-${cls}`;
  if (isResult || cls === 'stdout') {
    line.innerHTML = renderMarkdown(text);
    line.style.whiteSpace = 'pre-wrap';
  } else {
    line.textContent = text;
  }
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
  if (!content) return '';
  const str = typeof content === 'string' ? content : JSON.stringify(content);
  if (!str.trim()) return '';
  return str.length > 200 ? str.slice(0, 200) + '...' : str;
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

window.__selectTask = (taskId, port, address) => {
  selectedTask = { taskId, port, address: address || '127.0.0.1' };
  renderTaskStream();
};

registerView('ai-tasks', { mount, unmount });
