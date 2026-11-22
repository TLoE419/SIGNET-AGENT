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
  console.error('Workspace manual stages test timed out');
  await running?.backend.forceStop();
  rmSync(temp, {recursive: true, force: true});
  app.exit(1);
}, 300000);
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
  running = await launch({provider: 'none', visible: false, userData: path.join(temp, 'app'),
    stateFile: path.join(temp, 'chat', 'state.json')});
  assert.ok(running);
  const {window} = running;
  const fixture = JSON.parse(readFileSync(metadataPath, 'utf8'));
  const sbatchCalls = path.join(fixture.slurm, 'sbatch_calls');
  const js = source => window.webContents.executeJavaScript(source);
  const click = selector => js(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) throw Error('The requested control is missing');
    if (target instanceof HTMLElement) target.click();
    else target.dispatchEvent(new MouseEvent('click', {bubbles:true}));
  })(); true`);
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
  assert.equal(await js('document.documentElement.lang'), 'en');
  assert.equal(await js(`Boolean(document.querySelector('#ml-language'))`), false);
  await click('#ml-stage-tab');
  await click('[data-stage="1"]');
  await until(() => js(`Boolean(document.querySelector(${JSON.stringify(review)}))`), 'Review control did not mount');
  await until(() => js(`document.querySelector(${JSON.stringify(submit)})?.disabled === false`),
    'Prepared chr1 input review did not enable submit');
  assert.equal(await js(`document.querySelector(${JSON.stringify(submit)}).textContent`), 'Submit Stage 1');

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
  assert.equal(existsSync(path.join(localRun, 'work/res/resg/signet_Geno')), false);

  const historyId = 'workspace--' + runId;
  const runDetail = `#ml-run-${historyId}`;
  const selectStage = stage => click(`${runDetail} [data-history-select-stage="${stage}"]`);
  const stageAction = stage => `${runDetail} [data-run-stage="${stage}"]`;
  const openStage = async stage => {
    await selectStage(stage);
    await click(stageAction(stage));
  };
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
  const row = `[data-run-target="${historyId}"]`;
  await until(() => js(`Boolean(document.querySelector(${JSON.stringify(row)})?.getClientRects().length)`),
    'The completed run was missing from history after reload');
  await click(row);
  await openStage(1);
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
  const genotypeResult = readFileSync(path.join(remoteRun, 'work/res/resg/signet_Geno'), 'utf8');
  const genotypeDone = readFileSync(path.join(remoteRun, 'steps/genotype.done'), 'utf8');
  mkdirSync(path.join(remoteRun, 'work/tmp/tmpg'), {recursive:true});
  writeFileSync(path.join(remoteRun, 'work/tmp/tmpg/clean_Genotype.fam'), sampleIds.map(id => `${id} ${id} 0 0 1 -9`).join('\n') + '\n');
  const genotypeIntermediate = path.join(remoteRun, 'work/tmp/tmpg/impute/impute_Genotype.sizes');
  mkdirSync(path.dirname(genotypeIntermediate), {recursive: true});
  writeFileSync(genotypeIntermediate, '4 samples, 3 retained variants\n');
  const expressionPanel = '#lens-stage2';
  const expressionSubmit = `${expressionPanel} [data-expression-submit]`;
  const expressionStage = stageAction(2);
  const expressionState = () => js(`document.querySelector(${JSON.stringify(expressionPanel)})?.dataset.expressionState`);
  const openExpression = async () => {
    await click(history);
    await until(() => js(`Boolean(document.querySelector(${JSON.stringify(row)})?.getClientRects().length)`),
      'The original run did not reappear in history');
    await click(row);
    await selectStage(2);
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
      return input?.querySelector('[data-full-file-path]')?.textContent ?? input?.textContent;
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
  assert.equal(existsSync(path.join(localRun, 'work/res/resg/signet_Geno')), false, 'Individual genotype results must remain remote');
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
  const expressionMatrix = '1 2 2\n3 4 4\n5 6 6\n7 8 8\n';
  writeFileSync(path.join(expressionResultPath, 'signet_gexp'), expressionMatrix);
  writeFileSync(path.join(expressionResultPath, 'signet_gexpID'), sampleIds.join('\n') + '\n');
  writeFileSync(path.join(expressionResultPath, 'signet_gene_name'), 'GENE1\nMEGF6\nOTHER\n');
  writeFileSync(path.join(expressionResultPath, 'signet_gene_pos'), 'GENE1 chr1 100 200\nMEGF6 chr1 300 400\nOTHER chr1 500 600\n');
  writeFileSync(path.join(remoteRun, 'steps/expression.done'), '0 2026-11-17T10:00:00\n');
  writeFileSync(path.join(fixture.slurm, 'sacct'), 'COMPLETED\n');
  writeFileSync(path.join(fixture.slurm, 'squeue'), '');
  await until(async () => await expressionState() === 'completed', 'Stage 2 polling did not collect completed results');
  assert.equal(readExpression().state, 'completed');
  assert.equal(existsSync(path.join(localRun, 'work/res/rest/signet_gexp')), false, 'Individual expression results must remain remote');
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
  await openStage(2);
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
  assert.equal(existsSync(path.join(localRun, 'work/res/resg/signet_Geno')), false, 'Individual genotype results must remain remote');
  const originalExpressionRecord = readFileSync(expressionJson, 'utf8');
  const adjustmentPanel = '#lens-stage3';
  const adjustmentState = () => js(`document.querySelector(${JSON.stringify(adjustmentPanel)})?.dataset.adjustState`);
  async function openAdjustment() {
    await click(history);
    await until(() => js(`Boolean(document.querySelector(${JSON.stringify(row)})?.getClientRects().length)`),
      'The original run was missing while opening Stage 3');
    await click(row);
    await openStage(3);
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
    'signet_gexp.data': '-1 -2 -2\n0 0 0\n1 2 2\n',
    'signet_gexp_rmpc.data': '-0.5 -1 -0.75\n0 0 0\n0.5 1 0.75\n',
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
  for (const [key, expected] of Object.entries({genotype:4, expression:4, matched:4, retained:3, excluded:1, variants:3, genes:3})) {
    assert.equal(Number(await js(`document.querySelector('#lens-history-stage3 [data-s3-count="${key}"]').textContent`)), expected);
  }
  assert.equal(await js(`document.querySelectorAll('#lens-history-stage3 .s3-points circle').length`), 0);
  await until(() => js(`(()=>{const image=document.querySelector('#lens-history-stage3 .s3-remote-plot');return image&&!image.hidden&&image.complete&&image.naturalWidth===640})()`), 'The remotely rendered PCA image was blocked or did not load');
  assert.equal(existsSync(path.join(localRun, 'work/res/resa/workspace-pca.evec')), false);
  assert.ok(await js(`document.querySelector('#lens-history-stage3 [data-s3-difference]').textContent.includes('0.75000')`));

  const finishedAdjustmentReload = once(window.webContents, 'did-finish-load');
  window.webContents.reload();
  await finishedAdjustmentReload;
  await openAdjustment();
  await until(() => js(`document.querySelector('#lens-history-stage3')?.dataset.runState === 'ready'`),
    'Completed Stage 3 did not reopen after reload');
  assert.equal(readFileSync(stepJson, 'utf8'), genotypeRecord);
  assert.equal(readFileSync(expressionJson, 'utf8'), originalExpressionRecord);
  assert.equal(existsSync(path.join(localRun, 'work/res/resg/signet_Geno')), false, 'Individual genotype results must remain remote');
  assert.equal(existsSync(path.join(localRun, 'work/res/rest/signet_gexp')), false, 'Individual expression results must remain remote');
  assert.deepEqual(readFileSync(sbatchCalls, 'utf8').trim().split('\n'), ['submitted', 'submitted', 'submitted']);
  assert.deepEqual(readdirSync(path.join(fixture.project, 'runs')).sort(), ['step_test', runId].sort());
  const originalAdjustmentRecord = readFileSync(adjustmentJson, 'utf8');
  const originalAdjustedExpression = readFileSync(path.join(remoteRun, 'work/res/resa/signet_gexp_rmpc.data'), 'utf8');
  const cisPanel = '#lens-stage4';
  const cisState = () => js(`document.querySelector('${cisPanel}')?.dataset.cisState`);
  async function openCis() {
    await click(history);
    await until(() => js(`Boolean(document.querySelector(${JSON.stringify(row)})?.getClientRects().length)`),
      'The original run was missing while opening Stage 4');
    await click(row);
    await openStage(4);
  }
  await openCis();
  await until(() => js(`document.querySelector('${cisPanel} [data-cis-submit]')?.disabled === false`),
    'Stage 4 input review did not enable manual submission');
  assert.ok(await js(`document.querySelector('${cisPanel} [data-cis-form]')?.getClientRects().length > 0`));
  assert.equal(await js(`document.querySelector('[data-cis-setting="alpha.cis"]').value`), '0.05');
  for (const [key, value] of Object.entries({'alpha.cis':'0.01', upstream:'2000', downstream:'500', nperms:'200'})) {
    await setReviewValue(`[data-cis-setting="${key}"]`, value);
  }
  await setReviewValue('[data-cis-resource="cpus"]', '2');
  assert.deepEqual(readFileSync(sbatchCalls, 'utf8').trim().split('\n'), ['submitted', 'submitted', 'submitted'],
    'Reviewing Stage 4 submitted before confirmation');
  writeFileSync(path.join(fixture.slurm, 'sbatch_reply'), '444\n');
  writeFileSync(path.join(fixture.slurm, 'sacct'), '');
  writeFileSync(path.join(fixture.slurm, 'squeue'), 'PENDING\n');
  await js(`(() => {
    const button = document.querySelector('${cisPanel} [data-cis-submit]');
    button.click(); button.click();
  })()`);
  await until(async () => await cisState() === 'pending', 'Stage 4 did not show its queued state');
  const cisJson = path.join(localRun, 'steps/cis.json');
  const readCis = () => JSON.parse(readFileSync(cisJson, 'utf8'));
  assert.equal(readCis().run_id, runId);
  assert.equal(readCis().job_id, '444');
  assert.deepEqual(readCis().settings, {'alpha.cis':'0.01', nperms:'200', upstream:'2000', downstream:'500'});
  assert.deepEqual(readFileSync(sbatchCalls, 'utf8').trim().split('\n'), Array(4).fill('submitted'));
  writeFileSync(path.join(fixture.slurm, 'squeue'), 'RUNNING\n');
  await until(async () => await cisState() === 'running', 'Stage 4 polling did not report execution');
  const cisReload = once(window.webContents, 'did-finish-load');
  window.webContents.reload();
  await cisReload;
  await openCis();
  await until(async () => await cisState() === 'running', 'Stage 4 did not resume after reload');
  assert.deepEqual(readFileSync(sbatchCalls, 'utf8').trim().split('\n'), Array(4).fill('submitted'));
  const cisOutput = path.join(remoteRun, 'work/res/resc');
  mkdirSync(cisOutput, {recursive: true});
  const cisFiles = {
    'signet_all.sig.pValue_0.01': '1 1 0.001\n2 2 0.009\n1 3 0.002\n2 4 0.004\n',
    'signet_common.eQTL.data': '0 1\n1 0\n2 1\n',
    'signet_low.eQTL.data': '0\n1\n0\n',
    'signet_rare.eQTL.data': '1\n0\n0\n',
    'signet_all.eQTL.data': '0 1 0 1\n1 0 1 0\n2 1 0 0\n',
    'signet_net.gexp.data': files['signet_gexp.data'],
    'signet_net.genepos': 'GENE1 chr1 100 200\nMEGF6 chr1 300 400\nOTHER chr1 500 600\n',
    'signet_net.genename': 'GENE1\nMEGF6\nOTHER\n',
  };
  for (const [name, content] of Object.entries(cisFiles)) writeFileSync(path.join(cisOutput, name), content);
  writeFileSync(path.join(remoteRun, 'steps/cis.done'), '0 2026-11-17T14:00:00\n');
  writeFileSync(path.join(fixture.slurm, 'sacct'), 'COMPLETED\n');
  writeFileSync(path.join(fixture.slurm, 'squeue'), '');
  await until(async () => await cisState() === 'completed', 'Stage 4 did not collect completed results');
  await until(() => js(`(() => {
    const panel = document.querySelector('#lens-history-stage');
    return panel.dataset.stage === '4' && panel.dataset.runState === 'ready';
  })()`), 'Stage 4 did not open its completed association result');
  assert.equal(await js(`document.querySelectorAll('#lens-history-stage [data-stage-table] tbody tr').length`), 4);
  const bars = await js(`[...document.querySelectorAll('#lens-history-stage .ml-count-label')].map(n => Number(n.textContent))`);
  assert.deepEqual(bars, [2, 1, 1]);
  for (const [key, expected] of Object.entries({'alpha.cis':'0.01', nperms:'200', upstream:'2000', downstream:'500'})) {
    assert.equal(await js(`document.querySelector('#lens-history-stage [data-stage-setting="${key}"]').textContent`), expected);
  }
  const cisFinishedReload = once(window.webContents, 'did-finish-load');
  window.webContents.reload();
  await cisFinishedReload;
  await openCis();
  await until(() => js(`document.querySelector('#lens-history-stage')?.dataset.runState === 'ready'`),
    'Stage 4 associations did not reopen from saved history');
  assert.ok(await js(`document.querySelector('#lens-history-stage [data-stage-table]').textContent.includes('MEGF6')`));
  assert.equal(readFileSync(stepJson, 'utf8'), genotypeRecord);
  assert.equal(readFileSync(expressionJson, 'utf8'), originalExpressionRecord);
  assert.equal(readFileSync(adjustmentJson, 'utf8'), originalAdjustmentRecord);
  assert.equal(readFileSync(path.join(remoteRun, 'work/res/resa/signet_gexp_rmpc.data'), 'utf8'), originalAdjustedExpression);
  assert.equal(existsSync(path.join(localRun, 'work/res/resa/signet_gexp_rmpc.data')), false);
  assert.deepEqual(readFileSync(sbatchCalls, 'utf8').trim().split('\n'), Array(4).fill('submitted'));
  assert.deepEqual(readdirSync(path.join(fixture.project, 'runs')).sort(), ['step_test', runId].sort());
  const originalCisRecord = readFileSync(cisJson, 'utf8');
  const networkPanel = '#lens-stage5';
  const networkState = () => js(`document.querySelector('${networkPanel}')?.dataset.networkState`);
  async function openNetwork() {
    await click(history);
    await until(() => js(`Boolean(document.querySelector(${JSON.stringify(row)})?.getClientRects().length)`),
      'The original run was missing while opening Stage 5');
    await click(row);
    await openStage(5);
  }
  await openNetwork();
  await until(() => js(`document.querySelector('${networkPanel} [data-network-submit]')?.disabled === false`),
    'Stage 5 review did not enable manual submission');
  assert.ok(await js(`document.querySelector('${networkPanel} [data-network-form]')?.getClientRects().length > 0`));
  assert.equal(await js(`document.querySelector('[data-network-setting="nboots"]').value`), '100');
  for (const [key, value] of Object.entries({nboots:'2', cor:'0.25', ncores:'4', memory:'8', walltime:'1:30:00'})) {
    await setReviewValue(`[data-network-setting="${key}"]`, value);
  }
  await setReviewValue('[data-network-resource="hours"]', '3');
  assert.deepEqual(readFileSync(sbatchCalls, 'utf8').trim().split('\n'), Array(4).fill('submitted'));
  writeFileSync(path.join(fixture.slurm, 'sbatch_reply'), '555\n');
  writeFileSync(path.join(fixture.slurm, 'sacct'), '');
  writeFileSync(path.join(fixture.slurm, 'squeue'), 'PENDING\n');
  await js(`(() => {
    const button = document.querySelector('${networkPanel} [data-network-submit]');
    button.click(); button.click();
  })()`);
  await until(async () => await networkState() === 'pending', 'Stage 5 did not show its queued state');
  const networkJson = path.join(localRun, 'steps/network.json');
  const readNetwork = () => JSON.parse(readFileSync(networkJson, 'utf8'));
  assert.equal(readNetwork().run_id, runId);
  assert.equal(readNetwork().job_id, '555');
  assert.deepEqual(readNetwork().settings, {nboots:'2', ncis:'3', cor:'0.25', ncores:'4', memory:'8', walltime:'1:30:00'});
  assert.equal(readNetwork().resources.hours, 3);
  assert.match(readFileSync(path.join(remoteRun, 'steps/network.sbatch'), 'utf8'), /bash \.\/signet -n/);
  assert.deepEqual(readFileSync(sbatchCalls, 'utf8').trim().split('\n'), Array(5).fill('submitted'));
  for (const [phase, completed] of [['stage1', 'one\n'], ['stage2', '']]) {
    const directory = path.join(remoteRun, 'work/tmp/tmpn', phase);
    mkdirSync(directory, {recursive:true});
    writeFileSync(path.join(directory, 'params.txt'), 'first\nsecond\n');
    writeFileSync(path.join(directory, 'params1.txt.completed'), completed);
  }
  writeFileSync(path.join(fixture.slurm, 'squeue'), 'RUNNING\n');
  await until(async () => await networkState() === 'running', 'Stage 5 did not automatically report execution');
  assert.deepEqual(readNetwork().progress, {stage1:'1 2', stage2:'0 2'});
  assert.ok(await js(`document.querySelector('${networkPanel} [data-network-work-progress]')?.getClientRects().length > 0`),
    'Stage 5 internal calculation progress is hidden');
  const networkReload = once(window.webContents, 'did-finish-load');
  window.webContents.reload();
  await networkReload;
  await openNetwork();
  await until(async () => await networkState() === 'running', 'Stage 5 did not resume after reload');
  const networkOutput = path.join(remoteRun, 'work/res/resn');
  mkdirSync(networkOutput, {recursive:true});
  writeFileSync(path.join(networkOutput, 'signet_Afreq'), '0,0.5\n1,0\n0.5,0\n');
  writeFileSync(path.join(networkOutput, 'signet_CoeffMat0'), '0,0.2\n-0.4,0\n0.1,0\n');
  writeFileSync(path.join(networkOutput, 'signet_net.genepos'), cisFiles['signet_net.genepos']);
  writeFileSync(path.join(remoteRun, 'steps/network.done'), '0 2026-11-17T15:00:00\n');
  writeFileSync(path.join(fixture.slurm, 'sacct'), 'COMPLETED\n');
  writeFileSync(path.join(fixture.slurm, 'squeue'), '');
  await until(async () => await networkState() === 'completed', 'Stage 5 did not collect completed matrices');
  await until(() => js(`(() => {
    const panel = document.querySelector('#lens-history-stage');
    return panel.dataset.stage === '5' && panel.dataset.runState === 'ready';
  })()`), 'Stage 5 did not display candidate edges from its saved matrices');
  const candidates = await js(`[...document.querySelectorAll('#lens-history-stage [data-stage-table] tbody tr')]
    .map(row => [...row.cells].map(cell => cell.textContent))`);
  assert.deepEqual(candidates, [['MEGF6','GENE1','50%'], ['GENE1','MEGF6','100%'], ['GENE1','OTHER','50%']]);
  assert.deepEqual(await js(`[...document.querySelectorAll('#lens-history-stage .ml-count-label')].map(n => Number(n.textContent))`), [2,1]);
  assert.equal(await js(`document.querySelector('#lens-history-stage [data-stage-setting="nboots"]').textContent`), '2');
  assert.equal(await js(`document.querySelector('#lens-history-stage [data-stage-setting="walltime"]').textContent`), '1:30:00');
  const networkFinishedReload = once(window.webContents, 'did-finish-load');
  window.webContents.reload();
  await networkFinishedReload;
  await openNetwork();
  await until(() => js(`document.querySelector('#lens-history-stage')?.dataset.runState === 'ready'`),
    'Stage 5 candidates did not reopen from saved history');
  assert.equal(readFileSync(stepJson, 'utf8'), genotypeRecord);
  assert.equal(readFileSync(expressionJson, 'utf8'), originalExpressionRecord);
  assert.equal(readFileSync(adjustmentJson, 'utf8'), originalAdjustmentRecord);
  assert.equal(readFileSync(cisJson, 'utf8'), originalCisRecord);
  assert.equal(readFileSync(path.join(remoteRun, 'work/res/resa/signet_gexp_rmpc.data'), 'utf8'), originalAdjustedExpression);
  assert.equal(existsSync(path.join(localRun, 'work/res/resa/signet_gexp_rmpc.data')), false);
  assert.deepEqual(readFileSync(sbatchCalls, 'utf8').trim().split('\n'), Array(5).fill('submitted'));
  assert.deepEqual(readdirSync(path.join(fixture.project, 'runs')).sort(), ['step_test',runId].sort());
  const originalNetworkRecord = readFileSync(networkJson, 'utf8');
  const visualizationPanel = '#lens-stage6-run';
  const visualizationState = () => js(`document.querySelector('${visualizationPanel}')?.dataset.visualizeState`);
  async function openVisualization() {
    await click(history);
    await until(() => js(`Boolean(document.querySelector(${JSON.stringify(row)})?.getClientRects().length)`),
      'The original run was missing while opening Stage 6');
    await click(row);
    await openStage(6);
  }
  await openVisualization();
  await until(() => js(`!!document.querySelector('${visualizationPanel} [data-visualize-review]:not(:disabled)')`),
    'Stage 6 review did not settle');
  assert.ok(await js(`document.querySelector('${visualizationPanel} [data-visualize-form]')?.getClientRects().length > 0`));
  await setReviewValue('[data-visualize-setting="freq"]', '0.45');
  await setReviewValue('[data-visualize-setting="ntop"]', '1');
  await click(`${visualizationPanel} [data-visualize-review]`);
  await until(() => js(`document.querySelector('${visualizationPanel} [data-visualize-submit]')?.disabled === false`),
    'Stage 6 did not validate the requested frequency and subnetwork count');
  assert.deepEqual(readFileSync(sbatchCalls, 'utf8').trim().split('\n'), Array(5).fill('submitted'));
  writeFileSync(path.join(fixture.slurm, 'sbatch_reply'), '666\n');
  writeFileSync(path.join(fixture.slurm, 'sacct'), '');
  writeFileSync(path.join(fixture.slurm, 'squeue'), 'PENDING\n');
  await js(`(() => {
    const button = document.querySelector('${visualizationPanel} [data-visualize-submit]');
    button.click(); button.click();
  })()`);
  await until(async () => await visualizationState() === 'pending', 'Stage 6 did not show its queued state');
  const visualizationJson = path.join(localRun, 'steps/visualize.json');
  const readVisualization = () => JSON.parse(readFileSync(visualizationJson, 'utf8'));
  assert.equal(readVisualization().run_id, runId);
  assert.equal(readVisualization().job_id, '666');
  assert.deepEqual(readVisualization().settings, {freq:'0.45', ntop:'1'});
  assert.deepEqual(readFileSync(sbatchCalls, 'utf8').trim().split('\n'), Array(6).fill('submitted'));
  const visualizationScript = readFileSync(path.join(remoteRun, 'steps/visualize.sbatch'), 'utf8');
  assert.match(visualizationScript, /bash \.\/signet -v/);
  assert.match(visualizationScript, /cloud=T/);
  writeFileSync(path.join(fixture.slurm, 'squeue'), 'RUNNING\n');
  await until(async () => await visualizationState() === 'running', 'Stage 6 did not report automatic execution');
  const visualizationReload = once(window.webContents, 'did-finish-load');
  window.webContents.reload();
  await visualizationReload;
  await openVisualization();
  await until(async () => await visualizationState() === 'running', 'Stage 6 did not resume after reload');

  const edgeCsv = 'source_gene_symbol,target_gene_symbol,frequency,coefficient\n'
    + 'MEGF6,GENE1,0.5,0.2\nGENE1,MEGF6,1,-0.4\nGENE1,OTHER,0.5,0.1\n';
  for (const relative of readVisualization().required_outputs) {
    const target = path.join(remoteRun, 'work', relative);
    mkdirSync(path.dirname(target), {recursive:true});
    const content = (relative.includes('_edgelist_') || relative.endsWith('signet-edges.csv')) ? edgeCsv
      : relative.endsWith('_name.txt') ? 'GENE1\nMEGF6\nOTHER\n'
      : relative.endsWith('.pdf') ? '%PDF-1.4\nlocal scientific export fixture\n'
      : relative.endsWith('.eps') ? '%!PS-Adobe-3.0 EPSF-3.0\nlocal scientific export fixture\n'
      : relative.endsWith('.html') ? '<html><body>visNetwork fixture</body></html>\n' : 'saved export\n';
    writeFileSync(target, content);
  }
  writeFileSync(path.join(remoteRun, 'steps/visualize.out'), 'SIGNET_STAGE6_EXPORTS_COMPLETED\n');
  writeFileSync(path.join(remoteRun, 'steps/visualize.done'), '0 2026-11-17T16:00:00\n');
  writeFileSync(path.join(fixture.slurm, 'sacct'), 'COMPLETED\n');
  writeFileSync(path.join(fixture.slurm, 'squeue'), '');
  await until(async () => await visualizationState() === 'completed', 'Stage 6 did not verify and collect its exports');
  await openVisualization();
  const graphReady = () => js(`(() => {
    const panel = document.querySelector('#lens-stage6');
    return panel.dataset.runState === 'ready' && panel.dataset.runId === ${JSON.stringify(runId)} && panel.getClientRects().length > 0;
  })()`);
  await until(graphReady, 'The completed Stage 6 graph did not open from the same run history');
  assert.equal(await js(`document.querySelectorAll('#lens-stage6 [data-gene]').length`), 3);
  assert.equal(await js(`document.querySelectorAll('#lens-stage6 tbody tr').length`), 3);
  await click('#lens-stage6 [data-gene="MEGF6"]');
  assert.equal(await js(`document.querySelectorAll('#lens-stage6 tbody tr').length`), 2);
  const megf6Rows = await js(`[...document.querySelectorAll('#lens-stage6 tbody tr')].map(row => [...row.cells].slice(0,2).map(cell => cell.textContent))`);
  assert.ok(megf6Rows.every(cells => cells.includes('MEGF6')));

  await click('#ml-stage6-back');
  await openStage(3);
  await until(() => js(`document.querySelector('#lens-history-stage3')?.dataset.runState === 'ready'`),
    'Earlier Stage 3 did not reopen after viewing the live Stage 6 graph');
  await click('#ml-stage3-back');
  await openStage(6);
  await until(graphReady, 'Stage 6 graph did not reopen after an earlier stage');
  assert.equal(await js(`document.querySelector('#lens-stage6').dataset.selectedGene`), 'MEGF6');
  assert.equal(await js(`document.querySelectorAll('#lens-stage6 tbody tr').length`), 2);
  const visualizationFinishedReload = once(window.webContents, 'did-finish-load');
  window.webContents.reload();
  await visualizationFinishedReload;
  await openVisualization();
  await until(graphReady, 'Saved Stage 6 graph did not reopen after reload');
  await click('#lens-stage6 [data-gene="MEGF6"]');
  assert.equal(await js(`document.querySelectorAll('#lens-stage6 tbody tr').length`), 2);
  assert.equal(readFileSync(stepJson, 'utf8'), genotypeRecord);
  assert.equal(readFileSync(expressionJson, 'utf8'), originalExpressionRecord);
  assert.equal(readFileSync(adjustmentJson, 'utf8'), originalAdjustmentRecord);
  assert.equal(readFileSync(cisJson, 'utf8'), originalCisRecord);
  assert.equal(readFileSync(networkJson, 'utf8'), originalNetworkRecord);
  assert.deepEqual(readFileSync(sbatchCalls, 'utf8').trim().split('\n'), Array(6).fill('submitted'));
  assert.deepEqual(readdirSync(path.join(fixture.project, 'runs')).sort(), ['step_test',runId].sort());
  console.log('PASS: manual same-run Stages 1–6, progress/reload, preserved prior stages, actual export graph, and MEGF6-only linked table');
  await running.quit();
}

verify().catch(async error => {
  console.error(error);
  if (running) await running.backend.forceStop();
  rmSync(temp, {recursive: true, force: true});
  app.exit(1);
});
