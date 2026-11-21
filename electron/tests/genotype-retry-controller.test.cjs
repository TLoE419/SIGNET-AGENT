'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const source = readFileSync(path.join(__dirname, '../renderer/features/workspace/genotype-run.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check) {for (let i = 0; i < 80; i++) {if (check()) return; await settle();} assert.fail('Retry controller did not settle');}
const reply = (value, status = 200) => ({ok: status < 400, status, json: async () => clone(value)});
const files = {genotype: ['/original/study.ped', '/original/study.map'], expression: ['/original/expression'], clinical: ['/original/clinical']};
const dataset = (id = 'dataset-a') => ({id, name: [id, id], ready: true, persisted: true,
  inputs: {genotype: ['/new/other.ped', '/new/other.map'], expression: ['/new/expression'], clinical: ['/new/clinical']}});
const settings = {'restrict.tcga.geno': 2, mind: 0.1, geno: 0.1, hwe: 0.0001, int: 5000000};
const resources = {cpus: 4, mem_gb: 16, hours: 2};
const record = (overrides = {}) => ({run_id: 'retry-run', step: 'genotype', state: 'failed', job_id: '123',
  submitted_at: '2026-11-17T10:00:00Z', finished_at: '2026-11-17T10:05:00Z', settings, resources,
  inputs: {'ped.file': '/run/attempt1/study.ped', 'map.file': '/run/attempt1/study.map', ref: '/run/attempt1/ref/chr', gmap: '/run/attempt1/gmap/chr'},
  history: [{state: 'failed', at: '2026-11-17T10:05:00Z'}], reason: 'Saved failure reason', ...overrides});
const run = (saved, overrides = {}) => ({history_id: 'workspace--' + saved.run_id, run_id: saved.run_id,
  dataset_id: 'dataset-a', source: 'live', origin: 'workspace', capabilities: {continue_analysis: true},
  source_inputs: files, input_mode: 'dataset', jobs: {genotype: saved}, ...overrides});
const review = (saved = record(), overrides = {}) => ({run_id: saved.run_id, dataset_id: 'dataset-a', dataset_name: ['原始資料組', 'Original dataset'],
  mode: 'dataset', inputs: {'ped.file': '/run/attempt2/study.ped', 'map.file': '/run/attempt2/study.map', ref: '/run/attempt2/ref/chr', gmap: '/run/attempt2/gmap/chr'},
  source_inputs: files, settings: saved.settings, resources: saved.resources, limits: {cpus: [1, 64], mem_gb: [1, 128], hours: [0.1, 24]},
  ready: true, warnings: ['Original files are used again.'], issues: [], review_token: 'review-token',
  expected_job_id: saved.job_id ?? null, expected_attempt: saved.attempt ?? 1, next_attempt: (saved.attempt ?? 1) + 1, ...overrides});
function harness(t, handler) {
  const dom = new JSDOM('<!doctype html><section id="panel"></section>', {url: 'http://localhost', runScripts: 'outside-only'});
  const {window} = dom; t.after(async () => {await settle(); await settle(); window.close();}); window.eval(source);
  const panel = window.document.querySelector('#panel'), calls = [], changed = [];
  window.fetch = async (url, options = {}) => {const call = {url, options, body: options.body ? JSON.parse(options.body) : undefined}; calls.push(call); return handler(call);};
  const controller = window.mountGenotypeRun({panel, token: 'test-token', onHistoryChanged: (...args) => changed.push(args)});
  const q = part => panel.querySelector(`[data-genotype-${part}]`), click = part => {assert.ok(q(part), 'Missing ' + part); q(part).click();};
  const context = (rows, id = rows[0]?.run_id, d = dataset(), overrides = {}) => controller.setContext({datasetId: d.id, dataset: d, runs: rows, runId: id, visible: true, ...overrides});
  const remote = overrides => window.dispatchEvent(new window.CustomEvent('workspace-remote-context', {detail: {connected: true, identity: 'user@host|session', environmentKey: 'root', ...overrides}}));
  const edit = (part, value) => {const input = q(part); input.value = value; input.dispatchEvent(new window.Event('input', {bubbles: true}));};
  const acknowledge = () => {q('acknowledge').checked = true; q('acknowledge').dispatchEvent(new window.Event('change', {bubbles: true}));};
  return {window, panel, calls, changed, controller, q, click, context, remote, edit, acknowledge};
}

