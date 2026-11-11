// The model proposes; only a click on this card can send reviewed values.
function createStepReview(progressCard, request, poll) {
  const panel = node('article', 'step-review-card');
  panel.hidden = true;
  const title = node('strong', '');
  const controls = node('div', 'step-review-controls');
  const notice = node('p', 'step-review-notice');
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  panel.append(title, controls, notice);
  progressCard.after(panel);
  let latest, polling, key, busy = false;

  const names = {
    genotype:'第 1 階段 · 基因型前處理', expression:'第 2 階段 · 基因表現前處理',
    adjust:'第 3 階段 · 樣本調整', cis:'第 4 階段 · 尋找附近變異',
    network:'第 5 階段 · 建構調控網路', visualize:'第 6 階段 · 畫出網路圖'
  };
  const attempted = new Set();
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

  function render(analysis, state) {
    latest = analysis;
    polling = state;
    if (busy) return;
    const name = analysis.next_step;
    const proposal = analysis.proposal;
    const step = analysis.steps.find(item => item.step === name);
    const canPrepare = ['not_started', 'failed', 'cancelled'].includes(step?.phase)
      && !analysis.steps.some(item => ['submitting', 'submitted', 'queued', 'running', 'validating',
        'downloading', 'cancelling', 'unknown'].includes(item.phase));
    panel.hidden = !proposal && !canPrepare;
    const next = JSON.stringify([name, proposal?.id, proposal?.state, canPrepare]);
    if (next === key) return;
    key = next;
    controls.replaceChildren();
    say('');
    if (!name) return;
    uiText(title, names[name]);

    if (proposal?.state === 'pending') {
      if (!canPrepare) {
        say('分析已開始，這張確認卡不能再送算。');
        return;
      }
      const form = node('form', 'step-review-form');
      const fields = node('fieldset', 'step-review-fields');
      fields.append(node('legend', '', proposal.mode === 'example' ? '官方示範資料 · 請確認設定' : '請確認資料與設定'));
      if (name === 'adjust') {
        fields.append(node('p', 'step-review-notice', '請選用含樣本編號、種族與性別欄位的相容臨床表。'));
      }
      const values = {};
      for (const [group, schema] of Object.entries({inputs, settings, resources, options})) {
        const entries = Object.entries(proposal.parameters[group] || {});
        if (!entries.length) {
          if (group !== 'options') values[group] = {};
          continue;
        }
        const grid = node('div', group === 'inputs' ? 'step-review-grid step-review-inputs' : 'step-review-grid');
        values[group] = Object.fromEntries(entries.map(([key, value]) => {
          const spec = schema[key];
          const limits = group === 'resources' && analysis.resource_limits?.[key];
          const config = limits ? [...limits, spec[3]] : Array.isArray(spec) ? spec.slice(1) : undefined;
          return [key, field(grid, Array.isArray(spec) ? spec[0] : spec, value, config)];
        }));
        fields.append(grid);
      }
      const actions = node('div', 'step-review-actions');
      const accept = button('同意，開始這一步', confirm);
      accept.className = 'step-review-accept';
      const decline = button('先不要', () => void act(name, 'decline', {proposal_id:proposal.id}, fields));
      actions.append(accept, decline);
      fields.append(actions);
      form.append(fields);
      form.addEventListener('submit', event => event.preventDefault());
      function confirm() {
        if (busy || !form.reportValidity()) return;
        const payload = Object.fromEntries(Object.entries(values).map(([group, fields]) => [
          group, Object.fromEntries(Object.entries(fields).map(([name, input]) => [
            name, input.type === 'text' ? input.value.trim() : input.value === 'no' ? 'no' : Number(input.value)
          ]))
        ]));
        void act(name, 'confirm', {proposal_id:proposal.id, ...payload}, fields);
      }
      controls.append(form);
    } else {
      if (proposal) say(summaries[proposal.state] || '');
      if (canPrepare && proposal?.state !== 'confirmed') {
        const actions = node('div', 'step-review-actions');
        const prepare = button(name === 'genotype' ? '設定第一階段' : '準備本階段設定',
          () => void act(name, 'prepare', name === 'genotype' ? {mode:'custom'} : {}, actions));
        actions.append(prepare);
        if (name === 'genotype' || name === 'expression') {
          actions.append(button('使用官方示範資料', () => void act(name, 'prepare', {mode:'example'}, actions)));
        }
        controls.append(actions);
        if (name !== 'genotype' && step.phase === 'not_started' && !proposal && !attempted.has(name)) {
          attempted.add(name);
          void act(name, 'prepare', {}, actions);
        }
      }
    }
  }

  async function act(name, action, body, section) {
    if (busy || !polling || polling.controller.signal.aborted) return;
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
      if (latest.next_step === name) {
        const proposal = action === 'confirm'
          ? {...latest.proposal, state:result.state === 'unknown' ? 'unknown' : 'sent'} : result;
        latest = {...latest, proposal};
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

  return {update:render, remove:() => panel.remove()};
}
