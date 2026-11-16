'use strict';

// Native UI, production HTTP server, and the local fake Slurm runner used by Python tests.
const assert = require('node:assert/strict');
const {once} = require('node:events');
const {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app} = require('electron');
const {launch} = require('../main/app/main.cjs');

const repo = path.join(__dirname, '../..');
const temp = mkdtempSync(path.join(os.tmpdir(), 'signet-genotype-workspace-'));
const fixtureEntry = path.join(__dirname, 'fixtures/genotype_backend.py');
const metadataPath = path.join(temp, 'fixture.json');
const pythonWrapper = path.join(temp, 'python-fixture');
const defaultPython = path.join(repo, '.venv/bin/python');
process.env.SIGNET_GENOTYPE_TEST_PYTHON = process.env.SIGNET_PYTHON || (existsSync(defaultPython) ? defaultPython : 'python3');
process.env.SIGNET_GENOTYPE_TEST_ENTRY = fixtureEntry;
process.env.SIGNET_GENOTYPE_TEST_METADATA = metadataPath;
writeFileSync(pythonWrapper, '#!/bin/sh\nexec "$SIGNET_GENOTYPE_TEST_PYTHON" "$SIGNET_GENOTYPE_TEST_ENTRY" "$@"\n', {mode: 0o700});
process.env.SIGNET_PYTHON = pythonWrapper;

let running;
const deadline = setTimeout(async () => {
  console.error('Workspace genotype test timed out');
  await running?.backend.forceStop();
  rmSync(temp, {recursive: true, force: true});
  app.exit(1);
}, 75000);
app.on('will-quit', () => {
  clearTimeout(deadline);
  rmSync(temp, {recursive: true, force: true});
});

async function until(check, description, timeoutMs = 20000) {
  const expires = Date.now() + timeoutMs;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < expires);
  throw Error(description);
}

