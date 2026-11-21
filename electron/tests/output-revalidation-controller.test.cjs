'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const source = readFileSync(path.join(__dirname, '../renderer/features/workspace/genotype-run.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check) {for (let i = 0; i < 80; i++) {if (check()) return; await settle();} assert.fail('Output check did not settle');}
const response = (value, status = 200) => ({ok: status < 400, status, json: async () => clone(value)});
const eligible = {eligible: true, active: false, reason: 'Only saved outputs need to be checked.'};
const projection = (state, overrides = {}) => ({eligible: state === 'failed', active: state === 'validating', reason: '', ...overrides});
const job = (step, overrides = {}) => ({run_id: 'run-a', step, state: 'failed', attempt: 2, job_id: '123',
  submitted_at: '2026-11-17T10:00:00Z', finished_at: '2026-11-17T10:05:00Z', exit_code: '0',
  reason: 'Required outputs are missing.', missing_outputs: ['res/expected.data'], failure_hints: [], slurm_state: 'COMPLETED',
  inputs: {}, settings: {'restrict.tcga.geno': 2, mind: 0.1, geno: 0.1, hwe: 0.0001, int: 5000000, 'restrict.tcga': 2},
  resources: {cpus: 4, mem_gb: 16, hours: 2}, history: [{state: 'failed', at: '2026-11-17T10:05:00Z'}], ...overrides});
const run = (step, record, overrides = {}) => ({history_id: 'workspace--' + record.run_id, run_id: record.run_id,
  dataset_id: 'dataset-a', source: 'live', origin: 'workspace', capabilities: {continue_analysis: true},
  output_revalidation: {[step]: eligible}, jobs: {genotype: {state: 'completed'}, expression: {state: 'completed'},
    adjust: {state: 'completed'}, cis: {state: 'completed'}, network: {state: 'completed'}, [step]: record}, ...overrides});
const mounts = {genotype: 'Genotype', expression: 'Expression', adjust: 'Adjustment', cis: 'Cis', network: 'Network', visualize: 'Visualization'};
function harness(t, step, handler) {
  const dom = new JSDOM('<!doctype html><section id="panel"></section>', {url: 'http://localhost', runScripts: 'outside-only'});
  const {window} = dom; t.after(async () => {await settle(); await settle(); window.close();}); window.eval(source);
  const panel = window.document.querySelector('#panel'), calls = [], changed = [];
  window.fetch = async (url, options = {}) => {const call = {url, options, body: options.body ? JSON.parse(options.body) : undefined}; calls.push(call); return handler(call);};
  const controller = window['mount' + mounts[step] + 'Run']({panel, token: 'test-token', onHistoryChanged: (...args) => changed.push(args)});
  const q = part => panel.querySelector(`[data-${step}-${part}]`), click = part => {assert.ok(q(part), 'Missing ' + part); q(part).click();};
  const context = (rows, id = rows[0]?.run_id, overrides = {}) => controller.setContext({datasetId: 'dataset-a',
    dataset: {id: 'dataset-a', name: ['資料組', 'Dataset'], ready: true, persisted: true, inputs: {}},
    visible: true, runs: rows, runId: id, ...overrides});
  const remote = overrides => window.dispatchEvent(new window.CustomEvent('workspace-remote-context', {detail: {connected: true, identity: 'user@host|session', environmentKey: 'root', ...overrides}}));
  return {window, panel, calls, changed, controller, q, click, context, remote};
}

