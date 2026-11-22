'use strict';

// Only seeded local scheduler records can be cancelled. The fixture forbids
// submissions, containers, science commands, actual SSH and unrelated job IDs.
const assert = require('node:assert/strict');
const {once} = require('node:events');
const {createHash} = require('node:crypto');
const {existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app} = require('electron');
const {Backend} = require('../main/backend/backend.cjs');
const {launch} = require('../main/app/main.cjs');

const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'signet-cancellation-')));
app.setPath('appData', temporary);
const repo = path.resolve(__dirname, '../..');
const wrapper = path.join(temporary, 'python-fixture');
process.env.SIGNET_CANCEL_ROOT = temporary;
process.env.SIGNET_CANCEL_PYTHON = process.env.SIGNET_PYTHON || path.join(repo, '.venv/bin/python');
process.env.SIGNET_CANCEL_ENTRY = path.join(__dirname, 'fixtures/cancellation_backend.py');
writeFileSync(wrapper, '#!/bin/sh\nexec "$SIGNET_CANCEL_PYTHON" "$SIGNET_CANCEL_ENTRY" "$@"\n', {mode: 0o700});
process.env.SIGNET_PYTHON = wrapper;
let running;
let replacement;
const deadline = setTimeout(async () => {
  console.error('Cancellation integration test timed out');
  await replacement?.forceStop(); await running?.backend.forceStop(); app.exit(1);
}, 120000);
app.on('will-quit', () => {clearTimeout(deadline); rmSync(temporary, {recursive: true, force: true});});

async function until(check, description, timeout = 15000) {
  const end = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < end);
  throw Error(description);
}

function fingerprints(project, inputs) {
  const records = {};
  function visit(folder) {
    for (const item of readdirSync(folder, {withFileTypes: true})) {
      const filename = path.join(folder, item.name);
      if (item.isDirectory()) visit(filename);
      else if (!filename.includes(path.sep + 'steps' + path.sep) || /\.attempt\d+\.json$/.test(filename)) {
        records[filename] = createHash('sha256').update(readFileSync(filename)).digest('hex');
      }
    }
  }
  visit(project); visit(inputs);
  return records;
}

