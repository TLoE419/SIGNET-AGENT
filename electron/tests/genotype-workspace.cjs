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
  console.error('Workspace genotype/expression/adjustment test timed out');
  await running?.backend.forceStop();
  rmSync(temp, {recursive: true, force: true});
  app.exit(1);
}, 180000);
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
  const sampleIds = ['TCGA-XX-A001-01', 'TCGA-XX-A002-01', 'TCGA-XX-A003-01', 'TCGA-XX-A004-01'];

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
  writeFileSync(path.join(resultPath, 'signet_Genotype.sampleID'), sampleIds.join('\n') + '\n');
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

  const genotypeRecord = readFileSync(stepJson, 'utf8');
  const genotypeResult = readFileSync(path.join(localRun, 'work/res/resg/signet_Geno'), 'utf8');
  const genotypeDone = readFileSync(path.join(remoteRun, 'steps/genotype.done'), 'utf8');
  const genotypeIntermediate = path.join(remoteRun, 'work/tmp/tmpg/impute/impute_Genotype.sizes');
  mkdirSync(path.dirname(genotypeIntermediate), {recursive: true});
  writeFileSync(genotypeIntermediate, '4 samples, 3 retained variants\n');
  const expressionPanel = '#lens-stage2';
  const expressionSubmit = `${expressionPanel} [data-expression-submit]`;
  const expressionStage = `[data-run-stage="2"][data-run-id="${runId}"]`;
  const expressionState = () => js(`document.querySelector(${JSON.stringify(expressionPanel)})?.dataset.expressionState`);
  const openExpression = async () => {
    await click(history);
    await until(() => js(`Boolean(document.querySelector(${JSON.stringify(row)})?.getClientRects().length)`),
      'The original run did not reappear in history');
    await click(row);
    await until(() => js(`Boolean(document.querySelector(${JSON.stringify(expressionStage)})?.getClientRects().length)`),
      'The same run did not offer its next expression stage');
    await click(expressionStage);
    await until(() => js(`Boolean(document.querySelector(${JSON.stringify(expressionPanel)})?.getClientRects().length)`),
      'History did not open Stage 2 in the existing run');
  };

  await openExpression();
  await until(() => js(`document.querySelector(${JSON.stringify(expressionSubmit)})?.disabled === false`),
    'Reviewing the same run did not enable Stage 2 submission');
  assert.equal(await js(`document.querySelector(${JSON.stringify(expressionPanel)}).dataset.expressionRunId`), runId);
  for (const [key, file] of Object.entries(fixture.expression_inputs)) {
    const selector = `${expressionPanel} [data-expression-input="${key}"]`;
    const rendered = await js(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      return input?.value || input?.textContent;
    })()`);
    assert.equal(rendered, file, `Stage 2 did not review the prepared ${key}`);
  }
  assert.equal(await js(`document.querySelector('[data-expression-setting="restrict.tcga"]').value`), '1');
  await setReviewValue('[data-expression-resource="cpus"]', '2');
  await setReviewValue('[data-expression-resource="hours"]', '1.5');
  assert.deepEqual(readFileSync(sbatchCalls, 'utf8').trim().split('\n'), ['submitted'],
    'Opening Stage 2 or editing its review submitted a job');
  assert.equal(readFileSync(stepJson, 'utf8'), genotypeRecord, 'Review changed the completed Stage 1 record');

  writeFileSync(path.join(fixture.slurm, 'sbatch_reply'), '222\n');
  writeFileSync(path.join(fixture.slurm, 'sacct'), '');
  writeFileSync(path.join(fixture.slurm, 'squeue'), 'PENDING\n');
  await js(`(() => {
    const button = document.querySelector(${JSON.stringify(expressionSubmit)});
    button.click();
    button.click();
  })()`);
  await until(async () => await expressionState() === 'pending', 'Stage 2 did not show its queued state');
  assert.deepEqual(readFileSync(sbatchCalls, 'utf8').trim().split('\n'), ['submitted', 'submitted'],
    'Stage 2 submitted more than one job');
  assert.deepEqual(readdirSync(path.join(fixture.project, 'runs')).sort(), ['step_test', runId].sort(),
    'Stage 2 created another run instead of extending the original');
  const expressionJson = path.join(localRun, 'steps/expression.json');
  const readExpression = () => JSON.parse(readFileSync(expressionJson, 'utf8'));
  assert.equal(readExpression().run_id, runId);
  assert.equal(readExpression().job_id, '222');
  assert.equal(readExpression().settings['restrict.tcga'], '1');
  assert.deepEqual(readExpression().inputs, fixture.expression_inputs);
  assert.equal(readExpression().resources.cpus, 2);
  assert.equal(readExpression().resources.hours, 1.5);
  assert.match(readFileSync(path.join(remoteRun, 'steps/expression.sbatch'), 'utf8'), /bash \.\/signet -t < \/dev\/null/);
  assert.equal(readFileSync(stepJson, 'utf8'), genotypeRecord, 'Submitting Stage 2 rewrote Stage 1 history');
  assert.equal(readFileSync(path.join(localRun, 'work/res/resg/signet_Geno'), 'utf8'), genotypeResult);
  assert.equal(readFileSync(path.join(remoteRun, 'work/res/resg/signet_Geno'), 'utf8'), genotypeResult);
  assert.equal(readFileSync(path.join(remoteRun, 'steps/genotype.done'), 'utf8'), genotypeDone);
  assert.equal(readFileSync(genotypeIntermediate, 'utf8'), '4 samples, 3 retained variants\n',
    'Stage 2 upload changed the original genotype intermediate needed by Stage 3');

  writeFileSync(path.join(fixture.slurm, 'squeue'), 'RUNNING\n');
  await until(async () => await expressionState() === 'running', 'Stage 2 polling did not show its running state');
  const expressionReload = once(window.webContents, 'did-finish-load');
  window.webContents.reload();
  await expressionReload;
  await until(() => js(`!!document.querySelector(${JSON.stringify(history)})`), 'Could not reload during Stage 2');
  await openExpression();
  await until(async () => await expressionState() === 'running', 'Stage 2 did not resume progress after reloading');
  assert.equal(await js(`document.querySelector(${JSON.stringify(expressionPanel)}).dataset.expressionRunId`), runId);
  assert.deepEqual(readFileSync(sbatchCalls, 'utf8').trim().split('\n'), ['submitted', 'submitted'],
    'Reloading the active Stage 2 replayed submission');

  const expressionResultPath = path.join(remoteRun, 'work/res/rest');
  mkdirSync(expressionResultPath, {recursive: true});
  const expressionMatrix = '1 2\n3 4\n5 6\n7 8\n';
  writeFileSync(path.join(expressionResultPath, 'signet_gexp'), expressionMatrix);
  writeFileSync(path.join(expressionResultPath, 'signet_gexpID'), sampleIds.join('\n') + '\n');
  writeFileSync(path.join(expressionResultPath, 'signet_gene_name'), 'GENE1\nMEGF6\n');
  writeFileSync(path.join(expressionResultPath, 'signet_gene_pos'), '1 100 200\n1 300 400\n');
  writeFileSync(path.join(remoteRun, 'steps/expression.done'), '0 2026-11-17T10:00:00\n');
  writeFileSync(path.join(fixture.slurm, 'sacct'), 'COMPLETED\n');
  writeFileSync(path.join(fixture.slurm, 'squeue'), '');
  await until(async () => await expressionState() === 'completed', 'Stage 2 polling did not collect completed results');
  assert.equal(readExpression().state, 'completed');
  assert.equal(readFileSync(path.join(localRun, 'work/res/rest/signet_gexp'), 'utf8'), expressionMatrix);
  assert.equal(readFileSync(stepJson, 'utf8'), genotypeRecord, 'Completing Stage 2 changed the Stage 1 record');
  await click(`${expressionPanel} [data-expression-history]`);
  await until(() => js(`Boolean(document.querySelector(${JSON.stringify(expressionStage)})?.getClientRects().length)`),
    'The completed expression run did not open its saved timeline');
  const expressionSavedInputs = await js(`[...document.querySelectorAll(${JSON.stringify(runDetail + ' .ml-run-inputs code')})]
    .map(node => node.textContent)`);
  for (const file of Object.values(fixture.expression_inputs)) assert.ok(expressionSavedInputs.includes(file));
  const completedReload = once(window.webContents, 'did-finish-load');
  window.webContents.reload();
  await completedReload;
  await until(() => js(`!!document.querySelector(${JSON.stringify(history)})`), 'Could not reopen completed Stage 2');
  await click(history);
  await until(() => js(`Boolean(document.querySelector(${JSON.stringify(row)})?.getClientRects().length)`),
    'The completed Stage 2 run was missing after reload');
  await click(row);
  await click(expressionStage);
  await until(() => js(`(() => {
    const panel = document.querySelector('#lens-history-stage');
    return panel?.dataset.runId === ${JSON.stringify(runId)} && panel.dataset.stage === '2' && panel.dataset.runState === 'ready';
  })()`), 'The completed Stage 2 result did not reopen from history');
  assert.equal(await js(`document.querySelector('#lens-history-stage [data-stage-setting="restrict.tcga"]')?.textContent`), '1');
  assert.equal(await js(`document.querySelector('#lens-history-stage [data-stage-resource="cpus"]')?.textContent`), '2');
  assert.equal(await js(`document.querySelector('#lens-history-stage [data-stage-resource="time"]')?.textContent`), '01:30:00');
  assert.ok(await js(`document.querySelector('#lens-history-stage [data-stage-table]').textContent.includes('MEGF6')`));
  assert.deepEqual(readFileSync(sbatchCalls, 'utf8').trim().split('\n'), ['submitted', 'submitted']);
  assert.equal(readFileSync(stepJson, 'utf8'), genotypeRecord);
  assert.equal(readFileSync(path.join(localRun, 'work/res/resg/signet_Geno'), 'utf8'), genotypeResult);
  const originalExpressionRecord = readFileSync(expressionJson, 'utf8');
  const adjustmentPanel = '#lens-stage3';
  const adjustmentStage = `[data-run-stage="3"][data-run-id="${runId}"]`;
  const adjustmentState = () => js(`document.querySelector(${JSON.stringify(adjustmentPanel)})?.dataset.adjustState`);
  async function openAdjustment() {
    await click(history);
    await until(() => js(`Boolean(document.querySelector(${JSON.stringify(row)})?.getClientRects().length)`),
      'The original run was missing while opening Stage 3');
    await click(row);
    await click(adjustmentStage);
  }
  await openAdjustment();
  await until(() => js(`document.querySelector('${adjustmentPanel} [data-adjust-submit]')?.disabled === false`),
    'Stage 3 clinical review did not enable its manual submit button');
  assert.ok(await js(`document.querySelector('${adjustmentPanel} [data-adjust-form]')?.getClientRects().length > 0`),
    'Stage 3 clinical file and principal component controls are hidden');
  assert.equal(await js(`document.querySelector('[data-adjust-input="cli.file"]').value`), fixture.adjust_inputs['cli.file']);
  assert.equal(await js(`document.querySelector('[data-adjust-option="npc"]').value`), '3');
  await setReviewValue('[data-adjust-option="npc"]', '2');
  await setReviewValue('[data-adjust-resource="cpus"]', '2');
  assert.deepEqual(readFileSync(sbatchCalls, 'utf8').trim().split('\n'), ['submitted', 'submitted'],
    'Reviewing Stage 3 submitted a job before the user clicked submit');

  writeFileSync(path.join(fixture.slurm, 'sbatch_reply'), '333\n');
  writeFileSync(path.join(fixture.slurm, 'sacct'), '');
  writeFileSync(path.join(fixture.slurm, 'squeue'), 'PENDING\n');
  await js(`(() => {
    const button = document.querySelector('${adjustmentPanel} [data-adjust-submit]');
    button.click(); button.click();
  })()`);
  await until(async () => await adjustmentState() === 'pending', 'Stage 3 did not show its queued state');
  const adjustmentJson = path.join(localRun, 'steps/adjust.json');
  const readAdjustment = () => JSON.parse(readFileSync(adjustmentJson, 'utf8'));
  assert.equal(readAdjustment().run_id, runId);
  assert.equal(readAdjustment().job_id, '333');
  assert.equal(readAdjustment().options.npc, 2);
  assert.deepEqual(readAdjustment().inputs, fixture.adjust_inputs);
  assert.deepEqual(readFileSync(sbatchCalls, 'utf8').trim().split('\n'), ['submitted', 'submitted', 'submitted']);
  writeFileSync(path.join(fixture.slurm, 'squeue'), 'RUNNING\n');
  await until(async () => await adjustmentState() === 'running', 'Stage 3 did not automatically report execution');
  const adjustmentReload = once(window.webContents, 'did-finish-load');
  window.webContents.reload();
  await adjustmentReload;
  await openAdjustment();
  await until(async () => await adjustmentState() === 'running', 'Stage 3 did not resume after reload');

  const adjustmentOutputs = path.join(remoteRun, 'work/res/resa');
  mkdirSync(adjustmentOutputs, {recursive: true});
  const files = {
    'signet_matched.gexp': expressionMatrix,
    'signet_new.Geno': genotypeResult,
    'signet_new.Geno.map': '1 SNP1 0 100 A G\n1 SNP2 0 200 A G\n1 SNP3 0 300 A G\n',
    'signet_new.Geno.maf': '0.1\n0.2\n0.3\n',
    'signet_gexp.data': '-1 -2\n0 0\n1 2\n',
    'signet_gexp_rmpc.data': '-0.5 -1\n0 0\n0.5 1\n',
    'signet_geno.data': '0 1 2\n2 1 0\n1 0 1\n',
    'workspace-clinical.tsv': readFileSync(fixture.adjust_inputs['cli.file'], 'utf8'),
    'workspace-genotype-ids.txt': sampleIds.join('\n') + '\n',
    'workspace-pca.evec': '#eigvals: 6 3 1\nTCGA-XX-A001 -1 0 0\nTCGA-XX-A002 0 1 0\nTCGA-XX-A003 1 -1 0\n',
    'workspace-pca.eval': '6\n3\n1\n',
  };
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(adjustmentOutputs, file), content);
  writeFileSync(path.join(remoteRun, 'steps/adjust.done'), '0 2026-11-17T12:00:00\n');
  writeFileSync(path.join(fixture.slurm, 'sacct'), 'COMPLETED\n');
  writeFileSync(path.join(fixture.slurm, 'squeue'), '');
  await until(async () => await adjustmentState() === 'completed', 'Stage 3 did not collect its completed outputs');
  assert.equal(readAdjustment().state, 'completed');
  await until(() => js(`document.querySelector('#lens-history-stage3')?.dataset.runState === 'ready'`),
    'Completed Stage 3 did not show its actual saved results');
  assert.equal(await js(`document.querySelector('#lens-history-stage3 [data-s3-components]').textContent`), '2');
  for (const [key, expected] of Object.entries({genotype:4, expression:4, matched:4, retained:3, excluded:1, variants:3, genes:2})) {
    assert.equal(Number(await js(`document.querySelector('#lens-history-stage3 [data-s3-count="${key}"]').textContent`)), expected);
  }
  assert.equal(await js(`document.querySelectorAll('#lens-history-stage3 .s3-points circle').length`), 3);
  assert.ok(await js(`document.querySelector('#lens-history-stage3 [data-s3-difference]').textContent.includes('0.75000')`));

  const finishedAdjustmentReload = once(window.webContents, 'did-finish-load');
  window.webContents.reload();
  await finishedAdjustmentReload;
  await openAdjustment();
  await until(() => js(`document.querySelector('#lens-history-stage3')?.dataset.runState === 'ready'`),
    'Completed Stage 3 did not reopen after reload');
  assert.equal(readFileSync(stepJson, 'utf8'), genotypeRecord);
  assert.equal(readFileSync(expressionJson, 'utf8'), originalExpressionRecord);
  assert.equal(readFileSync(path.join(localRun, 'work/res/resg/signet_Geno'), 'utf8'), genotypeResult);
  assert.equal(readFileSync(path.join(localRun, 'work/res/rest/signet_gexp'), 'utf8'), expressionMatrix);
  assert.deepEqual(readFileSync(sbatchCalls, 'utf8').trim().split('\n'), ['submitted', 'submitted', 'submitted']);
  assert.deepEqual(readdirSync(path.join(fixture.project, 'runs')).sort(), ['step_test', runId].sort());
  console.log('PASS: manual same-run Stages 1–3, live polling, active/completed reload, immutable prior stages, and actual-shaped PCA/matching/comparison');
  await running.quit();
}

verify().catch(async error => {
  console.error(error);
  if (running) await running.backend.forceStop();
  rmSync(temp, {recursive: true, force: true});
  app.exit(1);
});
