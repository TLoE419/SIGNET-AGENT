'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const source = readFileSync(path.join(__dirname, '../renderer/features/workspace/genotype-run.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check) {
  for (let i = 0; i < 80; i++) {if (check()) return; await settle();}
  assert.fail('Cancellation controller did not settle');
}
const response = (value, status = 200) => ({ok: status < 400, status, json: async () => clone(value)});
const dataset = id => ({id, name: [id, id], persisted: true, ready: true,
  inputs: {genotype: ['/pub/study.ped', '/pub/study.map'], expression: ['/pub/expression'], clinical: ['/pub/clinical']}});
const job = (step, id = 'run-a', state = 'running', overrides = {}) => ({run_id: id, step, state, job_id: '123', attempt: 2,
  submitted_at: '2026-11-17T10:00:00Z', inputs: {}, settings: {}, resources: {}, history: [{state, at: '2026-11-17T10:00:00Z'}], ...overrides});
const run = (step, record, overrides = {}) => ({run_id: record.run_id, dataset_id: 'dataset-a', source: 'live', origin: 'workspace',
  capabilities: {continue_analysis: true}, jobs: {genotype: {state: 'completed'}, expression: {state: 'completed'},
    adjust: {state: 'completed'}, cis: {state: 'completed'}, network: {state: 'completed'}, [step]: record}, ...overrides});
const mounts = {genotype: 'Genotype', expression: 'Expression', adjust: 'Adjustment', cis: 'Cis', network: 'Network', visualize: 'Visualization'};
function harness(t, step, handler) {
  const dom = new JSDOM('<!doctype html><section id="panel"></section>', {url: 'http://localhost', runScripts: 'outside-only'});
  const {window} = dom;
  t.after(async () => {await settle(); await settle(); window.close();});
  const calls = [], changed = [], backs = [];
  window.fetch = async (url, options = {}) => {
    const call = {url, options, body: options.body ? JSON.parse(options.body) : undefined}; calls.push(call);
    return handler(call);
  };
  window.eval(source);
  const panel = window.document.querySelector('#panel');
  const controller = window['mount' + mounts[step] + 'Run']({panel, token: 'test-token',
    onHistoryChanged: (...args) => changed.push(args), onBack: () => backs.push(true)});
  const q = part => panel.querySelector(`[data-${step}-${part}]`);
  const click = part => {assert.ok(q(part), 'Missing ' + part); q(part).click();};
  const context = (rows, id = rows[0]?.run_id, overrides = {}) => controller.setContext({datasetId: 'dataset-a',
    dataset: dataset('dataset-a'), visible: true, runs: rows, runId: id, ...overrides});
  const remote = overrides => window.dispatchEvent(new window.CustomEvent('workspace-remote-context',
    {detail: {connected: true, identity: 'user@host|session', environmentKey: '/work|source', ...overrides}}));
  return {window, panel, calls, changed, backs, controller, q, click, context, remote};
}

for (const [index, step] of Object.keys(mounts).entries()) {
  test(`Stage ${index + 1} requires exact confirmation and waits for recorded terminal status`, async t => {
    let current = job(step, 'run-a', index % 2 ? 'pending' : 'running');
    let finishCancel;
    const h = harness(t, step, call => call.url.endsWith('/cancel') ? new Promise(resolve => {finishCancel = resolve;}) : response(current));
    h.remote(); h.context([run(step, current)]); await until(() => !h.q('refresh').disabled);
    assert.equal(h.q('cancel').hidden, false); assert.equal(h.q('cancel').disabled, false);
    h.click('cancel');
    assert.equal(h.calls.filter(call => call.url.endsWith('/cancel')).length, 0);
    assert.match(h.q('cancel-target').textContent, new RegExp(`run-a.*Stage ${index + 1}.*123.*Attempt: 2`));
    assert.equal(h.window.document.activeElement, h.q('cancel-dismiss'));
    h.click('cancel-dismiss'); assert.equal(h.q('cancel-confirmation').hidden, true);
    h.click('cancel'); h.click('cancel-confirm'); h.click('cancel-confirm');
    const posts = h.calls.filter(call => call.url.endsWith('/cancel'));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, `/signet/runs/run-a/steps/${step}/cancel`);
    assert.deepEqual(posts[0].body, {expected_job_id: '123', expected_attempt: 2});
    assert.equal(h.q('cancel').disabled, true); assert.equal(h.q('refresh').disabled, true);
    current = {...current, state: 'cancelling', cancel_requested_at: '2026-11-17T10:01:00Z'};
    finishCancel(response(current)); await until(() => h.panel.dataset[step + 'State'] === 'cancelling');
    assert.match(h.q('cancel-notice').textContent, /child jobs have stopped/);
    assert.equal(h.q('cancel').disabled, true);
    assert.equal(h.q('submit').disabled, true);
    h.click('refresh'); await until(() => !h.q('refresh').disabled);
    assert.equal(h.panel.dataset[step + 'State'], 'cancelling', 'Parent completion alone must not imply child termination');
    current = {...current, state: 'cancelled', finished_at: '2026-11-17T10:02:00Z'};
    h.click('refresh'); await until(() => h.panel.dataset[step + 'State'] === 'cancelled');
    assert.equal(h.q('cancel').hidden, true); assert.equal(h.q('cancel-notice').hidden, true);
    assert.equal(h.calls.filter(call => call.options.method === 'POST' && !call.url.endsWith('/cancel')).length, 0);
  });
}

