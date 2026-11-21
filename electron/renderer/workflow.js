// Workflow panel: stage 1 shows HPC3 readiness; buttons run one setup step each.
'use strict';
(() => {
  const panel = document.getElementById('workflow');
  if (!panel) return;
  const list = document.getElementById('workflow-items');
  const summary = document.getElementById('workflow-summary');
  const notice = document.getElementById('workflow-message');
  const checkButton = document.getElementById('workflow-check');
  const stageStatus = document.getElementById('workflow-environment-status');
  const items = [
    {id: 'hpc', label: "HPC3 environment", parts: ['connection', 'workspace', 'slurm', 'apptainer'],
     hint: "Connect with the SSH panel at the top right."},
    {id: 'signet_source', label: "SIGNET source code", button: "Install", install: true},
    {id: 'container', label: "SIGNET container", button: "Download", action: 'container'},
  ];
  const statusText = {ok: "Ready", missing: "Missing", problem: "Problem", in_progress: "In progress", unknown: "Not checked"};
  const severity = ['ok', 'in_progress', 'missing', 'problem'];
  const bridge = window.signetDesktop.environment;
  const inProgress = ['checking', 'installing-source', 'verifying'];
  let busy = false, checked = false, latest = null, generation = 0;
  let environment = {phase: 'disconnected', message: ''};
  const token = () => document.querySelector('meta[name="chat-token"]').content;

  function element(tag, className, source) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (source !== undefined) el.textContent = source;
    return el;
  }

  function say(source, kind = '') {
    notice.hidden = !source;
    notice.className = 'workflow-message ' + kind;
    if (source) notice.textContent = source;
  }

  async function call(path, body = {}) {
    const response = await fetch(path, {method: 'POST', body: JSON.stringify(body),
      headers: {'Content-Type': 'application/json', 'X-Chat-Token': token()}});
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "The local service rejected the request.");
    return value;
  }

  function actionButton(item) {
    const button = element('button', 'workflow-action', item.button);
    button.type = 'button';
    button.disabled = busy || inProgress.includes(environment.phase);
    button.addEventListener('click', () => item.install ? install(item) : run(item));
    return button;
  }

  // A folded row reports the worst part; its detail lists only the parts that need attention.
  function combined(item, checks) {
    if (!item.parts) return {check: checks.get(item.id), item};
    const parts = item.parts.map(id => checks.get(id)).filter(Boolean);
    if (!parts.length) return {item};
    const status = parts.reduce((worst, part) => severity.indexOf(part.status) > severity.indexOf(worst) ? part.status : worst, 'ok');
    const pending = parts.filter(part => part.status !== 'ok');
    const detail = (pending.length ? pending : parts.filter(part => part.item === 'connection')).map(part => part.detail).join(' · ');
    return {check: {status, detail}, item};
  }

  // Draws every item from the latest check; rows without a result show "not checked".
  function render() {
    const checks = new Map((latest?.checks || []).map(check => [check.item, check]));
    const rows = items.map(base => combined(base, checks));
    list.replaceChildren(...rows.map(({check, item}) => {
      const status = check?.status || 'unknown';
      const row = element('li', 'workflow-item');
      row.dataset.status = status;
      const text = element('div', 'workflow-item-text');
      text.append(element('span', 'workflow-item-label', item.label));
      // Backend details are technical evidence (paths, sizes, commits) and stay untranslated.
      if (check?.detail) text.append(Object.assign(element('span', 'workflow-item-detail'), {textContent: check.detail}));
      if (status === 'unknown' && item.hint) text.append(element('span', 'workflow-item-detail', item.hint));
      row.append(element('span', 'workflow-badge', statusText[status] || status), text);
      if (item.button && (status === 'missing' || (status === 'problem' && !item.install))) row.append(actionButton(item));
      return row;
    }));
    checkButton.disabled = busy || inProgress.includes(environment.phase);
    if (latest) {
      const ready = rows.filter(row => row.check?.status === 'ok').length;
      summary.textContent = `Environment: ${ready}/${items.length} ready`;
      stageStatus.textContent = `${ready}/${items.length}`;
    }
  }

  // Failures of the environment itself stay visible beside the per-item results.
  const environmentProblem = () => ['blocked', 'error'].includes(environment.phase) ? environment.message : '';

  // Reads each item's state from HPC3. Works before the environment is verified, so it can show what is missing.
  async function inspect() {
    if (busy) return;
    busy = true;
    render();
    const current = generation;
    say("Checking HPC3…");
    try {
      const result = await call('/hpc/check');
      if (current !== generation) return;
      checked = true;
      if (result.status !== 'ok') {
        latest = null;
        summary.textContent = environment.phase === 'disconnected' ? "HPC3 not connected" : result.status === 'not_ready' ? "Environment not ready" : "HPC3 cannot be checked right now.";
        say(result.reason || result.error || "HPC3 cannot be checked right now.", 'warning');
        return;
      }
      latest = result;
      const running = result.checks.some(item => item.status === 'in_progress');
      const problem = environmentProblem();
      if (problem) say(problem, 'warning');
      else say(result.ready ? "The environment is ready." : running ? "A step is running in the background; press Check again later." : '');
    } catch (error) {
      if (current === generation) say(error.message, 'error');
    } finally {
      if (current === generation) {busy = false; render();}
    }
  }

  // The one check button: the desktop re-checks the environment, and each settled result refreshes the rows.
  async function refresh() {
    if (busy || inProgress.includes(environment.phase)) return;
    const result = await bridge.check(environment.config?.root || '', environment.config?.partition || '');
    if (!result.ok) say(result.error || "HPC3 cannot be checked right now.", 'error');
  }

  async function install(item) {
    if (busy || !window.confirm('Install ' + item.label + '? This downloads the pinned source into your configured remote workspace.')) return;
    say("Installing SIGNET…");
    busy = true;
    render();
    try {
      const result = await call('/hpc/signet');
      say(result.detail || result.reason || result.error || "Submitted.", result.status === 'ok' ? '' : 'error');
    } catch (error) {
      say(error.message, 'error');
    } finally {
      busy = false;render();setTimeout(inspect, 3000);
    }
  }

  async function run(item) {
    if (busy) return;
    if (!window.confirm('Start ' + item.label + '? This writes to your configured remote workspace and may submit a Slurm job.')) return;
    busy = true;
    render();
    const current = generation;
    say("Submitting…");
    try {
      const result = await call('/hpc/' + item.action);
      if (current !== generation) return;
      say(result.detail || result.reason || result.error || "Submitted.", result.status === 'ok' ? '' : 'error');
    } catch (error) {
      if (current === generation) say(error.message, 'error');
    } finally {
      if (current === generation) {busy = false; render();}
    }
    // Background steps need a moment before their state is visible.
    setTimeout(inspect, 3000);
  }

  function observe(state) {
    environment = state;
    generation++;
    busy = false;
    checked = false;
    latest = null;
    summary.textContent = "Open to check HPC3";
    stageStatus.textContent = '';
    say(state.message || '');
    render();
    if (state.phase !== 'disconnected' && !inProgress.includes(state.phase) && panel.open) void inspect();
  }
  bridge.subscribe(observe);
  // A reloaded page joins a connection that is already open.
  void bridge.getSnapshot().then(result => {if (result.ok && result.value && result.value.phase !== 'disconnected') observe(result.value);});
  checkButton.addEventListener('click', refresh);
  // The assistant can open or collapse this panel through show_panel.
  window.addEventListener('panel-request', event => {
    if (event.detail?.panel === 'workflow') panel.open = Boolean(event.detail.visible);
  });
  panel.addEventListener('toggle', () => { if (panel.open && !checked) inspect(); });
  render();
})();