async function verify() {
  running = await launch({provider: 'codex', visible: false, userData: path.join(temp, 'app'),
    stateFile: path.join(temp, 'chat', 'state.json')});
  assert.ok(running);
  const {window} = running;
  const fixture = JSON.parse(readFileSync(metadataPath, 'utf8'));
  const sbatchCalls = path.join(fixture.slurm, 'sbatch_calls');
  const js = source => window.webContents.executeJavaScript(source);
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  const review = '#lens-stage1 [data-genotype-review]';
  const submit = '#lens-stage1 [data-genotype-submit]';
  const state = () => js(`document.querySelector('#lens-stage1')?.dataset.genotypeState`);
  const history = '[data-nav-target="history"]';

  const frame = await js(`(() => {
    const root = document.querySelector('.ml-app');
    return [root.offsetWidth, root.offsetHeight, root.querySelector('.ml-chat').offsetWidth];
  })()`);
  assert.deepEqual(frame, [1650, 894, 542]);
  await until(() => js(`!!document.querySelector('[data-stage="1"]')`), 'Stage timeline is missing');
  await click('#ml-stage-tab');
  await click('[data-stage="1"]');
  await until(() => js(`Boolean(document.querySelector(${JSON.stringify(review)}))`), 'Review control did not mount');
  await until(() => js(`document.querySelector(${JSON.stringify(submit)})?.disabled === false`),
    'Prepared chr1 input review did not enable submit');

  for (const [key, file] of Object.entries(fixture.inputs)) {
    const selector = `#lens-stage1 [data-genotype-input="${key}"]`;
    const rendered = await js(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      return input?.value || input?.textContent;
    })()`);
    assert.ok(rendered?.includes(file), `Review did not show the prepared input ${key}`);
  }

  async function setReviewValue(selector, value) {
    await js(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', {bubbles: true}));
      input.dispatchEvent(new Event('change', {bubbles: true}));
    })()`);
  }
  await setReviewValue('[data-genotype-setting="mind"]', '0.08');
  await setReviewValue('[data-genotype-resource="cpus"]', '4');
  assert.equal(existsSync(sbatchCalls), false, 'Opening review or editing settings submitted a job');
  assert.deepEqual(readdirSync(path.join(fixture.project, 'runs')), ['step_test'], 'Review created an analysis');

  await js(`(() => {
    const button = document.querySelector(${JSON.stringify(submit)});
    button.click();
    button.click();
  })()`);
  await until(async () => await state() === 'pending', 'The renderer did not report the queued job');
  let submitted = readFileSync(sbatchCalls, 'utf8').trim().split('\n');
  assert.deepEqual(submitted, ['submitted'], 'One click sequence must submit only one job');
  const runId = await js(`document.querySelector('#lens-stage1').dataset.genotypeRunId`);
  assert.match(runId, /^[A-Za-z0-9][A-Za-z0-9_-]+$/);
  const localRun = path.join(fixture.project, 'runs', runId);
  const stepJson = path.join(localRun, 'steps/genotype.json');
  const readStep = () => JSON.parse(readFileSync(stepJson, 'utf8'));

  assert.equal(readStep().job_id, '12345');
  assert.equal(readStep().state, 'pending');
  const plan = readFileSync(path.join(localRun, 'work/config.ini'), 'utf8');
  assert.match(plan, /^mind = 0\.08$/m);
  assert.match(plan, /^restrict\.tcga\.geno = 1$/m);
  assert.match(readFileSync(path.join(fixture.slurm, 'sbatch_args'), 'utf8'), /^--cpus-per-task=4$/m);

  writeFileSync(path.join(fixture.slurm, 'squeue'), 'RUNNING\n');
  await until(async () => await state() === 'running', 'Automatic polling did not show the running state');
  assert.equal(readStep().state, 'running');

  const remoteRun = path.join(fixture.remote, runId);
  const resultPath = path.join(remoteRun, 'work/res/resg');
  mkdirSync(resultPath, {recursive: true});
  writeFileSync(path.join(resultPath, 'signet_Geno'), '0 1 2\n2 1 0\n1 0 1\n0 0 2\n');
  writeFileSync(path.join(resultPath, 'signet_Genotype.sampleID'), 'S1\nS2\nS3\nS4\n');
  writeFileSync(path.join(remoteRun, 'steps/genotype.done'), '0 2026-11-16T10:00:00\n');
  writeFileSync(path.join(fixture.slurm, 'sacct'), 'COMPLETED\n');
  writeFileSync(path.join(fixture.slurm, 'squeue'), '');
  await until(async () => await state() === 'completed', 'Automatic polling did not verify and report completion');
  assert.equal(readStep().state, 'completed');
  assert.equal(readFileSync(path.join(localRun, 'work/res/resg/signet_Geno'), 'utf8'), '0 1 2\n2 1 0\n1 0 1\n0 0 2\n');

  const runDetail = `#ml-run-${runId}`;
  await click('#lens-stage1 [data-genotype-history]');
  await until(() => js(`Boolean(document.querySelector(${JSON.stringify(runDetail)})?.getClientRects().length)`),
    'The live completion action did not open the saved run');
  const savedInputs = await js(`[...document.querySelectorAll(${JSON.stringify(runDetail + ' .ml-run-inputs code')})]
    .map(node => node.textContent)`);
  assert.deepEqual(savedInputs, [fixture.inputs['ped.file'], fixture.inputs['map.file'],
    fixture.inputs.ref + '1.gen', fixture.inputs.gmap + '1.map']);

  const load = once(window.webContents, 'did-finish-load');
  window.webContents.reload();
  await load;
  await until(() => js(`!!document.querySelector(${JSON.stringify(history)})`), 'Could not reopen the workspace');
  await click(history);
  const row = `[data-run-target="${runId}"]`;
  await until(() => js(`Boolean(document.querySelector(${JSON.stringify(row)})?.getClientRects().length)`),
    'The completed run was missing from history after reload');
  await click(row);
  const stage = `[data-run-stage="1"][data-run-id="${runId}"]`;
  await click(stage);
  await until(() => js(`(() => {
    const panel = document.querySelector('#lens-history-stage');
    return panel?.dataset.runId === ${JSON.stringify(runId)} && panel.dataset.runState === 'ready';
  })()`), 'The completed genotype output did not reopen from history');
  assert.equal(await js(`document.querySelector('#lens-history-stage [data-stage-setting="mind"]')?.textContent`), '0.08');
  assert.equal(await js(`document.querySelector('#lens-history-stage [data-stage-resource="cpus"]')?.textContent`), '4');
  assert.ok(await js(`document.querySelector('#lens-history-stage .ml-count-chart')?.getClientRects().length`));
  const counts = await js(`[...document.querySelectorAll('#lens-history-stage .ml-count-label')].map(n => Number(n.textContent))`);
  assert.deepEqual(counts, [0, 0, 0, 0, 0, 3]);
  submitted = readFileSync(sbatchCalls, 'utf8').trim().split('\n');
  assert.deepEqual(submitted, ['submitted'], 'Checking history or reloading replayed a submission');
  console.log('PASS: manual Stage 1 submission, real local status polling, downloaded results, and history after reload');
  await running.quit();
}

verify().catch(async error => {
  console.error(error);
  if (running) await running.backend.forceStop();
  rmSync(temp, {recursive: true, force: true});
  app.exit(1);
});
