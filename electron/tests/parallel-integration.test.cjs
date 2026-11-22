'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');

const sourceRoot = process.env.SIGNET_INTEGRATION_SOURCE || path.join(__dirname, '../..');
const folder = path.join(sourceRoot, 'electron/renderer/features/workspace');
const clone = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check, message = 'Workspace did not settle') {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await settle();
  }
  assert.fail(message);
}
const catalog = [{id: 'example-chr1', name: ['甲資料組', 'Dataset A'], inputs: {genotype: ['study.ped', 'study.map']}},
  {id: 'dataset-b', name: ['乙資料組', 'Dataset B'], inputs: {}}];
function run(source, runId = 'shared', overrides = {}) {
  return {history_id: `${source === 'live' ? 'workspace' : source}--${runId}`, run_id: runId,
    revision: 'fixture', name: [runId, runId], dataset_id: 'example-chr1', source,
    origin: source === 'live' ? 'workspace' : 'archive', association: {status: 'recorded', method: 'manifest'},
    capabilities: {continue_analysis: source === 'live', stage_results: ['1', '6'], stage6_graph: true, assign_dataset: false},
    jobs: {genotype: {state: 'completed'}, visualize: {state: 'completed'}},
    operations: [], inputs: {}, status: 'completed', graph: {genes: 3, connections: 2}, issues: [], ...overrides};
}
const response = value => ({ok: true, status: 200, json: async () => clone(value)});
function stream(events) {
  const bytes = new TextEncoder().encode(events.map(event => JSON.stringify(event)).join('\n') + '\n');
  // Split a multibyte NDJSON stream to exercise the real streaming consumer.
  const chunks = [bytes.slice(0, 37), bytes.slice(37)];
  return {ok: true, body: {getReader: () => ({read: async () => chunks.length ? {value: chunks.shift(), done: false} : {done: true}})}};
}
const tool = (status, overrides = {}) => 'SIGNET_TOOL ' + JSON.stringify({operation_id: 'a'.repeat(32),
  tool_name: 'propose_workspace_stage', status, elapsed_ms: 1500, result_summary: status, ...overrides});

function harness(t, {rows = [run('live'), run('archive')], chats = [], initial = {}, reply = () => []} = {}) {
  const template = readFileSync(path.join(folder, 'index.html'), 'utf8');
  const html = template.replace('__INITIAL_CHAT__', JSON.stringify(initial)).replace('__MODEL__', 'fixture-selected-model');
  const dom = new JSDOM(html, {url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true});
  const {window} = dom, calls = [], contexts = {};
  window.ResizeObserver = class {observe() {} disconnect() {}};
  window.TextDecoder = TextDecoder;
  window.CSS = {escape: value => String(value).replace(/[^\w-]/g, '\\$&')};
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.eval(readFileSync(path.join(folder, '../chat/markdown.js'), 'utf8'));
  window.SignetInputValidation = {create: () => ({sync() {}})};
  for (const [name, key] of [['Genotype', 'genotype'], ['Expression', 'expression'], ['Adjustment', 'adjust'],
    ['Cis', 'cis'], ['Network', 'network'], ['Visualization', 'visualize']]) {
    window['mount' + name + 'Run'] = () => ({setContext(context) {contexts[key] = clone(context);}});
  }
  window.fetch = async (url, options = {}) => {
    const call = {url, options, body: options.body ? JSON.parse(options.body) : undefined};
    calls.push(call);
    if (url === '/stage6/history') return response({runs: rows, datasets: catalog});
    if (url === '/signet/datasets') return response({datasets: catalog});
    if (url.startsWith('/stage6/results?')) {
      const query = new URL('http://localhost' + url).searchParams;
      const source = query.get('source');
      const nodes = source === 'live' ? ['MEGF6', 'A', 'B'] : ['MEGF6', 'X', 'Y'];
      return response({run_id: query.get('run'), source, frequency: .45, top_networks: 1,
        graph: {nodes, edges: [{source: nodes[0], target: nodes[1], frequency: .8, coefficient: -.12},
          {source: nodes[1], target: nodes[2], frequency: .6, coefficient: .4}], counts: {genes: 3, connections: 2}}});
    }
    if (url === '/chat') return stream(reply(call, calls.filter(item => item.url === '/chat').length));
    if (url.startsWith('/bootstrap?')) return response({initial: chats.find(chat => url.includes(chat.session)) || {}});
    throw Error('Unexpected request ' + url);
  };
  window.eval(readFileSync(path.join(folder, 'workspace.js'), 'utf8'));
  const q = selector => window.document.querySelector(selector);
  const click = selector => {
    assert.ok(q(selector), 'Missing ' + selector);
    q(selector).dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
  };
  const choose = (selector, value) => {
    q(selector).value = value;
    q(selector).dispatchEvent(new window.Event('change', {bubbles: true}));
  };
  const send = async text => {
    q('#ml-input').value = text;
    q('#ml-composer').dispatchEvent(new window.Event('submit', {bubbles: true, cancelable: true}));
    await until(() => !q('#ml-send').disabled);
  };
  const openGraph = async historyId => {
    click('[data-nav-target="history"]');
    click(`[data-run-target="${historyId}"]`);
    click(`#ml-run-${historyId} [data-run-stage="6"]`);
    await until(() => q('#lens-stage6').dataset.historyId === historyId && q('#lens-stage6').dataset.runState === 'ready');
  };
  t.after(async () => {await settle(); await settle(); dom.window.close();});
  return {window, q, click, choose, send, openGraph, calls, contexts,
    ready: () => until(() => q('[data-run-target]') && !q('#ml-dataset-select').disabled)};
}

