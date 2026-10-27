// HPC3 connection card in the sidebar: shows /hpc3/status and drives the UCInetID, login
// and logout through the local /hpc3 API. Works the same in the browser and in Electron.
// No password ever passes through this page: login opens system dialogs owned by ssh.
'use strict';
(() => {
  const el = id => document.getElementById(id);
  const card = el('hpc3-card');
  if (!card) return;
  const token = document.querySelector('meta[name="chat-token"]').content;
  // How often the page asks for login progress while the dialogs are open.
  const POLL_MS = 2000;
  const tr = text => (typeof translateUI === 'function' ? translateUI(text) : text);

  // Plain-language reason for each hpc3_ssh.check() status; unknown ones fall back to ssh_failed.
  const REASONS = {
    not_configured: '請先輸入你的 UCInetID。',
    dns_failed: '找不到 HPC3 主機，請檢查網路連線。',
    network_unreachable: '連不到 HPC3，請連上 UCI VPN 或校園網路。',
    auth_required: '尚未登入 HPC3。',
    host_key_unknown: '尚未確認 HPC3 的主機身分，登入時請核對指紋。',
    host_key_changed: 'HPC3 的主機身分與紀錄不符，可能有安全風險，請先聯絡 RCIC。',
    connection_refused: 'HPC3 拒絕連線，登入節點可能正在維護。',
    timeout: '連線逾時，請檢查 VPN 後再試。',
    ssh_missing: '這台電腦沒有安裝 ssh。',
    unexpected_remote: '登入的帳號或主機不符，請檢查 UCInetID。',
    ssh_failed: 'SSH 連線失敗，請稍後再試。',
    stale_connection: '之前的登入已失效（可能換了網路或電腦休眠），請重新登入。',
  };
  // Logging in cannot fix these; offer "Check again" only.
  const NO_LOGIN = new Set(['not_configured', 'dns_failed', 'network_unreachable', 'host_key_changed',
    'ssh_missing', 'connection_refused']);

  let status = null;               // last GET /hpc3/status body, null while unknown
  let login = {state: 'idle'};     // last login progress from the server
  let editing = false;             // UCInetID form opened with "Change account"
  let error = '';                  // Chinese source text of the last error, translated on render
  let busy = false;                // a request from this card is in flight
  let timer = null;                // pending login-progress poll

  async function api(path, payload) {
    const options = {headers: {'X-Chat-Token': token}};
    if (payload !== undefined) {
      options.method = 'POST';
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(payload);
    }
    try {
      const response = await fetch(path, options);
      let body = {};
      try { body = await response.json(); } catch (_) {}
      return {code: response.status, body};
    } catch (_) {
      return {code: 0, body: {}};  // The local service is not reachable.
    }
  }

  function show(id, visible) { el(id).hidden = !visible; }
  function text(id, source) {
    // textContent only: values from the server are never interpreted as HTML.
    el(id).dataset.i18n = source;
    el(id).textContent = tr(source);
  }

  function render() {
    const waiting = login.state === 'waiting_for_user';
    const configured = status && status.status !== 'not_configured';
    const connected = !!(status && status.connected);
    const formOpen = !waiting && !connected && (editing || (status && !configured));
    card.dataset.state = waiting ? 'busy' : connected ? 'connected' : status ? 'disconnected' : 'checking';

    if (waiting) text('hpc3-state', '登入中…');
    else if (!status) text('hpc3-state', '正在檢查連線…');
    else if (connected) text('hpc3-state', '已連線');
    else if (!configured) text('hpc3-state', '尚未設定帳號');
    else text('hpc3-state', '未連線');

    const detail = el('hpc3-detail');
    if (waiting) {
      text('hpc3-detail', '請在跳出的視窗輸入密碼，並在手機上確認 Duo。');
    } else if (connected) {
      const remote = status.remote || {};
      delete detail.dataset.i18n;  // A user and host name, not text to translate.
      detail.textContent = (remote.user || status.user || '') + ' @ ' + (remote.hostname || status.host || '');
    } else if (status && configured) {
      text('hpc3-detail', REASONS[status.status] || REASONS.ssh_failed);
    }
    show('hpc3-detail', waiting || connected || !!(status && configured));

    show('hpc3-user-form', formOpen);
    if (formOpen && !el('hpc3-user').value) el('hpc3-user').value = (status && status.user) || '';
    show('hpc3-login', !!configured && !connected && !waiting && !formOpen && !NO_LOGIN.has(status.status));
    show('hpc3-refresh', !!status && !connected && !waiting && !formOpen);
    show('hpc3-logout', connected && !waiting);
    show('hpc3-change-user', !!configured && !connected && !waiting && !formOpen);
    for (const id of ['hpc3-login', 'hpc3-refresh', 'hpc3-logout', 'hpc3-change-user', 'hpc3-save']) el(id).disabled = busy;

    if (error) text('hpc3-error', error);
    show('hpc3-error', !!error);
  }

  async function refresh(force) {
    const result = await api('/hpc3/status' + (force ? '?refresh=1' : ''));
    if (result.code === 200) status = result.body;
    else if (!status) error = '無法取得 HPC3 狀態，請重新整理頁面。';
    render();
  }

  function poll() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const result = await api('/hpc3/login');
      if (result.code === 200) login = result.body;
      if (login.state === 'waiting_for_user') { render(); poll(); return; }
      if (login.state === 'failed') {
        error = login.cancelled ? '已取消登入。' : '登入沒有完成：視窗逾時、密碼錯誤或 Duo 被拒絕。';
      }
      await refresh(true);
    }, POLL_MS);
  }

  async function act(work) {
    busy = true; error = ''; render();
    try { await work(); } finally { busy = false; render(); }
  }

  el('hpc3-login').addEventListener('click', () => act(async () => {
    const result = await api('/hpc3/login', {});
    if (result.code === 202) { login = result.body; poll(); return; }
    if (result.code === 200) { login = result.body; await refresh(true); return; }
    error = {409: '登入正在進行中。', 501: '登入視窗需要 macOS，請在終端機執行 python3 hpc3_ssh.py login。',
      400: '請先輸入你的 UCInetID。'}[result.code] || '無法開始登入，請稍後再試。';
  }));

  el('hpc3-logout').addEventListener('click', () => act(async () => {
    const result = await api('/hpc3/logout', {});
    if (result.code !== 200) error = result.code === 409 ? '請等登入完成再登出。' : '登出失敗，請稍後再試。';
    login = {state: 'idle'};
    await refresh(true);
  }));

  el('hpc3-refresh').addEventListener('click', () => act(() => refresh(true)));

  el('hpc3-change-user').addEventListener('click', () => { editing = true; error = ''; render(); el('hpc3-user').focus(); });

  el('hpc3-user-form').addEventListener('submit', event => {
    event.preventDefault();
    act(async () => {
      const result = await api('/hpc3/user', {user: el('hpc3-user').value});
      if (result.code === 200) { editing = false; await refresh(true); return; }
      error = {400: 'UCInetID 格式不正確：只能用小寫英文字母、數字、_ 或 -。',
        409: '請先登出 HPC3 再更換帳號。'}[result.code] || '無法儲存 UCInetID，請稍後再試。';
    });
  });

  // Coming back to the window may mean the VPN or the connection changed meanwhile.
  window.addEventListener('focus', () => { if (!busy && login.state !== 'waiting_for_user') refresh(false); });
  window.addEventListener('languagechange', render);

  // Start: show the status, and pick up a login that was already running before a reload.
  (async () => {
    render();
    const progress = await api('/hpc3/login');
    if (progress.code === 200) login = progress.body;
    if (login.state === 'waiting_for_user') poll();
    await refresh(false);
  })();
})();
