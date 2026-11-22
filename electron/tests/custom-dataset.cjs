'use strict';

// Real workspace APIs, trusted input freezing/reference preparation, and local
// scheduler stand-ins. The original SIGNET statistical commands never execute.
const assert = require('node:assert/strict');
const {promisify} = require('node:util');
const {execFile} = require('node:child_process');
const {once} = require('node:events');
const {createHash} = require('node:crypto');
const {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app} = require('electron');
const {launch} = require('../main/app/main.cjs');

const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'signet-custom-dataset-')));
const repo = path.resolve(__dirname, '../..');
const metadata = path.join(temporary, 'fixture.json');
const wrapper = path.join(temporary, 'python-fixture');
process.env.SIGNET_CUSTOM_TEST_PYTHON = process.env.SIGNET_PYTHON || path.join(repo, '.venv/bin/python');
process.env.SIGNET_CUSTOM_TEST_ENTRY = path.join(__dirname, 'fixtures/custom_dataset_backend.py');
process.env.SIGNET_CUSTOM_TEST_METADATA = metadata;
writeFileSync(wrapper, '#!/bin/sh\nexec "$SIGNET_CUSTOM_TEST_PYTHON" "$SIGNET_CUSTOM_TEST_ENTRY" "$@"\n', {mode: 0o700});
process.env.SIGNET_PYTHON = wrapper;
let running;
const deadline = setTimeout(async () => {
  console.error('Custom dataset pipeline test timed out');
  await running?.backend.forceStop();
  app.exit(1);
}, 240000);
app.on('will-quit', () => { clearTimeout(deadline); rmSync(temporary, {recursive: true, force: true}); });

async function until(check, description, timeout = 25000) {
  const end = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < end);
  throw Error(typeof description === 'function' ? await description() : description);
}

function fingerprints(files) {
  return Object.fromEntries(files.map(filename => [filename, createHash('sha256').update(readFileSync(filename)).digest('hex')]));
}

