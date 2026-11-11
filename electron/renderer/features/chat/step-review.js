const stageMetricLabels = {
  imputation:'補值分段', expression_outputs:'表現前處理步驟', variant_filter:'染色體變異篩選',
  low_frequency:'低頻變異分段', rare_variants:'罕見變異分段',
  stage1:'建網第一組', stage2:'建網第二組', subnetworks:'子網路圖'
};
const stageReviewNames = {
  genotype:'第 1 階段 · 基因型前處理', expression:'第 2 階段 · 基因表現前處理',
  adjust:'第 3 階段 · 樣本調整', cis:'第 4 階段 · 尋找附近變異',
  network:'第 5 階段 · 建構調控網路', visualize:'第 6 階段 · 畫出網路圖'
};

// The model proposes; only a click on this card can send reviewed values.
function createStepReview(progressCard, request, poll, phases, active) {
  const cards = new Map();

  function update(analysis, state) {
    const idle = !analysis.steps.some(step => active.has(step.phase));
    let anchor = progressCard;
    for (const step of analysis.steps) {
      const current = step.step === analysis.next_step;
      const proposal = current ? analysis.proposal : null;
      const canPrepare = current && idle && ['not_started', 'failed', 'cancelled'].includes(step.phase);
      let card = cards.get(step.step);
      if (!card) {
        if (!proposal && !canPrepare && ['not_started', 'untracked'].includes(step.phase)) continue;
        card = createStageCard(step.step, request, poll, phases);
        anchor.after(card.panel);
        cards.set(step.step, card);
      }
      card.update({step, proposal, canPrepare, canRerun:idle && step.phase === 'completed',
                   resourceLimits:analysis.resource_limits}, state);
      anchor = card.panel;
    }
    return anchor;
  }

  return {update, remove() {for (const card of cards.values()) card.panel.remove();}};
}