for (const [index, step] of Object.keys(mounts).entries()) {
  test(`Stage ${index + 1} checks only existing outputs after an explicit click and keeps job/attempt identity`, async t => {
    const old = job(step); let finish;
    let current = {...old, state: 'completed', missing_outputs: [], finished_at: '2026-11-17T11:00:00Z', output_revalidation: projection('completed')};
    const h = harness(t, step, call => call.url.endsWith('/revalidate') ? new Promise(resolve => {finish = resolve;}) : response(current));
    const originals = JSON.stringify(old); h.remote(); h.context([run(step, old)]);
    assert.equal(h.calls.length, 0); assert.equal(h.q('revalidate').hidden, false);
    h.click('revalidate'); h.click('revalidate');
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, `/signet/runs/run-a/steps/${step}/revalidate`);
    assert.deepEqual(h.calls[0].body, {expected_job_id: '123', expected_attempt: 2});
    assert.equal(h.q('revalidate').disabled, true); assert.equal(h.q('submit').disabled, true);
    assert.equal(h.q('retry').hidden, true);
    assert.equal(h.panel.dataset[step + 'RevalidationState'], 'checking');
    assert.equal(h.panel.dataset[step + 'State'], 'failed', 'Pending check is not a completed analysis');
    finish(response({...old, state: 'validating', finished_at: undefined, output_revalidation: projection('validating'),
      history: [...old.history, {state: 'validating', at: '2026-11-17T10:30:00Z'}]}));
    await until(() => h.panel.dataset[step + 'State'] === 'validating');
    assert.equal(h.q('cancel').hidden, true); assert.match(h.q('revalidate-notice').textContent, /completion is not yet confirmed/);
    h.click('refresh'); await until(() => h.panel.dataset[step + 'State'] === 'completed');
    assert.equal(h.panel.dataset[step + 'RunId'], 'run-a'); assert.equal(h.q('job-id').textContent, '123');
    assert.equal(h.q('revalidate').hidden, true); assert.equal(JSON.stringify(old), originals);
    assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
    assert.equal(h.calls.some(call => /\/example|\/retry|\/cancel/.test(call.url)), false);
  });
}

test('backend-ineligible, noncurrent and jobless records never offer an output check', async t => {
  const step = 'expression', h = harness(t, step, () => response(job(step))); h.remote();
  for (const [index, reason] of ['Observed exit code 1', 'Recorded R error', 'Scheduler reported OUT_OF_MEMORY'].entries()) {
    const old = job(step, {run_id: 'bad-' + index});
    h.context([run(step, old, {output_revalidation: {[step]: {eligible: false, active: false, reason}}})]);
    assert.equal(h.q('revalidate').hidden, true); assert.match(h.q('revalidate-notice').textContent, new RegExp(reason)); h.click('revalidate');
  }
  for (const [index, state] of ['completed', 'cancelled', 'unknown', 'running'].entries()) {
    const old = job(step, {run_id: 'state-' + index, state}); h.context([run(step, old)]);
    assert.equal(h.q('revalidate').hidden, true); h.click('revalidate');
  }
  for (const [index, source] of ['archive', 'recorded'].entries()) {
    h.context([run(step, job(step, {run_id: 'source-' + index}), {source})]); assert.equal(h.q('revalidate').hidden, true); h.click('revalidate');
  }
  h.context([run(step, job(step, {run_id: 'jobless', job_id: null}))]); assert.equal(h.q('revalidate').hidden, true); h.click('revalidate');
  assert.equal(h.calls.some(call => call.url.endsWith('/revalidate')), false);
});