test('retry reviews the original files and manually submits edited settings in the same run exactly once', async t => {
  const old = record(), originalBytes = JSON.stringify(old); let finish;
  const h = harness(t, call => call.options.method === 'POST' ? new Promise(resolve => {finish = resolve;}) : reply(review(old)));
  h.remote(); h.context([run(old)]); assert.equal(h.calls.length, 0); assert.equal(h.q('retry').hidden, false);
  h.click('retry'); await until(() => h.panel.dataset.genotypeRetryState === 'ready');
  assert.match(h.calls[0].url, /^\/signet\/runs\/retry-run\/genotype\/retry\?/);
  const query = new URL('http://localhost' + h.calls[0].url).searchParams;
  assert.equal(query.get('expected_job_id'), '123'); assert.equal(query.get('expected_attempt'), '1');
  assert.equal(h.q('input="ped.file"').textContent, '/run/attempt2/study.ped');
  assert.match(h.panel.querySelector('[data-genotype-source-input="genotype"]').textContent, /original\/study/);
  assert.doesNotMatch(h.panel.querySelector('[data-genotype-source-input="genotype"]').textContent, /new\/other/);
  assert.equal(h.q('setting="restrict.tcga.geno"').readOnly, true);
  assert.equal(h.q('submit').disabled, true);
  h.edit('setting="mind"', '0.04'); h.edit('resource="cpus"', '8'); h.acknowledge();
  assert.equal(h.q('submit').disabled, false); h.click('submit'); h.click('submit');
  const posts = h.calls.filter(call => call.options.method === 'POST'); assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/signet/runs/retry-run/genotype/retry');
  assert.deepEqual(posts[0].body, {inputs: review(old).inputs, settings: {...settings, mind: 0.04}, resources: {...resources, cpus: 8},
    review_token: 'review-token', expected_job_id: '123', expected_attempt: 1, acknowledge_warnings: true});
  assert.equal(Object.hasOwn(posts[0].body, 'run_id'), false);
  finish(reply(record({attempt: 2, job_id: '456', state: 'pending', submitted_at: '2026-11-17T11:00:00Z', finished_at: undefined,
    inputs: review(old).inputs, settings: posts[0].body.settings, resources: posts[0].body.resources})));
  await until(() => h.panel.dataset.genotypeState === 'pending');
  assert.equal(h.panel.dataset.genotypeRunId, 'retry-run'); assert.equal(h.q('job-id').textContent, '456');
  assert.equal(h.panel.dataset.genotypeRetryState, 'idle'); assert.equal(h.q('submit').hidden, true);
  assert.equal(JSON.stringify(old), originalBytes); assert.equal(h.calls.some(call => call.url.includes('/datasets/')), false);
});

test('a jobless cancelled attempt uses none and accepts a higher unknown attempt without an ID', async t => {
  const old = record({state: 'cancelled', job_id: null});
  const h = harness(t, call => reply(call.options.method === 'POST' ? record({attempt: 2, state: 'unknown', job_id: null}) : review(old)));
  h.remote(); h.context([run(old)]); h.click('retry'); await until(() => h.panel.dataset.genotypeRetryState === 'ready');
  assert.equal(new URL('http://localhost' + h.calls[0].url).searchParams.get('expected_job_id'), 'none');
  h.acknowledge(); h.click('submit'); await until(() => h.panel.dataset.genotypeState === 'unknown');
  assert.equal(h.calls[1].body.expected_job_id, 'none'); assert.equal(h.q('retry').hidden, true);
  assert.equal(h.panel.dataset.genotypeRunId, 'retry-run');
});

test('active, completed, unknown, archived and recorded Stage 1 records never offer retry', async t => {
  const h = harness(t, () => reply(record({state: 'running'}))); h.remote();
  for (const [index, state] of ['pending', 'running', 'cancelling', 'validating', 'completed', 'unknown'].entries()) {
    const saved = record({run_id: 'case-' + index, state}); h.context([run(saved)]);
    assert.equal(h.q('retry').hidden, true); h.click('retry');
  }
  for (const [index, source] of ['archive', 'recorded'].entries()) {
    h.context([run(record({run_id: 'source-' + index}), {source, origin: source === 'archive' ? 'archive' : 'slurm'})]);
    assert.equal(h.q('retry').hidden, true); h.click('retry');
  }
  assert.equal(h.calls.some(call => call.url.includes('/genotype/retry')), false);
});