test('chat navigation changes the canonical source and linked gene used by the next request', async t => {
  const h = harness(t, {reply: (_call, turn) => turn === 1 ? [
    {type: 'workspace_action', text: {version: 1, action: 'select_gene', history_id: 'archive--shared', stage: 6, gene: 'X'}},
    {type: 'answer', text: 'Opened the saved result; analysis was not executed.'},
    {type: 'done', text: 'Conversation complete', status: 'completed'},
  ] : [{type: 'done', text: 'Conversation complete', status: 'completed'}]});
  await h.ready();
  await h.openGraph('workspace--shared');
  h.click('#lens-stage6 [data-gene="A"]');
  await h.send('Show the archived gene X');
  await until(() => h.q('#lens-stage6').dataset.historyId === 'archive--shared' && h.q('#lens-stage6').dataset.selectedGene === 'X');
  assert.equal(h.q('#lens-stage6 [data-gene="X"]').getAttribute('aria-pressed'), 'true');
  assert.equal(h.q('#lens-stage6 tbody').rows.length, 2);
  await h.send('Explain this selection');
  const requests = h.calls.filter(call => call.url === '/chat').map(call => call.body.workspace_context);
  assert.deepEqual(requests, [
    {version: 1, dataset_id: 'example-chr1', history_id: 'workspace--shared', stage: 6, selected_genes: ['A']},
    {version: 1, dataset_id: 'example-chr1', history_id: 'archive--shared', stage: 6, selected_genes: ['X']},
  ]);
  assert.deepEqual(h.calls.filter(call => call.options.method === 'POST').map(call => call.url), ['/chat', '/chat']);
});

test('an Agent proposal opens the exact manual review stage and reports needs review', async t => {
  const pending = run('live', 'pending', {jobs: {genotype: {state: 'completed'}, expression: {state: 'prepared'}},
    capabilities: {continue_analysis: true, stage_results: ['1'], stage6_graph: false}});
  const h = harness(t, {rows: [run('live'), pending], reply: () => [
    {type: 'progress', text: tool('needs_review')},
    {type: 'workspace_action', text: {version: 1, action: 'view_stage', history_id: 'workspace--pending', stage: 2}},
    {type: 'answer', text: 'Review the expression settings before confirming.'},
    {type: 'done', text: '回合需要確認；部分輸出已保留，請核對工作狀態，勿直接重送。', status: 'needs_review'},
  ]});
  await h.ready();
  h.choose('#ml-dataset-select', 'dataset-b');
  await h.send('Prepare the next stage');
  await until(() => h.q('#lens-stage2').hidden === false);
  assert.equal(h.contexts.expression.datasetId, 'example-chr1');
  assert.equal(h.contexts.expression.runId, 'pending');
  assert.deepEqual(h.contexts.expression.runs.map(row => row.history_id), ['workspace--pending']);
  assert.match(h.q('#ml-chat-status').textContent, /需要確認|Needs review/);
  assert.equal(h.calls.some(call => /submit|confirm|\/run\b/.test(call.url)), false);
});

