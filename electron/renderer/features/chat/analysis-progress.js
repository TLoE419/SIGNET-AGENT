// One card per linked run. Local snapshots remain readable while HPC3 is downloading.
(() => {
  const tracking = $('analysis-tracking');
  const form = $('analysis-link-form');
  const select = $('analysis-run');
  const link = $('analysis-link');
  const linkStatus = $('analysis-link-status');
  const messages = $('messages');
  const cards = new Map();
  const active = new Set(['submitting', 'submitted', 'queued', 'running', 'validating', 'downloading', 'cancelling', 'unknown']);
  const labels = {
    genotype:'基因型前處理', expression:'基因表現前處理', adjust:'樣本調整',
    cis:'尋找附近變異', network:'建構調控網路', visualize:'畫出網路圖'
  };
  const phases = {
    not_started:'未開始', untracked:'尚未追蹤', submitting:'正在送出…', submitted:'已送出',
    queued:'排隊中', running:'執行中', validating:'核對結果中', downloading:'正在下載結果',
    cancelling:'正在停止', cancelled:'已確認停止', failed:'執行失敗', completed:'已完成', unknown:'狀態未知'
  };
  let polling;

  async function request(path, state, body) {
    const headers = {'X-Chat-Token': document.querySelector('meta[name="chat-token"]').content};
    const options = {headers, signal:state.controller.signal};
    if (body) {
      headers['Content-Type'] = 'application/json';
      Object.assign(options, {method:'PATCH', body:JSON.stringify(body)});
    }
    const response = await fetch(path, options);
    if (!response.ok) throw new Error('Analysis request failed');
    return response.json();
  }

  function progressUnits(step) {
    if (step.phase !== 'running') return '';
    return Object.entries(step.progress || {}).flatMap(([batch, count]) => {
      const index = /^stage([1-9]\d*)$/.exec(batch)?.[1];
      const values = /^(\d+)\s+(\d+)$/.exec(count);
      if (!index || !values) return [];
      const done = Number(values[1]), total = Number(values[2]);
      if (!Number.isSafeInteger(total) || !Number.isSafeInteger(done) || total <= 0 || done > total) return [];
      return [`第 ${index} 組：${done}/${total}`];
    }).join('\n');
  }

  function createCard(analysis) {
    const root = node('details', 'analysis-progress-card');
    root.dataset.runId = analysis.run_id;
    root.setAttribute('aria-live', 'off');
    const heading = node('summary', 'analysis-progress-heading');
    const identity = node('span', 'analysis-progress-identity');
    identity.append(node('strong', '', '分析進度'));
    const id = node('small', 'analysis-progress-id');
    id.textContent = analysis.run_id;
    identity.append(id);
    const count = node('span', 'analysis-progress-count');
    const bar = node('progress', 'analysis-progress-bar');
    bar.setAttribute('aria-label', translateUI('已完成階段'));
    bar.dataset.i18nAria = '已完成階段';
    const current = node('span', 'analysis-progress-current');
    current.hidden = true;
    const notice = node('span', 'analysis-progress-notice');
    notice.hidden = true;
    const rows = node('ol', 'analysis-progress-steps');
    const stages = new Map();
    for (const [index, step] of analysis.steps.entries()) {
      const row = node('li', 'analysis-progress-step');
      row.dataset.step = step.step;
      const name = node('span', 'analysis-progress-name', labels[step.step]);
      const status = node('span', 'analysis-progress-phase');
      const units = node('small', 'analysis-progress-units');
      units.hidden = true;
      const number = node('span', 'analysis-progress-number');
      number.textContent = String(index + 1);
      row.append(number, name, status, units);
      rows.append(row);
      stages.set(step.step, {row, status, units});
    }
    heading.append(identity, count, bar, current, notice);
    root.append(heading, rows);
    // Preserve the reader's scroll position when checking or updating existing cards.
    const atEnd = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
    messages.append(root);
    if (atEnd) messages.scrollTop = messages.scrollHeight;
    return {root, count, bar, current, notice, stages, stale:false};
  }

  function note(card, localUnavailable) {
    const text = localUnavailable ? '暫時無法更新，顯示上次記錄。'
      : card.stale ? '暫時無法向 HPC3 確認，顯示上次記錄。' : '';
    if (card.notice.dataset.i18n !== text) uiText(card.notice, text);
    card.notice.hidden = !text;
  }

  function updateCard(analysis) {
    let card = cards.get(analysis.run_id);
    if (!card) {
      card = createCard(analysis);
      cards.set(analysis.run_id, card);
    }
    const count = `已完成 ${analysis.completed_steps}/${analysis.total_steps} 階段`;
    if (card.count.dataset.i18n !== count) uiText(card.count, count);
    card.bar.max = analysis.total_steps;
    card.bar.value = analysis.completed_steps;
    const focus = analysis.steps.find(item => active.has(item.phase))
      || analysis.steps.find(item => item.phase === 'failed' || item.phase === 'cancelled');
    const text = focus ? labels[focus.step] + ' · ' + phases[focus.phase] : '';
    if (card.current.dataset.i18n !== text) uiText(card.current, text);
    card.current.hidden = !text;
    for (const step of analysis.steps) {
      const {row, status, units} = card.stages.get(step.step);
      row.dataset.phase = step.phase;
      const measured = progressUnits(step);
      const text = step.phase === 'running' && !measured ? '執行中 · 目前無分段進度'
        : phases[step.phase] || phases.unknown;
      if (status.dataset.i18n !== text) uiText(status, text);
      if (units.dataset.i18n !== measured) uiText(units, measured);
      units.hidden = !measured;
    }
    note(card, false);
    return card;
  }

  async function checkStep(analysis, step, state, card) {
    const run = analysis.run_id;
    state.checks.add(run);
    state.nextCheck.set(run, Date.now() + 15000);
    try {
      const path = `/signet/runs/${encodeURIComponent(run)}/steps/${encodeURIComponent(step.step)}`;
      const result = await request(path, state);
      if (!state.controller.signal.aborted) card.stale = result.connection === 'interrupted';
    } catch (_) {
      if (!state.controller.signal.aborted) card.stale = true;
    } finally {
      state.checks.delete(run);
      if (!state.controller.signal.aborted) note(card, state.localUnavailable);
    }
  }

  async function poll(state) {
    if (state.controller.signal.aborted) return;
    if (state.reading) {state.refreshRequested = true; return;}
    clearTimeout(state.timer);
    state.reading = true;
    let delay = 15000;
    try {
      const {analyses} = await request('/signet/progress?session=' + encodeURIComponent(session), state);
      if (state.controller.signal.aborted) return;
      state.localUnavailable = false;
      const linked = analyses.filter(analysis => analysis.session === session && analysis.steps.length);
      const present = new Set(linked.map(analysis => analysis.run_id));
      for (const [run, card] of cards) {
        if (!present.has(run)) {
          card.root.remove();
          cards.delete(run);
          state.nextCheck.delete(run);
        }
      }
      for (const analysis of linked) {
        const card = updateCard(analysis);
        const step = analysis.steps.find(item => active.has(item.phase));
        if (step) {
          delay = 5000;
          if (!state.checks.has(analysis.run_id) && Date.now() >= (state.nextCheck.get(analysis.run_id) || 0)) {
            // Read the saved state on its own schedule even if this request is still downloading.
            void checkStep(analysis, step, state, card);
          }
        } else {
          card.stale = false;
          note(card, false);
          state.nextCheck.delete(analysis.run_id);
        }
      }
    } catch (_) {
      if (state.controller.signal.aborted) return;
      state.localUnavailable = true;
      for (const card of cards.values()) note(card, true);
    } finally {
      state.reading = false;
      if (!state.controller.signal.aborted) {
        state.timer = setTimeout(() => void poll(state), state.refreshRequested ? 0 : delay);
        state.refreshRequested = false;
      }
    }
  }

  function start() {
    if (polling) return;
    tracking.hidden = false;
    polling = {controller:new AbortController(), checks:new Set(), nextCheck:new Map()};
    void poll(polling);
  }

  function linkMessage(text) {
    uiText(linkStatus, text);
    linkStatus.hidden = !text;
  }

  async function choices(state) {
    link.disabled = true;
    select.replaceChildren();
    linkMessage('正在讀取分析…');
    try {
      const {runs} = await request('/signet/runs', state);
      if (state.controller.signal.aborted) return;
      for (const run of runs.filter(run => run.cohort === 'TCGA' && !run.session)) {
        const option = node('option', '');
        option.value = option.textContent = run.run_id;
        select.append(option);
      }
      link.disabled = !select.value;
      linkMessage(select.value ? '' : '沒有可連結的分析。');
    } catch (_) {
      if (!state.controller.signal.aborted) linkMessage('無法載入分析，請收起後再展開。');
    }
  }
  tracking.addEventListener('toggle', () => {if (tracking.open && polling) void choices(polling);});
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const state = polling;
    const run = select.value;
    if (!run || link.disabled || !state) return;
    link.disabled = true;
    try {
      await request(`/signet/runs/${encodeURIComponent(run)}/conversation`, state, {session});
      if (state.controller.signal.aborted) return;
      tracking.open = false;
      linkMessage('');
      void poll(state);
    } catch (_) {
      if (state.controller.signal.aborted) return;
      linkMessage('無法連結此分析，請重新開啟清單。');
    }
  });

  if (initialChat.session) start();
  window.addEventListener('chat-idle', () => {
    if (polling) void poll(polling);
    else start();
  });
  window.addEventListener('pagehide', () => {
    if (!polling) return;
    polling.controller.abort();
    clearTimeout(polling.timer);
    polling = undefined;
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted && !tracking.hidden) {
      start();
      if (tracking.open) void choices(polling);
    }
  });
})();
