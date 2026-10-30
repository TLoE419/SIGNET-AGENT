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
    {id: 'signet_source', label: 'SIGNET 程式碼', action: 'signet', button: '下載'},
    {id: 'container', label: 'SIGNET 容器', action: 'container', button: '下載',
     unavailable: '官方下載網站已於 2026 年 10 月關閉，等待新的下載來源。'},
    {id: 'reference_ref', label: '參考面板（ref）', button: '下載', action: 'reference/ref'},
    {id: 'reference_gmap', label: '遺傳圖譜（gmap）', button: '下載', action: 'reference/gmap'},
    {id: 'reference_gtf', label: '基因註解（gtf）', button: '下載', action: 'reference/gtf'},
    {id: 'reference_clinical', label: '臨床資料（clinical）', button: '下載', action: 'reference/clinical'},
    {id: 'imputation_reference', label: '補值參考檔（ref、gmap 轉檔）', button: '轉檔', action: 'prepare'},
  ];
  const statusText = {ok: '已就緒', missing: '缺少', problem: '有問題', in_progress: '進行中', unknown: '未檢查'};
  const severity = ['ok', 'in_progress', 'missing', 'problem'];
  let busy = false, checked = false, latest = null;
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

  async function call(path) {
    const response = await fetch(path, {method: 'POST', body: '{}',
      headers: {'Content-Type': 'application/json', 'X-Chat-Token': token()}});
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '本機服務拒絕請求。');
    return value;
  }

  function actionButton(item) {
    const button = element('button', 'workflow-action', item.button);
    button.type = 'button';
    if (busy || item.unavailable || !item.action) {
      button.disabled = true;
      if (item.unavailable) {
        button.dataset.i18nTitle = item.unavailable;
        button.title = translateUI(item.unavailable);
      }
    } else {
      button.addEventListener('click', () => run(item));
    }
    return button;
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
    const onlyWorkspace = pending.length === 1 && pending[0].item === 'workspace';
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
      else if (status === 'unknown' && item.hint) text.append(element('span', 'workflow-item-detail', item.hint));
      row.append(element('span', 'workflow-badge', statusText[status] || status), text);
      if (item.button && ['missing', 'problem'].includes(status)) row.append(actionButton(item));
      return row;
    }));
    checkButton.disabled = busy;
    if (latest) {
      const ready = rows.filter(row => row.check?.status === 'ok').length;
      uiText(summary, `準備環境 ${ready}/${items.length} 項就緒`);
      stageStatus.textContent = `${ready}/${items.length}`;
    }
  }

  async function check() {
    if (busy) return;
    busy = true;
    render();
    say('正在檢查 HPC3…');
    try {
      const result = await call('/hpc/check');
      checked = true;
      if (result.status !== 'ok') {
        latest = null;
        uiText(summary, '尚未連線 HPC3');
        say(result.reason || result.error || '目前無法檢查 HPC3。', 'warning');
        return;
      }
      latest = result;
      const running = result.checks.some(item => item.status === 'in_progress');
      say(result.ready ? '環境已準備好。' : running ? '有步驟正在背景執行，稍後再按「重新檢查」。' : '');
    } catch (error) {
      say(error.message, 'error');
    } finally {
      busy = false;
      render();
    }
  }

  async function run(item) {
    if (busy) return;
    busy = true;
    render();
    say('正在送出…');
    try {
      const result = await call('/hpc/' + item.action);
      say(result.detail || result.reason || result.error || '已送出。', result.status === 'ok' ? '' : 'error');
    } catch (error) {
      say(error.message, 'error');
    } finally {
      busy = false;
      render();
    }
    // Background steps need a moment before their state is visible.
    setTimeout(check, 3000);
  }

  checkButton.addEventListener('click', check);
  // The assistant can open or collapse this panel through show_panel.
  window.addEventListener('panel-request', event => {
    if (event.detail?.panel === 'workflow') panel.open = Boolean(event.detail.visible);
  });
  panel.addEventListener('toggle', () => { if (panel.open && !checked) check(); });
  window.addEventListener('languagechange', () => list.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = translateUI(el.dataset.i18nTitle);
  }));
  render();
})();