test('failed tool activity keeps a failed overall turn and preserves a later successful turn', async t => {
  const h = harness(t, {reply: (_call, turn) => turn === 1 ? [
    {type: 'progress', text: tool('running')},
    {type: 'progress', text: tool('failed', {result_summary: 'Saved result could not be read'})},
    {type: 'answer', text: 'The earlier result is still available.'},
    {type: 'done', text: '回合失敗；部分回答與工具紀錄已保留。', status: 'failed'},
  ] : [{type: 'answer', text: 'A successful later conversation.'}, {type: 'done', text: 'Conversation complete', status: 'completed'}]});
  await h.ready();
  await h.send('Inspect the saved result');
  assert.match(h.q('#ml-chat-status').textContent, /失敗|Failed/);
  const events = [...h.window.document.querySelectorAll('.ml-chat-event')];
  assert.equal(events.length, 2, 'one turn plus one tool; running/failed must share the operation row');
  assert.match(events[0].querySelector('.ml-chat-event-state').textContent, /失敗|Failed/);
  assert.match(events[1].textContent, /propose_workspace_stage/);
  assert.match(events[1].querySelector('.ml-chat-event-state').textContent, /失敗|Failed/);
  assert.match(events[1].textContent, /1\.50/);
  assert.match(events[1].textContent, /Saved result could not be read/);
  await h.send('Explain the error');
  assert.doesNotMatch(h.q('#ml-chat-status').textContent, /失敗|Failed|需要確認|Needs review/);
  assert.match(events[0].querySelector('.ml-chat-event-state').textContent, /失敗|Failed/);
});

test('an error after an answer preserves partial output and its separate diagnostic', async t => {
  const h = harness(t, {reply: () => [
    {type: 'answer', text: 'Partial evidence: 12 samples were retained.'},
    {type: 'error', text: 'Provider connection interrupted; check job status.'},
    {type: 'done', text: '回合需要確認；部分輸出已保留，請核對工作狀態，勿直接重送。', status: 'needs_review'},
  ]});
  await h.ready();
  await h.send('Summarize the saved run');
  const transcript = h.q('#ml-chat-transcripts').textContent;
  assert.match(transcript, /Partial evidence: 12 samples were retained/);
  assert.match(transcript, /Provider connection interrupted/);
  assert.match(h.q('#ml-chat-status').textContent, /需要確認|Needs review/);
});

test('saved failed and needs-review turns replay independently when switching chats', async t => {
  const first = {session: 'first', title: 'Failed chat', messages: [{role: 'assistant', text: 'Preserved partial answer'}],
    events: [[tool('failed'), '回合失敗；部分回答與工具紀錄已保留。']]};
  const second = {session: 'second', title: 'Review chat', messages: [{role: 'assistant', text: 'Review this proposal'}],
    events: [[tool('needs_review'), '回合需要確認；部分輸出已保留，請核對工作狀態，勿直接重送。']]};
  const h = harness(t, {initial: {...first, sessions: [first, second]}, chats: [first, second]});
  await h.ready();
  const activityStates = index => [...h.q('#ml-chat-events').children[index].querySelectorAll('.ml-chat-event-state')].map(row => row.textContent);
  assert.equal(activityStates(0).length, 2, 'saved tool and saved turn each have a status');
  assert.ok(activityStates(0).every(state => /失敗|Failed/.test(state)));
  h.click('#ml-chat-records button:nth-child(2)');
  await until(() => h.q('#ml-chat-title').textContent === 'Review chat');
  assert.equal(activityStates(1).length, 2);
  assert.ok(activityStates(1).every(state => /需要確認|Needs review/.test(state)));
  assert.ok(activityStates(0).every(state => /失敗|Failed/.test(state)));
  assert.match(h.q('#ml-chat-transcripts').textContent, /Preserved partial answer/);
});

