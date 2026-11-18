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
const catalog = [{id: 'example-chr1', name: ['範例資料組', 'Example dataset'], inputs: {genotype: [], expression: [], clinical: []}}];
const reply = value => ({ok: true, status: 200, json: async () => clone(value)});
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check) {
  for (let i = 0; i < 80; i++) { if (check()) return; await settle(); }
  assert.fail('History attempts did not mount');
}
function run(key, jobs, attempts, overrides = {}) {
  return {history_id: key, run_id: 'shared', revision: 'saved-revision', name: [key, key],
    dataset_id: 'example-chr1', source: 'recorded', origin: 'slurm', status: 'recorded', inputs: {},
    association: {status: 'recorded', method: 'manifest'},
    capabilities: {continue_analysis: false, stage_results: [], stage6_graph: false, assign_dataset: false},
    jobs, attempts, operations: [], issues: [], graph: null, ...overrides};
}
function attempt(number, current, record, overrides = {}) {
  return {number, current, record_file: `steps/genotype${current ? '' : '.attempt' + number}.json`,
    availability: 'recorded', record, issues: [], result: {status: 'not_recorded', outputs: []}, ...overrides};
}
function harness(t, rows) {
  const dom = new JSDOM(html, {url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true});
  const {window} = dom;
  t.after(async () => {await settle(); dom.window.close();});
  window.ResizeObserver = class {observe() {}};
  window.CSS = {escape: value => String(value).replace(/[^\w-]/g, '\\$&')};
  window.HTMLElement.prototype.scrollIntoView = function() {};
  window.SignetInputValidation = {create: () => ({sync() {}})};
  for (const name of ['Genotype', 'Expression', 'Adjustment', 'Cis', 'Network', 'Visualization']) {
    window['mount' + name + 'Run'] = () => ({setContext() {}});
  }
  const calls = [];
  window.fetch = async url => {
    calls.push(url);
    if (url === '/stage6/history') return reply({runs: rows, datasets: catalog});
    if (url === '/signet/datasets') return reply({datasets: catalog});
    throw Error('Unexpected request: ' + url);
  };
  window.eval(code);
  const q = selector => window.document.querySelector(selector);
  const click = selector => {assert.ok(q(selector), 'Missing ' + selector); q(selector).click();};
  return {window, q, click, calls, ready: async () => {await until(() => q('[data-run-target]')); click('[data-nav-target="history"]');}};
}

test('each attempt keeps its own settings, times, failure and saved output evidence in both languages', async t => {
  const old = {state: 'failed', job_id: 'job-101', submitted_at: '2026-11-01T10:00:00Z', finished_at: '2026-11-01T10:05:00Z',
    settings: {mind: '0.1'}, resources: {cpus: 2}, inputs: {'ped.file': '/old/study.ped'}, options: {npc: 2},
    reason: 'Required output missing', exit_code: '1', missing_outputs: ['res/old.txt'], failure_hints: ['Saved error hint'],
    history: [{state: 'submitted', at: '2026-11-01T10:00:00Z'}, {state: 'failed', at: '2026-11-01T10:05:00Z'}]};
  const current = {state: 'completed', job_id: 'job-102', submitted_at: '2026-11-02T10:00:00Z', started_at: '2026-11-02T10:01:00Z',
    finished_at: '2026-11-02T10:06:00Z', settings: {mind: '0.2'}, resources: {cpus: 4}, inputs: {'ped.file': '/new/study.ped'},
    reason: 'Outputs present', outputs: ['work/res/new.txt']};
  const row = run('recorded--shared', {genotype: current}, {genotype: [
    attempt(1, false, old, {result: {status: 'recorded_failed', outputs: [{path: 'res/old.txt', status: 'missing'}]}}),
    attempt(2, true, current, {result: {status: 'recorded_completed', outputs: [{path: 'work/res/new.txt', status: 'downloaded'}]}}),
  ]});
  const originals = JSON.stringify(row);
  const h = harness(t, [row]); await h.ready();
  const parent = '#ml-run-recorded--shared [data-history-job="genotype"]';
  assert.deepEqual([...h.q(parent).querySelectorAll('[data-history-attempt]')].map(node => node.dataset.historyAttempt), ['2', '1']);
  const first = h.q(parent + ' [data-history-attempt="1"]');
  const second = h.q(parent + ' [data-history-attempt="2"]');
  first.open = second.open = true;
  assert.equal(first.open && second.open, true);
  assert.equal(first.hasAttribute('name') || second.hasAttribute('name'), false);
  assert.equal(second.dataset.attemptCurrent, 'true');
  assert.match(first.querySelector('[data-history-saved="settings"]').textContent, /mind0\.1/);
  assert.match(second.querySelector('[data-history-saved="settings"]').textContent, /mind0\.2/);
  assert.match(first.textContent, /job-101/); assert.doesNotMatch(first.textContent, /job-102|new\/study/);
  assert.match(second.textContent, /job-102/); assert.doesNotMatch(second.textContent, /job-101|old\/study/);
  assert.match(first.querySelector('[data-history-attempt-result]').textContent, /Saved error hint.*res\/old\.txt.*紀錄顯示缺少/s);
  assert.match(second.querySelector('[data-history-attempt-result]').textContent, /紀錄顯示已下載/);
  assert.match(first.querySelector('[data-history-attempt-events]').textContent, /2026-11-01T10:00:00Z/);
  assert.match(second.textContent, /送出時間2026-11-02T10:00:00Z\s+開始時間2026-11-02T10:01:00Z/);
  h.click('#ml-language');
  assert.match(first.textContent, /Attempt 1.*Last recorded state: Failed/s);
  assert.match(second.textContent, /Attempt 2 · Current record/);
  assert.match(second.querySelector('[data-history-attempt-result]').textContent, /Recorded as downloaded/);
  assert.equal(JSON.stringify(row), originals);
  assert.equal(h.q(parent + ' [data-run-stage]'), null);
  assert.deepEqual(h.calls.sort(), ['/signet/datasets', '/stage6/history'].sort());
});

