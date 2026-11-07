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
  // `action` is a backend step (/hpc/<action>); `unavailable` explains a button that cannot work yet.
  // `parts` folds several backend checks into one row; the worst part decides its status.
  const items = [
    {id: 'hpc', label: 'HPC3 環境', parts: ['connection', 'workspace', 'slurm', 'apptainer'],
     hint: '請用右上角的 SSH 面板連線。'},
    {id: 'signet_source', label: 'SIGNET 程式碼', button: '安裝', install: true},
    {id: 'container', label: 'SIGNET 容器', button: '下載', action: 'container'},
    {id: 'reference_ref', label: '參考面板（ref）', button: '下載', action: 'reference/ref', file: 'ref'},
    {id: 'reference_gmap', label: '遺傳圖譜（gmap）', button: '下載', action: 'reference/gmap', file: 'gmap'},
    {id: 'reference_gtf', label: '基因註解（gtf）', button: '下載', action: 'reference/gtf', file: 'gtf'},
    {id: 'reference_clinical', label: '臨床資料（clinical）', button: '下載', action: 'reference/clinical', file: 'clinical'},
    {id: 'imputation_reference', label: '補值參考檔（ref、gmap 轉檔）', button: '轉檔', action: 'prepare'},
  ];
  const statusText = {ok: '已就緒', missing: '缺少', problem: '有問題', in_progress: '進行中', unknown: '未檢查'};
  const severity = ['ok', 'in_progress', 'missing', 'problem'];
  const bridge = window.signetDesktop.environment;
  const inProgress = ['checking', 'installing-source', 'verifying'];
  let busy = false, checked = false, latest = null, generation = 0;
  let environment = {phase: 'disconnected', message: ''};
  // Paths of files chosen on HPC3. They come from their own route and never reach the assistant.
  let selections = {};
  const token = () => document.querySelector('meta[name="chat-token"]').content;

  function element(tag, className, source) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (source !== undefined) uiText(el, source);
    return el;
  }

  function say(source, kind = '') {
    notice.hidden = !source;
    notice.className = 'workflow-message ' + kind;
    if (source) uiText(notice, source);
  }

  async function call(path, body = {}) {
    const response = await fetch(path, {method: 'POST', body: JSON.stringify(body),
      headers: {'Content-Type': 'application/json', 'X-Chat-Token': token()}});
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '本機服務拒絕請求。');
    return value;
  }

  function actionButton(item) {
    const button = element('button', 'workflow-action', item.button);
    button.type = 'button';
    if (busy || item.unavailable || !(item.action || item.install) || inProgress.includes(environment.phase)) {
      button.disabled = true;
      if (item.unavailable) {
        button.dataset.i18nTitle = item.unavailable;
        button.title = translateUI(item.unavailable);
      }
    } else {
      button.addEventListener('click', () => item.install ? install(item) : run(item));
    }
    return button;
  }

  function fileButtons(item, status) {
    const disabled = busy || inProgress.includes(environment.phase);
    const button = (source, click) => {
      const el = element('button', 'workflow-action', source);
      el.type = 'button';
      el.disabled = disabled;
      el.addEventListener('click', click);
      return el;
    };
    const buttons = [button('選擇 HPC 檔案', () => window.dispatchEvent(new CustomEvent('open-remote-files', {detail: {
      key: item.file, label: translateUI(item.label), current: selections[item.file] || ''}})))];
    if (selections[item.file]) buttons.push(button('改用預設', () => useDefault(item)));
    return status === 'in_progress' ? [] : buttons;
  }

  // A folded row reports the worst part; its detail lists only the parts that need attention.
  // Only a missing workspace has a fix the user can press, and installing SIGNET also creates it.
  function combined(item, checks) {
    if (!item.parts) return {check: checks.get(item.id), item};
    const parts = item.parts.map(id => checks.get(id)).filter(Boolean);
    if (!parts.length) return {item};
    const status = parts.reduce((worst, part) => severity.indexOf(part.status) > severity.indexOf(worst) ? part.status : worst, 'ok');
    const pending = parts.filter(part => part.status !== 'ok');
    const detail = (pending.length ? pending : parts.filter(part => part.item === 'connection')).map(part => part.detail).join(' · ');
    const onlyWorkspace = false;
    return {check: {status, detail}, item: onlyWorkspace ? {...item, action: 'workspace', button: '建立工作區'} : item};
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
      if (item.file && selections[item.file]) text.append(Object.assign(element('span', 'workflow-item-detail workflow-item-path'), {textContent: selections[item.file]}));
      else if (status === 'unknown' && item.hint) text.append(element('span', 'workflow-item-detail', item.hint));
      row.append(element('span', 'workflow-badge', statusText[status] || status), text);
      if (item.button && !selections[item.file] && (status === 'missing' || (status === 'problem' && !item.install))) row.append(actionButton(item));
      if (item.file && latest) row.append(...fileButtons(item, status));
      return row;
    }));
    checkButton.disabled = busy || inProgress.includes(environment.phase);
    if (latest) {
      const ready = rows.filter(row => row.check?.status === 'ok').length;
      uiText(summary, `準備環境 ${ready}/${items.length} 項就緒`);
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
    say('正在檢查 HPC3…');
    try {
      const result = await call('/hpc/check');
      if (current !== generation) return;
      checked = true;
      if (result.status !== 'ok') {
        latest = null;
        uiText(summary, environment.phase === 'disconnected' ? '尚未連線 HPC3' : result.status === 'not_ready' ? '環境尚未就緒' : '目前無法檢查 HPC3。');
        say(result.reason || result.error || '目前無法檢查 HPC3。', 'warning');
        return;
      }
      latest = result;
      const chosen = await call('/hpc/files/selected').catch(() => ({}));
      if (current !== generation) return;
      selections = chosen.selected || {};
      const running = result.checks.some(item => item.status === 'in_progress');
      const problem = environmentProblem();
      if (problem) say(problem, 'warning');
      else say(result.ready ? '環境已準備好。' : running ? '有步驟正在背景執行，稍後再按「重新檢查」。' : '');
    } catch (error) {
      if (current === generation) say(error.message, 'error');
    } finally {
      if (current === generation) {busy = false; render();}
    }
  }

  async function useDefault(item) {
    if (busy || !window.confirm('Stop using the selected ' + translateUI(item.label) + '? The file itself is not changed.')) return;
    const result = await call('/hpc/files/clear', {key: item.file}).catch(error => ({error: error.message}));
    if (result.status === 'ok') void inspect();
    else say(result.error || result.reason || '目前無法檢查 HPC3。', 'error');
  }

  // The one check button: the desktop re-checks the environment, and each settled result refreshes the rows.
  async function refresh() {
    if (busy || inProgress.includes(environment.phase)) return;
    const result = await bridge.check(environment.config?.root || '', environment.config?.partition || '');
    if (!result.ok) say(result.error || '目前無法檢查 HPC3。', 'error');
  }

  async function install(item) {
    if (busy || !window.confirm('Install ' + translateUI(item.label) + '? This downloads the pinned source into your configured remote workspace.')) return;
    say('正在安裝 SIGNET…');
    const result = await bridge.install();
    if (!result.ok) say(result.error || '目前無法檢查 HPC3。', 'error');
  }

  async function run(item) {
    if (busy) return;
    if (!window.confirm('Start ' + translateUI(item.label) + '? This writes to your configured remote workspace and may submit a Slurm job.')) return;
    busy = true;
    render();
    const current = generation;
    say('正在送出…');
    try {
      const result = await call('/hpc/' + item.action);
      if (current !== generation) return;
      say(result.detail || result.reason || result.error || '已送出。', result.status === 'ok' ? '' : 'error');
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
    selections = {};
    generation++;
    busy = false;
    checked = false;
    latest = null;
    uiText(summary, '展開以檢查 HPC3 環境');
    stageStatus.textContent = '';
    say(state.message || '');
    render();
    if (state.phase !== 'disconnected' && !inProgress.includes(state.phase) && panel.open) void inspect();
  }
  bridge.subscribe(observe);
  // A reloaded page joins a connection that is already open.
  void bridge.getSnapshot().then(result => {if (result.ok && result.value && result.value.phase !== 'disconnected') observe(result.value);});
  checkButton.addEventListener('click', refresh);
  window.addEventListener('remote-file-selected', () => { void inspect(); });
  // The assistant can open or collapse this panel through show_panel.
  window.addEventListener('panel-request', event => {
    if (event.detail?.panel === 'workflow') panel.open = Boolean(event.detail.visible);
  });
  panel.addEventListener('toggle', () => { if (panel.open && !checked) inspect(); });
  window.addEventListener('languagechange', () => list.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = translateUI(el.dataset.i18nTitle);
  }));
  render();
})();