async function verify() {
  running = await launch({provider: 'codex', visible: false, userData: path.join(temporary, 'app'),
    stateFile: path.join(temporary, 'chat.json')});
  const {window} = running;
  const fixturePath = path.join(temporary, 'fixture.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const original = fingerprints(fixture.project, fixture.inputs);
  const readLines = filename => existsSync(filename) ? readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean) : [];
  const cancelled = () => readLines(path.join(temporary, 'cancelled.txt'));
  const requests = () => readLines(path.join(temporary, 'requests.ndjson')).map(line => JSON.parse(line));
  const commands = () => readLines(path.join(temporary, 'commands.ndjson'));
  const js = async source => {
    const result = await window.webContents.executeJavaScript(`(async () => {
      try {return {value:await (${source})};}catch(error){return {error:error.stack||String(error)};}
    })()`);
    if (result.error) throw Error(result.error + '\nCancellation expression: ' + source.slice(0, 500));
    return result.value;
  };
  const click = selector => js(`(() => {const control=document.querySelector(${JSON.stringify(selector)});
    if(!control?.getClientRects().length)throw Error('Missing visible cancellation control: '+${JSON.stringify(selector)});
    if(control.matches(':disabled'))throw Error('Disabled cancellation control: '+${JSON.stringify(selector)});
    control.click();})()`);
  const request = (url, body) => js(`fetch(${JSON.stringify(url)},{method:'POST',
    headers:{'Content-Type':'application/json','X-Chat-Token':document.querySelector('meta[name="chat-token"]').content},
    body:${JSON.stringify(JSON.stringify(body))}}).then(async response=>({status:response.status,value:await response.json()}))`);
  const geometry = () => js(`(() => {const root=document.querySelector('.ml-app');return [root.offsetWidth,root.offsetHeight,
    root.querySelector('.ml-rail').offsetWidth,root.querySelector('.ml-chat').offsetWidth];})()`);
  const context = connected => js(`(() => {
    window.__cancellationRemoteContext={connected:${connected},identity:'isolated-cancellation',environmentKey:'local-scheduler-only'};
    if(!window.__cancellationContextInstalled){
      window.__cancellationContextInstalled=true;
      // The scheduler fixture owns connection state, including responses to later log/history mounts.
      window.addEventListener('workspace-remote-context',event=>{
        if(event.detail?.identity==='isolated-cancellation')return;
        event.stopImmediatePropagation();
        window.dispatchEvent(new CustomEvent('workspace-remote-context',{detail:window.__cancellationRemoteContext}));
      },true);
    }
    window.dispatchEvent(new CustomEvent('workspace-remote-context',{detail:window.__cancellationRemoteContext}));
  })()`);
  const selectDataset = async id => {
    await click('[data-nav-target="data"]');
    await until(() => js(`[...document.querySelector('#ml-dataset-select').options].some(option=>option.value===${JSON.stringify(id)})`), 'Cancellation dataset did not mount');
    await js(`(() => {const select=document.querySelector('#ml-dataset-select');select.value=${JSON.stringify(id)};
      select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  };
  const openStage = async (dataset, run, stage) => {
    await selectDataset(dataset);
    await click('[data-nav-target="history"]');
    const key = 'workspace--' + run;
    await until(() => js(`!!document.querySelector('[data-run-target="${key}"]')?.getClientRects().length`), 'Cancellation run is missing: ' + run);
    await click(`[data-run-target="${key}"]`);
    await click(`[data-history-id="${key}"][data-run-stage="${stage}"]`);
  };
  const selector = (stage, prefix, action) => `#lens-stage${stage} [data-${prefix}-${action}]`;
  const state = (stage, prefix) => js(`document.querySelector('#lens-stage${stage}').dataset.${prefix}State`);
  const visible = value => js(`!!document.querySelector(${JSON.stringify(value)})?.getClientRects().length`);
  const refresh = async (stage, prefix, expected) => {
    const control = selector(stage, prefix, 'refresh');
    await until(() => js(`document.querySelector(${JSON.stringify(control)})?.disabled===false`), 'Status refresh stayed disabled');
    if (!await visible(control) && await state(stage, prefix) === expected) return;
    await click(control);
    await until(async () => await state(stage, prefix) === expected &&
      await js(`document.querySelector(${JSON.stringify(control)})?.disabled===false`), 'Expected cancellation state ' + expected);
  };
  const setScheduler = (identifier, changes) => {
    const file = path.join(temporary, 'scheduler.json');
    const value = JSON.parse(readFileSync(file, 'utf8'));
    value[identifier] = {...value[identifier], ...changes};
    writeFileSync(file, JSON.stringify(value));
  };
  const setControl = changes => {
    const file = path.join(temporary, 'control.json');
    writeFileSync(file, JSON.stringify({...JSON.parse(readFileSync(file, 'utf8')), ...changes}));
  };
  const [datasetA, datasetB] = fixture.datasets;

  await until(() => js(`!!document.querySelector('#ml-language')`), 'Workspace did not mount');
  await click('#ml-language');
  await context(true);
  assert.deepEqual(await geometry(), [1650, 894, 53, 542]);
  await openStage(datasetA.id, fixture.pending, 2);
  await until(async () => await state(2, 'expression') === 'pending', 'Seeded pending expression job did not restore');
  await click(selector(2, 'expression', 'cancel'));
  assert.equal(await visible(selector(2, 'expression', 'cancel-confirmation')), true);
  const target = await js(`document.querySelector(${JSON.stringify(selector(2, 'expression', 'cancel-target'))}).textContent`);
  assert.ok(target.includes(fixture.pending) && target.includes('12345') && target.includes('2'));
  await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  writeFileSync('/private/tmp/signet-item9-cancellation-confirmation.png', (await window.webContents.capturePage()).toPNG());
  await click(selector(2, 'expression', 'cancel-dismiss'));
  assert.deepEqual(cancelled(), []);
  assert.deepEqual(requests(), [], 'Dismissing confirmation sent a cancellation request');

  // A stale dialog cannot cancel a different attempt, even for the same job ID.
  const beforeStale = commands().length;
  const stale = await request(`/signet/runs/${fixture.pending}/steps/expression/cancel`, {expected_job_id: '12345', expected_attempt: 1});
  assert.equal(stale.status, 409);
  assert.equal(commands().length, beforeStale, 'A stale cancellation contacted the scheduler');
  assert.deepEqual(cancelled(), []);
  await click(selector(2, 'expression', 'cancel'));
  const pendingConfirm = selector(2, 'expression', 'cancel-confirm');
  await js(`(() => {const button=document.querySelector(${JSON.stringify(pendingConfirm)});button.click();button.click();})()`);
  await until(async () => await state(2, 'expression') === 'cancelling', 'Pending job did not wait for confirmed cancellation');
  assert.deepEqual(cancelled(), ['12345']);
  const pendingCalls = requests().filter(call => call.run_id === fixture.pending && call.kwargs.expected_attempt === 2);
  assert.equal(pendingCalls.length, 1, 'Double confirmation sent duplicate cancellation');
  assert.equal(pendingCalls[0].kwargs.expected_job_id, '12345');
  await refresh(2, 'expression', 'cancelling');
  setScheduler('12345', {state: '', accounted: 'CANCELLED'});
  await refresh(2, 'expression', 'cancelled');

  await openStage(datasetA.id, fixture.genotype, 1);
  await until(async () => await state(1, 'genotype') === 'pending', 'History Stage 1 did not restore its own pending run');
  await click(selector(1, 'genotype', 'cancel'));
  const genotypeTarget = await js(`document.querySelector(${JSON.stringify(selector(1, 'genotype', 'cancel-target'))}).textContent`);
  assert.ok(genotypeTarget.includes(fixture.genotype) && genotypeTarget.includes('34567'));
  await click(selector(1, 'genotype', 'cancel-confirm'));
  await until(async () => await state(1, 'genotype') === 'cancelling', 'Selected historical Stage 1 did not enter cancelling');
  const genotypeCalls = requests().filter(call => call.run_id === fixture.genotype);
  assert.equal(genotypeCalls.length, 1);
  assert.equal(genotypeCalls[0].kwargs.expected_job_id, '34567');
  assert.equal(genotypeCalls[0].kwargs.expected_attempt, 1);
  setScheduler('34567', {state: '', accounted: 'CANCELLED'});
  await refresh(1, 'genotype', 'cancelled');

  await openStage(datasetB.id, fixture.unknown, 2);
  assert.equal(await state(2, 'expression'), 'unknown');
  assert.equal(await visible(selector(2, 'expression', 'cancel')), false, 'An unknown job ID offered cancellation');

  // A lost reply can mean a delivered request. Keep it unconfirmed until the
  // scheduler, rather than the clicked button, establishes termination.
  await openStage(datasetB.id, fixture.error, 2);
  setControl({fail_cancel: true});
  await click(selector(2, 'expression', 'cancel'));
  await click(selector(2, 'expression', 'cancel-confirm'));
  await until(() => js(`document.querySelector(${JSON.stringify(selector(2, 'expression', 'cancel-notice'))})?.textContent.includes('unconfirmed')`), 'Cancellation transport failure was not visible');
  assert.notEqual(await state(2, 'expression'), 'cancelled');
  setControl({fail_cancel: false});
  await refresh(2, 'expression', 'cancelling');
  assert.equal(await js(`document.querySelector(${JSON.stringify(selector(2, 'expression', 'cancel'))}).disabled`), true);
  assert.deepEqual(cancelled(), ['12345', '34567']);
  setScheduler('45678', {state: '', accounted: 'CANCELLED'});
  await refresh(2, 'expression', 'cancelled');

  await openStage(datasetB.id, fixture.running, 5);
  await until(async () => await state(5, 'network') === 'running', 'Seeded network job did not restore');
  await click(selector(5, 'network', 'cancel'));
  const runningTarget = await js(`document.querySelector(${JSON.stringify(selector(5, 'network', 'cancel-target'))}).textContent`);
  assert.ok(runningTarget.includes(fixture.running) && runningTarget.includes('23456') && runningTarget.includes('3'));
  await selectDataset(datasetA.id);
  await openStage(datasetB.id, fixture.running, 5);
  assert.equal(await visible(selector(5, 'network', 'cancel-confirmation')), false, 'Changing dataset retained a stale confirmation');
  await click(selector(5, 'network', 'cancel'));
  await context(false);
  await js(`window.dispatchEvent(new Event('workspace-request-remote-context'))`);
  assert.equal(await visible(selector(5, 'network', 'cancel-confirmation')), false, 'Disconnect left a usable cancellation confirmation');
  assert.equal(await js(`document.querySelector(${JSON.stringify(selector(5, 'network', 'cancel'))}).disabled`), true,
    'A later context request lost the fixture disconnection');
  assert.equal(await state(5, 'network'), 'running', 'Disconnect invented a terminal state');
  await context(true);

  const currentConfirmation = selector(5, 'network', 'cancel-confirmation');
  if (!await visible(currentConfirmation)) await click(selector(5, 'network', 'cancel'));
  await click(selector(5, 'network', 'cancel-confirm'));
  await until(async () => await state(5, 'network') === 'cancelling', 'Running network did not enter cancelling');
  assert.deepEqual([...new Set(cancelled())].sort(), ['12345', '23456', '34567', '777']);
  assert.ok(!cancelled().includes('888'), 'An unrelated child job was cancelled');
  const networkCalls = requests().filter(call => call.run_id === fixture.running);
  assert.ok(networkCalls.every(call => call.kwargs.expected_job_id === '23456' && call.kwargs.expected_attempt === 3));
  setScheduler('23456', {state: '', accounted: 'CANCELLED'});
  await refresh(5, 'network', 'cancelling');
  assert.equal(await state(5, 'network'), 'cancelling', 'Parent termination hid a still-running owned child');

  await running.backend.stop();
  replacement = new Backend(running.backend.options);
  assert.equal(await replacement.start(), running.origin);
  const loaded = once(window.webContents, 'did-finish-load');
  window.webContents.reload(); await loaded;
  const restarted = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.equal(restarted.starts.length, 2);
  assert.notEqual(restarted.starts[0], restarted.starts[1]);
  await context(true);
  await openStage(datasetB.id, fixture.running, 5);
  await until(async () => await state(5, 'network') === 'cancelling', 'Restart lost cancellation pending child termination');
  setScheduler('777', {state: '', accounted: 'CANCELLED'});
  await refresh(5, 'network', 'cancelled');
  assert.equal(await visible(selector(5, 'network', 'cancel')), false);
  assert.equal(await state(5, 'network'), 'cancelled');
  const final = JSON.parse(readFileSync(path.join(fixture.project, 'runs', fixture.running, 'steps/network.json'), 'utf8'));
  assert.equal(final.state, 'cancelled');
  assert.ok(final.cancel_requested_at && final.finished_at);
  assert.deepEqual([...new Set(cancelled())].sort(), ['12345', '23456', '34567', '777']);
  assert.equal(existsSync(path.join(temporary, 'forbidden.ndjson')), false, 'Unexpected command, job, submission or remote operation was attempted');
  assert.deepEqual(fingerprints(fixture.project, fixture.inputs), original, 'Cancellation changed source files, reviews, old attempts or run configuration');
  assert.deepEqual(await geometry(), [1650, 894, 53, 542]);
  await replacement.stop(); replacement = undefined;
  await running.quit();
  console.log('PASS: manual pending/running cancellation confirmation with exact job+attempt guards, dismiss/double-click/stale-target safety, disconnect and visible transport failure, only owned parent/children cancelled, child-drain state across Python restart, immutable originals and fixed geometry; controlled scheduler only, no actual SSH/submission/analysis');
}

verify().catch(async error => {console.error(error); await replacement?.forceStop(); await running?.backend.forceStop(); app.exit(1);});