test('an older poll response cannot overwrite accepted cancellation', async t => {
  const step = 'network', active = job(step); let oldPoll;
  const h = harness(t, step, call => call.url.endsWith('/cancel')
    ? response({...active, state: 'cancelling', cancel_requested_at: '2026-11-17T10:01:00Z'})
    : new Promise(resolve => {oldPoll = resolve;}));
  h.remote(); h.context([run(step, active)]);
  await until(() => !!oldPoll); h.click('cancel'); h.click('cancel-confirm');
  await until(() => h.panel.dataset.networkState === 'cancelling');
  oldPoll(response(active)); await settle();
  assert.equal(h.panel.dataset.networkState, 'cancelling');
});

test('confirmation clears when the run, dataset, job or remote identity changes', async t => {
  const step = 'expression'; const a = job(step), b = job(step, 'run-b', 'pending', {job_id: '456'});
  const h = harness(t, step, call => response(call.url.includes('run-b') ? b : a));
  h.remote(); h.context([run(step, a), run(step, b)]); await until(() => !h.q('refresh').disabled);
  h.click('cancel'); h.context([run(step, a), run(step, b)], 'run-b');
  assert.equal(h.q('cancel-confirmation').hidden, true); h.click('cancel-confirm');
  h.click('cancel'); h.remote({identity: 'different@host|session'});
  assert.equal(h.q('cancel-confirmation').hidden, true); h.click('cancel-confirm');
  h.click('cancel'); h.context([run(step, b)], 'run-b', {datasetId: 'dataset-b'});
  assert.equal(h.q('cancel-confirmation').hidden, true);
  assert.equal(h.calls.some(call => call.url.endsWith('/cancel')), false);
});

test('a cancellation reply stays with its captured run across a run switch', async t => {
  const step = 'network'; const a = job(step), b = job(step, 'run-b', 'running', {job_id: '456'}); let finishCancel;
  const h = harness(t, step, call => call.url.endsWith('/cancel') ? new Promise(resolve => {finishCancel = resolve;})
    : response(call.url.includes('run-b') ? b : a));
  h.remote(); h.context([run(step, a), run(step, b)]); await until(() => !h.q('refresh').disabled);
  h.click('cancel'); h.click('cancel-confirm'); h.context([run(step, a), run(step, b)], 'run-b');
  finishCancel(response({...a, state: 'cancelling', cancel_requested_at: '2026-11-17T10:01:00Z'})); await settle();
  assert.equal(h.panel.dataset.networkRunId, 'run-b'); assert.equal(h.panel.dataset.networkState, 'running');
  assert.equal(h.q('job-id').textContent, '456');
  h.context([run(step, a), run(step, b)], 'run-a');
  assert.equal(h.panel.dataset.networkState, 'cancelling'); assert.equal(h.q('job-id').textContent, '123');
});

test('disconnects and uncertain errors never display cancelled and preserve status recovery', async t => {
  const step = 'expression'; let current = job(step);
  const h = harness(t, step, call => call.url.endsWith('/cancel') ? response({error: 'SSH connection lost; outcome unknown'}, 502) : response(current));
  h.context([run(step, current)]); await until(() => !h.q('refresh').disabled);
  assert.equal(h.q('cancel').disabled, true); h.click('cancel'); assert.equal(h.q('cancel-confirmation').hidden, true);
  h.remote(); h.click('cancel'); h.click('cancel-confirm');
  await until(() => h.q('cancel-notice').textContent.includes('SSH connection lost'));
  assert.equal(h.panel.dataset.expressionState, 'running');
  assert.match(h.q('cancel-notice').textContent, /Cancellation outcome is unconfirmed/);
  assert.equal(h.q('cancel').disabled, true); assert.equal(h.q('refresh').disabled, false);
  current = {...current, state: 'cancelling', cancel_requested_at: '2026-11-17T10:01:00Z'};
  h.click('refresh'); await until(() => h.panel.dataset.expressionState === 'cancelling');
  h.remote({connected: false}); assert.equal(h.q('cancel').disabled, true);
  assert.equal(h.panel.dataset.expressionState, 'cancelling');
});