function createStageCard(name, request, poll, phases) {
  const panel = node('article', 'step-review-card');
  panel.dataset.step = name;
  const heading = node('header', 'step-review-heading');
  const title = node('strong', '', stageReviewNames[name]);
  const phase = node('p', 'step-review-notice step-review-phase');
  const rerun = button('重新執行', () => void openRerun());
  rerun.className = 'step-review-rerun';
  rerun.hidden = true;
  heading.append(title, phase, rerun);
  const progress = node('div', 'step-review-progress');
  const history = node('details', 'step-review-history');
  const savedValues = node('div', 'step-review-saved');
  history.append(node('summary', '', '本次送算設定'), savedValues);
  const controls = node('div', 'step-review-controls');
  const notice = node('p', 'step-review-notice');
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  const rerunStatus = node('p', 'step-review-notice');
  rerunStatus.setAttribute('role', 'status');
  rerunStatus.hidden = true;
  panel.append(heading, progress, history, controls, notice, rerunStatus);
  let latest, polling, key, progressKey, parametersKey, busy = false, attempted = false;
  let rerunBusy = false;
  const inputs = {'gexp.file':'基因表現資料', 'pmap.file':'基因註解', 'cli.file':'臨床資料表',
    'ped.file':'基因型資料（PED）', 'map.file':'基因型位置（MAP）',
    ref:'補值參考檔前綴', gmap:'遺傳圖譜前綴'};
  const settings = {
    'restrict.tcga.geno':['染色體', 'chromosome'], 'restrict.tcga':['染色體', 'chromosome'],
    'alpha.cis':['顯著性門檻', 0, 1, 'any'], nperms:['置換次數', 1, 100000, 1],
    upstream:['上游範圍（鹼基）', 0, 10000000, 1], downstream:['下游範圍（鹼基）', 0, 10000000, 1],
    nboots:['重抽樣次數', 1, 1000, 1], ncis:['每個基因的工具變數上限', 1, 10, 1],
    cor:['相關性門檻', 0, 1, 'any'], ncores:['子工作核心數', 1, 64, 1],
    memory:['子工作記憶體（GB）', 1, 128, 1], walltime:['子工作時間上限（時:分:秒）', 'text'],
    freq:['最低連線出現比例', 0, 1, 'any'], ntop:['顯示子網路數', 1, 20, 1],
    mind:['樣本缺失率上限', 0, 1, 'any'], geno:['位點缺失率上限', 0, 1, 'any'],
    hwe:['哈溫平衡門檻', 0, 1, 'any'], int:['補值分段長度（鹼基）', 1, 100000000, 1]
  };
  const resources = {cpus:['運算核心數', 1, 32, 1], mem_gb:['記憶體（GB）', 1, 128, 1],
    hours:['時間上限（小時）', .25, 24, 'any']};
  const options = {npc:['主成分數', 0, 10, 1]};
  const schemas = {inputs, settings, resources, options};
  const summaries = {declined:'已選擇先不要。尚未送出運算。', confirmed:'已確認，正在送算。',
    sent:'已送算，請查看上方進度。', unknown:'送算狀態未知，請查看上方進度。',
    stale:'確認卡已過期，請重新準備設定。', submission_error:'這次送算未能完成，請查看上方進度或重新準備設定。'};

  function say(text) {
    uiText(notice, text);
    notice.hidden = !text;
  }

  function button(label, fn) {
    const el = node('button', '', label);
    el.type = 'button';
    el.addEventListener('click', fn);
    return el;
  }

  function field(grid, label, value, spec) {
    const wrapper = node('label', 'step-review-field');
    wrapper.append(node('span', '', label));
    const input = node(spec?.[0] === 'chromosome' ? 'select' : 'input', '');
    if (spec?.[0] === 'chromosome') {
      for (const option of ['no', ...Array.from({length:22}, (_, i) => String(i + 1))]) {
        const item = node('option', '', option === 'no' ? '所有設定的染色體' : undefined);
        if (option !== 'no') item.textContent = option;
        item.value = option;
        input.append(item);
      }
    } else if (spec && spec[0] !== 'text') {
      input.type = 'number';
      [input.min, input.max, input.step] = spec;
    } else {
      input.type = 'text';
      input.spellcheck = false;
      input.autocomplete = 'off';
    }
    input.required = true;
    input.value = value;
    wrapper.append(input);
    grid.append(wrapper);
    return input;
  }

  function reviewForm(parameters, resourceLimits, legend, rerunning = false) {
    const form = node('form', 'step-review-form');
    const fields = node('fieldset', 'step-review-fields');
    fields.append(node('legend', '', legend));
    if (name === 'adjust') {
      fields.append(node('p', 'step-review-notice', '請選用含樣本編號、種族與性別欄位的相容臨床表。'));
    }
    const values = {};
    for (const [group, schema] of Object.entries(schemas)) {
      const entries = Object.entries(parameters[group] || {});
      if (!entries.length) {
        if (group !== 'options') values[group] = {};
        continue;
      }
      const grid = node('div', group === 'inputs' ? 'step-review-grid step-review-inputs' : 'step-review-grid');
      values[group] = Object.fromEntries(entries.map(([key, value]) => {
        const spec = schema[key];
        const limits = group === 'resources' && resourceLimits?.[key];
        const config = limits ? [...limits, spec[3]] : Array.isArray(spec) ? spec.slice(1) : undefined;
        return [key, field(grid, Array.isArray(spec) ? spec[0] : spec, value, config)];
      }));
      if (rerunning && (group === 'inputs' || group === 'resources')) {
        const details = node('details', 'step-rerun-group');
        details.append(node('summary', '', group === 'inputs' ? '輸入檔案' : '運算資源'), grid);
        fields.append(details);
      } else fields.append(grid);
    }
    form.append(fields);
    form.addEventListener('submit', event => event.preventDefault());
    if (rerunning) form.addEventListener('invalid', event => {
      const group = event.target.closest('.step-rerun-group');
      if (group) group.open = true;
    }, true);
    const payload = () => Object.fromEntries(Object.entries(values).map(([group, fields]) => [
      group, Object.fromEntries(Object.entries(fields).map(([name, input]) => [
        name, input.type === 'text' ? input.value.trim() : input.value === 'no' ? 'no' : Number(input.value)
      ]))
    ]));
    return {form, fields, payload};
  }

  function showSavedSettings(parameters) {
    const sections = [
      ['輸入檔案', ['inputs']], ['分析參數', ['settings', 'options']], ['運算資源', ['resources']]
    ];
    for (const [title, groups] of sections) {
      const list = node('dl', 'step-review-grid');
      const fullPaths = node('dl', 'step-review-full-paths');
      for (const group of groups) {
        for (const [key, spec] of Object.entries(schemas[group])) {
          const value = parameters?.[group]?.[key];
          if (value === undefined) continue;
          const [label, kind] = Array.isArray(spec) ? spec : [spec];
          const item = node('div', 'step-review-field');
          const text = node('dd', '');
          if (kind === 'chromosome' && value === 'no') uiText(text, '所有設定的染色體');
          else if (group === 'inputs') {
            text.textContent = String(value).split('/').slice(key === 'ref' || key === 'gmap' ? -2 : -1).join('/');
            const path = node('dd', '');
            path.textContent = value;
            fullPaths.append(node('dt', '', label), path);
          } else text.textContent = key === 'int' ? Number(value).toLocaleString() : value;
          item.append(node('dt', '', label), text);
          list.append(item);
        }
      }
      if (!list.children.length) continue;
      const section = node('section', 'step-review-setting-group');
      section.append(node('h4', '', title), list);
      if (fullPaths.children.length) {
        const details = node('details', 'step-review-paths');
        details.append(node('summary', '', '查看完整路徑'), fullPaths);
        section.append(details);
      }
      savedValues.append(section);
    }
  }

  function reportRerun(text) {
    uiText(rerunStatus, text);
    rerunStatus.hidden = !text;
  }

  async function openRerun() {
    if (rerunBusy || !latest.canRerun || polling.controller.signal.aborted) return;
    const state = polling;
    rerunBusy = true;
    rerun.disabled = true;
    reportRerun('');
    try {
      const proposal = await request(name, 'prepare', {}, state, true);
      if (state.controller.signal.aborted) return;
      const dialog = node('dialog', 'step-rerun-sheet');
      const heading = node('div', 'step-rerun-heading');
      dialog.setAttribute('aria-label', translateUI('重新執行'));
      const {form, fields, payload} = reviewForm(proposal.parameters, proposal.resource_limits, stageReviewNames[name], true);
      const impact = node('div', 'step-rerun-impact');
      function showImpact() {
        const pair = proposal.chromosome_pair;
        const changed = pair && String(payload().settings[pair.setting]) !== String(proposal.parameters.settings[pair.setting]);
        const affected = changed ? [pair.stage, ...proposal.affected_steps] : proposal.affected_steps;
        const reused = changed ? proposal.reused_steps.filter(step => step !== pair.stage) : proposal.reused_steps;
        impact.replaceChildren(node('strong', '', '這次會影響哪些階段'), node('p', '', '保留原分析結果。'));
        for (const [stages, label] of [[affected, '需要重跑'], [reused, '可沿用']]) {
          if (!stages.length) continue;
          const list = node('ul', '');
          for (const step of stages) list.append(node('li', '', stageReviewNames[step]));
          impact.append(node('span', '', label), list);
        }
        if (!affected.length) impact.append(node('p', '', '沒有後續階段需要重跑。'));
      }
      showImpact();
      if (proposal.chromosome_pair) form.addEventListener('change', showImpact);
      const actions = node('div', 'step-review-actions step-rerun-actions');
      const error = node('p', 'step-review-notice');
      error.setAttribute('role', 'status');
      const cancel = button('取消', () => dialog.close());
      const close = button('取消', () => dialog.close());
      close.className = 'step-rerun-close';
      close.setAttribute('aria-label', translateUI('取消'));
      close.dataset.i18nAria = '取消';
      heading.append(node('h2', '', '重新執行'), close);
      const accept = button('確認重新送算', () => void submitRerun());
      accept.className = 'step-review-accept';
      actions.append(cancel, accept);
      dialog.append(heading, node('p', 'step-review-notice', '沿用上次設定，可在送算前調整。'), form, impact, error, actions);
      let submitting = false;
      dialog.addEventListener('cancel', event => {if (submitting) event.preventDefault();});
      dialog.addEventListener('close', () => {
        dialog.remove();
        rerunBusy = false;
        rerun.disabled = !latest.canRerun;
      });
      async function submitRerun() {
        if (submitting || state.controller.signal.aborted || !form.reportValidity()) return;
        submitting = true;
        fields.disabled = accept.disabled = cancel.disabled = close.disabled = true;
        uiText(error, '正在確認並送算…');
        try {
          await request(name, 'confirm', {proposal_id:proposal.id, ...payload()}, state, true);
          if (!state.controller.signal.aborted) {
            reportRerun('新的分析已建立，請查看聊天中的進度。');
            dialog.close();
          }
        } catch (failure) {
          if (!state.controller.signal.aborted) {
            uiText(error, '無法完成重新送算，請查看分析進度。');
            if (failure.message) {
              const detail = node('small', 'step-review-error-detail');
              detail.textContent = failure.message;
              error.append(detail);
            }
          }
        } finally {
          submitting = false;
          fields.disabled = accept.disabled = cancel.disabled = close.disabled = false;
          if (!state.controller.signal.aborted) void poll(state);
        }
      }
      panel.append(dialog);
      dialog.showModal();
    } catch (error) {
      rerunBusy = false;
      rerun.disabled = !latest.canRerun;
      if (!state.controller.signal.aborted) reportRerun('無法開啟重新執行設定，請重新整理分析進度。');
    }
  }

  function showProgress(metrics) {
    const next = JSON.stringify(metrics);
    if (progressKey === next) return;
    progressKey = next;
    const rows = [];
    for (const [key, count] of Object.entries(metrics || {})) {
      const label = stageMetricLabels[key];
      const values = /^(\d+)\s+(\d+)$/.exec(count);
      if (!label || !values) continue;
      const done = Number(values[1]), total = Number(values[2]);
      if (!Number.isSafeInteger(total) || !Number.isSafeInteger(done) || total <= 0 || done > total) continue;
      const bar = node('progress', 'step-review-bar');
      bar.max = total;
      bar.value = done;
      bar.setAttribute('aria-label', translateUI(label));
      bar.dataset.i18nAria = label;
      const metric = node('div', 'step-review-metric');
      const countText = node('span', '');
      countText.textContent = `${done}/${total}`;
      metric.append(node('span', '', label), countText, bar);
      rows.push(metric);
    }
    progress.replaceChildren(...rows);
  }

  function render(review, state) {
    latest = review;
    polling = state;
    const {step, proposal, canPrepare, resourceLimits} = review;
    const label = step.reused_from ? '沿用已完成結果' : phases[step.phase] || phases.unknown;
    phase.hidden = step.phase === 'not_started';
    phase.dataset.phase = step.phase;
    if (phase.dataset.i18n !== label) uiText(phase, label);
    rerun.hidden = step.phase !== 'completed';
    rerun.disabled = !review.canRerun || rerunBusy;
    showProgress(step.progress);
    history.hidden = !step.parameters;
    const nextParameters = JSON.stringify(step.parameters);
    if (parametersKey !== nextParameters) {
      parametersKey = nextParameters;
      savedValues.replaceChildren();
      showSavedSettings(step.parameters);
    }
    if (busy) return;
    const next = JSON.stringify([proposal?.id, proposal?.state, canPrepare]);
    if (next === key) return;
    key = next;
    controls.replaceChildren();
    say('');
    if (proposal?.state === 'pending') {
      if (!canPrepare) {
        say('分析已開始，這張確認卡不能再送算。');
        return;
      }
      const {form, fields, payload} = reviewForm(proposal.parameters, resourceLimits,
        proposal.mode === 'example' ? '官方示範資料 · 請確認設定' : '請確認資料與設定');
      const actions = node('div', 'step-review-actions');
      const accept = button('同意，開始這一步', confirm);
      accept.className = 'step-review-accept';
      const decline = button('先不要', () => void act('decline', {proposal_id:proposal.id}, fields));
      actions.append(accept, decline);
      fields.append(actions);
      function confirm() {
        if (busy || !form.reportValidity()) return;
        void act('confirm', {proposal_id:proposal.id, ...payload()}, fields);
      }
      controls.append(form);
    } else {
      if (proposal) say(summaries[proposal.state] || '');
      if (canPrepare && proposal?.state !== 'confirmed') {
        const actions = node('div', 'step-review-actions');
        const prepare = button(name === 'genotype' ? '設定第一階段' : '準備本階段設定',
          () => void act('prepare', name === 'genotype' ? {mode:'custom'} : {}, actions));
        actions.append(prepare);
        if (name === 'genotype' || name === 'expression') {
          actions.append(button('使用官方示範資料', () => void act('prepare', {mode:'example'}, actions)));
        }
        controls.append(actions);
        if (name !== 'genotype' && step.phase === 'not_started' && !proposal && !attempted) {
          attempted = true;
          void act('prepare', {}, actions);
        }
      }
    }
  }

  async function act(action, body, section) {
    if (busy || !latest.canPrepare || !polling || polling.controller.signal.aborted) return;
    const state = polling;
    busy = true;
    const buttons = Array.from(section.querySelectorAll('button'));
    buttons.forEach(button => {button.disabled = true;});
    if (action === 'confirm') {
      section.disabled = true;
      say('正在確認並送算…');
    }
    try {
      const result = await request(name, action, body, state);
      if (state.controller.signal.aborted) return;
      if (latest.canPrepare) {
        const proposal = action === 'confirm'
          ? {...latest.proposal, state:result.state === 'unknown' ? 'unknown' : 'sent'} : result;
        latest = {...latest, proposal, canPrepare:action !== 'confirm'};
      }
    } catch (error) {
      if (!state.controller.signal.aborted) {
        const message = error.code === 'conflict' ? '確認卡已過期或已使用，請重新準備設定。'
          : error.code === 'not_ready' ? '請先連線到 HPC3，再重試。'
          : error.code === 'invalid_request' ? '請檢查輸入資料與設定。'
          : '無法確認操作結果，請先查看進度。';
        say(message);
        if (error.code === 'invalid_request' && error.message) {
          const detail = node('small', 'step-review-error-detail');
          detail.textContent = error.message;
          notice.append(detail);
        }

      }
    } finally {
      busy = false;
      section.disabled = false;
      buttons.forEach(button => {button.disabled = false;});
      if (!state.controller.signal.aborted) {
        render(latest, state);
        void poll(state);
      }
    }
  }

  return {panel, update:render};
}
