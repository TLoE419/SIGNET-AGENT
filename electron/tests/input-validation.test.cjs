'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const directory = path.join(__dirname, '../renderer/features/workspace');
const inputs = {genotype: ['/pub/u/study.ped', '/pub/u/study.map'], expression: ['/pub/u/expression.txt'], clinical: ['/pub/u/clinical.tsv']};
const clone = value => JSON.parse(JSON.stringify(value));

function makeReport({kind = 'genotype', datasetId = 'dataset-a', files = inputs, resolved = files[kind],
  status = 'passed', message = 'Structure checked.'} = {}) {
  return {
    dataset_id: datasetId, kind, inputs: clone(files), resolved_inputs: {[kind]: [...resolved]},
    checked_at: '2026-11-17T22:00:00Z', status, read_only: true, executed: false,
    checks: [{id: kind + '_format', kind, label: kind, status: status === 'incomplete' ? 'unchecked' : status,
      message, paths: [...resolved], metrics: {samples: 6}, issues: []}],
    pairing: {status: 'unchecked', issues: []},
    stage_readiness: {},
    files: resolved.map(path => ({path, complete: status !== 'incomplete', sha256: 'a'.repeat(64), size: 1, lines: 1})),
    limits: {max_seconds: 30},
  };
}

const reply = (value, status = 200) => ({ok: status < 400, status, json: async () => value});
const reportFor = ({body}) => makeReport({kind: body.kind, files: body.inputs});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

function harness(t, respond = call => reply(reportFor(call))) {
  const dom = new JSDOM(readFileSync(path.join(directory, 'index.html'), 'utf8'),
    {url: 'http://127.0.0.1:43210', runScripts: 'outside-only'});
  t.after(() => dom.window.close());
  const {window} = dom;
  const root = window.document.getElementById('signet-lens-left-preview');
  window.document.querySelector('meta[name="chat-token"]').content = 'test-token';
  const calls = [];
  window.fetch = async (url, init) => {
    const call = {url, init, body: JSON.parse(init.body)};
    calls.push(call);
    return respond(call);
  };
  window.eval(readFileSync(path.join(directory, 'input-validation.js'), 'utf8'));
  let dataset = {id: 'dataset-a', name: 'Dataset A', inputs: clone(inputs), persisted: true, ready: true};
  const renderedPaths = [];
  const renderFilePath = (path, options) => {
    renderedPaths.push([path, {...options}]);
    const span = window.document.createElement('span');
    span.dataset.testRenderedPath = path;
    span.textContent = path;
    return span;
  };
  const controller = window.SignetInputValidation.create({root, getDataset: () => dataset, renderFilePath});
  const panel = root.querySelector('[data-input-validation]');
  const remote = (overrides = {}) => window.dispatchEvent(new window.CustomEvent('workspace-remote-context',
    {detail: {connected: true, identity: 'user@host|session-a', environmentKey: 'root-a', ...overrides}}));
  const change = value => { dataset = {...dataset, ...value}; controller.sync(); };
  const select = kind => controller.select(kind);
  const button = () => panel.querySelector('[data-validation-action]');
  const state = () => panel.dataset.validationState;
  const checks = () => [...panel.querySelectorAll('[data-validation-check]')].map(node => node.dataset.validationCheck);
  const checkedFiles = () => [...panel.querySelectorAll('[data-validation-file]')].map(node => node.dataset.validationFile);
  return {root, calls, panel, button, state, checks, checkedFiles, renderedPaths, remote, change, select, controller};
}

const pathsIn = scope => [...scope.querySelectorAll('[data-test-rendered-path]')].map(node => node.dataset.testRenderedPath);