test('pointer drag, pan, zoom and edge inspection retain gene filtering and canonical run selection', async t => {
  const h = harness(t);
  await h.ready();
  await h.openGraph('workspace--shared');
  const stage = h.q('#lens-stage6'), graph = stage.querySelector('.s6-graph');
  // Supply the browser SVG geometry primitives absent from JSDOM.
  h.window.DOMPoint = class {constructor(x, y) {this.x = x; this.y = y;} matrixTransform() {return {x: this.x / 2, y: this.y / 2};}};
  graph.getScreenCTM = () => ({inverse: () => ({})});
  graph.setPointerCapture = () => {};
  const pointer = (target, type, x, y) => {
    const event = new h.window.MouseEvent(type, {bubbles: true, clientX: x, clientY: y, button: 0});
    Object.defineProperty(event, 'pointerId', {value: 7});
    target.dispatchEvent(event);
  };
  h.click('#lens-stage6 [data-gene="A"]');
  const gene = stage.querySelector('[data-gene="A"]');
  const original = gene.getAttribute('transform').match(/translate\(([^ ]+) ([^)]+)\)/).slice(1).map(Number);
  Object.defineProperty(gene, 'transform', {value: {baseVal: {consolidate: () => ({matrix: {e: original[0], f: original[1]}})}}});
  const edgeBefore = stage.querySelector('.s6-edge').getAttribute('d');
  pointer(gene, 'pointerdown', 20, 20);
  pointer(graph, 'pointermove', 60, 40);
  pointer(graph, 'pointerup', 60, 40);
  h.click('#lens-stage6 [data-gene="A"]');
  assert.equal(gene.getAttribute('transform'), `translate(${original[0] + 20} ${original[1] + 10})`);
  assert.notEqual(stage.querySelector('.s6-edge').getAttribute('d'), edgeBefore);
  assert.equal(stage.dataset.selectedGene, 'A');
  assert.equal(stage.querySelector('tbody').rows.length, 2);
  pointer(graph, 'pointerdown', 0, 0);
  pointer(graph, 'pointermove', 40, 20);
  pointer(graph, 'pointerup', 40, 20);
  h.click('#lens-stage6 .s6-graph');
  assert.equal(stage.querySelector('.s6-genes').getAttribute('transform'), 'translate(20 10)');
  stage.querySelector('.s6-graph-frame').dispatchEvent(new h.window.WheelEvent('wheel', {deltaY: -1, cancelable: true}));
  assert.equal(stage.querySelector('.s6-zoom input').value, '110');
  stage.querySelector('.s6-edge').dispatchEvent(new h.window.KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
  assert.match(stage.querySelector('.s6-summary').textContent, /0\.8.*-0\.12/);
  assert.equal(stage.dataset.selectedGene, 'A');
  assert.equal(stage.querySelector('tbody').rows.length, 2);
  h.click('#ml-stage6-back');
  await h.openGraph('archive--shared');
  h.click('#lens-stage6 [data-gene="X"]');
  h.click('#ml-stage6-back');
  await h.openGraph('workspace--shared');
  assert.equal(stage.dataset.selectedGene, 'A');
  assert.equal(stage.querySelector('[data-gene="A"]').getAttribute('aria-pressed'), 'true');
  assert.equal(stage.querySelector('tbody').rows.length, 2);
});

async function component(file, terminalFixture = false) {
  const result = await require('esbuild').build({entryPoints: [path.join(folder, file)], bundle: true,
    platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent',
    plugins: terminalFixture ? [{name: 'isolated-terminal-view', setup(build) {
      build.onResolve({filter: /^@xterm\//}, args => ({path: args.path, namespace: 'terminal-fixture'}));
      build.onLoad({filter: /.*/, namespace: 'terminal-fixture'}, args => ({contents: args.path.endsWith('.css') ? 'export default ""' : args.path.includes('addon-fit')
        ? 'export class FitAddon {fit(){}}'
        : `export class Terminal {cols=80;rows=24;loadAddon(){}open(){}clear(){}focus(){}dispose(){}writeln(){}write(_data,done){done?.()}onData(){return {dispose(){}}}onResize(){return {dispose(){}}}}`}));
    }}] : []});
  const loaded = {exports: {}};
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, loaded, loaded.exports);
  return loaded.exports;
}

function reactEnvironment(window) {
  const previous = new Map();
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLDialogElement', 'Node', 'MutationObserver', 'Event', 'MouseEvent', 'KeyboardEvent', 'navigator', 'ResizeObserver']) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {value: window[key], configurable: true});
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
  window.HTMLDialogElement.prototype.close = function () {this.open = false;};
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  };
}

