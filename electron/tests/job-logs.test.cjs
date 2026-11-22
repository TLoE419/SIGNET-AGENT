'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const folder = path.join(__dirname, '../renderer/features/workspace');
const code = readFileSync(path.join(folder, 'job-logs.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check) {for (let i = 0; i < 80; i++) {if (check()) return; await settle();} assert.fail('Log view did not settle');}
const reply = (value, status = 200) => ({ok: status < 400, status, json: async () => clone(value)});
const context = overrides => ({historyId: 'workspace--shared', runId: 'shared', source: 'live', datasetId: 'dataset-a',
  step: 'expression', number: 2, current: true, recordFile: 'steps/expression.json', recordIdentity: 'saved-identity',
  visible: true, record: {job_id: '123', state: 'failed', reason: 'Saved failure reason', exit_code: '1',
    missing_outputs: ['res/expression.txt'], failure_hints: ['Saved R error']}, ...overrides});
function result(call, target, overrides = {}) {
  const query = new URL('http://localhost' + call.url).searchParams;
  return {history_id: target.historyId, run_id: target.runId, source: target.source, identity: target.recordIdentity,
    step: target.step, attempt: target.number ?? null, job_id: target.record.job_id ?? null,
    stream: query.get('stream'), origin: 'remote', status: 'ready', lines: ['saved log line'], truncated: false,
    max_bytes: 65536, ...overrides};
}
function harness(t, initial, handler) {
  const dom = new JSDOM('<!doctype html><div id="parent"><div id="host"></div></div>', {url: 'http://localhost', runScripts: 'outside-only'});
  const {window} = dom;
  t.after(async () => {await settle(); view?.destroy(); window.close();});
  window.eval(code);
  const calls = []; let current = initial;
  window.fetch = async (url, options = {}) => {
    const call = {url, options}; calls.push(call);
    return handler ? handler(call, current) : reply(result(call, current));
  };
  const host = window.document.querySelector('#host');
  let view = window.SignetJobLogs.mount({host, token: 'test-token'}); view.setContext(initial);
  const q = selector => host.querySelector(selector);
  const open = () => {q('[data-job-logs]').open = true; q('[data-job-logs]').dispatchEvent(new window.Event('toggle'));};
  const close = () => {q('[data-job-logs]').open = false; q('[data-job-logs]').dispatchEvent(new window.Event('toggle'));};
  const click = selector => {assert.ok(q(selector)); q(selector).click();};
  return {window, host, calls, q, open, close, click,
    setContext(next) {current = next; view.setContext(next);},
    remote(overrides = {}) {window.dispatchEvent(new window.CustomEvent('workspace-remote-context', {detail: {connected: true, identity: 'user@host|session', environmentKey: 'root', ...overrides}}));},
    remount() {view.destroy(); view = window.SignetJobLogs.mount({host, token: 'test-token'}); view.setContext(current);},
  };
}

test('closed logs make no request and saved errors remain readable offline', async t => {
  const h = harness(t, context()); await settle();
  assert.equal(h.calls.length, 0);
  assert.match(h.q('[data-job-error-details]').textContent, /Saved failure reason.*res\/expression.txt.*Saved R error/s);
  h.setContext(context({record: {...context().record, reason: 'New saved failure reason'}}));
  assert.equal(h.calls.length, 0); assert.match(h.q('[data-job-error-details]').textContent, /New saved failure reason/);
});

test('manual streams send exact source/job/attempt guards and render log text without HTML execution', async t => {
  const target = context();
  const h = harness(t, target, call => reply(result(call, target, {lines: ['<img src=x onerror="window.logExecuted=true">', 'R error: missing file'], truncated: true})));
  h.open(); await until(() => h.q('[data-job-logs]').dataset.logState === 'ready');
  const query = new URL('http://localhost' + h.calls[0].url);
  assert.equal(query.pathname, '/signet/history/workspace--shared/steps/expression/log');
  assert.equal(query.searchParams.get('attempt'), '2'); assert.equal(query.searchParams.get('job_id'), '123');
  assert.equal(query.searchParams.get('identity'), 'saved-identity'); assert.equal(query.searchParams.get('lines'), '50');
  assert.equal(h.calls[0].options.headers['X-Chat-Token'], 'test-token');
  assert.match(h.q('[data-job-log-text]').textContent, /<img src=x/); assert.equal(h.q('[data-job-log-text] img'), null);
  assert.equal(h.window.logExecuted, undefined); assert.match(h.q('[data-job-log-status]').textContent, /truncated/);
  h.click('[data-job-log-stream="err"]'); await until(() => h.calls.length === 2 && h.q('[data-job-logs]').dataset.logState === 'ready');
  assert.equal(new URL('http://localhost' + h.calls[1].url).searchParams.get('stream'), 'err');
  h.click('[data-job-log-stream="submission"]'); await until(() => h.calls.length === 3 && h.q('[data-job-logs]').dataset.logState === 'ready');
  assert.equal(new URL('http://localhost' + h.calls[2].url).searchParams.get('stream'), 'submission');
  h.close(); h.open(); await settle(); assert.equal(h.calls.length, 3);
});

for (const [status, message] of [[404, /missing or was not saved/], [412, /disconnected/]]) {
  test(`a cached ${status} stays distinct from empty and does not retry on rerender`, async t => {
    const h = harness(t, context(), () => reply({error: 'Saved server reason'}, status));
    h.open(); await until(() => h.q('[data-job-logs]').dataset.logState === 'error');
    assert.match(h.q('[data-job-log-status]').textContent, message);
    assert.equal(h.q('[data-job-log-text]').hidden, true);
    h.remount(); await settle(); await settle();
    assert.equal(h.q('[data-job-logs]').open, true); assert.equal(h.calls.length, 1);
    assert.match(h.q('[data-job-log-status]').textContent, message);
    h.click('[data-job-log-refresh]'); await until(() => h.calls.length === 2 && h.q('[data-job-logs]').dataset.logState === 'error');
    assert.equal(h.calls.length, 2);
  });
}

test('an explicit empty result differs from a missing or unreadable log', async t => {
  const target = context(); const h = harness(t, target, call => reply(result(call, target, {status: 'empty', lines: [], origin: 'local'})));
  h.open(); await until(() => h.q('[data-job-logs]').dataset.logState === 'ready');
  assert.match(h.q('[data-job-log-status]').textContent, /currently empty/);
  assert.match(h.q('[data-job-log-source]').textContent, /Locally saved log/);
  assert.equal(h.q('[data-job-log-text]').hidden, true);
});

test('closing or hiding a pending log aborts it and discards its late response', async t => {
  let finish; const target = context();
  const h = harness(t, target, () => new Promise(resolve => {finish = resolve;}));
  h.open(); await until(() => h.calls.length === 1); h.close();
  assert.equal(h.calls[0].options.signal.aborted, true);
  finish(reply(result(h.calls[0], target, {lines: ['late old response']}))); await settle();
  assert.doesNotMatch(h.q('[data-job-log-text]').textContent, /late old/);
  h.open(); await until(() => h.calls.length === 2);
  h.setContext({...target, visible: false}); assert.equal(h.calls[1].options.signal.aborted, true);
  finish(reply(result(h.calls[1], target, {lines: ['hidden response']}))); await settle();
  assert.doesNotMatch(h.q('[data-job-log-text]').textContent, /hidden response/);
});

test('loaded selected stream and open state survive a same-target remount without another read', async t => {
  const h = harness(t, context()); h.open(); await until(() => h.q('[data-job-logs]').dataset.logState === 'ready');
  h.click('[data-job-log-stream="err"]'); await until(() => h.calls.length === 2 && h.q('[data-job-logs]').dataset.logState === 'ready');
  h.remount(); await settle(); await settle();
  assert.equal(h.q('[data-job-logs]').open, true);
  assert.equal(h.q('[data-job-log-stream="err"]').getAttribute('aria-pressed'), 'true');
  assert.equal(h.q('[data-job-log-text]').textContent, 'saved log line'); assert.equal(h.calls.length, 2);
});

test('source, attempt and remote identity switches cannot display a late response for the previous target', async t => {
  const first = context(), second = context({historyId: 'archive--shared', source: 'archive', number: 1, current: false, recordFile: 'steps/expression.attempt1.json'});
  const pending = []; const h = harness(t, first, (call, target) => new Promise(resolve => pending.push({call, target, resolve})));
  h.open(); await until(() => pending.length === 1); h.setContext(second);
  assert.equal(h.calls[0].options.signal.aborted, true); assert.equal(h.q('[data-job-logs]').open, false);
  pending[0].resolve(reply(result(pending[0].call, first, {lines: ['wrong source text']}))); await settle();
  assert.doesNotMatch(h.q('[data-job-log-text]').textContent, /wrong source/);
  h.open(); await until(() => pending.length === 2); h.remote({identity: 'other@host|session'});
  assert.equal(h.calls[1].options.signal.aborted, true); assert.equal(h.q('[data-job-logs]').open, false);
  pending[1].resolve(reply(result(pending[1].call, second, {lines: ['wrong remote text']}))); await settle();
  assert.doesNotMatch(h.q('[data-job-log-text]').textContent, /wrong remote/);
});

test('a response for another attempt is rejected without claiming its text belongs to the selected attempt', async t => {
  const target = context(), h = harness(t, target, call => reply(result(call, target, {attempt: 1, lines: ['old attempt secret']})));
  h.open(); await until(() => h.q('[data-job-logs]').dataset.logState === 'error');
  assert.match(h.q('[data-job-log-status]').textContent, /has not been confirmed empty/);
  assert.equal(h.q('[data-job-log-text]').hidden, true); assert.doesNotMatch(h.host.textContent, /old attempt secret/);
});

test('old Agent operations use their revision-bound endpoint and plans never request execution logs', async t => {
  const target = context({historyId: 'recorded--shared', source: 'recorded', step: undefined, number: null,
    operation: 'network', recordRevision: 'operation-hash', recordFile: 'network.json', record: {returncode: 1, reason: 'Recorded tool failure'}});
  const h = harness(t, target, call => reply(result(call, target, {operation: 'network', record_revision: 'operation-hash', origin: 'local'})));
  h.open(); await until(() => h.q('[data-job-logs]').dataset.logState === 'ready');
  assert.match(h.calls[0].url, /\/operations\/network\/log\?/);
  assert.equal(new URL('http://localhost' + h.calls[0].url).searchParams.get('record_revision'), 'operation-hash');
  assert.equal(h.q('[data-job-log-stream="submission"]').hidden, true);
  assert.match(h.q('[data-job-error-details]').textContent, /Exit code1/);
  h.setContext({...target, prepared: true, recordFile: 'network.plan.json', recordRevision: undefined});
  h.open(); await settle();
  assert.equal(h.calls.length, 1); assert.match(h.q('[data-job-log-status]').textContent, /prepared plan/);
  assert.equal(h.q('[data-job-log-stream="out"]').disabled, true);
  assert.equal(h.q('[data-job-log-stream="err"]').disabled, true);
});

test('current stage controller passes the normalized run identity into the shared log view', async t => {
  const target = context({number: 1, record: {...context().record, run_id: 'shared', step: 'expression', state: 'failed'}});
  const h = harness(t, target);
  const panel = h.window.document.createElement('section'); h.window.document.body.append(panel);
  h.window.eval(readFileSync(path.join(folder, 'genotype-run.js'), 'utf8'));
  const controller = h.window.mountExpressionRun({panel, token: 'test-token'});
  controller.setContext({datasetId: 'dataset-a', visible: true, runId: 'shared', runs: [{history_id: target.historyId,
    run_id: 'shared', source: 'live', origin: 'workspace', record_identity: 'saved-identity', capabilities: {continue_analysis: true},
    jobs: {genotype: {state: 'completed'}, expression: target.record}}]});
  const logs = panel.querySelector('[data-expression-logs] [data-job-logs]');
  assert.match(logs.textContent, /Saved failure reason/); assert.equal(h.calls.length, 0);
  logs.open = true; logs.dispatchEvent(new h.window.Event('toggle'));
  await until(() => logs.dataset.logState === 'ready');
  assert.equal(h.calls.length, 1); assert.match(h.calls[0].url, /workspace--shared\/steps\/expression\/log/);
});