async function waitFor(condition, message = 'Expected validation state') {
  const end = Date.now() + 1500;
  while (!condition()) {
    assert.ok(Date.now() < end, message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function assertNoDatasetWideResult(panel) {
  assert.equal(panel.querySelector('[data-validation-pairing], [data-pairing-count], [data-validation-stage]'), null);
  assert.doesNotMatch(panel.textContent, /Preliminary sample matching|Input checks by stage/);
}

test('manual checking sends the selected kind with the saved snapshot and renders only that kind', async t => {
  const h = harness(t);
  assert.equal(h.button().disabled, true);
  h.remote();
  assert.equal(h.calls.length, 0);
  assert.equal(h.root.querySelector('[data-nav-left="data"] [data-input-validate]'), null);
  const button = h.button();
  button.click();
  await waitFor(() => h.state() === 'passed');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, '/signet/datasets/dataset-a/validate');
  assert.equal(h.calls[0].init.method, 'POST');
  assert.equal(h.calls[0].init.headers['X-Chat-Token'], 'test-token');
  assert.deepEqual(h.calls[0].body, {inputs, kind: 'genotype'});
  assert.deepEqual(h.checks(), ['genotype_format']);
  assert.deepEqual(h.checkedFiles(), inputs.genotype);
  assertNoDatasetWideResult(h.panel);
  const genotype = h.panel.querySelector('[data-validation-check="genotype_format"]');
  assert.deepEqual(pathsIn(genotype), inputs.genotype);
  assert.deepEqual(pathsIn(h.panel.querySelector('[data-validation-section="coverage"]')), inputs.genotype);
  assert.deepEqual(h.renderedPaths, [...inputs.genotype, ...inputs.genotype].map(path => [path, {includeFilename: true}]));
  assert.equal(genotype.open, false);
  genotype.open = true;
  h.controller.sync();
  assert.equal(h.panel.querySelector('[data-validation-check="genotype_format"]'), genotype);
  assert.equal(h.button(), button);
  h.change({name: ['Old label', 'Updated dataset A']});
  assert.match(h.panel.querySelector('.ml-validation-meta').textContent, /Updated dataset A/);
  assert.equal(genotype.open, true, 'The saved name change preserves the details disclosure');
  assert.equal(h.calls.length, 1);
});

test('each kind keeps its independent report and switching never starts a check', async t => {
  const h = harness(t, call => reply(makeReport({kind: call.body.kind, files: call.body.inputs,
    status: call.body.kind === 'expression' ? 'warning' : 'passed'})));
  h.remote();
  h.button().click();
  await waitFor(() => h.state() === 'passed');
  h.select('expression');
  assert.equal(h.state(), 'idle');
  assert.deepEqual(h.checks(), []);
  assert.equal(h.calls.length, 1);
  h.button().click();
  await waitFor(() => h.state() === 'warning');
  assert.deepEqual(h.checks(), ['expression_format']);
  assert.deepEqual(h.checkedFiles(), inputs.expression);
  assert.equal(h.panel.querySelector('[data-validation-check="expression_format"]').open, true);
  h.select('clinical');
  assert.equal(h.state(), 'idle');
  h.select('genotype');
  assert.equal(h.state(), 'passed');
  assert.deepEqual(h.checks(), ['genotype_format']);
  h.select('expression');
  assert.equal(h.state(), 'warning');
  assert.equal(h.calls.length, 2);
  assertNoDatasetWideResult(h.panel);
});

test('changes to a different kind preserve a pending check and the current report', async t => {
  const check = deferred();
  const h = harness(t, () => check.promise);
  h.remote();
  h.button().click();
  await waitFor(() => h.calls.length === 1);
  h.change({inputs: {...clone(inputs), clinical: ['/pub/u/new-clinical.tsv']}});
  assert.equal(h.calls[0].init.signal.aborted, false);
  check.resolve(reply(reportFor(h.calls[0])));
  await waitFor(() => h.state() === 'passed');
  h.change({inputs: {...clone(inputs), expression: ['/pub/u/new-expression.tsv']}});
  assert.equal(h.state(), 'passed');
  assert.equal(h.calls.length, 1);
});

test('a check finishing in the background updates only its own kind', async t => {
  const check = deferred();
  const h = harness(t, call => call.body.kind === 'genotype' ? check.promise : reply(reportFor(call)));
  h.remote();
  h.button().click();
  h.select('clinical');
  h.button().click();
  await waitFor(() => h.state() === 'passed');
  assert.deepEqual(h.checks(), ['clinical_format']);
  check.resolve(reply(reportFor(h.calls[0])));
  await tick();
  assert.equal(h.state(), 'passed');
  assert.deepEqual(h.checks(), ['clinical_format']);
  h.select('genotype');
  assert.equal(h.state(), 'passed');
  assert.deepEqual(h.checks(), ['genotype_format']);
  assert.equal(h.calls.length, 2);
});

test('changes to the checked kind abort the old request and reject its late result', async t => {
  const check = deferred();
  const h = harness(t, () => check.promise);
  h.remote();
  h.select('clinical');
  h.button().click();
  await waitFor(() => h.calls.length === 1);
  h.change({inputs: {...clone(inputs), clinical: ['/pub/u/new-clinical.tsv']}});
  assert.equal(h.calls[0].init.signal.aborted, true);
  check.resolve(reply(reportFor(h.calls[0])));
  await tick();
  assert.equal(h.state(), 'stale');
  assert.deepEqual(h.checks(), []);
  assert.equal(h.calls.length, 1);
});

test('switching datasets resets all kinds and discards a late reply from the prior dataset', async t => {
  const check = deferred();
  const h = harness(t, call => call.body.kind === 'clinical' ? check.promise : reply(reportFor(call)));
  h.remote();
  h.button().click();
  await waitFor(() => h.state() === 'passed');
  h.select('clinical');
  h.button().click();
  await waitFor(() => h.calls.length === 2);
  h.change({id: 'dataset-b', name: 'Dataset B'});
  assert.equal(h.calls[1].init.signal.aborted, true);
  check.resolve(reply(reportFor(h.calls[1])));
  await tick();
  assert.equal(h.state(), 'idle');
  assert.doesNotMatch(h.panel.textContent, /Dataset A/);
  h.select('genotype');
  assert.equal(h.state(), 'idle');
  assert.deepEqual(h.checks(), []);
  assert.equal(h.calls.length, 2);
});

test('disconnect and remote account or environment changes invalidate results without rerunning the check', async t => {
  const h = harness(t);
  h.remote();
  h.button().click();
  await waitFor(() => h.state() === 'passed');
  h.remote({connected: false});
  assert.equal(h.button().disabled, true);
  assert.notEqual(h.state(), 'passed');
  h.remote({identity: 'other@host|session-b', environmentKey: 'root-b'});
  assert.equal(h.button().disabled, false);
  assert.notEqual(h.state(), 'passed');
  assert.equal(h.calls.length, 1);
});

test('server conflicts clear the prior success and rapid clicks only start one retry', async t => {
  let failing = false;
  const h = harness(t, call => failing ? reply({error: 'The saved inputs changed. Check again.', code: 'conflict'}, 409) : reply(reportFor(call)));
  h.remote();
  h.button().click();
  await waitFor(() => h.state() === 'passed');
  const retry = h.button();
  failing = true;
  retry.click();
  retry.click();
  await waitFor(() => h.state() === 'stale');
  assert.match(h.panel.textContent, /The saved inputs changed/);
  assert.deepEqual(h.checks(), []);
  assert.equal(h.calls.length, 2);
  assert.equal(h.button(), retry);
});

test('the current kind shows incomplete coverage and structural issues as text', async t => {
  const report = makeReport({kind: 'clinical', status: 'incomplete', message: '<img src=x onerror=alert(1)> exceeds the read limit.'});
  const h = harness(t, () => reply(report));
  h.remote();
  h.select('clinical');
  h.button().click();
  await waitFor(() => h.state() === 'incomplete');
  assert.deepEqual(h.checks(), ['clinical_format']);
  assert.equal(h.panel.querySelector('[data-validation-check]').dataset.status, 'unchecked');
  assert.equal(h.panel.querySelector('img[onerror]'), null);
  assert.match(h.panel.textContent, /<img src=x.*exceeds the read limit/);
  assertNoDatasetWideResult(h.panel);
});

test('wrong-kind, inconsistent or overbroad replies never count as selected-kind success', async t => {
  for (const change of [
    report => { report.kind = 'expression'; },
    report => { report.checks[0].status = 'failed'; },
    report => { report.files[0].complete = false; },
    report => { report.files.push({path: inputs.clinical[0], complete: true, sha256: 'a'.repeat(64)}); },
    report => { report.checks[0].paths.push(inputs.clinical[0]); },
    report => { report.resolved_inputs.clinical = inputs.clinical; },
  ]) {
    const report = makeReport();
    change(report);
    const h = harness(t, () => reply(report));
    h.remote();
    h.button().click();
    await waitFor(() => h.state() === 'unavailable');
    assert.deepEqual(h.checks(), []);
    assertNoDatasetWideResult(h.panel);
  }
});

test('built-in example aliases remain bound to their own resolved file checks', async t => {
  const aliases = {genotype: ['study.ped', 'study.map'], expression: ['example_gexp'], clinical: ['official-demo-chr1-restart-clinical.tsv']};
  const report = makeReport({kind: 'expression', datasetId: 'example-chr1', files: aliases, resolved: inputs.expression});
  const canonical = '/dfs6b/pub/u/expression.txt';
  report.files[0] = {...report.files[0], selected_path: inputs.expression[0], path: canonical};
  const h = harness(t, () => reply(report));
  h.change({id: 'example-chr1', inputs: aliases});
  h.remote();
  h.select('expression');
  h.button().click();
  await waitFor(() => h.state() === 'passed');
  assert.deepEqual(pathsIn(h.panel.querySelector('[data-validation-check="expression_format"]')), inputs.expression);
  assert.deepEqual(pathsIn(h.panel.querySelector('[data-validation-section="coverage"]')), [canonical]);
  assert.deepEqual(h.checkedFiles(), [canonical]);
  assert.deepEqual(h.renderedPaths, [[inputs.expression[0], {includeFilename: true}], [canonical, {includeFilename: true}]]);
  report.resolved_inputs.expression[0] = '/pub/u/unrelated.tsv';
  h.button().click();
  await waitFor(() => h.state() === 'unavailable');
  assert.deepEqual(h.checkedFiles(), []);
});