test('same-run history refreshes preserve retry edits while mutable Data selections stay irrelevant', async t => {
  const old = record(); const h = harness(t, () => reply(review(old))); h.remote(); h.context([run(old)]);
  h.click('retry'); await until(() => h.panel.dataset.genotypeRetryState === 'ready');
  h.edit('setting="mind"', '0.06'); h.acknowledge();
  const changed = dataset(); changed.inputs.genotype = ['/later/study.ped', '/later/study.map'];
  h.context([run(old)], 'retry-run', changed);
  assert.equal(h.q('setting="mind"').value, '0.06'); assert.equal(h.q('acknowledge').checked, true);
  assert.equal(h.q('input="ped.file"').textContent, '/run/attempt2/study.ped');
  assert.equal(h.calls.length, 1);
});

test('invalid retry parameter values block submission until corrected', async t => {
  const old = record(); const h = harness(t, call => reply(call.options.method === 'POST'
    ? record({attempt: 2, job_id: '456', state: 'pending'}) : review(old)));
  h.remote(); h.context([run(old)]); h.click('retry'); await until(() => h.panel.dataset.genotypeRetryState === 'ready');
  h.edit('setting="mind"', '2'); h.acknowledge(); h.click('submit');
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);
  assert.equal(h.q('setting="mind"').validity.rangeOverflow, true);
  h.edit('setting="mind"', '0.07'); h.click('submit'); await until(() => h.panel.dataset.genotypeState === 'pending');
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('switching runs or remote identity discards a pending or ready retry review', async t => {
  const old = record(), other = record({run_id: 'other-run', job_id: '999'}); let finish;
  const h = harness(t, () => new Promise(resolve => {finish = resolve;})); h.remote(); h.context([run(old), run(other)]);
  h.click('retry'); assert.equal(h.calls.length, 1); h.context([run(old), run(other)], 'other-run');
  assert.equal(h.calls[0].options.signal.aborted, true);
  finish(reply(review(old))); await settle();
  assert.equal(h.panel.dataset.genotypeRunId, 'other-run'); assert.equal(h.q('submit').hidden, true);
  h.context([run(old)], 'retry-run'); assert.equal(h.panel.dataset.genotypeRetryState, 'idle');
  h.click('retry'); const pending = finish; pending(reply(review(old))); await until(() => h.panel.dataset.genotypeRetryState === 'ready');
  h.acknowledge(); h.remote({identity: 'other@host|session'});
  assert.equal(h.panel.dataset.genotypeRetryState, 'idle'); assert.equal(h.q('acknowledge').checked, false);
  h.click('submit'); assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);
});

