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
    {id: 'signet_source', label: "SIGNET source code", button: "Install", action: "signet", confirm: "This downloads the pinned source and example data into your configured remote workspace."},
    {id: 'container', label: "SIGNET container", button: "Download", action: 'container'},
  ];
  const statusText = {ok: "Ready", missing: "Missing", problem: "Problem", in_progress: "In progress", unknown: "Not checked"};
  const severity = ['ok', 'in_progress', 'missing', 'problem'];
  const bridge = window.signetDesktop.environment;
  const inProgress = ['checking', 'installing-source', 'verifying'];
  let busy = false, checked = false, latest = null, generation = 0, followUp = null, lastRecheck = 0;
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
    button.addEventListener('click', () => run(item));
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
      if (item.button && (status === 'missing' || status === 'problem')) row.append(actionButton(item));
      return row;
    }));
    checkButton.disabled = busy || inProgress.includes(environment.phase);
    updateNext();
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
      afterInspect(result, current);
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

  // The SIGNET installation runs on HPC3 for about a minute: follow it, then let the desktop
  // re-verify the environment, which it last checked before SIGNET was there.
  function afterInspect(result, current) {
    clearTimeout(followUp);
    const source = result.checks.find(item => item.item === 'signet_source');
    if (source?.status === 'in_progress') {
      followUp = setTimeout(() => { if (current === generation) void inspect(); }, 5000);
      return;
    }
    const awaitsSource = (environment.missing || []).some(name => name.startsWith('SIGNET'));
    // At most once a minute, so a disagreement between the two checks cannot loop.
    if (source?.status === 'ok' && environment.phase === 'needs-install' && awaitsSource && Date.now() - lastRecheck > 60000) {
      lastRecheck = Date.now();
      setTimeout(() => { if (current === generation) void refresh(); }, 0);
    }
  }

  async function run(item) {
    if (busy) return;
    if (!window.confirm('Start ' + item.label + '? ' + (item.confirm || 'This writes to your configured remote workspace and may submit a Slurm job.'))) return;
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
    clearTimeout(followUp);
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
  // ---- Stages 2 and 3: the six SIGNET steps of this conversation's analyses ----
  // Stage 2 lists -g, -t and -a; stage 3 lists -c, -n and -v, so together they match the
  // chat's progress card. Reviewing settings and submitting stay on the chat cards, so there
  // is one place that sends work to HPC3.
  const environmentStage = document.getElementById('workflow-environment');
  const nextBox = document.getElementById('workflow-next');
  const nextButton = document.getElementById('workflow-next-button');
  const preStage = document.getElementById('workflow-preprocess-stage');
  const preDetails = document.getElementById('workflow-preprocess');
  const groups = [
    {stage: preStage, details: preDetails, body: document.getElementById('workflow-preprocess-body'),
     status: document.getElementById('workflow-preprocess-status'), start: true,
     steps: [['genotype', '-g', '基因型前處理'], ['expression', '-t', '基因表現前處理'], ['adjust', '-a', '樣本調整']]},
    {stage: document.getElementById('workflow-results-stage'), details: document.getElementById('workflow-results'),
     body: document.getElementById('workflow-results-body'), status: document.getElementById('workflow-results-status'),
     start: false,
     steps: [['cis', '-c', '尋找附近變異'], ['network', '-n', '建構調控網路'], ['visualize', '-v', '畫出網路圖']]},
  ].filter(group => group.details && group.body);
  const phaseText = {not_started: '未開始', submitting: '正在送出…', submitted: '已送出', queued: '排隊中', running: '執行中',
    validating: '核對結果中', downloading: '正在下載結果', cancelling: '正在停止', cancelled: '已確認停止',
    failed: '執行失敗', completed: '已完成', unknown: '狀態未知'};
  const phaseStatus = phase => phase === 'completed' ? 'ok' : phase === 'failed' ? 'problem'
    : ['not_started', 'cancelled'].includes(phase) ? 'unknown' : 'in_progress';
  // The chat page's conversation ID (features/chat/chat.js); absent when this file runs alone.
  const conversation = () => (typeof session === 'string' ? session : '');
  let preTimer = null, starting = false, preNote = '';

  const environmentReady = () => Boolean(latest?.ready) && environment.phase === 'ready';

  function updateNext() {
    if (!nextBox) return;
    const ready = environmentReady();
    nextBox.hidden = !ready;
    for (const group of groups) group.stage?.classList.toggle('locked', !ready);
  }

  async function get(path) {
    const response = await fetch(path, {headers: {'X-Chat-Token': token()}});
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '本機服務拒絕請求。');
    return value;
  }

  // Step progress arrives as {"imputation": "12 40"}: finished and total work units.
  function progressText(progress) {
    return Object.values(progress || {}).map(value => String(value).split(' ')).filter(pair => pair.length === 2)
      .map(([done, total]) => `${done}/${total}`).join(' · ');
  }

  function showCard(run) {
    const card = [...document.querySelectorAll('.analysis-progress-card')].find(el => el.dataset.runId === run);
    if (!card) {
      preNote = '卡片還沒出現在聊天中，請稍候再試。';
      void loadProgress();
      return;
    }
    card.open = true;
    card.scrollIntoView?.({behavior: 'smooth', block: 'start'});
  }

  function renderGroup(group, analyses) {
    const nodes = [];
    for (const analysis of analyses) {
      const block = element('div', 'workflow-analysis');
      const head = element('div', 'workflow-analysis-head');
      head.append(Object.assign(element('span', 'workflow-analysis-id'), {textContent: analysis.run_id}));
      const family = analysis.family || {};
      const reruns = analyses.some(item => item.family?.number);
      const label = family.number ? `重跑 ${family.number}` : reruns ? '原始分析' : '';
      if (label) head.append(element('span', 'workflow-analysis-family', label + (reruns && family.latest ? ' · 最新' : '')));
      const open = element('button', 'workflow-action', '到聊天中的卡片');
      open.type = 'button';
      open.addEventListener('click', () => showCard(analysis.run_id));
      head.append(open);
      const rows = element('ul', 'workflow-items');
      for (const [name, flag, label] of group.steps) {
        const step = analysis.steps.find(item => item.step === name) || {phase: 'not_started'};
        const row = element('li', 'workflow-item');
        row.dataset.status = phaseStatus(step.phase);
        row.dataset.step = name;
        const text = element('div', 'workflow-item-text');
        const title = element('span', 'workflow-item-label');
        title.append(Object.assign(element('code', ''), {textContent: flag + ' '}), element('span', '', label));
        text.append(title);
        const metric = progressText(step.progress);
        if (metric) text.append(Object.assign(element('span', 'workflow-item-detail'), {textContent: metric}));
        row.append(element('span', 'workflow-badge', phaseText[step.phase] || phaseText.unknown), text);
        rows.append(row);
      }
      block.append(head, rows);
      nodes.push(block);
    }
    const ready = environmentReady();
    // One conversation, one analysis (plus its reruns): a new analysis starts in a new conversation.
    if (group.start && analyses.length) {
      const actions = element('div', 'workflow-stage-actions workflow-start');
      const button = element('button', 'workflow-action', '開新對話來跑新分析');
      button.type = 'button';
      button.addEventListener('click', () => document.getElementById('new-chat')?.click());
      actions.append(button);
      nodes.push(actions);
    } else if (group.start) {
      const actions = element('div', 'workflow-stage-actions workflow-start');
      for (const [mode, label] of [['example', '用官方示範資料開始'], ['custom', '用自己的資料開始']]) {
        const button = element('button', 'workflow-action', label);
        button.type = 'button';
        button.dataset.mode = mode;
        button.disabled = !ready || starting || !conversation();
        button.addEventListener('click', () => void startAnalysis(mode));
        actions.append(button);
      }
      nodes.push(actions);
    }
    const note = preNote || (!ready && !analyses.length ? '請先完成準備環境。'
      : analyses.length ? '' : group.start ? '尚未開始分析。按下後會在聊天中產生第一階段的確認卡，確認後才會送出。'
      : '請先在資料前處理開始分析。');
    if (note) nodes.push(element('p', 'workflow-message' + (preNote ? ' warning' : ''), note));
    group.body.replaceChildren(...nodes);
    const last = analyses.at(-1);
    group.status.textContent = last
      ? `${group.steps.filter(([name]) => last.steps.find(item => item.step === name)?.phase === 'completed').length}/${group.steps.length}`
      : '';
  }

  // Reads saved state only (no HPC3 call); the chat cards refresh the jobs themselves.
  async function loadProgress() {
    clearTimeout(preTimer);
    if (!groups.some(group => group.details.open)) return;
    const id = conversation();
    let analyses = [];
    try {
      if (id) analyses = (await get('/signet/progress?session=' + encodeURIComponent(id))).analyses || [];
    } catch (error) {
      preNote = error.message;
    }
    for (const group of groups) renderGroup(group, analyses);
    preNote = '';
    if (analyses.some(analysis => analysis.steps.some(step => phaseStatus(step.phase) === 'in_progress'))) {
      preTimer = setTimeout(() => void loadProgress(), 10000);
    }
  }

  async function startAnalysis(mode) {
    const id = conversation();
    if (starting || !id || !environmentReady()) return;
    const data = mode === 'example' ? 'the official example data' : 'your own data';
    if (!window.confirm(`Start a TCGA analysis with ${data}? This creates a new analysis and its first confirmation card in the chat. Nothing is submitted until you confirm the card.`)) return;
    starting = true;
    preNote = '正在建立分析…';
    await loadProgress();
    try {
      const result = await call('/signet/analyses', {session: id, mode});
      history.replaceState(null, '', '/?session=' + encodeURIComponent(id));
      window.dispatchEvent(new Event('analysis-started'));
      starting = false;
      await loadProgress();
      setTimeout(() => showCard(result.run_id), 1500);
    } catch (error) {
      starting = false;
      preNote = error.message;
      await loadProgress();
    }
  }

  nextButton?.addEventListener('click', () => {
    environmentStage.open = false;
    preDetails.open = true;
    preStage.scrollIntoView?.({block: 'nearest'});
    void loadProgress();  // the toggle event is asynchronous, so load now
  });
  for (const group of groups) {
    group.details.addEventListener('toggle', () => {
      if (group.details.open) void loadProgress();
      else if (!groups.some(other => other.details.open)) clearTimeout(preTimer);
    });
  }
  // The assistant may have started or advanced an analysis during the turn.
  window.addEventListener('chat-idle', () => { void loadProgress(); });

  bridge.subscribe(observe);
  // A reloaded page joins a connection that is already open.
  void bridge.getSnapshot().then(result => {if (result.ok && result.value && result.value.phase !== 'disconnected') observe(result.value);});
  checkButton.addEventListener('click', refresh);
  // The assistant can open or collapse this panel through show_panel.
  window.addEventListener('panel-request', event => {
    if (event.detail?.panel !== 'workflow') return;
    panel.open = Boolean(event.detail.visible);
    if (event.detail.refresh) setTimeout(() => { void inspect(); }, 3000);
  });
  panel.addEventListener('toggle', () => { if (panel.open && !checked) inspect(); });
  render();
})();