async function verify() {
  running = await launch({provider: 'codex', visible: false, userData: path.join(temporary, 'app'),
    stateFile: path.join(temporary, 'chat.json')});
  const {window} = running;
  const fixture = JSON.parse(readFileSync(metadata, 'utf8'));
  const [datasetA, datasetB] = fixture.datasets;
  const originalFiles = [...fixture.datasets.flatMap(dataset => Object.values(dataset.inputs).flat()),
    fixture.reference, fixture.genetic_map, fixture.annotation, fixture.corrected_clinical];
  const originalFingerprints = fingerprints(originalFiles);
  const callsFile = path.join(fixture.slurm, 'sbatch_calls');
  const calls = () => existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n') : [];
  const js = async source => {
    const result = await window.webContents.executeJavaScript(`(async () => {
      try {return {value:await (${source})};} catch(error) {return {error:error.stack||String(error)};}
    })()`);
    if (result.error) throw Error(result.error + '\nCustom dataset expression: ' + source.slice(0, 800));
    return result.value;
  };
  const click = selector => js(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    if (!control) throw Error('Missing custom dataset control: ' + ${JSON.stringify(selector)});
    control.click();
  })()`);
  const geometry = () => js(`(() => { const root=document.querySelector('.ml-app');
    return [root.offsetWidth,root.offsetHeight,root.querySelector('.ml-rail').offsetWidth,root.querySelector('.ml-chat').offsetWidth]; })()`);
  const controlledConnection = async () => {
    await until(() => js(`!!document.querySelector('#ml-remote-status')`), 'The workspace connection controller did not mount');
    // SSH authentication is covered by the separate loopback native tests. Here
    // the backend transport is already bound to StepsTest's local-only runner.
    await js(`(() => {window.dispatchEvent(new CustomEvent('workspace-remote-context',{detail:{connected:true,
      identity:'isolated-custom-pipeline',environmentKey:'local-scheduler-fixture'}}));return true;})()`);
  };
  const selectDataset = async id => {
    await click('[data-nav-target="data"]');
    await until(() => js(`[...document.querySelector('#ml-dataset-select').options].some(option=>option.value===${JSON.stringify(id)})`),
      'The custom dataset catalog is missing');
    await js(`(() => {const picker=document.querySelector('#ml-dataset-select');picker.value=${JSON.stringify(id)};
      picker.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  };
  const request = (url, body, method = 'POST') => js(`fetch(${JSON.stringify(url)},{method:${JSON.stringify(method)},
    headers:{'Content-Type':'application/json','X-Chat-Token':document.querySelector('meta[name="chat-token"]').content},
    body:${JSON.stringify(JSON.stringify(body))}}).then(async reply=>({status:reply.status,value:await reply.json()}))`);
  const panelState = (stage, name) => js(`document.querySelector('#lens-stage${stage}')?.dataset[${JSON.stringify(name+'State')}]`);
  const stageState = step => panelState({genotype:1,expression:2,adjust:3}[step], step);
  const openRunStage = async (runId, stage) => {
    await click('[data-nav-target="history"]');
    const row = `[data-run-target][data-run-id="${runId}"]`;
    await until(() => js(`!!document.querySelector(${JSON.stringify(row)})?.getClientRects().length`), 'The run is missing from its dataset history');
    await click(row);
    const stageLink = `[data-run-stage="${stage}"][data-run-id="${runId}"]`;
    await until(() => js(`!!document.querySelector(${JSON.stringify(stageLink)})?.getClientRects().length`),
      async () => 'The saved run did not expose Stage ' + stage + ': ' + await js(`document.querySelector('#ml-run-details')?.textContent`));
    await click(stageLink);
  };
  async function setValue(selector, value) {
    await js(`(() => {const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};
      input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  }
  async function executeJob(runId, step, jobId) {
    writeFileSync(path.join(fixture.slurm, 'squeue'), 'RUNNING\n');
    await until(async () => await stageState(step) === 'running', step + ' did not report running');
    const remote = path.join(fixture.remote, runId);
    const script = path.join(remote, 'steps', step + '.sbatch');
    const resources = JSON.parse(readFileSync(path.join(fixture.project, 'runs', runId, 'steps', step + '.json'))).resources;
    let result;
    try {
      result = await promisify(execFile)('bash', [script], {cwd: path.join(remote, 'work'), timeout: 30000,
        env: {...process.env, PATH: path.join(fixture.slurm, 'bin') + path.delimiter + process.env.PATH,
          FAKE: fixture.slurm, SIGNET_CUSTOM_REMOTE: fixture.remote, SLURM_JOB_ID: jobId, SLURM_CPUS_PER_TASK: String(resources.cpus)}});
    } catch (error) {
      writeFileSync(path.join(remote, 'steps', step + '.out'), error.stdout || '');
      writeFileSync(path.join(remote, 'steps', step + '.err'), error.stderr || '');
      throw error;
    }
    writeFileSync(path.join(remote, 'steps', step + '.out'), result.stdout);
    writeFileSync(path.join(remote, 'steps', step + '.err'), result.stderr);
    writeFileSync(path.join(fixture.slurm, 'squeue'), '');
    writeFileSync(path.join(fixture.slurm, 'sacct'), 'COMPLETED\n');
    await until(async () => await stageState(step) === 'completed', step + ' did not collect its verified outputs');
  }

  assert.deepEqual(await geometry(), [1650, 894, 53, 542]);
  await controlledConnection();
  await selectDataset(datasetA.id);
  await click('[data-nav-target="analysis"]');
  await click('#ml-stage-tab');
  await click('[data-stage="1"]');
  await until(() => js(`!!document.querySelector('#lens-stage1 [data-genotype-review]:not(:disabled)')`), 'Custom Stage 1 did not offer explicit review');
  assert.deepEqual(calls(), [], 'Selecting a custom dataset submitted a job');
  assert.deepEqual(readdirSync(path.join(fixture.project, 'runs')), ['step_test']);
  await click('#lens-stage1 [data-genotype-review]');
  await until(() => js(`(() => {
    const source=document.querySelector('#lens-stage1 [data-genotype-source-input="genotype"]');
    const acknowledge=document.querySelector('#lens-stage1 [data-genotype-acknowledge]');
    return !!source?.getClientRects().length&&source.textContent.includes(${JSON.stringify(datasetA.inputs.genotype[0])})&&
      !!acknowledge?.getClientRects().length&&!acknowledge.disabled&&
      document.querySelector('#lens-stage1 [data-genotype-review]')?.disabled===false;
  })()`), async () => 'The custom Stage 1 review did not settle: ' + await js(`document.querySelector('#lens-stage1')?.textContent`));
  assert.equal(await js(`document.querySelector('#lens-stage1 [data-genotype-submit]').disabled`), true,
    'Custom warning acknowledgement must precede submission');
  assert.match(await js(`document.querySelector('#lens-stage1 [data-genotype-warnings]').textContent`),
    /Stage 3:.*clinical/i, 'Stage 1 must disclose the deferred clinical problem before acknowledgement');
  for (const [kind, files] of Object.entries(datasetA.inputs)) {
    const text = await js(`document.querySelector('[data-genotype-source-input="${kind}"]')?.textContent`);
    for (const filename of files) assert.ok(text?.includes(filename), 'Stage 1 did not review the selected source ' + kind);
  }
  assert.equal(await js(`document.querySelector('[data-genotype-setting="restrict.tcga.geno"]').value`), '2');
  assert.deepEqual(calls(), [], 'Reviewing or acknowledging files must not submit a job');
  await click('[data-genotype-acknowledge]');
  await until(() => js(`document.querySelector('#lens-stage1 [data-genotype-submit]')?.disabled===false`), 'Acknowledging warnings did not enable manual submission');
  await js(`(() => {const button=document.querySelector('#lens-stage1 [data-genotype-submit]');button.click();button.click();})()`);
  await until(async () => await stageState('genotype') === 'pending', 'Custom Stage 1 did not queue');
  const runId = await js(`document.querySelector('#lens-stage1').dataset.genotypeRunId`);
  const localRun = path.join(fixture.project, 'runs', runId);
  const initialPath = path.join(localRun, 'workspace-genotype.json');
  const initial = JSON.parse(readFileSync(initialPath, 'utf8'));
  assert.equal(initial.dataset_id, datasetA.id);
  assert.equal(initial.mode, 'dataset');
  assert.deepEqual(initial.source_inputs, datasetA.inputs);
  assert.equal(initial.settings['restrict.tcga.geno'], '2');
  assert.deepEqual(calls(), ['submitted'], 'A double click submitted more than one genotype job');
  const changed = await request('/signet/datasets/' + datasetA.id, {inputs: datasetB.inputs}, 'PATCH');
  assert.equal(changed.status, 200);
  await executeJob(runId, 'genotype', '12345');
  const localManifest = path.join(localRun, 'work/res/resg/workspace-inputs.json');
  const remoteManifest = path.join(fixture.remote, runId, 'work/res/resg/workspace-inputs.json');
  assert.equal(existsSync(localManifest), false, 'Stage 1 evidence should remain in the remote data environment');
  const manifest = JSON.parse(readFileSync(remoteManifest, 'utf8'));
  assert.equal(manifest.dataset_id, datasetA.id);
  assert.equal(manifest.preparation.chromosome, '2');
  assert.equal(manifest.preparation.matched_markers, 3);
  assert.ok(existsSync(path.join(fixture.remote, runId, 'inputs/prepared/ref/chr2.gen')));
  assert.equal(existsSync(path.join(fixture.remote, runId, 'inputs/prepared/ref/chr1.gen')), false);
  for (const item of manifest.source_files) {
    assert.equal(createHash('sha256').update(readFileSync(item.frozen_path)).digest('hex'), item.frozen_sha256);
    assert.ok(!item.path.includes('/cohorts/b/'), 'Stage 1 froze newly edited catalog inputs instead of reviewed inputs');
  }
  const immutableGenotype = readFileSync(path.join(localRun, 'steps/genotype.json'));
  const initialBytes = readFileSync(initialPath);
  const manifestBytes = readFileSync(remoteManifest);

  const reload = once(window.webContents, 'did-finish-load');
  window.webContents.reload(); await reload;
  await controlledConnection();
  await selectDataset(datasetA.id);
  for (const filename of datasetB.inputs.genotype) assert.ok(await js(`document.querySelector('#ml-input-genotype [data-current-files]').textContent.includes(${JSON.stringify(filename)})`));
  await openRunStage(runId, 2);
  await until(() => js(`document.querySelector('#lens-stage2 [data-expression-submit]')?.disabled===false`), 'Frozen Stage 2 review did not enable submission');
  const frozen = initial.frozen_inputs;
  for (const [key, expected] of Object.entries({'gexp.file': frozen.expression[0], 'pmap.file': frozen.annotation})) {
    assert.equal(await js(`(() => {const control=document.querySelector('[data-expression-input="${key}"]');return control?.value||control?.textContent;})()`), expected);
  }
  assert.deepEqual(calls(), ['submitted'], 'Opening Stage 2 replayed Stage 1');
  writeFileSync(path.join(fixture.slurm, 'sbatch_reply'), '222\n');
  writeFileSync(path.join(fixture.slurm, 'squeue'), 'PENDING\n');
  writeFileSync(path.join(fixture.slurm, 'sacct'), '');
  await click('#lens-stage2 [data-expression-submit]');
  await until(async () => await stageState('expression') === 'pending', 'Frozen Stage 2 did not queue');
  await executeJob(runId, 'expression', '222');
  assert.deepEqual(JSON.parse(readFileSync(path.join(localRun, 'steps/expression.json'))).inputs,
    {'gexp.file': frozen.expression[0], 'pmap.file': frozen.annotation});

  await openRunStage(runId, 3);
  await until(() => js(`document.querySelector('#lens-stage3 [data-adjust-input="cli.file"]')?.value===${JSON.stringify(frozen.clinical[0])}&&
    document.querySelector('#lens-stage3 [data-adjust-review]')?.disabled===false`),
    async () => 'Frozen Stage 3 review did not settle: ' + await js(`document.querySelector('#lens-stage3')?.textContent`));
  assert.equal(await js(`document.querySelector('[data-adjust-input="cli.file"]').value`), frozen.clinical[0]);
  assert.equal(await js(`document.querySelector('[data-adjust-input="cli.file"]').readOnly`), false);
  assert.equal(await js(`document.querySelector('#lens-stage3 [data-adjust-submit]').disabled`), true,
    'The original malformed clinical file must block Stage 3');
  const frozenClinicalBytes = readFileSync(frozen.clinical[0]);
  await setValue('[data-adjust-input="cli.file"]', fixture.corrected_clinical);
  assert.equal(await js(`document.querySelector('#lens-stage3 [data-adjust-submit]').disabled`), true,
    'Replacing a clinical path must invalidate prior review');
  assert.deepEqual(calls(), ['submitted', 'submitted'], 'Replacing clinical input cannot submit a job');
  await click('#lens-stage3 [data-adjust-review]');
  await until(() => js(`document.querySelector('#lens-stage3 [data-adjust-submit]')?.disabled===false`),
    async () => 'The corrected Stage 3 clinical review did not enable submission: ' + await js(`document.querySelector('#lens-stage3')?.textContent`));
  assert.equal(await js(`document.querySelector('[data-adjust-input="cli.file"]').value`), fixture.corrected_clinical);
  await setValue('[data-adjust-option="npc"]', '2');
  writeFileSync(path.join(fixture.slurm, 'sbatch_reply'), '333\n');
  writeFileSync(path.join(fixture.slurm, 'squeue'), 'PENDING\n');
  writeFileSync(path.join(fixture.slurm, 'sacct'), '');
  await click('#lens-stage3 [data-adjust-submit]');
  await until(async () => await stageState('adjust') === 'pending', 'Frozen Stage 3 did not queue');
  await executeJob(runId, 'adjust', '333');
  const savedAdjust = JSON.parse(readFileSync(path.join(localRun, 'steps/adjust.json')));
  assert.equal(savedAdjust.clinical.source, fixture.corrected_clinical);
  assert.notEqual(savedAdjust.inputs['cli.file'], frozen.clinical[0], 'Stage 3 must use its reviewed clinical copy');
  assert.ok(savedAdjust.inputs['cli.file'].startsWith(path.join(fixture.remote, runId, 'inputs/clinical') + path.sep));
  assert.deepEqual(readFileSync(savedAdjust.inputs['cli.file']), readFileSync(fixture.corrected_clinical),
    'The reviewed copy should preserve the corrected clinical values');
  assert.deepEqual(readFileSync(frozen.clinical[0]), frozenClinicalBytes, 'Replacing clinical input must preserve the original frozen file');
  assert.equal(savedAdjust.options.npc, 2);
  await until(() => js(`document.querySelector('#lens-history-stage3')?.dataset.runState==='ready'`), 'Completed custom Stage 3 results did not display');
  assert.equal(Number(await js(`document.querySelector('#lens-history-stage3 [data-s3-count="matched"]').textContent`)), 6);
  await until(() => js(`(() => {const image=document.querySelector('#lens-history-stage3 .s3-remote-plot');
    return image&&!image.hidden&&image.complete&&image.naturalWidth===640&&image.naturalHeight===420;})()`),
    'The completed Stage 3 remote-rendered plot did not display');
  assert.equal(await js(`document.querySelectorAll('#lens-history-stage3 .s3-points circle').length`), 0,
    'Live Stage 3 individual component scores must remain remote');
  assert.equal(Number(await js(`document.querySelector('#lens-history-stage3 [data-s3-count="retained"]').textContent`)), 6);
  assert.deepEqual(calls(), ['submitted', 'submitted', 'submitted']);
  assert.deepEqual(readFileSync(path.join(localRun, 'steps/genotype.json')), immutableGenotype);
  assert.deepEqual(readFileSync(initialPath), initialBytes);
  assert.deepEqual(readFileSync(remoteManifest), manifestBytes);
  assert.equal(existsSync(localManifest), false, 'Later reviews must not download the original Stage 1 evidence');

  await selectDataset(datasetB.id);
  await click('[data-nav-target="history"]');
  const visibleRuns = () => js(`[...document.querySelectorAll('#ml-run-list [data-run-target]')].filter(row=>row.getClientRects().length).map(row=>row.dataset.runId).sort()`);
  assert.deepEqual(await visibleRuns(), [fixture.archived], 'Dataset B inherited the new custom dataset A run');
  for (const stage of [1, 2, 3, 4, 5, 6]) {
    await openRunStage(fixture.archived, stage);
    const selector = stage === 3 ? '#lens-history-stage3' : stage === 6 ? '#lens-stage6' : '#lens-history-stage';
    await until(() => js(`document.querySelector('${selector}')?.dataset.runState==='ready'&&document.querySelector('${selector}')?.dataset.runId===${JSON.stringify(fixture.archived)}`),
      'Dataset B could not reopen its own Stage ' + stage);
    if (stage === 6) {
      assert.equal(await js(`document.querySelectorAll('#lens-stage6 tbody tr').length`), 3);
      await js(`document.querySelector('#lens-stage6 [data-gene="MEGF6"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
      assert.equal(await js(`document.querySelectorAll('#lens-stage6 tbody tr').length`), 2);
    }
  }
  await selectDataset(datasetA.id);
  await click('[data-nav-target="history"]');
  assert.deepEqual(await visibleRuns(), [runId], 'Dataset A inherited dataset B’s archived analysis');
  await openRunStage(runId, 1);
  await until(() => js(`document.querySelector('#lens-history-stage')?.dataset.runId===${JSON.stringify(runId)}&&document.querySelector('#lens-history-stage')?.dataset.runState==='ready'`), 'The custom Stage 1 result did not reopen');
  assert.equal(await js(`document.querySelector('#lens-history-stage [data-stage-setting="restrict.tcga.geno"]').textContent`), '2');
  assert.deepEqual(fingerprints(originalFiles), originalFingerprints, 'Custom execution modified the selected original input/reference files');
  assert.deepEqual(calls(), ['submitted', 'submitted', 'submitted'], 'History inspection resubmitted a step');
  assert.deepEqual(await geometry(), [1650, 894, 53, 542]);
  await running.quit();
  console.log('PASS: custom chr2 Stage 1 with explicit deferred-clinical warning, real input freezing/reference preparation, frozen Stage 2 after catalog edits, manual Stage 3 clinical replacement and fresh review without upstream reruns, reviewed-copy provenance, remote-rendered PCA without individual scores, immutable originals and snapshots, six-stage dataset history isolation and fixed geometry; controlled connection context and local-only scheduler, no real SSH/Slurm/container/SIGNET analysis');
}

verify().catch(async error => { console.error(error); await running?.backend.forceStop(); app.exit(1); });