test('gaps and invalid snapshots never borrow current settings or create result actions', async t => {
  const current = {state: 'failed', settings: {mind: '0.9'}, job_id: 'current-job'};
  const rows = [attempt(1, false, null, {availability: 'missing', issues: ['Snapshot was not saved']}),
    attempt(2, false, null, {availability: 'invalid', issues: ['Foreign snapshot rejected']}), attempt(3, true, current)];
  const h = harness(t, [run('recorded--shared', {genotype: current}, {genotype: rows})]); await h.ready();
  for (const number of ['1', '2']) {
    const detail = h.q(`[data-history-attempt="${number}"]`);
    assert.equal(detail.dataset.attemptAvailable, 'false');
    assert.equal(detail.querySelector('[data-history-saved]'), null);
    assert.equal(detail.querySelector('[data-history-attempt-result]'), null);
    assert.doesNotMatch(detail.textContent, /0\.9|current-job/);
    assert.equal(detail.querySelector('button,a'), null);
  }
  assert.match(h.q('[data-history-attempt="1"]').textContent, /Snapshot was not saved/);
  assert.match(h.q('[data-history-attempt="2"]').textContent, /保存的紀錄無法讀取/);
});

test('unnumbered archive attempts and current-less archived attempts stay readable without invented numbers', async t => {
  const record = {state: 'completed', settings: {mind: '0.4'}};
  const h = harness(t, [run('archive--shared', {genotype: record}, {genotype: [attempt(null, true, record)],
    expression: [attempt(1, false, {state: 'failed', reason: 'Archived expression failure'})]}, {source: 'archive', origin: 'archive'})]); await h.ready();
  const detail = h.q('[data-history-attempt="unknown"]');
  assert.match(detail.textContent, /嘗試次數未記錄/); assert.doesNotMatch(detail.textContent, /第 1 次嘗試/);
  assert.match(h.q('[data-history-job="expression"] [data-history-attempt="1"]').textContent, /Archived expression failure/);
  assert.equal(h.q('[data-run-stage]'), null);
});

test('expanded attempts survive rerender without opening same-number attempts in other steps or sources', async t => {
  const record = {state: 'failed', settings: {mind: '0.1'}};
  const attempts = {genotype: [attempt(1, true, record)], expression: [attempt(1, true, record)]};
  const row = run('recorded--shared', {genotype: record, expression: record}, attempts, {dataset_id: null,
    association: {status: 'unclassified', method: null}, capabilities: {continue_analysis: false, stage_results: [], stage6_graph: false, assign_dataset: true}});
  const other = run('archive--shared', {genotype: record}, {genotype: [attempt(1, true, record)]}, {source: 'archive', origin: 'archive'});
  const h = harness(t, [row, other]); await h.ready();
  const selected = '#ml-run-recorded--shared [data-history-job="genotype"]';
  h.q(selected).open = true; h.q(selected + ' [data-history-attempt="1"]').open = true;
  // Missing assignment selection triggers the same real rerender used while saving.
  h.click('#ml-run-recorded--shared [data-history-assign]');
  assert.equal(h.q(selected).open, true);
  assert.equal(h.q(selected + ' [data-history-attempt="1"]').open, true);
  assert.equal(h.q('#ml-run-recorded--shared [data-history-job="expression"] [data-history-attempt="1"]').open, false);
  assert.equal(h.q('#ml-run-archive--shared [data-history-attempt="1"]').open, false);
});

test('unreadable event entries cannot hide valid history or imply an invented event', async t => {
  const record = {state: 'failed', settings: {}, history: [null, 'legacy-note', {}, {state: 'failed', at: '2026-11-01T10:00:00Z'}]};
  const h = harness(t, [run('recorded--shared', {genotype: record}, {genotype: [attempt(1, true, record)]})]); await h.ready();
  assert.match(h.q('[data-history-attempt-event-warning]').textContent, /部分保存的時間線無法讀取/);
  assert.equal(h.q('[data-history-attempt-events]').children.length, 1);
  assert.match(h.q('[data-history-attempt-events]').textContent, /2026-11-01T10:00:00Z/);
  h.click('#ml-language');
  assert.match(h.q('[data-history-attempt-event-warning]').textContent, /Part of the recorded timeline is unreadable/);
});
