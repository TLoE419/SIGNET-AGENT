'use strict';

// Original staging/reference code and batch scripts run against a local fake
// scheduler/container only. No real SSH, Slurm, R or SIGNET analysis is used.
const assert = require('node:assert/strict');
const {promisify} = require('node:util');
const {execFile} = require('node:child_process');
const {once} = require('node:events');
const {createHash} = require('node:crypto');
const {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app} = require('electron');
const {Backend} = require('../main/backend/backend.cjs');
const {launch} = require('../main/app/main.cjs');

const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'signet-genotype-retry-')));
app.setPath('appData', temporary);
const repo = path.resolve(__dirname, '../..');
const wrapper = path.join(temporary, 'python-fixture');
process.env.SIGNET_RETRY_ROOT = temporary;
process.env.SIGNET_RETRY_PYTHON = process.env.SIGNET_PYTHON || path.join(repo, '.venv/bin/python');
process.env.SIGNET_RETRY_ENTRY = path.join(__dirname, 'fixtures/genotype_retry_backend.py');
writeFileSync(wrapper, '#!/bin/sh\nexec "$SIGNET_RETRY_PYTHON" "$SIGNET_RETRY_ENTRY" "$@"\n', {mode: 0o700});
process.env.SIGNET_PYTHON = wrapper;
let running;
let replacement;
const deadline = setTimeout(async () => {
  console.error('Same-run genotype retry integration test timed out');
  await replacement?.forceStop(); await running?.backend.forceStop(); app.exit(1);
}, 180000);
app.on('will-quit', () => {clearTimeout(deadline); rmSync(temporary, {recursive: true, force: true});});

async function until(check, description, timeout = 25000) {
  const end = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < end);
  throw Error(typeof description === 'function' ? await description() : description);
}

const digest = filename => createHash('sha256').update(readFileSync(filename)).digest('hex');
function tree(folder) {
  const files = {};
  function visit(directory) {
    for (const item of readdirSync(directory, {withFileTypes: true})) {
      const filename = path.join(directory, item.name);
      if (item.isDirectory()) visit(filename);
      else files[path.relative(folder, filename)] = digest(filename);
    }
  }
  visit(folder);
  return files;
}