test('a refused retry invalidates its token without changing run ID or automatically resubmitting', async t => {
  const old = record(); const h = harness(t, call => call.options.method === 'POST'
    ? reply({error: 'The reviewed files changed.', code: 'conflict'}, 409) : reply(review(old)));
  h.remote(); h.context([run(old)]); h.click('retry'); await until(() => h.panel.dataset.genotypeRetryState === 'ready');
  h.acknowledge(); h.click('submit'); await until(() => h.q('notice').textContent.includes('reviewed files changed'));
  assert.equal(h.panel.dataset.genotypeRunId, 'retry-run'); assert.equal(h.q('submit').disabled, true);
  assert.equal(h.q('acknowledge').checked, false); assert.equal(h.q('refresh').hidden, false);
  h.click('submit'); assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
  h.click('review'); await until(() => h.panel.dataset.genotypeRetryState === 'ready');
  assert.equal(h.q('acknowledge').checked, false); assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('an uncertain submission locks retry until the same run status confirms what happened', async t => {
  const old = record(); const next = record({attempt: 2, job_id: null, state: 'failed'});
  const h = harness(t, call => call.options.method === 'POST' ? Promise.reject(Error('Connection lost during submission'))
    : reply(call.url.includes('/steps/') ? next : review(old)));
  h.remote(); h.context([run(old)]); h.click('retry'); await until(() => h.panel.dataset.genotypeRetryState === 'ready');
  h.acknowledge(); h.click('submit'); await until(() => h.panel.dataset.genotypeState === 'unknown');
  assert.equal(h.q('retry').hidden, true); assert.match(h.q('notice').textContent, /Submission outcome is unconfirmed/);
  h.click('refresh'); await until(() => h.panel.dataset.genotypeState === 'failed');
  assert.equal(h.q('retry').hidden, false); assert.equal(h.panel.dataset.genotypeRunId, 'retry-run');
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('a retry response updates only its captured run after switching to another history run', async t => {
  const old = record(), other = record({run_id: 'other-run', job_id: '999', settings: {...settings, mind: 0.3}}); let finish;
  const h = harness(t, call => call.options.method === 'POST' ? new Promise(resolve => {finish = resolve;}) : reply(review(old)));
  h.remote(); h.context([run(old), run(other)]); h.click('retry'); await until(() => h.panel.dataset.genotypeRetryState === 'ready');
  h.acknowledge(); h.click('submit'); h.context([run(old), run(other)], 'other-run');
  finish(reply(record({attempt: 2, job_id: '456', state: 'pending'}))); await settle();
  assert.equal(h.panel.dataset.genotypeRunId, 'other-run'); assert.equal(h.q('setting="mind"').value, '0.3');
  h.context([run(old), run(other)], 'retry-run');
  assert.equal(h.panel.dataset.genotypeState, 'pending'); assert.equal(h.q('job-id').textContent, '456');
});

test('a newer attempt from history updates the separate Analysis cache even without a later timestamp', async t => {
  const old = record(), next = record({attempt: 2, job_id: '456', state: 'pending'});
  const h = harness(t, () => reply(next)); h.remote(); h.context([run(old)], null);
  assert.equal(h.panel.dataset.genotypeState, 'failed');
  h.context([run(old)], 'retry-run'); h.context([run(next)], null);
  assert.equal(h.panel.dataset.genotypeState, 'pending'); assert.equal(h.q('job-id').textContent, '456');
});

test('wrong-target retry responses are unconfirmed rather than overwriting the saved run', async t => {
  const old = record(); const h = harness(t, call => reply(call.options.method === 'POST'
    ? record({run_id: 'unrelated', attempt: 2, state: 'pending'}) : review(old)));
  h.remote(); h.context([run(old)]); h.click('retry'); await until(() => h.panel.dataset.genotypeRetryState === 'ready');
  h.acknowledge(); h.click('submit'); await until(() => h.panel.dataset.genotypeState === 'unknown');
  assert.equal(h.panel.dataset.genotypeRunId, 'retry-run'); assert.equal(h.q('job-id').textContent, '123');
  assert.equal(h.q('retry').hidden, true);
});

test('leaving the Stage 1 view invalidates the reviewed token and acknowledgement', async t => {
  const old = record(); const h = harness(t, () => reply(review(old))); h.remote(); h.context([run(old)]);
  h.click('retry'); await until(() => h.panel.dataset.genotypeRetryState === 'ready'); h.acknowledge();
  h.context([run(old)], 'retry-run', dataset(), {visible: false});
  h.context([run(old)]);
  assert.equal(h.panel.dataset.genotypeRetryState, 'idle'); assert.equal(h.q('acknowledge').checked, false);
  assert.equal(h.q('submit').hidden, true); h.click('submit');
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);
});

test('an in-flight retry response from a former remote context remains unconfirmed until status recovery', async t => {
  const old = record(), next = record({attempt: 2, job_id: '456', state: 'pending'}); let finish;
  const h = harness(t, call => call.options.method === 'POST' ? new Promise(resolve => {finish = resolve;})
    : reply(call.url.includes('/steps/') ? next : review(old)));
  h.remote(); h.context([run(old)]); h.click('retry'); await until(() => h.panel.dataset.genotypeRetryState === 'ready');
  h.acknowledge(); h.click('submit'); h.remote({identity: 'other@host|session'});
  finish(reply(next)); await until(() => h.panel.dataset.genotypeState === 'unknown');
  assert.equal(h.q('job-id').textContent, '123'); assert.equal(h.q('retry').hidden, true);
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
  h.remote(); h.click('refresh'); await until(() => h.panel.dataset.genotypeState === 'pending');
  assert.equal(h.q('job-id').textContent, '456'); assert.equal(h.panel.dataset.genotypeRunId, 'retry-run');
});