test('the real model toolbar opens the Settings dialog without replacing its chip or submitting chat', async t => {
  const h = harness(t);
  await h.ready();
  const ids = [...h.window.document.querySelectorAll('[id]')].map(element => element.id);
  assert.equal(new Set(ids).size, ids.length, 'toolbar and React Settings mount must have unique IDs');
  const restore = reactEnvironment(h.window);
  const React = require('react'), {act} = React, {createRoot} = require('react-dom/client');
  const {WorkspaceModelSettings} = await component('WorkspaceModelSettings.tsx');
  let statusReads = 0, saves = 0;
  const bridge = {getStatus: async () => {statusReads++; return {ok: true, value: {provider: 'codex', geminiConfigured: false, encryptionAvailable: true}};},
    saveGeminiKey: async () => {saves++; return {ok: true, value: {restarting: false}};}, clearGeminiKey: async () => assert.fail('No key removal was requested')};
  const mount = h.q('#ml-model-settings');
  assert.equal(mount.tagName, 'DIV');
  const root = createRoot(mount);
  try {
    await act(async () => root.render(React.createElement(WorkspaceModelSettings, {workspace: h.q('#signet-lens-left-preview'), bridge, model: 'fixture-selected-model'})));
    const button = h.q('.ml-composer-toolbar button.ml-chip');
    assert.ok(button, 'Model chip must be a keyboard accessible button');
    assert.equal(button.type, 'button');
    h.q('#ml-input').value = 'Retain this unsent draft';
    await act(async () => button.click());
    const dialog = h.q('dialog.model-key-modal');
    assert.equal(dialog.open, true);
    assert.equal(h.window.document.querySelectorAll('.model-key-modal').length, 1);
    assert.match(dialog.textContent, /fixture-selected-model/);
    assert.equal(h.q('#ml-model-chip').textContent, 'fixture-selected-model');
    assert.equal(h.q('#ml-input').value, 'Retain this unsent draft');
    assert.equal(h.calls.some(call => call.url === '/chat'), false);
    assert.equal(saves, 0);
    assert.ok(statusReads >= 2, 'opening refreshes secure-key status');
    await act(async () => h.click('#ml-language'));
    assert.match(dialog.textContent, /Current model/);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('advanced terminal opens views without shell commands and closes only its owned session', async t => {
  const dom = new JSDOM('<div id="mount"></div>', {url: 'http://localhost', pretendToBeVisual: true});
  dom.window.ResizeObserver = class {observe() {} disconnect() {}};
  t.after(() => dom.window.close());
  const restore = reactEnvironment(dom.window);
  const React = require('react'), {act} = React, {createRoot} = require('react-dom/client');
  const {DevTerminalPanel} = await component('../devtools/DevTerminalPanel.tsx', true);
  const calls = [];
  const bridge = {raw: () => () => {}, rawHistory: async () => ({ok: true, value: []}), activity: () => () => {}, subscribe: () => () => {},
    open: async (id, cols, rows) => {calls.push(['open', id, cols, rows]); return {ok: true};},
    close: async id => {calls.push(['close', id]); return {ok: true};},
    input: async () => assert.fail('No terminal input was requested'), resize: async () => assert.fail('No terminal resize was requested'),
    ack: async () => assert.fail('No terminal output was sent')};
  const root = createRoot(dom.window.document.getElementById('mount'));
  const q = selector => dom.window.document.querySelector(selector);
  const button = text => [...dom.window.document.querySelectorAll('button')].find(element => element.textContent === text);
  const props = {bridge, connected: true, status: 'Connected', diagnostics: [], onConnect: () => assert.fail('Settings opening must not reconnect'), advanced: true};
  try {
    await act(async () => root.render(React.createElement(DevTerminalPanel, props)));
    await act(async () => q('.ssh-dev-launch').click());
    await act(async () => button('Interactive shell').click());
    assert.equal(q('[role="switch"]').getAttribute('aria-checked'), 'false');
    assert.deepEqual(calls, [], 'opening Settings and shell view must not open a shell');
    await act(async () => q('[role="switch"]').click());
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'open');
    const ownedId = calls[0][1];
    assert.equal(q('[role="switch"]').getAttribute('aria-checked'), 'true');
    await act(async () => button('Connection diagnostics').click());
    assert.equal(calls.length, 1, 'changing diagnostic tabs must not create another shell');
    await act(async () => button('Close panel').click());
    assert.deepEqual(calls[1], ['close', ownedId]);
    await act(async () => q('.ssh-dev-launch').click());
    await act(async () => button('Interactive shell').click());
    assert.equal(calls.length, 2, 'reopening must leave the new shell disabled');
    await act(async () => q('[role="switch"]').click());
    const secondId = calls[2][1];
    await act(async () => root.render(React.createElement(DevTerminalPanel, {...props, connected: false, status: 'Disconnected'})));
    assert.deepEqual(calls[3], ['close', secondId]);
    assert.match(q('.ssh-dev-panel').textContent, /Connect to SSH/);
    assert.equal(calls.length, 4);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
