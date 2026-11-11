// The model proposes; only a click on this card can send reviewed values.
function createGenotypeReview(progressCard, request, poll) {
  const panel = node('article', 'genotype-review-card');
  panel.hidden = true;
  const title = node('strong', '', '第 1 階段 · 基因型前處理');
  const controls = node('div', 'genotype-review-controls');
  const notice = node('p', 'genotype-review-notice');
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  panel.append(title, controls, notice);
  progressCard.after(panel);
  let latest, polling, key, busy = false;

  const inputs = {'ped.file':'基因型資料（PED）', 'map.file':'基因型位置（MAP）',
    ref:'補值參考檔前綴', gmap:'遺傳圖譜前綴'};
  const settings = {
    'restrict.tcga.geno':['染色體', 'chromosome'],
    mind:['樣本缺失率上限', 0, 1, 'any'], geno:['位點缺失率上限', 0, 1, 'any'],
    hwe:['哈溫平衡門檻', 0, 1, 'any'], int:['補值分段長度（鹼基）', 1, 100000000, 1]
  };
  const resources = {cpus:['運算核心數', 1, 32, 1], mem_gb:['記憶體（GB）', 1, 128, 1],
    hours:['時間上限（小時）', .25, 24, 'any']};
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
    const wrapper = node('label', 'genotype-review-field');
    wrapper.append(node('span', '', label));
    const input = node(spec?.[0] === 'chromosome' ? 'select' : 'input', '');
    if (spec?.[0] === 'chromosome') {
      for (const option of ['no', ...Array.from({length:22}, (_, i) => String(i + 1))]) {
        const item = node('option', '', option === 'no' ? '所有設定的染色體' : undefined);
        if (option !== 'no') item.textContent = option;
        item.value = option;
        input.append(item);
      }
    } else if (spec) {
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
    const proposal = analysis.genotype_proposal;
    const genotype = analysis.steps.find(item => item.step === 'genotype');
    const canPrepare = ['not_started', 'failed', 'cancelled'].includes(genotype?.phase)
      && !analysis.steps.some(item => ['submitting', 'submitted', 'queued', 'running', 'validating',
        'downloading', 'cancelling', 'unknown'].includes(item.phase));
    panel.hidden = !proposal && !canPrepare;
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
      const form = node('form', 'genotype-review-form');
      const fields = node('fieldset', 'genotype-review-fields');
      fields.append(node('legend', '', proposal.mode === 'example' ? '官方示範資料 · 請確認設定' : '請確認資料與設定'));
      const values = {};
      for (const [group, schema] of Object.entries({inputs, settings, resources})) {
        const grid = node('div', group === 'inputs' ? 'genotype-review-grid genotype-review-inputs' : 'genotype-review-grid');
        values[group] = Object.fromEntries(Object.entries(schema).map(([name, spec]) => [
          name, field(grid, Array.isArray(spec) ? spec[0] : spec, proposal.parameters[group][name],
                      Array.isArray(spec) ? spec.slice(1) : undefined)
        ]));
        fields.append(grid);
      }
      const actions = node('div', 'genotype-review-actions');
      const accept = button('同意，開始這一步', confirm);
      accept.className = 'genotype-review-accept';
      const decline = button('先不要', () => void act('decline', {proposal_id:proposal.id}, fields));
      actions.append(accept, decline);
      fields.append(actions);
      form.append(fields);
      form.addEventListener('submit', event => event.preventDefault());
      function confirm() {
        if (busy || !form.reportValidity()) return;
        const payload = Object.fromEntries(Object.entries(values).map(([group, fields]) => [
          group, Object.fromEntries(Object.entries(fields).map(([name, input]) => [
            name, group === 'inputs' ? input.value.trim() : input.value === 'no' ? 'no' : Number(input.value)
          ]))
        ]));
        void act('confirm', {proposal_id:proposal.id, ...payload}, fields);
      }
      controls.append(form);
    } else {
      if (proposal) say(summaries[proposal.state] || '');
      if (canPrepare && proposal?.state !== 'confirmed') {
        const actions = node('div', 'genotype-review-actions');
        const custom = button('設定第一階段', () => void act('prepare', {mode:'custom'}, actions));
        const example = button('使用官方示範資料', () => void act('prepare', {mode:'example'}, actions));
        actions.append(custom, example);
        controls.append(actions);
      }
    }
  }

  async function act(action, body, section) {
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
      const result = await request(action, body, state);
      if (state.controller.signal.aborted) return;
      const proposal = action === 'confirm'
        ? {...latest.genotype_proposal, state:result.state === 'unknown' ? 'unknown' : 'sent'} : result;
      latest = {...latest, genotype_proposal:proposal};
    } catch (error) {
      if (!state.controller.signal.aborted) {
        const message = error.code === 'conflict' ? '確認卡已過期或已使用，請重新準備設定。'
          : error.code === 'not_ready' ? '請先連線到 HPC3，再重試。'
          : error.code === 'invalid_request' ? '請檢查輸入資料與設定。'
          : '無法確認操作結果，請先查看進度。';
        say(message);
        if (error.code === 'invalid_request' && error.message) {
          const detail = node('small', 'genotype-review-error-detail');
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
