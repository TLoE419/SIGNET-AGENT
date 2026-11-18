'use strict';

// Read production HTTP results from frozen local history. The fixture rejects all remote operations.
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app} = require('electron');
const {launch} = require('../main/app/main.cjs');

const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'signet-stage-timeline-')));
app.setPath('appData', temporary);
const wrapper = path.join(temporary, 'python-fixture');
process.env.SIGNET_HISTORY_TEST_ROOT = temporary;
process.env.SIGNET_HISTORY_TEST_PYTHON = path.resolve(__dirname, '../../.venv/bin/python');
process.env.SIGNET_HISTORY_TEST_ENTRY = path.join(__dirname, 'fixtures/history_backend.py');
writeFileSync(wrapper, '#!/bin/sh\nexec "$SIGNET_HISTORY_TEST_PYTHON" "$SIGNET_HISTORY_TEST_ENTRY" "$@"\n', {mode: 0o700});
process.env.SIGNET_PYTHON = wrapper;
let running;
const deadline = setTimeout(async () => {console.error('Timeline test timed out'); await running?.backend.forceStop(); app.exit(1);}, 60000);
app.on('will-quit', () => {clearTimeout(deadline); rmSync(temporary, {recursive: true, force: true});});

async function until(check, description) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error(description);
}
function fingerprint(folder) {
  const result = {};
  function visit(current) {
    for (const entry of readdirSync(current, {withFileTypes: true})) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) visit(filename);
      else result[filename] = createHash('sha256').update(readFileSync(filename)).digest('hex');
    }
  }
  visit(folder);
  return result;
}

async function verify() {
  running = await launch({provider: 'codex', visible: false, userData: path.join(temporary, 'app'), stateFile: path.join(temporary, 'chat.json')});
  const fixture = JSON.parse(readFileSync(path.join(temporary, 'fixture.json'), 'utf8'));
  const original = fingerprint(fixture.project);
  const js = source => running.window.webContents.executeJavaScript(source);
  const click = selector => js(`(() => {const node = document.querySelector(${JSON.stringify(selector)});
    if (!node?.getClientRects().length) throw Error('Missing visible control: ' + ${JSON.stringify(selector)});
    if (typeof node.click === 'function') node.click(); else node.dispatchEvent(new MouseEvent('click', {bubbles: true}));})()`);
  const choose = (selector, value) => js(`(() => {const node = document.querySelector(${JSON.stringify(selector)});
    node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('change', {bubbles: true}));})()`);
  const entry = stage => `[data-stage="${stage}"]`;
  const text = stage => js(`document.querySelector(${JSON.stringify(entry(stage))}).closest('.ml-stage-entry').textContent`);
  const preview = stage => js(`(() => {const node = document.querySelector(${JSON.stringify(entry(stage))}).closest('.ml-stage-entry');
    return {hidden: node.querySelector('.ml-stage-preview').hidden, marks: node.querySelector('.ml-stage-thumbnail').childElementCount};})()`);
  const geometry = () => js(`(() => {const node = document.querySelector('.ml-app');
    return [node.offsetWidth, node.offsetHeight, node.querySelector('.ml-rail').offsetWidth, node.querySelector('.ml-chat').offsetWidth];})()`);
  await until(() => js(`!!document.querySelector('#ml-language')`), 'Workspace did not mount');
  await click('[data-nav-target="history"]');
  await choose('#ml-history-scope', 'all');
  const id = 'archive--' + fixture.shared;
  await until(() => js(`!!document.querySelector('[data-run-target="${id}"]')?.getClientRects().length`), 'Frozen archive missing');
  await click(`[data-run-target="${id}"]`);
  for (let stage = 1; stage <= 6; stage++) {
    assert.equal((await preview(stage)).hidden, true);
    assert.match(await text(stage), /開啟這個階段以讀取保存摘要/);
    await click(`#ml-run-${id} [data-run-stage="${stage}"]`);
    await until(async () => !(await preview(stage)).hidden, 'Actual saved thumbnail missing for Stage ' + stage);
    assert.ok((await preview(stage)).marks > 0);
    assert.doesNotMatch(await text(stage), /<span|[{}]/);
    if (stage === 3) assert.doesNotMatch(await text(stage), /排程工作核心數/);
    else assert.match(await text(stage), stage === 5 ? /監控工作核心數: 2/ : /排程工作核心數: 2/);
    assert.deepEqual(await geometry(), [1650, 894, 53, 542]);
    if (stage === 3) {
      assert.match(await text(stage), /主成分數: 2.*配對樣本 6.*保留樣本 6.*排除樣本 0/s);
      assert.equal(await js(`document.querySelector('[data-stage="3"]').closest('.ml-stage-entry').querySelectorAll('svg circle').length`), 6);
    }
    if (stage === 6) {
      assert.match(await text(stage), /頻率門檻: 0\.45.*基因數 3 · 連線數 3/s);
      await click('#lens-stage6 [data-gene="MEGF6"]');
      assert.equal(await js(`document.querySelectorAll('#lens-stage6 tbody tr').length`), 2);
    }
    await click(stage === 3 ? '#ml-stage3-back' : stage === 6 ? '#ml-stage6-back' : '#ml-archive-stage-back');
    assert.equal(await js(`document.querySelector('#ml-timeline').dataset.historyId`), id);
  }
  await click(`#ml-run-${id} [data-run-stage="3"]`);
  await until(() => js(`document.querySelector('#lens-history-stage3').dataset.runState === 'ready'`), 'Stage 3 return failed');
  await click('#ml-stage3-back');
  await click(`#ml-run-${id} [data-run-stage="6"]`);
  await until(() => js(`document.querySelector('#lens-stage6').dataset.runState === 'ready'`), 'Stage 6 return failed');
  assert.equal(await js(`document.querySelector('#lens-stage6').dataset.selectedGene`), 'MEGF6');
  assert.equal(await js(`document.querySelectorAll('#lens-stage6 tbody tr').length`), 2);
  await click('#ml-language');
  assert.match(await text(3), /Principal components: 2.*Matched samples 6.*Retained samples 6/s);
  assert.match(await text(6), /Frequency threshold: 0\.45.*Genes 3 · Edges 3/s);
  assert.deepEqual(await geometry(), [1650, 894, 53, 542]);
  assert.deepEqual(fingerprint(fixture.project), original, 'History browsing changed saved inputs, settings or results');
  assert.equal(existsSync(path.join(temporary, 'forbidden-remote.ndjson')), false);
  assert.equal((await running.backend.stop()).code, 0);
  await running.quit();
  console.log('PASS: real saved summaries/settings/thumbnails for all six stages, zero counts and PCs, bilingual return navigation, preserved gene/table selection, immutable local records, no remote calls, fixed 1650x894/53/542 geometry');
}

app.whenReady().then(verify).then(() => app.quit()).catch(async error => {
  console.error(error.stack || error);
  await running?.backend.forceStop();
  app.exit(1);
});
