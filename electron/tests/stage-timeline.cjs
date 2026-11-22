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

function checkSidebarMotion(reduced) {
  const query = selector => document.querySelector(selector);
  const nav = view => `[data-nav-target="${view}"]`;
  const pane = view => `.ml-nav-pane[data-nav-left="${view}"]`;
  const app = query('.ml-app');
  const sidebar = query('#ml-chat-panel');
  const resizeAnimation = () => app.getAnimations().find(animation => animation.transitionProperty === '--ml-sidebar-open');
  const finishSidebarResize = () => {
    resizeAnimation()?.finish();
    sidebar.getAnimations().find(animation => animation.transitionProperty === 'display')?.finish();
  };
  const animationFor = element => element.getAnimations().find(animation => animation.animationName === 'ml-sidebar-enter');
  function check(condition, message) {
    if (!condition) throw Error(message);
  }
  function checkEntrance(selector) {
    const panel = query(selector);
    check(!panel.hidden && panel.getClientRects().length, `Sidebar content not visible: ${selector}`);
    const animation = animationFor(panel);
    if (reduced) {
      check(!animation, `Sidebar animated under reduced motion: ${selector}`);
      return;
    }
    check(animation, `Sidebar did not animate: ${selector}`);
    animation.pause();
    animation.currentTime = 0;
    const enteringLeft = panel.getBoundingClientRect().left;
    const enteringOpacity = Number(getComputedStyle(panel).opacity);
    animation.finish();
    check(panel.getBoundingClientRect().left > enteringLeft && Number(getComputedStyle(panel).opacity) > enteringOpacity,
      `Sidebar did not slide in from the left and fade in: ${selector}`);
    return animation;
  }
  check(matchMedia('(prefers-reduced-motion: reduce)').matches === reduced, 'Motion preference was not set');
  for (const view of ['settings', 'data', 'history']) {
    query(nav(view)).click();
    checkEntrance(pane(view));
  }
  query(nav('analysis')).click();
  query('#ml-agent-tab').click();
  checkEntrance('#ml-agent-view');
  query('#ml-agent-tab').dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
  check(document.activeElement === query('#ml-stage-tab'), 'Keyboard switch did not focus the Stage tab');
  checkEntrance('#ml-stage-view');
  query('#ml-agent-tab').click();
  checkEntrance('#ml-agent-view');
  for (const drawer of ['chat-list', 'chat-activity']) {
    query(`#ml-${drawer}-toggle`).click();
    checkEntrance(`#ml-${drawer}`);
  }
  query('#ml-chat-activity-toggle').click();
  query(nav('settings')).click();
  const previousAnimation = checkEntrance(pane('settings'));
  query('#ml-close').click();
  check(sidebar.hidden && sidebar.inert && document.activeElement === query(nav('settings')),
    'Closing the sidebar did not return focus to the selected navigation button');
  finishSidebarResize();
  check(!animationFor(query(pane('settings'))), 'Hidden settings retained an active animation');
  query(nav('settings')).click();
  const reopenedAnimation = checkEntrance(pane('settings'));
  finishSidebarResize();
  if (!reduced) check(previousAnimation !== reopenedAnimation, 'Reopening the sidebar did not replay the entrance');
  query(nav('settings')).click();
  check(!animationFor(query(pane('settings'))), 'Selecting the visible settings sidebar replayed its entrance');

  function checkRightResize(page, trigger, start, end) {
    trigger.click();
    const transition = resizeAnimation();
    check(Boolean(transition) !== reduced, 'Right panel motion does not match the motion preference');
    if (transition) {
      transition.pause();
      transition.currentTime = transition.effect.getTiming().duration / 2;
      const middle = page.getBoundingClientRect();
      check(middle.left > Math.min(start, end) && middle.left < Math.max(start, end) && middle.right === innerWidth,
        'Right panel did not slide while keeping its right edge anchored');
    }
    finishSidebarResize();
    const settled = page.getBoundingClientRect();
    check(settled.left === end && settled.right === innerWidth, 'Right panel did not fill its settled track');
  }
  for (const view of ['analysis', 'data', 'history', 'settings']) {
    const button = query(nav(view));
    button.click();
    const page = [...app.querySelectorAll(':scope > :is(.ml-workspace, .ml-nav-workspace)')].find(panel => panel.checkVisibility());
    check(page, `Right panel missing on ${view}`);
    const expandedLeft = page.getBoundingClientRect().left;
    const railRight = query('.ml-rail').getBoundingClientRect().right;
    checkRightResize(page, query('#ml-close'), expandedLeft, railRight);
    checkRightResize(page, button, railRight, expandedLeft);
  }
}

