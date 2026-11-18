'use strict';

// Production HTTP/history controllers over frozen local records only. No SSH,
// scheduler, container, scientific command, or user profile is available here.
const assert = require('node:assert/strict');
const {once} = require('node:events');
const {createHash} = require('node:crypto');
const {existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app} = require('electron');
const {Backend} = require('../main/backend/backend.cjs');
const {launch} = require('../main/app/main.cjs');

const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'signet-history-')));
app.setPath('appData', temporary);
const repo = path.resolve(__dirname, '../..');
const wrapper = path.join(temporary, 'python-fixture');
process.env.SIGNET_HISTORY_TEST_ROOT = temporary;
process.env.SIGNET_HISTORY_TEST_PYTHON = process.env.SIGNET_PYTHON || path.join(repo, '.venv/bin/python');
process.env.SIGNET_HISTORY_TEST_ENTRY = path.join(__dirname, 'fixtures/history_backend.py');
writeFileSync(wrapper, '#!/bin/sh\nexec "$SIGNET_HISTORY_TEST_PYTHON" "$SIGNET_HISTORY_TEST_ENTRY" "$@"\n', {mode: 0o700});
process.env.SIGNET_PYTHON = wrapper;
let running;
let replacement;
const deadline = setTimeout(async () => {
  console.error('History integration test timed out');
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
  throw Error(typeof description === 'function' ? await description() : description);
}

function fingerprint(folders) {
  const result = {};
  function visit(folder) {
    for (const item of readdirSync(folder, {withFileTypes: true})) {
      const filename = path.join(folder, item.name);
      if (item.isDirectory()) visit(filename);
      else result[filename] = createHash('sha256').update(readFileSync(filename)).digest('hex');
    }
  }
  for (const folder of folders) visit(folder);
  return result;
}

async function verify() {
  running = await launch({provider: 'codex', visible: false, userData: path.join(temporary, 'app'),
    stateFile: path.join(temporary, 'chat.json')});
  const {window} = running;
  const fixturePath = path.join(temporary, 'fixture.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const [datasetA, datasetB] = fixture.datasets;
  const originals = [path.join(fixture.project, 'runs'), path.join(fixture.project, 'data/datasets'),
    path.join(fixture.project, 'data/stage6-results'), ...fixture.datasets.map(dataset => dataset.folder)];
  const frozen = fingerprint(originals);
  const js = async source => {
    const result = await window.webContents.executeJavaScript(`(async () => {
      try {return {value:await (${source})};}
      catch(error) {return {error:error.stack||String(error)};}
    })()`);
    if (result.error) throw Error(result.error + '\nHistory test expression: ' + source.slice(0, 600));
    return result.value;
  };
  const click = selector => js(`(() => {const control=document.querySelector(${JSON.stringify(selector)});
    if(!control?.getClientRects().length)throw Error('Missing visible history control: '+${JSON.stringify(selector)});
    if(typeof control.click==='function')control.click();
    else control.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`);
  const request = (url, body, method = body ? 'PATCH' : 'GET') => js(`fetch(${JSON.stringify(url)},{method:${JSON.stringify(method)},
    headers:{'Content-Type':'application/json','X-Chat-Token':document.querySelector('meta[name="chat-token"]').content},
    body:${JSON.stringify(body ? JSON.stringify(body) : undefined)}}).then(async reply=>({status:reply.status,value:await reply.json()}))`);
  const history = async () => {const reply = await request('/stage6/history'); assert.equal(reply.status, 200); return reply.value;};
  const rows = () => js(`[...document.querySelectorAll('#ml-run-list [data-run-target]')].filter(row=>row.getClientRects().length).map(row=>row.dataset.runTarget).sort()`);
  const setSelect = (selector, value) => js(`(() => {const input=document.querySelector(${JSON.stringify(selector)});
    if(!input)throw Error('Missing select '+${JSON.stringify(selector)});input.value=${JSON.stringify(value)};
    input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const selectDataset = async id => {
    await click('[data-nav-target="data"]');
    await until(() => js(`[...document.querySelector('#ml-dataset-select').options].some(option=>option.value===${JSON.stringify(id)})`), 'Dataset catalog did not mount');
    await setSelect('#ml-dataset-select', id);
  };
  const scope = async value => {
    await click('[data-nav-target="history"]');
    await until(() => js(`!!document.querySelector('#ml-history-scope')`), 'History scope control did not mount');
    await setSelect('#ml-history-scope', value);
  };
  const open = async id => {
    await scope('all');
    await until(() => js(`!!document.querySelector('[data-run-target="${id}"]')?.getClientRects().length`), 'History record is not visible: ' + id);
    await click(`[data-run-target="${id}"]`);
    await until(() => js(`!!document.querySelector('#ml-run-${id}')?.getClientRects().length`), 'History detail did not open: ' + id);
  };
  const detailText = id => js(`document.querySelector('#ml-run-${id}').textContent`);
  const geometry = () => js(`(() => {const root=document.querySelector('.ml-app');return [root.offsetWidth,root.offsetHeight,
    root.querySelector('.ml-rail').offsetWidth,root.querySelector('.ml-chat').offsetWidth];})()`);
  const ids = {generic: 'recorded--' + fixture.generic, agent: 'recorded--' + fixture.agent,
    configured: 'recorded--' + fixture.configured, visualization: 'recorded--' + fixture.visualization,
    live: 'workspace--' + fixture.shared, archive: 'archive--' + fixture.shared, orphan: 'archive--' + fixture.orphan};

  await until(() => js(`!!document.querySelector('#ml-language')`), 'Workspace did not mount');
  assert.deepEqual(await geometry(), [1650, 894, 53, 542]);
  await click('#ml-language');
  await selectDataset(datasetA.id);
  const initial = await history();
  assert.deepEqual(initial.runs.map(run => run.history_id).sort(), Object.values(ids).sort());
  const generic = initial.runs.find(run => run.history_id === ids.generic);
  assert.equal(generic.dataset_id, null, 'Matching current input paths must not silently assign historical ownership');
  assert.equal(generic.origin, 'slurm');
  assert.equal(generic.jobs.genotype.settings.mind, '0.2');
  assert.equal(generic.jobs.expression.state, 'failed');
  assert.equal(generic.capabilities.continue_analysis, false);
  assert.deepEqual(generic.capabilities.stage_results, [], 'Unavailable historical result readers must not become clickable links');
  const agent = initial.runs.find(run => run.history_id === ids.agent);
  const completed = agent.operations.find(operation => operation.operation === 'genotype_tcga');
  const prepared = agent.operations.find(operation => operation.operation === 'network');
  assert.equal(completed.status, 'process_completed');
  assert.equal(completed.settings_evidence, 'not_recorded');
  assert.deepEqual(completed.settings, {}, 'Today’s mutable config was invented as historical settings');
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.executed, false);
  assert.equal(prepared.settings_evidence, 'prepared_snapshot');
  assert.equal(prepared.settings.nboots, '7');
  assert.equal(initial.runs.find(run => run.history_id === ids.configured).status, 'configured');
  assert.equal(initial.runs.find(run => run.history_id === ids.orphan).dataset_id, 'retired-dataset');

  await scope('current');
  assert.deepEqual(await rows(), [ids.live], 'Dataset A must show only its workspace run');
  await selectDataset(datasetB.id);
  await scope('current');
  assert.deepEqual(await rows(), [ids.archive], 'Same-ID archive belongs to dataset B');
  await scope('unclassified');
  assert.deepEqual(await rows(), [ids.agent, ids.configured, ids.generic, ids.visualization].sort());
  await scope('all');
  assert.deepEqual(await rows(), Object.values(ids).sort(), 'All history lost a source or a retired dataset archive');

  await open(ids.generic);
  for (const step of ['genotype', 'expression']) await click(`#ml-run-${ids.generic} [data-history-job="${step}"] summary`);
  const genericText = await detailText(ids.generic);
  assert.ok(genericText.includes('0.2') && genericText.includes('fixture-31') && genericText.includes('fixture-32'));
  for (const filename of datasetA.inputs.genotype) assert.ok(genericText.includes(filename));
  assert.equal(await js(`document.querySelectorAll('#ml-run-${ids.generic} [data-run-stage]').length`), 0);
  assert.equal(await js(`!!document.querySelector('#ml-run-${ids.generic} [data-history-job="genotype"] [data-history-saved="settings"]').getClientRects().length`), true);
  await open(ids.agent);
  for (const operation of ['genotype_tcga', 'network']) await click(`#ml-run-${ids.agent} [data-history-operation="${operation}"] summary`);
  const agentText = await detailText(ids.agent);
  assert.ok(!agentText.includes('9876') && !agentText.includes('0.98765'), 'Mutable config values leaked into the historical detail');
  assert.match(agentText, /Process completed; scientific outputs unverified/);
  assert.match(agentText, /Prepared; execution not recorded/);
  assert.equal(await js(`document.querySelector('#ml-run-${ids.agent} [data-history-operation="genotype_tcga"] [data-settings-evidence]').dataset.settingsEvidence`), 'not_recorded');
  assert.equal(await js(`document.querySelector('#ml-run-${ids.agent} [data-history-operation="network"] [data-settings-evidence]').dataset.settingsEvidence`), 'prepared_snapshot');
  assert.equal(await js(`document.querySelectorAll('#ml-run-${ids.agent} [data-history-operation]').length`), 2);
  assert.equal(await js(`document.querySelectorAll('#ml-run-${ids.agent} [data-run-stage]').length`), 0);
  await open(ids.configured);
  assert.equal(await js(`document.querySelectorAll('#ml-run-${ids.configured} [data-history-job],#ml-run-${ids.configured} [data-history-operation],#ml-run-${ids.configured} [data-run-stage]').length`), 0);

  // The same canonical ID must retain two distinct source-specific viewers.
  await open(ids.live);
  await click(`[data-history-id="${ids.live}"][data-run-stage="1"]`);
  await until(() => js(`document.querySelector('#lens-history-stage')?.dataset.runState==='ready'`), 'Workspace result did not reopen');
  assert.equal(await js(`document.querySelector('#lens-history-stage [data-stage-setting="mind"]').textContent`), '0.2');
  await open(ids.archive);
  await click(`[data-history-id="${ids.archive}"][data-run-stage="1"]`);
  await until(() => js(`document.querySelector('#lens-history-stage')?.dataset.runState==='ready'&&document.querySelector('#lens-history-stage').dataset.historyId===${JSON.stringify(ids.archive)}`),
    'The same-ID archived Stage 1 did not select its explicit source');
  assert.equal(await js(`document.querySelector('#lens-history-stage [data-stage-setting="mind"]').textContent`), '0.1');
  await open(ids.archive);
  await click(`[data-history-id="${ids.archive}"][data-run-stage="3"]`);
  await until(() => js(`document.querySelector('#lens-history-stage3')?.dataset.runState==='ready'&&document.querySelector('#lens-history-stage3').dataset.historyId===${JSON.stringify(ids.archive)}`),
    'Archived Stage 3 did not use its explicit source');
  assert.equal(await js(`document.querySelector('#lens-history-stage3 [data-s3-components]').textContent`), '2');
  for (const id of [ids.archive, ids.visualization]) {
    await open(id);
    await click(`[data-history-id="${id}"][data-run-stage="6"]`);
    await until(() => js(`document.querySelector('#lens-stage6')?.dataset.runState==='ready'&&document.querySelector('#lens-stage6').dataset.runId===${JSON.stringify(id===ids.archive ? fixture.shared : fixture.visualization)}`),
      'Source-specific Stage 6 result did not reopen: ' + id);
    assert.equal(await js(`document.querySelectorAll('#lens-stage6 tbody tr').length`), 3);
    await click('#lens-stage6 [data-gene="MEGF6"]');
    assert.equal(await js(`document.querySelectorAll('#lens-stage6 tbody tr').length`), 2);
  }

  await open(ids.generic);
  const form = `[data-history-assignment="${ids.generic}"]`;
  await setSelect(form + ' [data-history-dataset]', datasetA.id);
  await click(form + ' [data-history-assign]');
  await until(async () => (await history()).runs.find(run => run.history_id === ids.generic)?.association.status === 'manual', 'Manual dataset assignment did not save');
  await selectDataset(datasetA.id);
  await scope('current');
  assert.deepEqual(await rows(), [ids.generic, ids.live].sort(), 'Assigned historical run did not join the selected dataset');
  await scope('unclassified');
  assert.deepEqual(await rows(), [ids.agent, ids.configured, ids.visualization].sort());
  const stale = await request('/signet/history/' + ids.generic + '/dataset', {dataset_id: datasetB.id, revision: '0'.repeat(64)});
  assert.equal(stale.status, 409, 'A stale history assignment must not overwrite newer evidence');
  const forbidden = await request('/signet/history/' + ids.archive + '/dataset', {dataset_id: datasetA.id,
    revision: initial.runs.find(run => run.history_id === ids.archive).revision});
  assert.equal(forbidden.status, 409, 'Manual organization must not replace explicit archived dataset ownership');
  const overlay = path.join(fixture.project, 'data/workspace-history.json');
  const savedOverlay = readFileSync(overlay);
  assert.deepEqual(fingerprint(originals), frozen, 'History assignment changed original inputs, settings, records, or archived results');

  await running.backend.stop();
  replacement = new Backend(running.backend.options);
  assert.equal(await replacement.start(), running.origin);
  const restarted = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.equal(restarted.starts.length, 2);
  assert.notEqual(restarted.starts[0], restarted.starts[1]);
  const loaded = once(window.webContents, 'did-finish-load');
  window.webContents.reload(); await loaded;
  await selectDataset(datasetA.id);
  await scope('current');
  assert.deepEqual(await rows(), [ids.generic, ids.live].sort(), 'Assignment did not survive an actual Python process restart');
  const reopened = await history();
  const assigned = reopened.runs.find(run => run.history_id === ids.generic);
  assert.equal(assigned.association.status, 'manual');
  assert.equal(assigned.dataset_id, datasetA.id);
  assert.equal(assigned.jobs.genotype.settings.mind, '0.2');
  assert.deepEqual(readFileSync(overlay), savedOverlay, 'Reopening rewrote the saved organization metadata');
  assert.deepEqual(fingerprint(originals), frozen, 'Reopening history changed frozen provenance or results');
  assert.equal(existsSync(path.join(temporary, 'forbidden-remote.ndjson')), false, 'Read-only history attempted a remote operation');
  assert.deepEqual(await geometry(), [1650, 894, 53, 542]);
  await replacement.stop(); replacement = undefined;
  await running.quit();
  console.log('PASS: workspace/Slurm/Agent/configured/archive history, source-scoped duplicate IDs, retired datasets, honest saved settings and execution states, capability-only result links with MEGF6 filtering, manual assignment across Python restart, immutable originals and fixed geometry; local records only, no SSH/jobs/analysis');
}

verify().catch(async error => {console.error(error); await replacement?.forceStop(); await running?.backend.forceStop(); app.exit(1);});
