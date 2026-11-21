'use strict';

// Checks already-recorded jobs and downloads owned fixture outputs only. The
// backend fixture rejects every submission, cancellation and settings mutation.
const assert = require('node:assert/strict');
const {once} = require('node:events');
const {createHash} = require('node:crypto');
const {existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app} = require('electron');
const {Backend} = require('../main/backend/backend.cjs');
const {launch} = require('../main/app/main.cjs');

const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'signet-output-revalidation-')));
app.setPath('appData', temporary);
const repo = path.resolve(__dirname, '../..');
const wrapper = path.join(temporary, 'python-fixture');
process.env.SIGNET_REVALIDATION_ROOT = temporary;
process.env.SIGNET_REVALIDATION_PYTHON = process.env.SIGNET_PYTHON || path.join(repo, '.venv/bin/python');
process.env.SIGNET_REVALIDATION_ENTRY = path.join(__dirname, 'fixtures/revalidation_backend.py');
writeFileSync(wrapper, '#!/bin/sh\nexec "$SIGNET_REVALIDATION_PYTHON" "$SIGNET_REVALIDATION_ENTRY" "$@"\n', {mode: 0o700});
process.env.SIGNET_PYTHON = wrapper;
let running;
let replacement;
const deadline = setTimeout(async () => {
  console.error('Output revalidation integration test timed out');
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

function frozenFiles(project, inputs) {
  const result = {};
  function visit(folder) {
    for (const item of readdirSync(folder, {withFileTypes: true})) {
      const filename = path.join(folder, item.name);
      if (item.isDirectory()) visit(filename);
      else if (!filename.includes(path.sep + 'steps' + path.sep) || /\.attempt\d+\.json$/.test(filename)) {
        if (filename.includes(path.sep + 'work' + path.sep + 'res' + path.sep)) continue;
        result[filename] = createHash('sha256').update(readFileSync(filename)).digest('hex');
      }
    }
  }
  visit(project); visit(inputs);
  return result;
}

function existingOutputs(fixture) {
  const result = {};
  function visit(folder) {
    if (!existsSync(folder)) return;
    for (const item of readdirSync(folder, {withFileTypes: true})) {
      const filename = path.join(folder, item.name);
      if (item.isDirectory()) visit(filename);
      else result[filename] = createHash('sha256').update(readFileSync(filename)).digest('hex');
    }
  }
  for (const record of fixture.records) {
    visit(path.join(fixture.project, 'runs', record.run_id, 'work/res'));
    visit(path.join(fixture.root, 'remote/work', record.run_id, 'work/res'));
  }
  return result;
}

async function verify() {
  running = await launch({provider: 'codex', visible: false, userData: path.join(temporary, 'app'),
    stateFile: path.join(temporary, 'chat.json')});
  const {window} = running;
  const fixturePath = path.join(temporary, 'fixture.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const immutable = frozenFiles(fixture.project, fixture.inputs);
  const priorOutputs = existingOutputs(fixture);
  const currentPath = record => path.join(fixture.project, 'runs', record.run_id, 'steps', record.step + '.json');
  const readCurrent = record => JSON.parse(readFileSync(currentPath(record), 'utf8'));
  const initial = Object.fromEntries(fixture.records.map(record => [record.run_id, readCurrent(record)]));
  const reads = () => existsSync(path.join(temporary, 'reads.ndjson')) ? readFileSync(path.join(temporary, 'reads.ndjson'), 'utf8').trim().split('\n').filter(Boolean) : [];
  const js = async source => {
    const result = await window.webContents.executeJavaScript(`(async () => {
      try{return {value:await (${source})};}catch(error){return {error:error.stack||String(error)};}
    })()`);
    if (result.error) throw Error(result.error + '\nOutput check expression: ' + source.slice(0, 500));
    return result.value;
  };
  const click = selector => js(`(() => {const button=document.querySelector(${JSON.stringify(selector)});
    if(!button?.getClientRects().length)throw Error('Missing visible output-check control: '+${JSON.stringify(selector)});button.click();})()`);
  const request = (url, body) => js(`fetch(${JSON.stringify(url)},{method:${JSON.stringify(body ? 'POST' : 'GET')},
    headers:{'Content-Type':'application/json','X-Chat-Token':document.querySelector('meta[name="chat-token"]').content},
    body:${JSON.stringify(body ? JSON.stringify(body) : undefined)}}).then(async response=>({status:response.status,value:await response.json()}))`);
  const endpoint = record => `/signet/runs/${record.run_id}/steps/${record.step}/revalidate`;
  const guard = record => ({expected_job_id: record.job_id, expected_attempt: record.attempt});
  const geometry = () => js(`(() => {const root=document.querySelector('.ml-app');return [root.offsetWidth,root.offsetHeight,
    root.querySelector('.ml-rail').offsetWidth,root.querySelector('.ml-chat').offsetWidth];})()`);
  const connection = connected => js(`window.dispatchEvent(new CustomEvent('workspace-remote-context',{detail:{connected:${connected},
    identity:'isolated-output-check',environmentKey:'read-only-owned-job-output'}}))`);
  const isolateConnection = () => js(`window.addEventListener('workspace-remote-context',event=>{
    if(event.detail?.identity!=='isolated-output-check')event.stopImmediatePropagation();
  },{capture:true})`);
  const control = changes => {
    const filename = path.join(temporary, 'control.json');
    writeFileSync(filename, JSON.stringify({...JSON.parse(readFileSync(filename, 'utf8')), ...changes}));
  };
  const selectDataset = async id => {
    await click('[data-nav-target="data"]');
    await until(() => js(`[...document.querySelector('#ml-dataset-select').options].some(option=>option.value===${JSON.stringify(id)})`), 'Revalidation dataset did not mount');
    await js(`(() => {const picker=document.querySelector('#ml-dataset-select');picker.value=${JSON.stringify(id)};
      picker.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  };
  const openStage = async record => {
    await selectDataset(fixture.datasets[0].id);
    await click('[data-nav-target="history"]');
    const key = 'workspace--' + record.run_id;
    await until(() => js(`!!document.querySelector('[data-run-target="${key}"]')?.getClientRects().length`), 'Revalidation run is missing from history');
    await click(`[data-run-target="${key}"]`);
    await click(`[data-history-id="${key}"][data-run-stage="${record.stage}"]`);
    await connection(true);
  };
  const panel = record => record.stage === 6 ? '#lens-stage6-run' : '#lens-stage' + record.stage;
  const prefix = record => ({1: 'genotype', 2: 'expression', 3: 'adjust', 4: 'cis', 5: 'network', 6: 'visualize'})[record.stage];
  const button = record => panel(record) + ` [data-${prefix(record)}-revalidate]`;
  const notice = record => panel(record) + ` [data-${prefix(record)}-revalidate-notice]`;
  const checkingState = record => js(`document.querySelector(${JSON.stringify(panel(record))}).dataset.${prefix(record)}RevalidationState`);
  const startCheck = async record => {
    await connection(true);
    await until(() => js(`document.querySelector(${JSON.stringify(button(record))})?.disabled===false`), 'Output-check button stayed disabled');
    await js(`(() => {window.dispatchEvent(new CustomEvent('workspace-remote-context',{detail:{connected:true,
      identity:'isolated-output-check',environmentKey:'read-only-owned-job-output'}}));
      const button=document.querySelector(${JSON.stringify(button(record))});
      if(!button?.getClientRects().length||button.disabled)throw Error('Output check target is not actionable');button.click();})()`);
  };
  const resultReady = record => {
    const result = record.stage === 6 ? '#lens-stage6' : record.stage === 3 ? '#lens-history-stage3' : '#lens-history-stage';
    return js(`document.querySelector(${JSON.stringify(result)})?.dataset.runState==='ready'&&document.querySelector(${JSON.stringify(result)}).dataset.runId===${JSON.stringify(record.run_id)}`);
  };

  await until(() => js(`!!document.querySelector('#ml-language')`), 'Workspace did not mount');
  // The actual desktop broker remains disconnected. This isolated workflow
  // uses its explicitly mocked transport, whose connection events must agree.
  await isolateConnection();
  await click('#ml-language');
  assert.deepEqual(await geometry(), [1650, 894, 53, 542]);
  const listed = await request('/stage6/history');
  assert.equal(listed.status, 200);
  for (const record of fixture.records) {
    const row = listed.value.runs.find(row => row.history_id === 'workspace--' + record.run_id);
    assert.equal(row.output_revalidation[record.step].eligible, true, 'Eligible failed output check was not projected for ' + record.step);
  }
  for (const record of fixture.ineligible) {
    const count = reads().length;
    assert.equal((await request(endpoint(record), guard(record))).status, 409);
    assert.equal(reads().length, count, 'An ineligible output check contacted the remote environment');
  }
  const first = fixture.records[0];
  const beforeStale = reads().length;
  assert.equal((await request(endpoint(first), {...guard(first), expected_job_id: '999999'})).status, 409);
  assert.equal((await request(endpoint(first), {...guard(first), expected_attempt: 1})).status, 409);
  assert.equal(reads().length, beforeStale);
  control({connected: false});
  assert.equal((await request(endpoint(first), guard(first))).status, 412);
  assert.equal(readCurrent(first).state, 'failed');
  control({connected: true});

  for (const record of fixture.records) {
    await openStage(record);
    await until(() => js(`!!document.querySelector(${JSON.stringify(button(record))})?.getClientRects().length`), 'Eligible stage has no manual output check: ' + record.step);
    const previousChecks = readCurrent(record).output_checks?.length ?? 0;
    if (record.stage === 2) control({delay_run: record.run_id});
    await startCheck(record);
    assert.equal(await js(`document.querySelector(${JSON.stringify(button(record))}).disabled`), true, 'Output checking did not block duplicate clicks');
    assert.notEqual(await checkingState(record), 'ready', 'Clicking the button immediately claimed completion');
    if (record.stage === 2) {
      await selectDataset(fixture.datasets[1].id);
      await until(() => (readCurrent(record).output_checks?.length ?? 0) > previousChecks && readCurrent(record).state === 'failed', 'Hidden output check never finished');
      assert.equal(await js(`document.querySelector('#ml-dataset-select').value`), fixture.datasets[1].id);
      assert.equal(await js(`!!document.querySelector(${JSON.stringify(panel(record))}).getClientRects().length`), false, 'A late check replaced the selected dataset');
      control({delay_run: ''});
      await openStage(record);
    } else {
      await until(() => (readCurrent(record).output_checks?.length ?? 0) > previousChecks && readCurrent(record).state === 'failed', 'Manual missing-output check did not record its outcome');
    }
    assert.equal(readCurrent(record).state, 'failed');
    assert.equal(readCurrent(record).job_id, record.job_id);
    assert.equal(readCurrent(record).attempt, record.attempt);
    assert.ok(readCurrent(record).missing_outputs.length > 0);
    if (record.stage === 6) {
      await js(`document.querySelector(${JSON.stringify(button(record))}).scrollIntoView({block:'nearest'})`);
      await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      writeFileSync('/private/tmp/signet-item12-output-revalidation.png', (await window.webContents.capturePage()).toPNG());
    }
    const missing = fixture.missing[record.run_id];
    writeFileSync(missing.path, missing.content);
    await until(() => js(`document.querySelector(${JSON.stringify(button(record))})?.disabled===false`), 'Manual check did not become available after an unchanged failure');
    await startCheck(record);
    await until(() => readCurrent(record).state === 'completed', 'Existing outputs did not recover ' + record.step);
    const completed = readCurrent(record);
    assert.equal(completed.job_id, record.job_id); assert.equal(completed.attempt, record.attempt);
    assert.deepEqual(completed.settings, initial[record.run_id].settings);
    assert.deepEqual(completed.inputs, initial[record.run_id].inputs);
    assert.deepEqual(completed.resources, initial[record.run_id].resources);
    assert.equal(completed.original_failure.reason, 'Required outputs are missing.');
    assert.equal(completed.original_failure.state, 'failed');
    assert.ok(completed.output_checks.length >= previousChecks + 2);
    assert.ok(completed.history.some(event => event.state === 'failed'));
    await until(() => resultReady(record), 'Recovered saved result did not open for stage ' + record.stage);
    if (record.stage === 6) {
      assert.equal(await js(`document.querySelectorAll('#lens-stage6 tbody tr').length`), 3);
      await js(`document.querySelector('#lens-stage6 [data-gene="MEGF6"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
      assert.equal(await js(`document.querySelectorAll('#lens-stage6 tbody tr').length`), 2);
      await js(`document.querySelector('#lens-stage6').scrollIntoView({block:'start'})`);
      await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      writeFileSync('/private/tmp/signet-item12-recovered-megf6.png', (await window.webContents.capturePage()).toPNG());
    }
    assert.equal((await request(endpoint(record), guard(record))).status, 409, 'A completed job remained eligible');
  }

  for (const record of fixture.ineligible) {
    await openStage(record);
    assert.equal(await js(`!!document.querySelector(${JSON.stringify(button(record))})?.getClientRects().length`), false, 'An ineligible saved job offered output revalidation');
  }
  assert.deepEqual(frozenFiles(fixture.project, fixture.inputs), immutable, 'Output revalidation modified original inputs, settings, source snapshots or prior attempts');
  await running.backend.stop(); replacement = new Backend(running.backend.options);
  assert.equal(await replacement.start(), running.origin);
  const loaded = once(window.webContents, 'did-finish-load'); window.webContents.reload(); await loaded;
  await isolateConnection();
  const reopened = await request('/stage6/history');
  assert.equal(reopened.status, 200);
  for (const record of fixture.records) {
    const row = reopened.value.runs.find(row => row.history_id === 'workspace--' + record.run_id);
    assert.equal(row.jobs[record.step].state, 'completed');
    assert.equal(row.jobs[record.step].job_id, record.job_id); assert.equal(row.jobs[record.step].attempt, record.attempt);
    assert.equal(row.jobs[record.step].original_failure.reason, 'Required outputs are missing.');
    assert.ok(row.jobs[record.step].output_checks.length >= 2);
    assert.equal(row.output_revalidation[record.step].eligible, false);
  }
  await selectDataset(fixture.datasets[0].id); await openStage(fixture.records[5]);
  await until(() => resultReady(fixture.records[5]), 'Recovered graph did not reopen after backend restart');
  const restarted = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.equal(restarted.starts.length, 2); assert.notEqual(restarted.starts[0], restarted.starts[1]);
  assert.deepEqual(frozenFiles(fixture.project, fixture.inputs), immutable);
  const finalOutputs = existingOutputs(fixture);
  for (const [filename, fingerprint] of Object.entries(priorOutputs)) assert.equal(finalOutputs[filename], fingerprint, 'Output recovery overwrote an existing saved result: ' + filename);
  assert.equal(existsSync(path.join(temporary, 'forbidden.ndjson')), false, 'Output checking attempted a mutation, cancellation or analysis');
  assert.ok(readFileSync(path.join(temporary, 'posts.ndjson'), 'utf8').trim().split('\n').every(line => JSON.parse(line).endsWith('/revalidate')));
  assert.deepEqual(await geometry(), [1650, 894, 53, 542]);
  await replacement.stop(); replacement = undefined;
  await running.quit();
  console.log('PASS: all six failed stages manually checked without rerun, still-missing reasons then same-job/attempt recovery, preserved original failure/audits/snapshots/settings/previous attempts, ineligible/stale/disconnected guards, selection race isolation, saved result readers and Stage6 MEGF6 after Python restart, immutable sources and fixed geometry; read-only local scheduler/output fixtures only, no HPC/submission/cancellation/analysis');
}

verify().catch(async error => {console.error(error); await replacement?.forceStop(); await running?.backend.forceStop(); app.exit(1);});