async function verify() {
  running = await launch({provider: 'codex', visible: false, userData: path.join(temporary, 'app'),
    stateFile: path.join(temporary, 'chat.json')});
  const {window} = running;
  const fixturePath = path.join(temporary, 'fixture.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const [datasetA, datasetB] = fixture.datasets;
  const runId = fixture.run_id;
  const local = path.join(fixture.project, 'runs', runId);
  const remote = path.join(fixture.remote, runId);
  const initialSnapshot = readFileSync(path.join(local, 'workspace-genotype.json'));
  const initialRecord = readFileSync(path.join(local, 'steps/genotype.json'));
  const firstRecord = JSON.parse(initialRecord);
  const firstLocalLogs = Object.fromEntries(['out', 'err', 'job'].map(suffix => [suffix, readFileSync(path.join(local, 'steps/genotype.' + suffix))]));
  const firstRemoteLogs = Object.fromEntries(['out', 'err', 'job', 'done', 'sbatch'].map(suffix => [suffix, readFileSync(path.join(remote, 'steps/genotype.' + suffix))]));
  const firstFrozen = tree(path.join(remote, 'inputs/frozen'));
  const firstPrepared = tree(path.join(remote, 'inputs/prepared'));
  const firstLocalResults = tree(path.join(local, 'work/res/resg'));
  const firstRemoteResults = tree(path.join(remote, 'work/res/resg'));
  const originals = [...fixture.datasets.flatMap(dataset => Object.values(dataset.inputs).flat()), fixture.reference, fixture.genetic_map, fixture.annotation];
  const fingerprints = Object.fromEntries(originals.map(filename => [filename, digest(filename)]));
  const submissions = () => existsSync(path.join(fixture.slurm, 'sbatch_calls'))
    ? readFileSync(path.join(fixture.slurm, 'sbatch_calls'), 'utf8').trim().split('\n').filter(Boolean) : [];
  const js = async source => {
    const result = await window.webContents.executeJavaScript(`(async () => {
      try{return {value:await (${source})};}catch(error){return {error:error.stack||String(error)};}
    })()`);
    if (result.error) throw Error(result.error + '\nGenotype retry expression: ' + source.slice(0, 500));
    return result.value;
  };
  const click = selector => js(`(() => {const control=document.querySelector(${JSON.stringify(selector)});
    if(!control?.getClientRects().length)throw Error('Missing visible retry control: '+${JSON.stringify(selector)});control.click();})()`);
  const request = (url, body, method = body ? 'POST' : 'GET') => js(`fetch(${JSON.stringify(url)},{method:${JSON.stringify(method)},
    headers:{'Content-Type':'application/json','X-Chat-Token':document.querySelector('meta[name="chat-token"]').content},
    body:${JSON.stringify(body ? JSON.stringify(body) : undefined)}}).then(async response=>({status:response.status,value:await response.json()}))`);
  const geometry = () => js(`(() => {const root=document.querySelector('.ml-app');return [root.offsetWidth,root.offsetHeight,
    root.querySelector('.ml-rail').offsetWidth,root.querySelector('.ml-chat').offsetWidth];})()`);
  const connection = () => js(`window.dispatchEvent(new CustomEvent('workspace-remote-context',{detail:{connected:true,
    identity:'isolated-genotype-retry',environmentKey:'same-owned-local-scheduler'}}))`);
  const state = () => js(`document.querySelector('#lens-stage1').dataset.genotypeState`);
  const selectDataset = async id => {
    await click('[data-nav-target="data"]');
    await until(() => js(`[...document.querySelector('#ml-dataset-select').options].some(option=>option.value===${JSON.stringify(id)})`), 'Dataset catalog did not mount');
    await js(`(() => {const picker=document.querySelector('#ml-dataset-select');picker.value=${JSON.stringify(id)};
      picker.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  };
  const openRun = async () => {
    await click('[data-nav-target="history"]');
    const key = 'workspace--' + runId;
    await until(() => js(`!!document.querySelector('[data-run-target="${key}"]')?.getClientRects().length`), 'The original retry run disappeared from history');
    await click(`[data-run-target="${key}"]`);
  };
  const openStage = async () => {
    await openRun();
    await click(`[data-history-id="workspace--${runId}"][data-run-stage="1"]`);
  };
  const retryURL = (job, attempt) => `/signet/runs/${runId}/genotype/retry?` + new URLSearchParams({expected_job_id: job, expected_attempt: String(attempt)});
  const setValue = (selector, value) => js(`(() => {const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};
    input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const refresh = async expected => {
    const selector = '#lens-stage1 [data-genotype-refresh]';
    await until(() => js(`document.querySelector(${JSON.stringify(selector)})?.disabled===false`), 'Genotype status refresh stayed disabled');
    await click(selector);
    await until(async () => await state() === expected && await js(`document.querySelector(${JSON.stringify(selector)}).disabled===false`), 'Genotype did not reach ' + expected);
  };
  const review = async (prior, number) => {
    await until(() => js(`document.querySelector('[data-run-target="workspace--${runId}"]').textContent.includes(${JSON.stringify(number === 1 ? 'Failed' : 'Cancelled')})`), 'History did not finish restoring the retryable attempt');
    await connection();
    await click('#lens-stage1 [data-genotype-retry]');
    await until(() => js(`document.querySelector('#lens-stage1').dataset.genotypeRetryState==='ready'`),
      async () => 'Retry review did not settle: ' + await js(`document.querySelector('#lens-stage1').textContent`));
    const target = await js(`document.querySelector('#lens-stage1 [data-genotype-retry-context]').textContent`);
    assert.ok(target.includes(runId) && target.includes(String(number)) && target.includes(String(number + 1)));
    assert.equal(await js(`document.querySelector('#lens-stage1 [data-genotype-job-id]').textContent`), prior);
    assert.equal(await js(`document.querySelector('[data-genotype-setting="restrict.tcga.geno"]').value`), '2');
    assert.equal(await js(`document.querySelector('[data-genotype-setting="restrict.tcga.geno"]').readOnly`), true);
    for (const [kind, files] of Object.entries(datasetA.inputs)) {
      const text = await js(`document.querySelector('[data-genotype-source-input="${kind}"]').textContent`);
      for (const filename of files) assert.ok(text.includes(filename), 'Retry replaced original source inputs');
      for (const filename of datasetB.inputs[kind]) assert.ok(!text.includes(filename), 'Retry borrowed the mutable dataset catalog');
    }
    assert.equal(await js(`document.querySelector('#lens-stage1 [data-genotype-acknowledge]').checked`), false);
    assert.equal(await js(`document.querySelector('#lens-stage1 [data-genotype-submit]').disabled`), true);
  };
  const submit = async (job, mind, cpus) => {
    await setValue('[data-genotype-setting="mind"]', mind);
    await setValue('[data-genotype-resource="cpus"]', cpus);
    await setValue('[data-genotype-resource="mem_gb"]', '12');
    await setValue('[data-genotype-resource="hours"]', '2');
    await click('[data-genotype-acknowledge]');
    await until(() => js(`document.querySelector('#lens-stage1 [data-genotype-submit]').disabled===false`), 'Retry confirmation did not enable submission');
    writeFileSync(path.join(fixture.slurm, 'sbatch_reply'), job + '\n');
    await js(`(() => {const button=document.querySelector('#lens-stage1 [data-genotype-submit]');button.click();button.click();})()`);
    await until(async () => ['submitted', 'pending'].includes(await state()),
      async () => 'Reviewed retry was not queued: ' + await js(`document.querySelector('#lens-stage1').textContent`));
    if (await state() !== 'pending') await refresh('pending');
    assert.equal(await js(`document.querySelector('#lens-stage1').dataset.genotypeRunId`), runId);
  };

  await until(() => js(`!!document.querySelector('#ml-language')`), 'Workspace did not mount');
  await click('#ml-language'); await connection();
  assert.deepEqual(await geometry(), [1650, 894, 53, 542]);
  assert.deepEqual(submissions(), ['submitted']);
  assert.equal(firstRecord.state, 'failed');
  const changed = await request('/signet/datasets/' + datasetA.id, {inputs: datasetB.inputs}, 'PATCH');
  assert.equal(changed.status, 200);
  const loadedCatalog = once(window.webContents, 'did-finish-load'); window.webContents.reload(); await loadedCatalog;
  await click('#ml-language'); await connection(); await selectDataset(datasetA.id);
  for (const filename of datasetB.inputs.genotype) assert.ok(await js(`document.querySelector('#ml-input-genotype [data-current-files]').textContent.includes(${JSON.stringify(filename)})`));
  await openStage();
  assert.equal(await state(), 'failed');
  assert.deepEqual(submissions(), ['submitted'], 'Opening the failed run submitted an analysis');

  // Unknown states and active children are rejected before review or settings changes.
  const currentPath = path.join(local, 'steps/genotype.json');
  writeFileSync(currentPath, JSON.stringify({...firstRecord, state: 'unknown'}));
  assert.equal((await request(retryURL('12345', 1))).status, 409);
  writeFileSync(currentPath, initialRecord);
  const child = path.join(fixture.slurm, 'workdir_777');
  writeFileSync(child, path.join(remote, 'work/draining-child'));
  const draining = await request(retryURL('12345', 1));
  assert.equal(draining.status, 200);
  assert.equal(draining.value.ready, false);
  assert.ok(draining.value.issues.some(issue => /stopped|children/i.test(issue)));
  unlinkSync(child);
  const secondReview = await request(retryURL('12345', 1));
  assert.equal(secondReview.status, 200);
  assert.equal(secondReview.value.next_attempt, 2);
  assert.ok(secondReview.value.inputs['ped.file'].includes('/inputs/attempt2/'));
  await review('12345', 1);
  assert.equal(await js(`document.querySelector('[data-genotype-setting="mind"]').value`), '0.1');
  assert.equal(await js(`document.querySelector('[data-genotype-resource="cpus"]').value`), '2');
  await setValue('[data-genotype-setting="mind"]', '0.2');
  await setValue('[data-genotype-resource="cpus"]', '3');
  await js(`document.querySelector('#lens-stage1 [data-genotype-submit]').scrollIntoView({block:'nearest'})`);
  await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  writeFileSync('/private/tmp/signet-item11-stage1-retry.png', (await window.webContents.capturePage()).toPNG());
  await submit('222', '0.2', '3');
  assert.deepEqual(submissions(), ['submitted', 'submitted'], 'A double click submitted duplicate retries');
  assert.deepEqual(readdirSync(path.join(fixture.project, 'runs')).sort(), ['retry-chr2', 'step_test']);
  assert.equal((await request(retryURL('222', 2))).status, 409, 'An active retry allowed another review');
  const staleBody = {inputs: secondReview.value.inputs, settings: {...secondReview.value.settings, mind: 0.2},
    resources: {cpus: 3, mem_gb: 12, hours: 2}, review_token: secondReview.value.review_token,
    expected_job_id: '12345', expected_attempt: 1, acknowledge_warnings: true};
  assert.equal((await request(`/signet/runs/${runId}/genotype/retry`, staleBody)).status, 409);
  assert.deepEqual(readFileSync(path.join(local, 'steps/genotype.attempt1.json')), initialRecord);
  assert.deepEqual(tree(path.join(local, 'steps/genotype.attempt1.results')), firstLocalResults);
  assert.deepEqual(tree(path.join(remote, 'steps/genotype.attempt1.results')), firstRemoteResults);
  for (const [suffix, value] of Object.entries(firstLocalLogs)) assert.deepEqual(readFileSync(path.join(local, 'steps/genotype.attempt1.' + suffix)), value);
  for (const [suffix, value] of Object.entries(firstRemoteLogs)) assert.deepEqual(readFileSync(path.join(remote, 'steps/genotype.attempt1.' + suffix)), value);

  // Cancelled partial staging gets its own preserved namespace; the next retry
  // must prepare original sources again under attempt3, never reuse attempt2.
  for (const [base, value] of [[local, 'CANCELLED LOCAL TWO\n'], [remote, 'CANCELLED REMOTE TWO\n']]) {
    mkdirSync(path.join(base, 'work/res/resg'), {recursive: true});
    writeFileSync(path.join(base, 'work/res/resg/partial-attempt-two.txt'), value);
  }
  mkdirSync(path.join(remote, 'inputs/attempt2/frozen'), {recursive: true});
  mkdirSync(path.join(remote, 'inputs/attempt2/prepared/ref'), {recursive: true});
  writeFileSync(path.join(remote, 'inputs/attempt2/frozen/expression'), 'CANCELLED PARTIAL EXPRESSION\n');
  writeFileSync(path.join(remote, 'inputs/attempt2/prepared/ref/chr2.gen'), 'CANCELLED PARTIAL REFERENCE\n');
  writeFileSync(path.join(remote, 'steps/genotype.out'), 'CANCELLED ATTEMPT TWO STDOUT\n');
  writeFileSync(path.join(remote, 'steps/genotype.err'), 'CANCELLED ATTEMPT TWO STDERR\n');
  for (const suffix of ['out', 'err', 'job']) writeFileSync(path.join(local, 'steps/genotype.' + suffix), readFileSync(path.join(remote, 'steps/genotype.' + suffix)));
  writeFileSync(path.join(fixture.slurm, 'squeue'), ''); writeFileSync(path.join(fixture.slurm, 'sacct'), 'CANCELLED\n');
  await refresh('cancelled');
  const cancelledRecord = readFileSync(currentPath);
  const secondInputs = tree(path.join(remote, 'inputs/attempt2'));
  await review('222', 2);
  assert.equal(await js(`document.querySelector('[data-genotype-setting="mind"]').value`), '0.2');
  assert.equal(await js(`document.querySelector('[data-genotype-resource="cpus"]').value`), '3');
  await submit('333', '0.3', '4');
  assert.deepEqual(submissions(), ['submitted', 'submitted', 'submitted']);
  assert.deepEqual(readFileSync(path.join(local, 'steps/genotype.attempt2.json')), cancelledRecord);
  assert.equal(readFileSync(path.join(local, 'steps/genotype.attempt2.err'), 'utf8'), 'CANCELLED ATTEMPT TWO STDERR\n');
  assert.equal(readFileSync(path.join(remote, 'steps/genotype.attempt2.err'), 'utf8'), 'CANCELLED ATTEMPT TWO STDERR\n');
  assert.equal(readFileSync(path.join(local, 'steps/genotype.attempt2.results/partial-attempt-two.txt'), 'utf8'), 'CANCELLED LOCAL TWO\n');
  assert.equal(readFileSync(path.join(remote, 'steps/genotype.attempt2.results/partial-attempt-two.txt'), 'utf8'), 'CANCELLED REMOTE TWO\n');
  const current = JSON.parse(readFileSync(currentPath));
  assert.equal(current.attempt, 3); assert.equal(current.previous_job_id, '222');
  assert.equal(current.settings.mind, '0.3'); assert.equal(current.resources.cpus, 4);
  assert.ok(current.inputs['ped.file'].includes('/inputs/attempt3/'));
  writeFileSync(path.join(fixture.slurm, 'science_phase'), 'success\n');
  writeFileSync(path.join(fixture.slurm, 'squeue'), 'RUNNING\n'); await refresh('running');
  const executed = await promisify(execFile)('bash', [path.join(remote, 'steps/genotype.sbatch')], {
    cwd: path.join(remote, 'work'), timeout: 30000,
    env: {...process.env, PATH: path.join(fixture.slurm, 'bin') + path.delimiter + process.env.PATH,
      FAKE: fixture.slurm, SIGNET_CUSTOM_REMOTE: fixture.remote, SLURM_JOB_ID: '333', SLURM_CPUS_PER_TASK: '4'}});
  writeFileSync(path.join(remote, 'steps/genotype.out'), executed.stdout);
  writeFileSync(path.join(remote, 'steps/genotype.err'), executed.stderr);
  writeFileSync(path.join(fixture.slurm, 'squeue'), ''); writeFileSync(path.join(fixture.slurm, 'sacct'), 'COMPLETED\n');
  await refresh('completed');
  assert.ok(!readFileSync(path.join(local, 'work/res/resg/signet_Geno'), 'utf8').includes('PARTIAL'));
  const manifest = JSON.parse(readFileSync(path.join(local, 'work/res/resg/workspace-inputs.json')));
  assert.equal(manifest.dataset_id, datasetA.id);
  assert.ok(manifest.source_files.every(item => item.frozen_path.includes('/inputs/attempt3/')));
  assert.ok(manifest.source_files.every(item => !item.path.includes('/cohorts/b/')));
  assert.equal(existsSync(path.join(remote, 'inputs/attempt3/prepared/old-reference-sentinel.txt')), false);
  assert.ok(!readFileSync(path.join(remote, 'inputs/attempt3/prepared/ref/chr2.gen'), 'utf8').includes('CANCELLED'));
  assert.deepEqual(tree(path.join(remote, 'inputs/frozen')), firstFrozen);
  assert.deepEqual(tree(path.join(remote, 'inputs/prepared')), firstPrepared);
  assert.deepEqual(tree(path.join(remote, 'inputs/attempt2')), secondInputs);
  assert.deepEqual(readFileSync(path.join(local, 'workspace-genotype.json')), initialSnapshot);
  const next = await request(`/signet/runs/${runId}/expression/example`);
  assert.equal(next.status, 200);
  assert.ok(next.value.inputs['gexp.file'].includes('/inputs/attempt3/frozen/expression'));
  assert.equal((await request(retryURL('333', 3))).status, 409, 'A completed Stage 1 allowed retry');

  await running.backend.stop(); replacement = new Backend(running.backend.options);
  assert.equal(await replacement.start(), running.origin);
  const loaded = once(window.webContents, 'did-finish-load'); window.webContents.reload(); await loaded;
  await connection(); await selectDataset(datasetA.id); await openRun();
  const history = await request('/stage6/history');
  const row = history.value.runs.find(row => row.history_id === 'workspace--' + runId);
  assert.deepEqual(row.attempts.genotype.map(attempt => [attempt.number, attempt.record.state, attempt.record.job_id]),
    [[1, 'failed', '12345'], [2, 'cancelled', '222'], [3, 'completed', '333']]);
  assert.ok(row.frozen_inputs.expression[0].includes('/inputs/attempt3/'));
  const details = `#ml-run-workspace--${runId} [data-history-job="genotype"]`;
  await click(details + ' > summary');
  for (const number of [1, 2, 3]) {
    const attempt = details + ` [data-history-attempt="${number}"]`;
    await click(attempt + ' > summary');
    assert.ok(await js(`document.querySelector(${JSON.stringify(attempt)}).textContent.includes('0.${number}')`));
  }
  const restarted = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.equal(restarted.starts.length, 2); assert.notEqual(restarted.starts[0], restarted.starts[1]);
  assert.deepEqual(Object.fromEntries(originals.map(filename => [filename, digest(filename)])), fingerprints);
  assert.deepEqual(readFileSync(path.join(local, 'workspace-genotype.json')), initialSnapshot);
  assert.deepEqual(submissions(), ['submitted', 'submitted', 'submitted']);
  assert.equal(existsSync(path.join(temporary, 'forbidden.ndjson')), false, 'Retry invoked another run or downstream stage');
  assert.deepEqual(await geometry(), [1650, 894, 53, 542]);
  await replacement.stop(); replacement = undefined;
  await running.quit();
  console.log('PASS: failed/cancelled Stage1 same-run manual retry with original files/settings, parameter/resource edits, warning confirmation, stale/active/unknown/draining/completed refusals, exact local+remote attempt/log/result retention, fresh per-attempt frozen/reference namespaces, changed catalog ignored, latest Stage2 frozen-input review without submission, Python restart and fixed geometry; local fake scheduler/container only, no real HPC/science');
}

verify().catch(async error => {console.error(error); await replacement?.forceStop(); await running?.backend.forceStop(); app.exit(1);});