async function checkConnectionTableMotion(reduced) {
  const table = document.querySelector('#lens-stage6-table');
  const summary = table.querySelector('summary');
  const height = () => table.getBoundingClientRect().height;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (const open of [false, true]) {
    const before = height();
    summary.click();
    if (table.open !== open) throw Error('The native disclosure state did not change immediately');
    const immediate = height();
    if (!reduced) await wait(100);
    const middle = height();
    if (!reduced) await wait(200);
    const after = height();
    if (open ? after <= before : after >= before) throw Error('The connection table did not reach its target size');
    if (reduced ? immediate !== after : middle <= Math.min(before, after) || middle >= Math.max(before, after)) {
      throw Error('Connection table motion does not match the motion preference');
    }
  }
}

async function verify() {
  running = await launch({provider: 'none', visible: false, userData: path.join(temporary, 'app'), stateFile: path.join(temporary, 'chat.json')});
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
  const resize = async (width, height) => {
    running.window.setContentSize(width, height);
    await until(() => js(`innerWidth === ${width} && innerHeight === ${height}`), `Viewport did not resize to ${width} × ${height}`);
  };
  const startLayout = () => js(`(() => {
    const bounds = selector => document.querySelector(selector).getBoundingClientRect();
    const rail = bounds('.ml-rail'), chat = bounds('.ml-chat'), start = bounds('#ml-start');
    const input = bounds('#ml-input'), send = bounds('#ml-send');
    const fits = (rect, pane) => rect.left >= pane.left && rect.right <= pane.right &&
      rect.top >= pane.top && rect.bottom <= pane.bottom;
    const startActions = [...document.querySelectorAll('#ml-start button')];
    return {
      panesFill: rail.left === 0 && rail.right === chat.left && chat.right === start.left &&
        start.right === innerWidth && [rail, chat, start].every(rect => rect.top === 0 && rect.bottom === innerHeight),
      square: getComputedStyle(document.querySelector('#ml-start')).borderRadius === '0px',
      composerFits: [input, send].every(rect => fits(rect, chat)),
      startActionsFit: startActions.length === 4 && startActions.every(button => fits(button.getBoundingClientRect(), start)),
    };
  })()`);
  const assertFullPage = async selector => {
    assert.ok(await js(`(() => {
      const page = document.querySelector(${JSON.stringify(selector)});
      const box = page.getBoundingClientRect();
      const sidebar = document.querySelector('.ml-chat').getBoundingClientRect();
      const style = getComputedStyle(page);
      return box.left === sidebar.right && box.top === 0 && box.right === innerWidth &&
        box.bottom === innerHeight && style.borderRadius === '0px' &&
        [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].every(width => width === '0px');
    })()`), `Page should fill its pane without a rounded frame: ${selector}`);
  };
  await until(() => js(`!!document.querySelector('#ml-chat-title').textContent`), 'Workspace did not mount');
  await js(`Promise.all(document.querySelector('#ml-agent-view').getAnimations().map(animation => animation.finished.catch(() => {})))`);
  await js(`(() => {
    const reply = document.createElement('div');
    reply.className = 'ml-saved-reply ml-live-reply';
    for (let line = 0; line < 12; line++) {
      const paragraph = document.createElement('p');
      paragraph.textContent = 'Review the input files in Data and confirm the analysis settings before opening Stage 1.';
      reply.append(paragraph);
    }
    document.querySelector('#ml-chat-transcripts > div').append(reply);
  })()`);
  for (const [width, height] of [[1320, 600], [900, 820], [760, 460], [1650, 894]]) {
    await resize(width, height);
    assert.deepEqual(await startLayout(), {panesFill: true, square: true, composerFits: true, startActionsFit: true},
      `Starting workspace at ${width} × ${height}`);
    if (width === 760) {
      assert.ok(await js(`(() => {
        const thread = document.querySelector('#ml-thread');
        thread.scrollTop = thread.scrollHeight;
        return thread.scrollTop > 0 && document.documentElement.scrollHeight === innerHeight;
      })()`), 'Long conversations must scroll within the chat pane');
    }
  }
  await click('#ml-close');
  await until(() => js(`(() => {
    const start = document.querySelector('#ml-start').getBoundingClientRect();
    return start.left === document.querySelector('.ml-rail').getBoundingClientRect().right &&
      start.right === innerWidth;
  })()`), 'Closing chat must give the right pane its space');
  await click('[data-nav-target="data"]');
  await until(() => js(`document.querySelector('.ml-chat').offsetWidth === 542`), 'Sidebar must regain its open width');
  await until(() => js(`!document.querySelector('#ml-dataset-select').disabled`), 'Dataset catalog missing');
  await choose('#ml-dataset-select', fixture.datasets[0].id);
  await resize(900, 820);
  await assertFullPage('[data-nav-right="data"]');
  await click('[data-nav-target="analysis"]');
  await click('#ml-stage-tab');
  for (let stage = 1; stage <= 6; stage++) {
    await click(entry(stage));
    await assertFullPage(stage === 6 ? '#lens-stage6-run' : `#lens-stage${stage}`);
  }
  await click('[data-nav-target="settings"]');
  await assertFullPage('#lens-stage6-run');
  await resize(1650, 894);
  await click('[data-nav-target="analysis"]');
  await click('#ml-agent-tab');
  await click('[data-nav-target="history"]');
  await choose('#ml-history-scope', 'all');
  const id = 'archive--' + fixture.shared;
  await until(() => js(`!!document.querySelector('[data-run-target="${id}"]')?.getClientRects().length`), 'Frozen archive missing');
  await click(`[data-run-target="${id}"]`);
  await assertFullPage('#ml-run-details');
  const openHistoryStage = async stage => {
    await click(`#ml-run-${id} [data-history-select-stage="${stage}"]`);
    await click(`#ml-run-${id} [data-run-stage="${stage}"]`);
  };
  for (let stage = 1; stage <= 6; stage++) {
    assert.equal((await preview(stage)).hidden, true);
    assert.match(await text(stage), /Open this stage to load its saved summary/);
    await openHistoryStage(stage);
    await until(async () => !(await preview(stage)).hidden, 'Actual saved thumbnail missing for Stage ' + stage);
    await assertFullPage(stage === 3 ? '#lens-history-stage3' : stage === 6 ? '#lens-stage6' : '#lens-history-stage');
    assert.ok((await preview(stage)).marks > 0);
    assert.doesNotMatch(await text(stage), /<span|[{}]/);
    if (stage === 3) assert.doesNotMatch(await text(stage), /Scheduled job cores/);
    else assert.match(await text(stage), stage === 5 ? /Controller job cores: 2/ : /Scheduled job cores: 2/);
    assert.deepEqual(await geometry(), [1650, 894, 68, 542]);
    if (stage === 3) {
      assert.match(await text(stage), /Principal components: 2.*Matched samples 6.*Retained samples 6.*Excluded samples 0/s);
      assert.equal(await js(`document.querySelector('[data-stage="3"]').closest('.ml-stage-entry').querySelectorAll('svg circle').length`), 6);
    }
    if (stage === 6) {
      assert.match(await text(stage), /Frequency threshold: 0\.45.*Genes 3 · Edges 3/s);
      await click('#lens-stage6 [data-gene="MEGF6"]');
      assert.equal(await js(`document.querySelectorAll('#lens-stage6 tbody tr').length`), 2);
    }
    await click(stage === 3 ? '#ml-stage3-back' : stage === 6 ? '#ml-stage6-back' : '#ml-archive-stage-back');
    assert.equal(await js(`document.querySelector('#ml-timeline').dataset.historyId`), id);
  }
  await openHistoryStage(3);
  await until(() => js(`document.querySelector('#lens-history-stage3').dataset.runState === 'ready'`), 'Stage 3 return failed');
  await click('#ml-stage3-back');
  await openHistoryStage(6);
  await until(() => js(`document.querySelector('#lens-stage6').dataset.runState === 'ready'`), 'Stage 6 return failed');
  assert.equal(await js(`document.querySelector('#lens-stage6').dataset.selectedGene`), 'MEGF6');
  assert.match(await text(3), /Principal components: 2.*Matched samples 6.*Retained samples 6/s);
  assert.match(await text(6), /Frequency threshold: 0\.45.*Genes 3 · Edges 3/s);
  await click('[data-nav-target="data"]');
  await choose('#ml-dataset-select', fixture.datasets[1].id);
  await click('[data-nav-target="analysis"]');
  await click('#ml-stage-tab');
  await click(entry(6));
  await choose('#ml-stage6-run', id);
  await until(() => js(`document.querySelector('#lens-stage6').dataset.historyId === '${id}'`), 'Analysis archive did not load');
  await click('#lens-stage6 [data-gene="MEGF6"]');
  for (const stage of [3, 1, 2, 4, 5]) {
    await click(entry(stage));
    const panel = stage === 3 ? '#lens-history-stage3' : '#lens-history-stage';
    await until(() => js(`!document.querySelector('${panel}').hidden && document.querySelector('${panel}').dataset.runState === 'ready'`),
      'Analysis timeline opened an execution form instead of saved Stage ' + stage);
    assert.equal(await js(`document.querySelector('${panel}').dataset.historyId`), id);
    assert.equal(await js(`document.querySelector('#lens-stage${stage}').hidden`), true);
    const context = await js(`(()=>{const detail={};window.dispatchEvent(new CustomEvent('workspace-context-request',{detail}));return detail.context})()`);
    assert.equal(context.history_id, id); assert.equal(context.stage, stage);
    assert.equal(await js(`document.querySelector('.ml-app').dataset.nav`), 'analysis');
    assert.deepEqual(await geometry(), [1650, 894, 68, 542]);
  }
  await click(entry(6));
  await until(() => js(`!document.querySelector('#lens-stage6').hidden && document.querySelector('#lens-stage6').dataset.historyId === '${id}'`),
    'Analysis timeline did not restore its archived graph');
  assert.equal(await js(`document.querySelector('#lens-stage6').dataset.selectedGene`), 'MEGF6');
  assert.equal(await js(`document.querySelectorAll('#lens-stage6 tbody tr').length`), 2);
  await resize(900, 520);
  assert.ok(await js(`(() => {
    const page = document.querySelector('#lens-stage6');
    const graph = page.querySelector('.s6-graph-frame').getBoundingClientRect();
    const table = page.querySelector('.ml-result-dock');
    const separated = graph.bottom < table.getBoundingClientRect().top;
    page.scrollTop = page.scrollHeight;
    return separated && page.scrollTop > 0 && table.getBoundingClientRect().bottom <= page.getBoundingClientRect().bottom;
  })()`), 'Short windows must keep the graph and connection table separate and reachable');
  const debuggerProtocol = running.window.webContents.debugger;
  debuggerProtocol.attach('1.3');
  try {
    for (const value of ['no-preference', 'reduce']) {
      await debuggerProtocol.sendCommand('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value}]});
      await js(`(${checkSidebarMotion.toString()})(${value === 'reduce'})`);
      await click('[data-nav-target="analysis"]');
      await click('#ml-stage-tab');
      await click(entry(6));
      await until(() => js(`!document.querySelector('#lens-stage6').hidden`), 'Stage 6 was not visible for the table motion check');
      const tableMotionError = await js(`(async () => {
        try {
          await (${checkConnectionTableMotion.toString()})(${value === 'reduce'});
        } catch (error) {
          return error.message;
        }
      })()`);
      assert.equal(tableMotionError, undefined, tableMotionError);
    }
  } finally {
    debuggerProtocol.detach();
  }
  assert.deepEqual(fingerprint(fixture.project), original, 'History browsing changed saved inputs, settings or results');
  assert.equal(existsSync(path.join(temporary, 'forbidden-remote.ndjson')), false);
  assert.equal((await running.backend.stop()).code, 0);
  await running.quit();
  console.log('PASS: edge-to-edge layout, sidebar and table resize motion, reduced motion, and all six saved stages');
}

app.whenReady().then(verify).then(() => app.quit()).catch(async error => {
  console.error(error.stack || error);
  await running?.backend.forceStop();
  app.exit(1);
});
