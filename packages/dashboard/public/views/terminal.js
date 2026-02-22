import { registerView, dashboardApi, escapeHtml } from '../app.js';

let eventSource = null;
let refreshTimer = null;

function mount(container) {
  container.innerHTML = `
    <div class="section-header">Terminal</div>

    <div class="form-row mb-1">
      <div class="form-group">
        <div class="form-label">Session</div>
        <select class="input" id="term-session"></select>
      </div>
      <div class="form-group">
        <div class="form-label">Working Directory</div>
        <input class="input" id="term-cwd" placeholder="/ (optional)">
      </div>
    </div>

    <div class="prompt-bar">
      <span class="prompt-prefix" id="term-prompt">$</span>
      <input class="prompt-input" id="term-cmd" placeholder="Enter command..." autofocus>
      <button class="btn btn-primary btn-sm" id="btn-run">Run</button>
      <button class="btn btn-danger btn-sm" id="btn-cancel" style="display:none">Cancel</button>
    </div>

    <div class="terminal" id="term-output">
      <div class="terminal-line system">Ready. Select a session and enter a command.</div>
    </div>
  `;

  loadSessions();
  refreshTimer = setInterval(loadSessions, 10000);

  const cmdInput = document.getElementById('term-cmd');
  cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runCommand();
  });
  document.getElementById('btn-run').addEventListener('click', runCommand);
  document.getElementById('btn-cancel').addEventListener('click', cancelCommand);
  document.getElementById('term-session').addEventListener('change', updatePrompt);
}

function unmount() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

async function loadSessions() {
  try {
    const { main, sessions } = await dashboardApi('/sessions');
    const sel = document.getElementById('term-session');
    const currentVal = sel.value;
    const allSessions = [];
    if (main && main.status === 'running') allSessions.push(main);
    allSessions.push(...sessions.filter(s => s.status === 'running'));

    sel.innerHTML = allSessions.map(s =>
      `<option value="${s.port}" ${s.port == currentVal ? 'selected' : ''}>${escapeHtml(s.hostname)} :${s.port}</option>`
    ).join('');

    updatePrompt();
  } catch {}
}

function updatePrompt() {
  const sel = document.getElementById('term-session');
  const opt = sel.options[sel.selectedIndex];
  const hostname = opt ? opt.textContent.split(' :')[0] : '?';
  document.getElementById('term-prompt').textContent = `${hostname} $`;
}

function runCommand() {
  const port = document.getElementById('term-session').value;
  const cmd = document.getElementById('term-cmd').value.trim();
  const cwd = document.getElementById('term-cwd').value.trim();

  if (!cmd || !port) return;

  const output = document.getElementById('term-output');
  output.innerHTML = '';

  // Show command being run
  const promptText = document.getElementById('term-prompt').textContent;
  appendLine(output, `${promptText} ${cmd}`, 'system');

  // Disable/enable buttons
  document.getElementById('btn-run').style.display = 'none';
  document.getElementById('btn-cancel').style.display = '';
  document.getElementById('term-cmd').disabled = true;

  // Parse command: first word is command, rest are args
  const parts = cmd.split(/\s+/);
  const command = parts[0];
  const args = parts.slice(1);

  const url = `/dashboard/api/sse/execute/${port}?command=${encodeURIComponent(command)}&args=${encodeURIComponent(JSON.stringify(args))}${cwd ? '&cwd=' + encodeURIComponent(cwd) : ''}`;

  eventSource = new EventSource(url);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'stdout') {
        appendLine(output, data.data, 'stdout');
      } else if (data.type === 'stderr') {
        appendLine(output, data.data, 'stderr');
      } else if (data.type === 'exit') {
        const code = parseInt(data.data);
        appendLine(output, `\nProcess exited with code ${code}`, code === 0 ? 'exit-ok' : 'exit-err');
        finishCommand();
      } else if (data.type === 'error') {
        appendLine(output, `Error: ${data.data}`, 'exit-err');
        finishCommand();
      }
    } catch {}
  };

  eventSource.onerror = () => {
    appendLine(output, '\nConnection closed.', 'system');
    finishCommand();
  };
}

function cancelCommand() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  const output = document.getElementById('term-output');
  appendLine(output, '\n^C Cancelled.', 'exit-err');
  finishCommand();
}

function finishCommand() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  document.getElementById('btn-run').style.display = '';
  document.getElementById('btn-cancel').style.display = 'none';
  document.getElementById('term-cmd').disabled = false;
  document.getElementById('term-cmd').value = '';
  document.getElementById('term-cmd').focus();
}

function appendLine(container, text, className) {
  const div = document.createElement('div');
  div.className = `terminal-line ${className}`;
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

registerView('terminal', { mount, unmount });