test('completed, recorded, archived and jobless records cannot be cancelled', async t => {
  const step = 'expression'; const active = job(step);
  const h = harness(t, step, () => response(active)); h.remote();
  for (const overrides of [{source: 'archive', origin: 'archive'}, {source: 'recorded', origin: 'slurm'},
    {capabilities: {continue_analysis: false}}]) {
    h.context([run(step, active, overrides)]);
    assert.equal(h.q('cancel').hidden, true); h.click('cancel'); assert.equal(h.q('cancel-confirmation').hidden, true);
  }
  h.context([run(step, job(step, 'finished', 'completed'))], 'finished');
  assert.equal(h.q('cancel').hidden, true);
  h.context([run(step, job(step, 'jobless', 'unknown', {job_id: null}))], 'jobless');
  assert.equal(h.q('cancel').hidden, true);
  assert.equal(h.calls.some(call => call.url.endsWith('/cancel')), false);
});

test('Stage 1 explicit history runs preserve the separate Analysis selection', async t => {
  const a = job('genotype', 'analysis-run', 'completed'), b = job('genotype', 'history-run', 'pending', {job_id: '456'});
  const h = harness(t, 'genotype', call => response(call.url.includes('history-run') ? b : a)); h.remote();
  const rows = [run('genotype', a), run('genotype', b)];
  h.context([rows[0]], null); assert.equal(h.panel.dataset.genotypeRunId, 'analysis-run');
  h.context(rows, 'history-run'); await until(() => !h.q('refresh').disabled);
  assert.equal(h.panel.dataset.genotypeRunId, 'history-run'); assert.equal(h.q('new').hidden, true);
  h.click('cancel'); assert.match(h.q('cancel-target').textContent, /history-run.*456/);
  h.click('back'); assert.equal(h.backs.length, 1);
  h.context(rows, null); assert.equal(h.panel.dataset.genotypeRunId, 'analysis-run');
  assert.equal(h.q('cancel-confirmation').hidden, true);
});

test('a response for another job or attempt cannot claim cancellation of the confirmed target', async t => {
  const step = 'network', active = job(step);
  const h = harness(t, step, call => call.url.endsWith('/cancel')
    ? response({...active, job_id: '999', attempt: 3, state: 'cancelled'}) : response(active));
  h.remote(); h.context([run(step, active)]); await until(() => !h.q('refresh').disabled);
  h.click('cancel'); h.click('cancel-confirm');
  await until(() => h.q('cancel-notice').textContent.includes('unconfirmed'));
  assert.equal(h.panel.dataset.networkState, 'running');
  assert.equal(h.q('job-id').textContent, '123');
  assert.equal(h.q('cancel').disabled, true);
});

test('a delayed Analysis poll cannot replace another history run in the same dataset', async t => {
  const a = job('genotype', 'analysis-run', 'running', {settings: {mind: 0.1}});
  const b = job('genotype', 'history-run', 'pending', {job_id: '456', settings: {mind: 0.4}});
  let finishAnalysisPoll;
  const h = harness(t, 'genotype', call => call.url.includes('analysis-run')
    ? new Promise(resolve => {finishAnalysisPoll = resolve;}) : response(b));
  h.remote(); h.context([run('genotype', a)], null);
  await until(() => !!finishAnalysisPoll);
  h.context([run('genotype', a), run('genotype', b)], 'history-run');
  await until(() => !h.q('refresh').disabled);
  assert.equal(h.panel.querySelector('[data-genotype-setting="mind"]').value, '0.4');
  finishAnalysisPoll(response({...a, state: 'completed', settings: {mind: 0.9}, finished_at: '2026-11-17T11:00:00Z'}));
  await settle();
  assert.equal(h.panel.dataset.genotypeRunId, 'history-run');
  assert.equal(h.q('job-id').textContent, '456');
  assert.equal(h.panel.querySelector('[data-genotype-setting="mind"]').value, '0.4');
  h.context([run('genotype', a), run('genotype', b)], null);
  assert.equal(h.panel.dataset.genotypeRunId, 'analysis-run');
  assert.equal(h.panel.dataset.genotypeState, 'completed');
  assert.equal(h.panel.querySelector('[data-genotype-setting="mind"]').value, '0.9');
});
