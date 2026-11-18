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
function harness(t, rows, handler) {
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
    window['mount' + name + 'Run'] = () => ({setContext() {}});
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
  return {q, click, choose, calls, entry, open, back, ready: async () => {
    await until(() => q('[data-run-target]'));
    click('[data-nav-target="history"]');
  }};
}

test('all six summaries and previews come only from lazily opened saved results, with readable bilingual settings', async t => {
  const row = run();
  const original = JSON.stringify(row);
  const h = harness(t, [row]); await h.ready();
  assert.deepEqual(h.calls.map(call => call.url), ['/stage6/history', '/signet/datasets']);
  assert.match(h.entry(1).textContent, /樣本缺失率上限: 0\.12/);
  assert.match(h.entry(3).textContent, /主成分數: 2/);
  for (let stage = 1; stage <= 6; stage++) {
    assert.equal(h.entry(stage).querySelector('.ml-stage-preview').hidden, true);
    assert.equal(h.entry(stage).querySelector('.ml-stage-note').textContent, '已完成');
    assert.match(h.entry(stage).textContent, /開啟這個階段以讀取保存摘要/);
    h.open(row.history_id, stage);
    await until(() => !h.entry(stage).querySelector('.ml-stage-preview').hidden);
    assert.ok(h.entry(stage).querySelector('.ml-stage-thumbnail').childElementCount > 0);
    assert.doesNotMatch(h.entry(stage).querySelector('.ml-stage-detail').textContent, /[{}]/);
    h.back(stage);
    assert.equal(h.q('#ml-timeline').dataset.historyId, row.history_id);
  }
  assert.match(h.entry(1).textContent, /樣本數 7 · 變異數 11/);
  assert.match(h.entry(2).textContent, /樣本數 6 · 基因數 4/);
  assert.match(h.entry(3).textContent, /基因型樣本 9.*表現量樣本 8.*配對樣本 7.*保留樣本 6.*排除樣本 1.*主成分數 2/);
  assert.match(h.entry(4).textContent, /顯著配對數 3 · 涉及基因數 2/);
  assert.match(h.entry(5).textContent, /候選連線數 5 · 分析基因數 4/);
  assert.match(h.entry(6).textContent, /基因數 2 · 連線數 1/);
  const calls = h.calls.length;
  h.click('#ml-language');
  assert.match(h.entry(1).textContent, /Max\. sample missingness: 0\.12/);
  assert.match(h.entry(3).textContent, /Principal components: 2.*Matched samples 7.*Retained samples 6/s);
  assert.match(h.entry(6).textContent, /Frequency threshold: \.45.*Maximum displayed subnetworks: 1.*Genes 2 · Edges 1/s);
  assert.equal(h.entry(3).querySelector('.ml-stage-note').textContent, 'Completed');
  assert.equal(h.calls.length, calls, 'Language changes must not parse or fetch another result');
  assert.equal(JSON.stringify(row), original);
  assert.ok(h.calls.every(call => !call.options.method || call.options.method === 'GET'));
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
  assert.match(h.entry(2).textContent, /執行中.*尚無可讀取的保存結果/s);
  h.open(archived.history_id, 6);
  await until(() => h.q('#lens-stage6').dataset.historyId === archived.history_id);
  assert.match(h.entry(6).textContent, /基因數 2/); h.back(6);
  h.open(live.history_id, 6);
  await until(() => h.q('#lens-stage6').dataset.historyId === live.history_id);
  assert.match(h.entry(6).textContent, /基因數 3/);
  assert.equal(h.q('#lens-stage6 [data-gene="A"]').getAttribute('aria-pressed'), 'true');
  h.back(6);
  h.click('[data-nav-target="analysis"]');
  h.choose('#ml-stage6-run', '');
  assert.equal(h.q('#ml-timeline').dataset.historyId, '');
  assert.equal(h.entry(6).querySelector('.ml-stage-preview').hidden, true);
  assert.doesNotMatch(h.entry(6).textContent, /基因數 [23]/);
});

test('missing, failed and foreign result reads do not render success counts or demonstration thumbnails', async t => {
  const h = harness(t, [run()], url => {
    if (url.startsWith('/stage3/results?')) return reply({}, 404);
    if (url.startsWith('/stage6/results?')) return reply({...saved(6), source: 'live'});
    if (url.startsWith('/stage/results?')) return reply({}, 500);
  }); await h.ready();
  h.open('archive--shared', 3);
  await until(() => h.q('#lens-history-stage3').dataset.runState === 'empty');
  assert.match(h.entry(3).textContent, /尚無可讀取的保存結果/); h.back(3);
  h.open('archive--shared', 6);
  await until(() => h.q('#lens-stage6').dataset.runState === 'load-error');
  assert.match(h.entry(6).textContent, /無法載入保存結果/); h.back(6);
  h.open('archive--shared', 1);
  await until(() => h.q('#lens-history-stage').dataset.runState === 'error');
  assert.match(h.entry(1).textContent, /無法載入保存結果/);
  for (const stage of [1, 3, 6]) {
    assert.equal(h.entry(stage).querySelector('.ml-stage-preview').hidden, true);
    assert.equal(h.entry(stage).querySelector('.ml-stage-thumbnail').childElementCount, 0);
    assert.doesNotMatch(h.entry(stage).textContent, /基因數|保留樣本|樣本數 7/);
  }
});

test('a refreshed attempt or revision invalidates old timeline counts and previews until that result is opened', async t => {
  const row = run();
  const h = harness(t, [row]); await h.ready();
  h.open(row.history_id, 3);
  await until(() => !h.entry(3).querySelector('.ml-stage-preview').hidden);
  h.back(3);
  row.revision = 'new-attempt'; row.jobs.adjust.attempt = 2; row.jobs.adjust.options.npc = 4;
  h.click('#ml-history-retry');
  await until(() => h.entry(3).textContent.includes('主成分數: 4'));
  assert.equal(h.entry(3).querySelector('.ml-stage-preview').hidden, true);
  assert.doesNotMatch(h.entry(3).textContent, /配對樣本 7|主成分數 2/);
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
  assert.match(h.entry(3).textContent, /保留樣本 200/);
  const dots = h.entry(3).querySelectorAll('.ml-stage-thumbnail circle').length;
  assert.ok(dots > 0 && dots <= 48);
  h.back(3); h.open('archive--shared', 6);
  await until(() => !h.entry(6).querySelector('.ml-stage-preview').hidden);
  assert.match(h.entry(6).textContent, /基因數 100 · 連線數 99/);
  assert.equal(h.entry(6).querySelectorAll('.ml-stage-thumbnail circle').length, 24);
  assert.ok(h.entry(6).querySelectorAll('.ml-stage-thumbnail line').length <= 48);
});
