'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const folder = path.join(__dirname, '../renderer/features/workspace');
const html = readFileSync(path.join(folder, 'index.html'), 'utf8').replace('__INITIAL_CHAT__', '{}');
const code = readFileSync(path.join(folder, 'workspace.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const reply = (value, status = 200) => ({ok: status < 400, status, json: async () => clone(value)});
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check) {
  for (let i = 0; i < 80; i++) {if (check()) return; await settle();}
  assert.fail('Saved timeline did not settle');
}
const steps = ['genotype', 'expression', 'adjust', 'cis', 'network', 'visualize'];
function run(source = 'archive') {
  return {history_id: `${source === 'live' ? 'workspace' : source}--shared`, run_id: 'shared', revision: 'one',
    name: ['保存執行', 'Saved run'], source, origin: source === 'live' ? 'workspace' : source,
    dataset_id: 'example-chr1', inputs: {}, status: 'completed', operations: [], issues: [],
    capabilities: {continue_analysis: source === 'live', stage_results: ['1', '2', '3', '4', '5', '6'], stage6_graph: true},
    jobs: Object.fromEntries(steps.map((step, index) => [step, {state: 'completed', attempt: 1,
      settings: index === 0 ? {mind: '0.12'} : index === 5 ? {freq: '.45', ntop: '1'} : {},
      options: index === 2 ? {npc: 2} : {}}])), graph: {genes: 3, connections: 2}};
}
function saved(stage, source = 'archive') {
  if (stage === 3) return {run_id: 'shared', npc: 2,
    matching: {genotype: 9, expression: 8, matched: 7, retained: 6, excluded: 1},
    pca: {points: [[1, 1], [2, 3], [4, 2]], variance_explained: [60, 30], source: 'retained_genotype'}};
  if (stage === 6) return {run_id: 'shared', source, frequency: .45, top_networks: 1,
    graph: {nodes: source === 'live' ? ['A', 'B', 'C'] : ['X', 'Y'],
      edges: [{source: source === 'live' ? 'A' : 'X', target: source === 'live' ? 'B' : 'Y', frequency: 1, coefficient: .5}],
      counts: {genes: source === 'live' ? 3 : 2, connections: 1}}};
  const summary = {
    1: {samples: 7, variants: 11, nonzero_bins: [1, 2, 3, 4, 0, 1], genotype_codes: [10, 10, 1]},
    2: {samples: 6, genes: 4, histogram: [{lower: 0, upper: 10, count: 24}], gene_summary: []},
    4: {genes: 2, counts: {common: 2, low: 1, rare: 0}, pairs: []},
    5: {genes: 4, frequencies: [{frequency: .5, count: 3}, {frequency: 1, count: 2}], edges: []},
  }[stage];
  return {run_id: 'shared', stage, summary};
}
function harness(t, rows, handler, manualRuns = {}) {
  const dom = new JSDOM(html, {url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true});
  const {window} = dom, calls = [];
  t.after(async () => {await settle(); window.close();});
  window.ResizeObserver = class {observe() {}};
  window.CSS = {escape: value => String(value).replace(/[^\w-]/g, '\\$&')};
  window.HTMLElement.prototype.scrollIntoView = function() {};
  window.SignetInputValidation = {create: () => ({sync() {}})};
  window.lucide = {createIcons() {
    for (const icon of window.document.querySelectorAll('.ml-stage-preview [data-lucide]')) {
      icon.replaceWith(window.document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    }
  }};
  for (const name of ['Genotype', 'Expression', 'Adjustment', 'Cis', 'Network', 'Visualization']) {
    window['mount' + name + 'Run'] = () => ({setContext() {}, getRunId: () => manualRuns[name] ?? null});
  }
  window.fetch = async (url, options = {}) => {
    calls.push({url, options});
    const custom = handler?.(url, options);
    if (custom !== undefined) return custom;
    if (url === '/stage6/history') return reply({runs: rows});
    if (url === '/signet/datasets') return reply({datasets: [{id: 'example-chr1', name: ['資料組', 'Dataset'], inputs: {}}]});
    const query = new URL('http://localhost' + url).searchParams;
    if (url.startsWith('/stage3/results?')) return reply(saved(3));
    if (url.startsWith('/stage6/results?')) return reply(saved(6, query.get('source')));
    if (url.startsWith('/stage/results?')) return reply(saved(Number(query.get('stage'))));
    throw Error('Unexpected request: ' + url);
  };
  window.eval(code);
  const q = selector => window.document.querySelector(selector);
  const click = selector => {assert.ok(q(selector), selector); q(selector).dispatchEvent(new window.MouseEvent('click', {bubbles: true}));};
  const choose = (selector, value) => {q(selector).value = value; q(selector).dispatchEvent(new window.Event('change', {bubbles: true}));};
  const entry = stage => q(`[data-stage="${stage}"]`).closest('.ml-stage-entry');
  const open = (id, stage) => {click(`[data-run-target="${id}"]`); click(`#ml-run-${id} [data-run-stage="${stage}"]`);};
  const back = stage => click(stage === 3 ? '#ml-stage3-back' : stage === 6 ? '#ml-stage6-back' : '#ml-archive-stage-back');
  return {window, q, click, choose, calls, entry, open, back, ready: async () => {
    await until(() => q('[data-run-target]'));
    click('[data-nav-target="history"]');
  }};
}

test('opens the start page with completed runs available and waits for an explicit stage selection', async t => {
  const row = run('live');
  const h = harness(t, [row]);
  const welcome = h.q('#ml-start');
  const connection = h.q('#ml-start-connection');
  const status = () => h.q('#ml-start-connection-status').textContent;
  const remote = connected => h.window.dispatchEvent(new h.window.CustomEvent('workspace-remote-context', {detail: {connected}}));
  const active = () => h.q('#ml-timeline [aria-current="step"]');
  assert.equal(welcome.hidden, false);
  assert.equal(status(), 'Not connected');
  assert.equal(connection.hasAttribute('data-connected'), false);
  remote(true);
  assert.equal(status(), 'Connected');
  assert.equal(connection.hasAttribute('data-connected'), true);
  remote(false);
  assert.equal(status(), 'Not connected');
  assert.equal(connection.hasAttribute('data-connected'), false);
  await until(() => h.q('[data-run-target]'));
  assert.equal(h.q('#lens-stage6').hidden, true);
  assert.equal(active(), null);
  assert.equal(h.q('#ml-start-title').textContent, 'Start an analysis');
  for (const view of ['settings', 'data', 'history']) {
    h.click(`[data-start-view="${view}"]`);
    assert.equal(h.q('.ml-app').dataset.nav, view);
    assert.equal(h.window.document.activeElement, h.q(`[data-nav-target="${view}"]`));
    if (view !== 'settings') assert.equal(welcome.hidden, true);
    h.click('[data-nav-target="analysis"]');
  }
  h.click('#ml-start-stage');
  assert.equal(welcome.hidden, true);
  assert.equal(h.q('#ml-stage-tab').getAttribute('aria-selected'), 'true');
  assert.equal(active()?.dataset.stage, '1');
  h.click('#ml-timeline [data-stage="6"]');
  await until(() => !h.q('#lens-stage6').hidden && h.q('#lens-stage6').dataset.historyId === row.history_id);
  assert.ok(h.calls.every(call => !call.options.method || call.options.method === 'GET'));
});

test('all six summaries and previews come only from lazily opened saved results, with readable settings', async t => {
  const row = run();
  const original = JSON.stringify(row);
  const h = harness(t, [row]); await h.ready();
  assert.deepEqual(h.calls.map(call => call.url), ['/stage6/history', '/signet/datasets']);
  assert.match(h.entry(1).textContent, /Max\. sample missingness: 0\.12/);
  assert.match(h.entry(3).textContent, /Principal components: 2/);
  for (let stage = 1; stage <= 6; stage++) {
    assert.equal(h.entry(stage).querySelector('.ml-stage-preview').hidden, true);
    assert.equal(h.entry(stage).querySelector('.ml-stage-note').textContent, 'Completed');
    assert.match(h.entry(stage).textContent, /Open this stage to load its saved summary/);
    h.open(row.history_id, stage);
    await until(() => !h.entry(stage).querySelector('.ml-stage-preview').hidden);
    assert.ok(h.entry(stage).querySelector('.ml-stage-thumbnail').childElementCount > 0);
    assert.doesNotMatch(h.entry(stage).querySelector('.ml-stage-detail').textContent, /[{}]/);
    h.back(stage);
    assert.equal(h.q('#ml-timeline').dataset.historyId, row.history_id);
  }
  assert.match(h.entry(1).textContent, /Samples 7 · Variants 11/);
  assert.match(h.entry(2).textContent, /Samples 6 · Genes 4/);
  assert.match(h.entry(3).textContent, /Genotype samples 9.*Expression samples 8.*Matched samples 7.*Retained samples 6.*Excluded samples 1.*Principal components 2/);
  assert.match(h.entry(4).textContent, /Significant pairs 3 · Genes represented 2/);
  assert.match(h.entry(5).textContent, /Candidate edges 5 · Genes analyzed 4/);
  assert.match(h.entry(6).textContent, /Genes 2 · Edges 1/);
  assert.match(h.entry(1).textContent, /Max\. sample missingness: 0\.12/);
  assert.match(h.entry(3).textContent, /Principal components: 2.*Matched samples 7.*Retained samples 6/s);
  assert.match(h.entry(6).textContent, /Frequency threshold: \.45.*Maximum displayed subnetworks: 1.*Genes 2 · Edges 1/s);
  assert.equal(h.entry(3).querySelector('.ml-stage-note').textContent, 'Completed');
  assert.equal(JSON.stringify(row), original);
  assert.ok(h.calls.every(call => !call.options.method || call.options.method === 'GET'));
});

test('Stage 5 plots dense frequencies on a percentage axis without stacking the labels', async t => {
  const row = run('live');
  const result = saved(5, 'live');
  result.summary.frequencies = Array.from({length: 100}, (_, i) =>
    ({frequency: (i + 1) / 100, count: 125 - i})).filter(bin => bin.frequency !== .64);
  const h = harness(t, [row], url => {
    if (url.startsWith('/stage/results?') && new URL(url, 'http://localhost').searchParams.get('stage') === '5') return reply(result);
  });
  await h.ready();
  h.open(row.history_id, 5);
  const chart = () => h.q('#lens-history-stage .ml-count-chart');
  await until(chart);
  assert.equal(chart().querySelectorAll('.ml-count-bar').length, 99);
  assert.equal(chart().querySelectorAll('.ml-count-label').length, 0);
  assert.deepEqual([...chart().querySelectorAll('.ml-count-frequency-tick')].map(el => el.textContent),
    ['0%', '20%', '40%', '60%', '80%', '100%']);
  const bars = [...chart().querySelectorAll('.ml-count-bar')];
  assert.equal(bars[0].querySelector('title').textContent, '1% · Candidate edge count 125');
  assert.equal(bars.at(-1).querySelector('title').textContent, '100% · Candidate edge count 26');
  const gap = index => Number(bars[index + 1].getAttribute('x')) - Number(bars[index].getAttribute('x'));
  assert.ok(Math.abs(gap(62) - 2 * gap(61)) < .001, 'a missing percentage leaves a gap on the numeric axis');
  assert.equal(chart().querySelector('.ml-count-bar title').textContent, '1% · Candidate edge count 125');
});

test('analysis sidebar stages keep the selected archive instead of opening a same-named live run', async t => {
  const h = harness(t, [run('live'), run()]); await h.ready();
  h.click('[data-nav-target="analysis"]');
  h.choose('#ml-stage6-run', 'archive--shared');
  await until(() => h.q('#lens-stage6').dataset.historyId === 'archive--shared');
  h.click('#lens-stage6 [data-gene="X"]');
  h.click('#ml-timeline [data-stage="3"]');
  await until(() => h.q('#lens-history-stage3').hidden === false);
  assert.equal(h.q('.ml-app').dataset.nav, 'analysis');
  assert.equal(h.q('#lens-stage3').hidden, true, 'A different live execution form must stay hidden');
  await until(() => h.q('#lens-history-stage3').dataset.historyId === 'archive--shared');
  const context = {};
  h.window.dispatchEvent(new h.window.CustomEvent('workspace-context-request', {detail: context}));
  assert.equal(context.context.history_id, 'archive--shared');
  assert.equal(context.context.stage, 3);
  assert.ok(h.calls.some(call => call.url === '/stage3/results?run=shared&source=archive'));
  for (const stage of [1, 2, 4, 5]) {
    h.click(`#ml-timeline [data-stage="${stage}"]`);
    await until(() => h.q('#lens-history-stage').hidden === false &&
      h.q('#lens-history-stage').dataset.historyId === 'archive--shared' &&
      h.q('#lens-history-stage').dataset.stage === String(stage));
    assert.equal(h.q(`#lens-stage${stage}`).hidden, true);
  }
  h.click('#ml-timeline [data-stage="6"]');
  await until(() => h.q('#lens-stage6').hidden === false && h.q('#lens-stage6').dataset.historyId === 'archive--shared');
  assert.equal(h.q('#lens-stage6').dataset.selectedGene, 'X');
  assert.equal(h.q('#lens-stage6 tbody').rows.length, 1);
  assert.equal(h.q('#ml-timeline').dataset.historyId, 'archive--shared');
  h.click('[data-nav-target="history"]');
  assert.equal(h.q('[data-run-target="archive--shared"]').getAttribute('aria-pressed'), 'true');
  assert.equal(h.q('#lens-stage6').dataset.historyId, 'archive--shared');
  h.click('[data-nav-target="analysis"]');
  h.click('#ml-timeline [data-stage="3"]');
  await until(() => h.q('#lens-history-stage3').dataset.historyId === 'archive--shared');
  h.click('[data-nav-target="settings"]');
  assert.equal(h.q('#lens-history-stage3').hidden, false, 'Settings keeps the selected saved result');
  assert.equal(h.q('#lens-stage3').hidden, true);
  h.click('[data-nav-target="history"]');
  h.open('workspace--shared', 3);
  await until(() => h.q('#lens-history-stage3').dataset.historyId === 'workspace--shared');
  h.click('[data-nav-target="analysis"]');
  await until(() => h.q('#lens-history-stage3').dataset.historyId === 'archive--shared');
  assert.equal(h.q('#lens-history-stage3').hidden, false, 'Analysis restores its own canonical saved selection');
  assert.ok(h.calls.every(call => !call.options.method || call.options.method === 'GET'));
});

test('an unavailable archived sidebar stage stays empty instead of falling back to a live form', async t => {
  const archived = run();
  archived.capabilities.stage_results = ['6'];
  archived.jobs.adjust.state = 'not_submitted';
  const h = harness(t, [run('live'), archived]); await h.ready();
  h.click('[data-nav-target="analysis"]');
  h.choose('#ml-stage6-run', archived.history_id);
  await until(() => h.q('#lens-stage6').dataset.historyId === archived.history_id);
  h.click('#ml-timeline [data-stage="3"]');
  assert.equal(h.q('#lens-history-stage3').hidden, false);
  assert.equal(h.q('#lens-history-stage3').dataset.runState, 'empty');
  assert.equal(h.q('#lens-stage3').hidden, true);
  assert.equal(h.calls.some(call => call.url.startsWith('/stage3/results?')), false);
  h.click('#ml-timeline [data-stage="2"]');
  assert.equal(h.q('#lens-history-stage').hidden, false);
  assert.equal(h.q('#lens-history-stage').dataset.runState, 'empty');
  assert.equal(h.q('#lens-stage2').hidden, true);
  assert.equal(h.calls.some(call => call.url.startsWith('/stage/results?')), false);
});

test('same run ID keeps source-specific results, restores gene selection, and hides absent or unfinished results', async t => {
  const live = run('live'), archived = run();
  archived.jobs.expression = {state: 'running', settings: {'restrict.tcga': 2}};
  archived.capabilities.stage_results = ['1', '3', '4', '5', '6'];
  const h = harness(t, [live, archived]); await h.ready();
  h.open(live.history_id, 6);
  await until(() => h.q('#lens-stage6').dataset.historyId === live.history_id);
  h.click('#lens-stage6 [data-gene="A"]'); h.back(6);
  h.click(`[data-run-target="${archived.history_id}"]`);
  assert.equal(h.entry(6).querySelector('.ml-stage-preview').hidden, true);
  assert.match(h.entry(2).textContent, /Running.*No readable saved result is available/s);
  h.open(archived.history_id, 6);
  await until(() => h.q('#lens-stage6').dataset.historyId === archived.history_id);
  assert.match(h.entry(6).textContent, /Genes 2/); h.back(6);
  h.open(live.history_id, 6);
  await until(() => h.q('#lens-stage6').dataset.historyId === live.history_id);
  assert.match(h.entry(6).textContent, /Genes 3/);
  assert.equal(h.q('#lens-stage6 [data-gene="A"]').getAttribute('aria-pressed'), 'true');
  h.back(6);
  h.click('[data-nav-target="analysis"]');
  h.click('#ml-timeline [data-stage="6"]');
  h.choose('#ml-stage6-run', '');
  assert.equal(h.q('#ml-timeline').dataset.historyId, '');
  assert.equal(h.entry(6).querySelector('.ml-stage-preview').hidden, true);
  assert.doesNotMatch(h.entry(6).textContent, /Genes [23]/);
});

test('missing, failed and foreign result reads do not render success counts or demonstration thumbnails', async t => {
  const h = harness(t, [run()], url => {
    if (url.startsWith('/stage3/results?')) return reply({}, 404);
    if (url.startsWith('/stage6/results?')) return reply({...saved(6), source: 'live'});
    if (url.startsWith('/stage/results?')) return reply({}, 500);
  }); await h.ready();
  h.open('archive--shared', 3);
  await until(() => h.q('#lens-history-stage3').dataset.runState === 'empty');
  assert.match(h.entry(3).textContent, /No readable saved result is available/); h.back(3);
  h.open('archive--shared', 6);
  await until(() => h.q('#lens-stage6').dataset.runState === 'load-error');
  assert.match(h.entry(6).textContent, /Could not load saved results/); h.back(6);
  h.open('archive--shared', 1);
  await until(() => h.q('#lens-history-stage').dataset.runState === 'error');
  assert.match(h.entry(1).textContent, /Could not load saved results/);
  for (const stage of [1, 3, 6]) {
    assert.equal(h.entry(stage).querySelector('.ml-stage-preview').hidden, true);
    assert.equal(h.entry(stage).querySelector('.ml-stage-thumbnail').childElementCount, 0);
    assert.doesNotMatch(h.entry(stage).textContent, /Genes|Retained samples|Samples 7/);
  }
});

test('opening Stage loads all six completed thumbnails one at a time', async t => {
  const row = run();
  const requested = [];
  let finishFirst;
  const h = harness(t, [row], url => {
    const request = new URL(url, 'http://localhost');
    if (!request.searchParams.has('run')) return;
    const stage = request.pathname === '/stage3/results' ? 3 : request.pathname === '/stage6/results' ? 6
      : Number(request.searchParams.get('stage'));
    if (!stage) return;
    requested.push(stage);
    if (stage === 1) return new Promise(resolve => { finishFirst = resolve; });
    return reply(saved(stage, row.source));
  });
  await h.ready();h.click('#ml-stage-tab');
  await until(() => Boolean(finishFirst));assert.deepEqual(requested, [1]);
  finishFirst(reply(saved(1)));
  await until(() => steps.every((_, index) => !h.entry(index + 1).querySelector('.ml-stage-preview').hidden));
  assert.deepEqual(requested, [1, 2, 3, 4, 5, 6]);
  assert.match(h.entry(1).textContent, /Samples 7 · Variants 11/);
  assert.match(h.entry(2).textContent, /Samples 6 · Genes 4/);
  assert.equal(h.q('#lens-history-stage').hidden, true);
});

test('a timed out thumbnail leaves the next completed stage eligible to load', async t => {
  const row = run('live');
  row.jobs = {genotype: {state: 'completed'}, expression: {state: 'completed'}, adjust: {state: 'running'}};
  row.capabilities.stage_results = ['1', '2', '3'];row.capabilities.stage6_graph = false;row.graph = null;
  const h = harness(t, [row], url => {
    if (url.startsWith('/stage/results?') && new URL(url, 'http://localhost').searchParams.get('stage') === '1') return reply({}, 504);
  });
  await h.ready();h.click('#ml-stage-tab');
  await until(() => h.entry(2).textContent.includes('Samples 6'));
  assert.match(h.entry(1).textContent, /Result read timed out/);
  assert.equal(h.entry(1).querySelector('.ml-stage-preview').hidden, true);
  assert.equal(h.calls.some(call => call.url.startsWith('/stage3/results?')), false);
  assert.equal(h.calls.filter(call => call.url.startsWith('/stage/results?')).length, 2);
});

test('the visible live timeline advances from measured progress to saved results without opening a stage', async t => {
  const row = run('live');
  row.jobs = {genotype: {state: 'running', job_id: '123', progress: {imputation: '9 36'}}};
  row.capabilities.stage_results = [];row.capabilities.stage6_graph = false;row.graph = null;
  const h = harness(t, [row]);await h.ready();h.click('#ml-stage-tab');
  assert.match(h.entry(1).querySelector('.ml-stage-note').textContent, /9 \/ 36/);
  assert.equal(h.entry(1).querySelector('.ml-stage-thumbnail rect:last-child').getAttribute('width'), '31');
  row.jobs.genotype.progress.imputation = '18 36';
  h.click('#ml-history-retry');await until(() => h.entry(1).textContent.includes('18 / 36'));
  assert.equal(h.entry(1).querySelector('.ml-stage-thumbnail rect:last-child').getAttribute('width'), '62');
  row.revision = 'genotype-complete';row.jobs.genotype.state = 'completed';row.capabilities.stage_results.push('1');
  row.jobs.expression = {state: 'pending', job_id: '124'};
  h.click('#ml-history-retry');await until(() => h.entry(1).textContent.includes('Samples 7'));
  assert.equal(h.entry(1).dataset.runState, 'completed');assert.equal(h.entry(2).dataset.runState, 'pending');
  assert.equal(h.entry(1).querySelector('.ml-stage-thumbnail').childElementCount, 6);
  row.revision = 'expression-complete';row.jobs.expression.state = 'completed';row.capabilities.stage_results.push('2');
  h.click('#ml-history-retry');await until(() => h.entry(2).textContent.includes('Samples 6'));
  assert.match(h.entry(1).textContent, /Samples 7/);
  assert.equal(h.q('#lens-history-stage').hidden, true);
  assert.deepEqual(h.calls.filter(call => call.url.startsWith('/stage/results?')).map(call => new URL(call.url, 'http://localhost').searchParams.get('stage')), ['1', '2']);
});

test('the manual Stage 2 timeline follows the run chosen in the preparation panel', async t => {
  const latest = run('live'), selected = run('live');
  selected.run_id = 'selected-run';selected.history_id = 'workspace--selected-run';
  for (const row of [latest, selected]) {
    row.jobs = {genotype: {state: 'completed'}, expression: {state: 'running'}};
    row.capabilities.stage_results = [];row.capabilities.stage6_graph = false;row.graph = null;
  }
  selected.jobs.expression.progress = {expression_outputs: '1 3'};
  const h = harness(t, [latest, selected], undefined, {Expression: selected.run_id});
  await h.ready();h.click('[data-nav-target="analysis"]');h.click('#ml-timeline [data-stage="2"]');
  assert.equal(h.q('#ml-timeline').dataset.historyId, selected.history_id);
  assert.match(h.entry(2).querySelector('.ml-stage-note').textContent, /1 \/ 3/);
  assert.equal(h.q('#lens-stage2').hidden, false);
});

test('switching runs aborts a pending live thumbnail and does not publish the old result', async t => {
  const first = run('live'), second = run('live');
  second.run_id = 'other';second.history_id = 'workspace--other';
  for (const row of [first, second]) {
    row.jobs = {genotype: {state: 'completed'}};
    row.capabilities.stage_results = ['1'];row.capabilities.stage6_graph = false;row.graph = null;
  }
  let finishFirst;
  const h = harness(t, [first, second], url => {
    if (!url.startsWith('/stage/results?')) return;
    const id = new URL(url, 'http://localhost').searchParams.get('run');
    if (id === first.run_id) return new Promise(resolve => { finishFirst = resolve; });
    return reply({...saved(1), run_id: second.run_id, summary: {...saved(1).summary, samples: 8}});
  });
  await h.ready();h.click('#ml-stage-tab');
  await until(() => Boolean(finishFirst));
  const firstRequest = h.calls.find(call => call.url.startsWith('/stage/results?'));
  h.click('[data-run-target="workspace--other"]');
  await until(() => h.entry(1).textContent.includes('Samples 8'));
  assert.equal(firstRequest.options.signal.aborted, true);
  finishFirst(reply(saved(1)));await settle();
  assert.equal(h.q('#ml-timeline').dataset.historyId, second.history_id);
  assert.doesNotMatch(h.entry(1).textContent, /Samples 7/);
});

test('a refreshed attempt or revision invalidates old timeline counts and previews until that result is opened', async t => {
  const row = run();
  const h = harness(t, [row]); await h.ready();
  h.open(row.history_id, 3);
  await until(() => !h.entry(3).querySelector('.ml-stage-preview').hidden);
  h.back(3);
  row.revision = 'new-attempt'; row.jobs.adjust.attempt = 2; row.jobs.adjust.options.npc = 4;
  h.click('#ml-history-retry');
  await until(() => h.entry(3).textContent.includes('Principal components: 4'));
  assert.equal(h.entry(3).querySelector('.ml-stage-preview').hidden, true);
  assert.doesNotMatch(h.entry(3).textContent, /Matched samples 7|Principal components 2/);
});

test('large saved plots keep real totals while bounding thumbnail marks', async t => {
  const h = harness(t, [run()], url => {
    if (url.startsWith('/stage3/results?')) return reply({...saved(3),
      matching: {...saved(3).matching, retained: 200},
      pca: {...saved(3).pca, points: Array.from({length: 200}, (_, index) => [index, index / 2])}});
    if (url.startsWith('/stage6/results?')) return reply({...saved(6), graph: {
      nodes: Array.from({length: 100}, (_, index) => 'GENE' + index),
      edges: Array.from({length: 99}, (_, index) => ({source: 'GENE' + index, target: 'GENE' + (index + 1), frequency: 1, coefficient: .1})),
      counts: {genes: 100, connections: 99},
    }});
  }); await h.ready();
  h.open('archive--shared', 3);
  await until(() => !h.entry(3).querySelector('.ml-stage-preview').hidden);
  assert.match(h.entry(3).textContent, /Retained samples 200/);
  const dots = h.entry(3).querySelectorAll('.ml-stage-thumbnail circle').length;
  assert.ok(dots > 0 && dots <= 48);
  h.back(3); h.open('archive--shared', 6);
  await until(() => !h.entry(6).querySelector('.ml-stage-preview').hidden);
  assert.match(h.entry(6).textContent, /Genes 100 · Edges 99/);
  assert.equal(h.entry(6).querySelectorAll('.ml-stage-thumbnail circle').length, 24);
  assert.ok(h.entry(6).querySelectorAll('.ml-stage-thumbnail line').length <= 48);
});


test('remote Stage3 shows a raster PCA and timeline preview without individual coordinates', async t => {
  const row = run('live');
  const picture = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ0kAAAAASUVORK5CYII=';
  const result = saved(3);
  result.pca = {png_base64: picture, width: 640, height: 420, point_count: 6, variance_explained: [60, 30], source: 'signet_smartpca'};
  const h = harness(t, [row], url => url.startsWith('/stage3/results?') ? reply(result) : undefined);
  await h.ready();h.open(row.history_id, 3);
  await until(() => h.q('.s3-remote-plot')?.hidden === false);
  assert.equal(h.q('.s3-remote-plot').getAttribute('src'), 'data:image/png;base64,' + picture);
  assert.equal(h.q('#lens-history-stage3 .s3-chart').hasAttribute('hidden'), true);
  assert.match(h.entry(3).textContent, /Retained samples 6/);
  const thumbnail = h.entry(3).querySelector('.ml-stage-thumbnail');
  assert.equal(thumbnail.querySelectorAll('circle').length, 0);
  assert.equal(thumbnail.querySelector('image').getAttribute('href'), 'data:image/png;base64,' + picture);
  assert.match(h.q('.s3-remote-plot').alt, /individual scores stay remote/);
});


test('history labels original and latest rerun and displays escaped parameter differences', async t => {
  const original = run('live'), child = run('live');
  original.rerun_family = {number:0,latest:false,changes:[],changes_available:true};
  child.run_id='rerun-one';child.history_id='workspace--rerun-one';
  child.rerun_family = {number:1,latest:true,source_run:'shared',from_step:'network',changes_available:true,
    changes:[{group:'settings',key:'nboots',before:100,after:500},{group:'clinical_choices',key:'<private-category>',before:'<img src=x>',after:'exclude'}]};
  const h = harness(t,[original,child]);await h.ready();
  assert.match(h.q('[data-run-target="workspace--shared"]').textContent,/Original run/);
  assert.match(h.q('[data-run-target="workspace--rerun-one"]').textContent,/Rerun 1.*Latest/);
  h.click('[data-run-target="workspace--rerun-one"]');
  const comparison = h.q('#ml-run-workspace--rerun-one [data-history-rerun-changes]');
  assert.match(comparison.textContent,/Bootstrap runs.*100.*500/s);
  assert.equal(comparison.querySelector('img'),null);assert.match(comparison.textContent,/<private-category>/);
  assert.match(h.q('#ml-run-workspace--rerun-one [data-history-rerun-changes]').textContent,/Bootstrap runs/);
});
