'use strict';

// Reads real saved retry schemas through the production backend and UI. The
// fixture denies SSH and never submits, retries, cancels, or executes analysis.
const assert = require('node:assert/strict');
const {once} = require('node:events');
const {createHash} = require('node:crypto');
const {existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app} = require('electron');
const {Backend} = require('../main/backend/backend.cjs');
const {launch} = require('../main/app/main.cjs');

const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'signet-attempts-')));
app.setPath('appData', temporary);
const repo = path.resolve(__dirname, '../..');
const wrapper = path.join(temporary, 'python-fixture');
process.env.SIGNET_HISTORY_TEST_ROOT = temporary;
process.env.SIGNET_HISTORY_TEST_PYTHON = process.env.SIGNET_PYTHON || path.join(repo, '.venv/bin/python');
process.env.SIGNET_HISTORY_TEST_ENTRY = path.join(__dirname, 'fixtures/attempts_backend.py');
writeFileSync(wrapper, '#!/bin/sh\nexec "$SIGNET_HISTORY_TEST_PYTHON" "$SIGNET_HISTORY_TEST_ENTRY" "$@"\n', {mode: 0o700});
process.env.SIGNET_PYTHON = wrapper;
let running;
let replacement;
const deadline = setTimeout(async () => {
  console.error('Attempt history integration test timed out');
  await replacement?.forceStop();
  await running?.backend.forceStop();
  app.exit(1);
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

function fingerprints(folders) {
  const values = {};
  function visit(folder) {
    for (const item of readdirSync(folder, {withFileTypes: true})) {
      const filename = path.join(folder, item.name);
      if (item.isDirectory()) visit(filename);
      else values[filename] = createHash('sha256').update(readFileSync(filename)).digest('hex');
    }
  }
  folders.forEach(visit);
  return values;
}

async function verify() {
  running = await launch({provider: 'none', visible: false, userData: path.join(temporary, 'app'),
    stateFile: path.join(temporary, 'chat.json')});
  const {window} = running;
  const fixturePath = path.join(temporary, 'fixture.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const folders = [path.join(fixture.project, 'runs'), path.join(fixture.project, 'data')];
  const original = fingerprints(folders);
  const js = async source => {
    const result = await window.webContents.executeJavaScript(`(async () => {
      try {return {value:await (${source})};}
      catch(error) {return {error:error.stack||String(error)};}
    })()`);
    if (result.error) throw Error(result.error + '\nAttempt history expression: ' + source.slice(0, 600));
    return result.value;
  };
  const click = selector => js(`(() => {const control=document.querySelector(${JSON.stringify(selector)});
    if(!control?.getClientRects().length)throw Error('Missing visible attempt history control: '+${JSON.stringify(selector)});
    control.click();})()`);
  const history = async () => {
    const reply = await js(`fetch('/stage6/history',{headers:{'X-Chat-Token':document.querySelector('meta[name="chat-token"]').content}})
      .then(async response=>({status:response.status,value:await response.json()}))`);
    assert.equal(reply.status, 200);
    return reply.value;
  };
  const geometry = () => js(`(() => {const root=document.querySelector('.ml-app');return [root.offsetWidth,root.offsetHeight,
    root.querySelector('.ml-rail').offsetWidth,root.querySelector('.ml-chat').offsetWidth];})()`);
  const open = async id => {
    await click('[data-nav-target="history"]');
    await js(`(() => {const select=document.querySelector('#ml-history-scope');select.value='all';
      select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(() => js(`!!document.querySelector('[data-run-target="${id}"]')?.getClientRects().length`), 'Recorded run did not appear: ' + id);
    await click(`[data-run-target="${id}"]`);
  };
  const shared = 'workspace--' + fixture.shared;
  const archive = 'archive--' + fixture.shared;
  const generic = 'recorded--' + fixture.generic;
  const job = (id, step) => `#ml-run-${id} [data-history-job="${step}"]`;
  const attempt = (id, step, number) => job(id, step) + ` [data-history-attempt="${number}"]`;
  const selectStage = (id, stage) => click(`#ml-run-${id} [data-history-select-stage="${stage}"]`);
  const activePanel = id => `#ml-run-${id} [data-history-stage-panel]:not([hidden])`;
  const settings = id => click(activePanel(id) + ' [data-history-detail-tab="settings"]');
  const picker = id => activePanel(id) + ' [data-history-attempt-select]';
  const pickAttempt = (id, recordFile) => js(`(() => {
    const select=document.querySelector(${JSON.stringify(picker(id))});
    if(!select?.getClientRects().length)throw Error('Saved attempt picker is hidden.');
    select.value=${JSON.stringify(recordFile)};
    select.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);

  await until(() => js(`!!document.querySelector('#ml-chat-title').textContent`), 'Workspace did not mount');
  assert.deepEqual(await geometry(), [1650, 894, 68, 542]);
  const initial = await history();
  const liveRecord = initial.runs.find(row => row.history_id === shared);
  const archivedRecord = initial.runs.find(row => row.history_id === archive);
  const genericRecord = initial.runs.find(row => row.history_id === generic);
  assert.equal(liveRecord.jobs.genotype.job_id, '703');
  assert.equal(liveRecord.jobs.genotype.settings.mind, '0.3');
  assert.deepEqual(liveRecord.attempts.genotype.map(entry => [entry.number, entry.current, entry.availability]),
    [[1, false, 'recorded'], [2, false, 'recorded'], [3, true, 'recorded']]);
  for (const [number, status, state] of [[1, 'recorded_failed', 'failed'], [2, 'recorded_cancelled', 'cancelled'], [3, 'recorded_completed', 'completed']]) {
    const entry = liveRecord.attempts.genotype.find(entry => entry.number === number);
    assert.equal(entry.record.job_id, String(700 + number));
    assert.equal(entry.record.settings.mind, '0.' + number);
    assert.equal(entry.record.resources.cpus, number);
    assert.equal(entry.record.state, state);
    assert.equal(entry.result.status, status);
    assert.equal(entry.record.history[0].state, 'submitted');
  }
  assert.deepEqual(liveRecord.attempts.genotype[0].result.outputs, [{path: 'res/resg/signet_Geno', status: 'missing'}]);
  assert.ok(liveRecord.attempts.genotype[2].result.outputs.every(output => output.status === 'downloaded'));
  assert.equal(archivedRecord.attempts.genotype.length, 1);
  assert.equal(archivedRecord.attempts.genotype[0].number, null, 'Archive must not borrow the workspace attempt number');
  assert.equal(archivedRecord.attempts.genotype[0].record.settings.mind, '0.1');
  const gap = genericRecord.attempts.expression.find(entry => entry.number === 2);
  assert.equal(gap.availability, 'missing');
  assert.equal(gap.record, null);
  const invalid = genericRecord.attempts.expression.find(entry => entry.number === 5);
  assert.equal(invalid.availability, 'invalid');
  assert.equal(invalid.record, null);
  assert.ok(!JSON.stringify(genericRecord.attempts).includes('must-not-be-adopted'));

  await open(shared);
  await selectStage(shared, 1);
  await settings(shared);
  assert.deepEqual(await js(`(() => {
    const select = document.querySelector(${JSON.stringify(picker(shared))});
    return [...select.querySelectorAll('optgroup')].map(group => ({
      label: group.querySelector('legend').textContent,
      records: [...group.querySelectorAll('option')].map(option => option.value),
    }));
  })()`), [
    {label: 'Current record', records: liveRecord.attempts.genotype.filter(entry => entry.current).map(entry => entry.record_file)},
    {label: 'Previous attempts', records: liveRecord.attempts.genotype.filter(entry => !entry.current).reverse().map(entry => entry.record_file)},
  ]);
  for (const number of [1, 2, 3]) {
    const selector = attempt(shared, 'genotype', number);
    await pickAttempt(shared, liveRecord.attempts.genotype.find(entry => entry.number === number).record_file);
    assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).dataset.attemptCurrent`), String(number === 3));
    const values = await js(`(() => {const entry=document.querySelector(${JSON.stringify(selector)});return {
      text:entry.textContent,settings:entry.querySelector('[data-history-saved="settings"]').textContent,
      result:entry.querySelector('[data-history-attempt-result]').textContent,
      events:entry.querySelector('[data-history-attempt-events]').textContent};})()`);
    assert.ok(values.text.includes(String(700 + number)) && values.settings.includes('0.' + number));
    assert.ok(values.text.includes(`2026-11-10 0${number}:00:00`));
    assert.ok(values.events.includes(`2026-11-10 0${number}:05:00`));
    assert.doesNotMatch(values.text, /-08:?00/);
    if (number === 1) {
      assert.match(values.text, /Required outputs are missing\./);
      assert.match(values.text, /Controlled attempt-one failure/);
      assert.match(values.result, /res\/resg\/signet_Geno/);
      assert.ok(!values.result.includes('work/res/resg/signet_Genotype.sampleID'), 'Current downloads leaked into a failed attempt');
    }
    if (number === 3) assert.match(values.result, /work\/res\/resg\/signet_Genotype.sampleID/);
  }
  const priorRecord = liveRecord.attempts.genotype[0].record_file;
  await pickAttempt(shared, priorRecord);
  assert.equal(await js(`document.querySelector(${JSON.stringify(picker(shared))}).value`), priorRecord,
    'The selected earlier attempt did not open');
  await open(archive);
  await selectStage(archive, 1);
  await settings(archive);
  assert.equal(await js(`document.querySelector(${JSON.stringify(picker(archive))}) === null`), true,
    'A single archived attempt offered a selector');
  assert.ok(await js(`(() => {
    const label = document.querySelector(${JSON.stringify(activePanel(archive) + ' [data-history-attempt-single]')});
    return Boolean(label?.getClientRects().length && label.textContent.includes('Attempt number not recorded'));
  })()`), 'A single archived attempt did not display its recorded number status');
  assert.equal(await js(`document.querySelectorAll(${JSON.stringify(job(archive, 'genotype') + ' [data-history-attempt]')}).length`), 1);
  assert.ok(!await js(`document.querySelector(${JSON.stringify(job(archive, 'genotype'))}).textContent.includes('703')`),
    'Same-named workspace retry leaked into the archive');

  await open(generic);
  await selectStage(generic, 2);
  await settings(generic);
  for (const number of [1, 2, 3, 4, 5]) {
    const selector = attempt(generic, 'expression', number);
    await pickAttempt(generic, genericRecord.attempts.expression.find(entry => entry.number === number).record_file);
    assert.ok(await js(`!!document.querySelector(${JSON.stringify(selector)})`));
    if (number === 2 || number === 5) {
      assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).dataset.attemptAvailable`), 'false');
      assert.equal(await js(`document.querySelectorAll(${JSON.stringify(selector + ' [data-history-saved="settings"]')}).length`), 0);
    }
  }
  assert.ok(!await js(`document.querySelector(${JSON.stringify(job(generic, 'expression'))}).textContent.includes('0.98765')`));
  assert.deepEqual(fingerprints(folders), original, 'Reading attempts rewrote saved records or scientific outputs');

  await running.backend.stop();
  replacement = new Backend(running.backend.options);
  assert.equal(await replacement.start(), running.origin);
  const loaded = once(window.webContents, 'did-finish-load');
  window.webContents.reload(); await loaded;
  const reopened = await history();
  assert.deepEqual(reopened.runs.find(row => row.history_id === shared).attempts, liveRecord.attempts);
  assert.deepEqual(reopened.runs.find(row => row.history_id === generic).attempts, genericRecord.attempts);
  const restarted = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.equal(restarted.starts.length, 2);
  assert.notEqual(restarted.starts[0], restarted.starts[1]);
  await open(shared);
  await selectStage(shared, 1);
  assert.equal(await js(`document.querySelector(${JSON.stringify(picker(shared))}).options.length`), 3);
  assert.deepEqual(fingerprints(folders), original);
  assert.equal(existsSync(path.join(temporary, 'forbidden-remote.ndjson')), false);
  assert.deepEqual(await geometry(), [1650, 894, 68, 542]);
  await replacement.stop(); replacement = undefined;
  await running.quit();
  console.log('PASS: all saved retry attempts, individual settings/jobs/times/failure/result evidence, missing and invalid archives, current-versus-previous/source isolation, actual Python restart, immutable originals and fixed geometry; local records only, no SSH/retry/analysis');
}

verify().catch(async error => {console.error(error); await replacement?.forceStop(); await running?.backend.forceStop(); app.exit(1);});