test('disconnect and server failures preserve the failed state and never claim outputs were recovered', async t => {
  const step = 'expression', old = job(step), h = harness(t, step, () => response({error: 'The remote server is disconnected.'}, 412));
  h.context([run(step, old)]); assert.equal(h.q('revalidate').disabled, true); h.click('revalidate'); assert.equal(h.calls.length, 0);
  h.remote(); h.click('revalidate'); await until(() => h.panel.dataset.expressionRevalidationState === 'error');
  assert.equal(h.panel.dataset.expressionState, 'failed'); assert.equal(h.q('job-id').textContent, '123');
  assert.match(h.q('revalidate-notice').textContent, /last confirmed state.*disconnected/s);
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('still-missing outputs update history but never automatically run another check', async t => {
  const step = 'expression', old = job(step); const h = harness(t, step, () => response({...old, output_revalidation: eligible,
    output_checks: [{at: '2026-11-17T10:30:00Z', before: 'failed', after: 'failed', outcome: 'failed'}]}));
  h.remote(); h.context([run(step, old)]); h.click('revalidate'); await until(() => h.panel.dataset.expressionRevalidationState === 'checked');
  assert.equal(h.panel.dataset.expressionState, 'failed'); assert.match(h.q('revalidate-notice').textContent, /still did not pass/);
  assert.equal(h.changed.length, 1, 'Saved check audit should refresh even when state/job did not change');
  h.context([run(step, old)]); await settle(); assert.equal(h.calls.length, 1); assert.equal(h.q('revalidate').disabled, false);
});

test('a check invalidates a ready Stage 1 retry review and disables preparing a new run', async t => {
  const step = 'genotype', old = job(step); let finish;
  const h = harness(t, step, call => call.url.endsWith('/revalidate') ? new Promise(resolve => {finish = resolve;}) : response({run_id: 'run-a',
    dataset_id: 'dataset-a', expected_job_id: '123', expected_attempt: 2, next_attempt: 3, ready: true, inputs: old.inputs,
    source_inputs: {}, settings: old.settings, resources: old.resources, limits: {}, warnings: [], review_token: 'old-token'}));
  h.remote(); h.context([run(step, old)], null); h.click('retry'); await until(() => h.panel.dataset.genotypeRetryState === 'ready');
  h.q('acknowledge').checked = true; h.q('acknowledge').dispatchEvent(new h.window.Event('change', {bubbles: true}));
  h.click('revalidate'); assert.equal(h.panel.dataset.genotypeRetryState, 'idle'); assert.equal(h.q('acknowledge').checked, false);
  assert.equal(h.q('new').disabled, true); h.click('new'); assert.equal(h.panel.dataset.genotypeRunId, 'run-a');
  finish(response({...old, state: 'completed', output_revalidation: projection('completed')}));
  await until(() => h.panel.dataset.genotypeState === 'completed');
  h.click('submit'); assert.equal(h.calls.filter(call => call.options.method === 'POST' && !call.url.endsWith('/revalidate')).length, 0);
});

test('an old status response cannot overwrite the check or unlock a newer status request', async t => {
  const step = 'expression', old = job(step); const polls = []; let finish;
  const h = harness(t, step, call => call.url.endsWith('/revalidate') ? new Promise(resolve => {finish = resolve;})
    : new Promise(resolve => polls.push(resolve)));
  h.remote(); h.context([run(step, old)]); h.click('refresh'); await until(() => polls.length === 1);
  h.click('revalidate'); finish(response({...old, state: 'validating', output_revalidation: projection('validating')}));
  await until(() => h.panel.dataset.expressionState === 'validating'); h.click('refresh'); await until(() => polls.length === 2);
  polls[0](response(old)); await settle(); assert.equal(h.panel.dataset.expressionState, 'validating');
  assert.equal(h.q('refresh').disabled, true);
  polls[1](response({...old, state: 'completed', output_revalidation: projection('completed')}));
  await until(() => h.panel.dataset.expressionState === 'completed');
});

test('a response stays with its captured run while a different run is selected', async t => {
  const step = 'network', old = job(step), other = job(step, {run_id: 'run-b', job_id: '456'}); let finish;
  const h = harness(t, step, () => new Promise(resolve => {finish = resolve;})); h.remote(); h.context([run(step, old), run(step, other)]);
  h.click('revalidate'); h.context([run(step, old), run(step, other)], 'run-b');
  finish(response({...old, state: 'completed', output_revalidation: projection('completed')})); await settle();
  assert.equal(h.panel.dataset.networkRunId, 'run-b'); assert.equal(h.panel.dataset.networkState, 'failed'); assert.equal(h.q('job-id').textContent, '456');
  h.context([run(step, old), run(step, other)], 'run-a'); assert.equal(h.panel.dataset.networkState, 'completed');
});

test('remote identity changes and wrong job/attempt responses cannot recover the selected record', async t => {
  const step = 'expression', old = job(step); let finish;
  const h = harness(t, step, () => new Promise(resolve => {finish = resolve;})); h.remote(); h.context([run(step, old)]);
  h.click('revalidate'); h.remote({identity: 'different@host|session'});
  finish(response({...old, state: 'completed', output_revalidation: projection('completed')}));
  await until(() => h.panel.dataset.expressionRevalidationState === 'error'); assert.equal(h.panel.dataset.expressionState, 'failed');
  h.click('revalidate'); finish(response({...old, job_id: '999', attempt: 3, state: 'completed', output_revalidation: projection('completed')}));
  await until(() => h.panel.dataset.expressionRevalidationState === 'error'); assert.equal(h.panel.dataset.expressionState, 'failed');
  assert.equal(h.q('job-id').textContent, '123');
});

test('a newer attempt and a newer completed state cannot be overwritten by an older check response', async t => {
  const step = 'expression', old = job(step); let finish;
  const h = harness(t, step, () => new Promise(resolve => {finish = resolve;})); h.remote(); h.context([run(step, old)]);
  h.click('revalidate');
  const next = job(step, {attempt: 3, job_id: '456', state: 'failed', output_revalidation: projection('failed', {eligible: false, reason: 'Observed process error'})});
  h.context([run(step, next)]);
  finish(response({...old, state: 'completed', output_revalidation: projection('completed')})); await settle();
  assert.equal(h.q('job-id').textContent, '456'); assert.match(h.q('revalidate-notice').textContent, /Observed process error/);
  assert.doesNotMatch(h.q('revalidate-notice').textContent, /changed/);
  const another = job(step, {run_id: 'second-run'}); h.context([run(step, another)]); h.click('revalidate');
  const completed = {...another, state: 'completed', finished_at: '2026-11-17T11:00:00Z', updated_at: '2026-11-17T11:00:00Z', output_revalidation: projection('completed')};
  h.context([run(step, completed)]);
  finish(response({...another, output_revalidation: eligible})); await settle();
  assert.equal(h.panel.dataset.expressionState, 'completed');
});

for (const step of ['genotype', 'expression']) {
  test(`${step} recovers an interrupted POST from the saved check without reopening an unrelated terminal failure`, async t => {
    const old = job(step), validating = {...old, state: 'validating', finished_at: undefined,
      original_failure: {state: 'failed'}, output_revalidation_requested_at: '2026-11-17T11:00:00Z',
      output_checks: [{at: '2026-11-17T11:00:00Z', outcome: 'validating'}]};
    const completed = {...validating, state: 'completed', output_checks: [{at: '2026-11-17T11:00:00Z', outcome: 'completed'}], output_revalidation: projection('completed')};
    const h = harness(t, step, call => call.url.endsWith('/revalidate') ? Promise.reject(Error('Response connection lost')) : response(completed));
    h.remote(); h.context([run(step, old)]); h.click('revalidate');
    await until(() => h.panel.dataset[step + 'RevalidationState'] === 'error');
    h.context([run(step, validating, {output_revalidation: {[step]: projection('validating')}})]);
    assert.equal(h.panel.dataset[step + 'State'], 'validating');
    assert.equal(h.q('refresh').hidden, false);
    assert.match(h.q('revalidate-notice').textContent, /completion is not yet confirmed/);
    if (!h.q('refresh').disabled) h.click('refresh');
    await until(() => h.panel.dataset[step + 'State'] === 'completed');
    assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
  });
}

test('ordinary status refresh in a Stage 1 retry review cannot invoke the legacy output-check alias', async t => {
  const step = 'genotype', old = job(step);
  const h = harness(t, step, call => response(call.url.includes('/steps/') ? old : {run_id: 'run-a', dataset_id: 'dataset-a',
    expected_job_id: '123', expected_attempt: 2, next_attempt: 3, ready: true, inputs: old.inputs, source_inputs: {},
    settings: old.settings, resources: old.resources, limits: {}, warnings: [], review_token: 'still-current-token'}));
  h.remote(); h.context([run(step, old)]); h.click('retry'); await until(() => h.panel.dataset.genotypeRetryState === 'ready');
  h.q('acknowledge').checked = true; h.q('acknowledge').dispatchEvent(new h.window.Event('change', {bubbles: true}));
  h.click('refresh'); await until(() => !h.q('refresh').disabled);
  const status = h.calls.find(call => call.url.includes('/steps/'));
  assert.equal(status.url, '/signet/runs/run-a/steps/genotype');
  assert.equal(h.panel.dataset.genotypeRetryState, 'ready'); assert.equal(h.q('acknowledge').checked, true);
  assert.equal(h.calls.some(call => call.url.includes('/revalidate')), false);
});
