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
  const chooseAttempt = (selector, entry) => {
    const select = q(selector + ' [data-history-attempt-select]');
    select.value = entry.dataset.attemptRecord;
    select.dispatchEvent(new window.Event('change', {bubbles: true}));
  };
  return {window, q, click, chooseAttempt, calls, ready: async () => {await until(() => q('[data-run-target]')); click('[data-nav-target="history"]');}};
}

test('output checks retain the original failure and per-check evidence without adding attempts or making requests', async t => {
  const before = {state: 'failed', reason: 'Required outputs are missing.', exit_code: '0', missing_outputs: ['res/late.txt']};
  const after = {state: 'completed', reason: '<script>never execute</script>', exit_code: '0', missing_outputs: []};
  const record = {...after, job_id: '12345', attempt: 1, original_failure: before,
    output_checks: [{at: '2026-11-17T10:10:00Z', before, after, outcome: 'completed'}], output_checks_total: 1};
  const row = run('recorded--shared', {genotype: record}, {genotype: [attempt(1, true, record)]});
  const original = JSON.stringify(row);
  const h = harness(t, [row]); await h.ready();
  const section = h.q('[data-history-output-checks]');
  assert.ok(section);
  assert.match(section.textContent, /same job and attempt/);
  assert.match(section.querySelector('[data-history-original-failure]').textContent, /Required outputs are missing.*res\/late\.txt/s);
  assert.equal(section.querySelectorAll('[data-history-output-check]').length, 1);
  assert.equal(section.querySelector('script'), null);
  assert.match(section.textContent, /<script>never execute<\/script>/);
  assert.equal(h.window.document.querySelectorAll('[data-history-attempt]').length, 1);
  const calls = [...h.calls];
    assert.match(section.textContent, /Output recheck history.*Original recorded failure/s);
  assert.deepEqual(h.calls, calls);
  assert.equal(JSON.stringify(row), original);
});

test('each attempt keeps its own settings, times, failure and saved output evidence in English', async t => {
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
  assert.equal(first.hidden, true);
  assert.equal(second.hidden, false);
  h.chooseAttempt(parent, first);
  h.click(parent + ' [data-history-detail-tab="settings"]');
  assert.equal(first.hidden, false);
  assert.equal(second.hidden, true);
  assert.equal(first.querySelector('[data-history-detail-view="settings"]').hidden, false);
  assert.equal(second.dataset.attemptCurrent, 'true');
  assert.match(first.querySelector('[data-history-saved="settings"]').textContent, /mind0\.1/);
  assert.match(second.querySelector('[data-history-saved="settings"]').textContent, /mind0\.2/);
  assert.match(first.textContent, /job-101/); assert.doesNotMatch(first.textContent, /job-102|new\/study/);
  assert.match(second.textContent, /job-102/); assert.doesNotMatch(second.textContent, /job-101|old\/study/);
  assert.match(first.querySelector('[data-history-attempt-result]').textContent, /Saved error hint.*res\/old\.txt.*Recorded as missing/s);
  assert.match(second.querySelector('[data-history-attempt-result]').textContent, /Recorded as downloaded/);
  const firstEvent = first.querySelector('[data-history-attempt-events] time');
  assert.equal(firstEvent.textContent, '2026-11-01 10:00:00');
  assert.equal(firstEvent.dateTime, old.history[0].at);
  assert.match(second.textContent, /Submitted at2026-11-02 10:00:00\s+Started at2026-11-02 10:01:00/);
  assert.match(first.textContent, /Last recorded state: Failed/);
  const picker = h.q(parent + ' [data-history-attempt-select]');
  assert.match(picker.selectedOptions[0].textContent, /Attempt 1 · Failed/);
  assert.match(picker.options[0].textContent, /Attempt 2 · Completed · Current record/);
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
  const missing = h.q('[data-history-attempt="2"]');
  const job = '[data-history-job="genotype"]';
  h.chooseAttempt(job, missing);
  assert.match(h.q(job + ' [data-history-attempt-select]').selectedOptions[0].textContent, /Saved record unreadable/);
  assert.equal(missing.hidden, false);
});

test('unnumbered archive attempts and current-less archived attempts stay readable without invented numbers', async t => {
  const record = {state: 'completed', settings: {mind: '0.4'}};
  const h = harness(t, [run('archive--shared', {genotype: record}, {genotype: [attempt(null, true, record)],
    expression: [attempt(1, false, {state: 'failed', reason: 'Archived expression failure'})]}, {source: 'archive', origin: 'archive'})]); await h.ready();
  const unnumbered = '[data-history-job="genotype"] [data-history-attempt-single]';
  assert.equal(h.q('[data-history-attempt-select]'), null);
  assert.match(h.q(unnumbered).textContent, /Attempt number not recorded/);
  assert.doesNotMatch(h.q(unnumbered).textContent, /Attempt 1/);
  h.click('[data-history-select-stage="2"]');
  assert.match(h.q('[data-history-job="expression"] [data-history-attempt-single]').textContent, /Attempt 1/);
  assert.match(h.q('[data-history-job="expression"] [data-history-attempt="1"]').textContent, /Archived expression failure/);
  assert.equal(h.q('[data-run-stage]'), null);
});

test('stage, attempt and section selections survive rerender independently across sources', async t => {
  const record = {state: 'failed', settings: {mind: '0.1'}};
  const attempts = {genotype: [attempt(1, true, record)], expression: [attempt(1, false, record), attempt(2, true, record)]};
  const row = run('recorded--shared', {genotype: record, expression: record}, attempts, {dataset_id: null,
    association: {status: 'unclassified', method: null}, capabilities: {continue_analysis: false, stage_results: [], stage6_graph: false, assign_dataset: true}});
  const other = run('archive--shared', {genotype: record}, {genotype: [attempt(1, true, record)]}, {source: 'archive', origin: 'archive'});
  const h = harness(t, [row, other]); await h.ready();
  const selected = '#ml-run-recorded--shared [data-history-job="expression"]';
  h.click('#ml-run-recorded--shared [data-history-select-stage="2"]');
  h.chooseAttempt(selected, h.q(selected + ' [data-history-attempt="1"]'));
  h.click(selected + ' [data-history-detail-tab="settings"]');
  // Missing assignment selection triggers the same real rerender used while saving.
  h.click('#ml-run-recorded--shared [data-history-assign]');
  assert.equal(h.q('#ml-run-recorded--shared [data-history-stage-panel="2"]').hidden, false);
  assert.equal(h.q(selected + ' [data-history-attempt="2"]').hidden, true);
  assert.equal(h.q(selected + ' [data-history-attempt="1"] [data-history-detail-view="settings"]').hidden, false);
  assert.equal(h.q('#ml-run-recorded--shared [data-history-stage-panel="1"]').hidden, true);
  assert.equal(h.q('#ml-run-archive--shared [data-history-attempt="1"] [data-history-detail-view="settings"]').hidden, true);
});

test('unreadable event entries cannot hide valid history or imply an invented event', async t => {
  const record = {state: 'failed', settings: {}, history: [null, 'legacy-note', {}, {state: 'failed', at: '2026-11-01T10:00:00Z'}]};
  const h = harness(t, [run('recorded--shared', {genotype: record}, {genotype: [attempt(1, true, record)]})]); await h.ready();
  assert.match(h.q('[data-history-attempt-event-warning]').textContent, /Part of the recorded timeline is unreadable/);
  assert.equal(h.q('[data-history-attempt-events]').children.length, 1);
  assert.equal(h.q('[data-history-attempt-events] time').textContent, '2026-11-01 10:00:00');
});
