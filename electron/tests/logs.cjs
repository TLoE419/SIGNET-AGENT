'use strict';

// Production history/log readers over owned temporary files only. Submissions,
// cancellation, containers, science and actual SSH are forbidden by the fixture.
const assert = require('node:assert/strict');
const {once} = require('node:events');
const {createHash} = require('node:crypto');
const {existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app} = require('electron');
const {Backend} = require('../main/backend/backend.cjs');
const {launch} = require('../main/app/main.cjs');

const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'signet-logs-')));
app.setPath('appData', temporary);
const repo = path.resolve(__dirname, '../..');
const wrapper = path.join(temporary, 'python-fixture');
process.env.SIGNET_LOGS_ROOT = temporary;
process.env.SIGNET_LOGS_PYTHON = process.env.SIGNET_PYTHON || path.join(repo, '.venv/bin/python');
process.env.SIGNET_LOGS_ENTRY = path.join(__dirname, 'fixtures/logs_backend.py');
writeFileSync(wrapper, '#!/bin/sh\nexec "$SIGNET_LOGS_PYTHON" "$SIGNET_LOGS_ENTRY" "$@"\n', {mode: 0o700});
process.env.SIGNET_PYTHON = wrapper;
let running;
let replacement;
const deadline = setTimeout(async () => {
  console.error('Read-only log integration test timed out');
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

function fingerprints(folders) {
  const records = {};
  function visit(folder) {
    for (const item of readdirSync(folder, {withFileTypes: true})) {
      const filename = path.join(folder, item.name);
      if (item.isDirectory()) visit(filename);
      else {
        const value = statSync(filename);
        try {records[filename] = createHash('sha256').update(readFileSync(filename)).digest('hex');}
        catch (error) {
          if (error.code !== 'EACCES') throw error;
          records[filename] = `unreadable:${value.mode}:${value.size}:${value.mtimeMs}`;
        }
      }
    }
  }
  folders.forEach(visit);
  return records;
}

async function verify() {
  running = await launch({provider: 'codex', visible: false, userData: path.join(temporary, 'app'),
    stateFile: path.join(temporary, 'chat.json')});
  const {window} = running;
  const fixturePath = path.join(temporary, 'fixture.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const frozenFolders = [fixture.project, fixture.remote];
  const original = fingerprints(frozenFolders);
  const readLines = filename => existsSync(filename) ? readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean) : [];
  const requests = () => readLines(path.join(temporary, 'requests.ndjson'));
  const remoteRequests = () => readLines(path.join(temporary, 'remote-requests.ndjson'));
  const js = async source => {
    const result = await window.webContents.executeJavaScript(`(async () => {
      try {return {value:await (${source})};}catch(error){return {error:error.stack||String(error)};}
    })()`);
    if (result.error) throw Error(result.error + '\nLog expression: ' + source.slice(0, 500));
    return result.value;
  };
  const click = selector => js(`(() => {const control=document.querySelector(${JSON.stringify(selector)});
    if(!control?.getClientRects().length)throw Error('Missing visible log control: '+${JSON.stringify(selector)});
    control.click();})()`);
  const request = url => js(`fetch(${JSON.stringify(url)},{headers:{'X-Chat-Token':document.querySelector('meta[name="chat-token"]').content}})
    .then(async response=>({status:response.status,value:await response.json()}))`);
  const geometry = () => js(`(() => {const root=document.querySelector('.ml-app');return [root.offsetWidth,root.offsetHeight,
    root.querySelector('.ml-rail').offsetWidth,root.querySelector('.ml-chat').offsetWidth];})()`);
  const setControl = changes => {
    const file = path.join(temporary, 'control.json');
    writeFileSync(file, JSON.stringify({...JSON.parse(readFileSync(file, 'utf8')), ...changes}));
  };
  const context = connected => js(`window.dispatchEvent(new CustomEvent('workspace-remote-context',{detail:{connected:${connected},
    identity:'isolated-log-reader',environmentKey:'owned-read-only-files'}}))`);
  const openRun = async id => {
    await click('[data-nav-target="history"]');
    await js(`(() => {const select=document.querySelector('#ml-history-scope');select.value='all';
      select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(() => js(`!!document.querySelector('[data-run-target="${id}"]')?.getClientRects().length`), 'Log history row did not appear: ' + id);
    await click(`[data-run-target="${id}"]`);
  };
  const host = (id, number) => `#ml-run-${id} [data-history-job="expression"] [data-history-attempt="${number}"] [data-history-job-logs]`;
  const text = selector => js(`document.querySelector(${JSON.stringify(selector + ' [data-job-log-text]')})?.textContent||''`);
  const status = selector => js(`document.querySelector(${JSON.stringify(selector + ' [data-job-log-status]')})?.textContent||''`);
  const logState = selector => js(`document.querySelector(${JSON.stringify(selector + ' [data-job-logs]')})?.dataset.logState`);
  const openLogs = async selector => {
    await js(`(() => {const host=document.querySelector(${JSON.stringify(selector)});
      const details=host?.matches('[data-job-logs]')?host:host?.querySelector('[data-job-logs]');
      if(!details)throw Error('Log drawer is missing: '+${JSON.stringify(selector)});
      if(!details.open)details.querySelector('summary').click();})()`);
  };
  const closeLogs = selector => js(`(() => {const host=document.querySelector(${JSON.stringify(selector)});
    const details=host.matches('[data-job-logs]')?host:host.querySelector('[data-job-logs]');
    if(details.open)details.querySelector('summary').click();})()`);
  const openAttempt = async (id, number) => {
    await openRun(id);
    const job = `#ml-run-${id} [data-history-job="expression"]`;
    await js(`(() => {for(const selector of [${JSON.stringify(job)},${JSON.stringify(job + ` [data-history-attempt="${number}"]`)}]){
      const details=document.querySelector(selector);if(!details)throw Error('Missing saved attempt '+selector);
      if(!details.open)details.querySelector('summary').click();}})()`);
    return host(id, number);
  };
  const stream = (selector, value) => click(selector + ` [data-job-log-stream="${value}"]`);
  const frames = () => js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);

  await until(() => js(`!!document.querySelector('#ml-language')`), 'Workspace did not mount');
  await click('#ml-language');
  await context(true);
  const response = await request('/stage6/history');
  assert.equal(response.status, 200);
  const shared = 'workspace--' + fixture.shared, archive = 'archive--' + fixture.shared, generic = 'recorded--' + fixture.generic;
  const run = response.value.runs.find(row => row.history_id === shared);
  const archived = response.value.runs.find(row => row.history_id === archive);
  const logURL = (row, number, job, output = 'err') => `/signet/history/${row.history_id}/steps/expression/log?` + new URLSearchParams({
    attempt: String(number), job_id: job, identity: row.record_identity, stream: output, lines: '50'});
  assert.deepEqual(await geometry(), [1650, 894, 53, 542]);
  assert.equal(requests().length, 0, 'Initial workspace fetched a log before a manual request');
  await openRun(shared);
  await click(`[data-history-id="${shared}"][data-run-stage="2"]`);
  const live = '#lens-stage2 [data-expression-logs]';
  await until(() => js(`!!document.querySelector(${JSON.stringify(live)})`), 'Live stage log control did not mount');
  assert.equal(requests().length, 0, 'Opening a stage fetched its still-closed log');
  await openLogs(live);
  await until(async () => (await text(live)).includes('CURRENT attempt3 stdout line 249'), 'Current stdout did not load');
  assert.ok(!(await text(live)).includes('stdout line 0 '), 'Bounded stdout returned its oldest lines');
  assert.equal(requests().length, 1);
  await stream(live, 'err');
  await until(async () => (await text(live)).includes('Error: controlled expression preprocessing failed'), 'Current stderr did not load');
  assert.ok(!(await text(live)).includes('STALE local current'), 'A loose local log from an older job was treated as current');
  const errors = await js(`document.querySelector(${JSON.stringify(live + ' [data-job-error-details]')}).textContent`);
  assert.ok(errors.includes('res/rest/signet_gexp') && errors.includes('Expression output file was not produced'));
  assert.ok((await text(live)).includes('<img src=x onerror='));
  assert.equal(await js(`document.querySelectorAll(${JSON.stringify(live + ' [data-job-log-text] img')}).length`), 0);
  assert.equal(await js(`window.__signetLogExecuted===undefined`), true);
  await js(`document.querySelector(${JSON.stringify(live)}).scrollIntoView({block:'nearest'})`);
  await frames();
  writeFileSync('/private/tmp/signet-item10-job-logs.png', (await window.webContents.capturePage()).toPNG());
  const bounded = await request(logURL(run, 3, '1003', 'out'));
  assert.equal(bounded.status, 200);
  assert.equal(bounded.value.truncated, true);
  assert.ok(bounded.value.lines.length <= 50 && Buffer.byteLength(bounded.value.lines.join('\n')) <= 65536);
  const remoteMarker = path.join(fixture.remote, 'steps/expression.job');
  const remoteOwner = path.join(fixture.remote, '.owner');
  for (const filename of [remoteMarker, remoteOwner]) {
    const saved = readFileSync(filename);
    writeFileSync(filename, '999999\n');
    assert.equal((await request(logURL(run, 3, '1003'))).status, 409, 'A changed remote owner/job marker returned another log');
    writeFileSync(filename, saved);
  }
  const localMarker = path.join(fixture.project, 'runs', fixture.shared, 'steps/expression.job');
  const localError = path.join(fixture.project, 'runs', fixture.shared, 'steps/expression.err');
  const savedLocalMarker = readFileSync(localMarker), savedLocalError = readFileSync(localError);
  writeFileSync(localMarker, '1003\n'); writeFileSync(localError, 'LOCAL current attempt3 stderr: matching saved job marker\n');
  const localCurrent = await request(logURL(run, 3, '1003'));
  assert.equal(localCurrent.status, 200); assert.equal(localCurrent.value.origin, 'local');
  assert.ok(localCurrent.value.lines.join('\n').includes('LOCAL current attempt3'));
  writeFileSync(localMarker, savedLocalMarker); writeFileSync(localError, savedLocalError);
  await closeLogs(live);
  const closedCount = requests().length;
  await click('#ml-language'); await click('#ml-language');
  await frames();
  assert.equal(requests().length, closedCount, 'Language changes fetched a closed log');

  const beforeStale = remoteRequests().length;
  assert.equal((await request(logURL(run, 3, '1001'))).status, 409, 'A stale job ID selected a current log');
  assert.equal((await request(logURL(run, 3, '1003').replace(run.record_identity, '0'.repeat(64)))).status, 409);
  assert.equal(remoteRequests().length, beforeStale, 'Stale guards contacted remote files');
  const old = await openAttempt(shared, 1);
  assert.equal(requests().length, closedCount + 2, 'Expanding an attempt fetched its still-closed log');
  await openLogs(old);
  // The unreadable stdout must produce an error rather than a ready/empty log.
  await until(async () => await logState(old) === 'error', 'Unreadable stdout did not report a reason');
  assert.equal(await text(old), '');
  assert.equal((await request(logURL(run, 1, '1001', 'out'))).status, 502, 'Unreadable stdout was returned as an empty log');
  await stream(old, 'err');
  await until(async () => (await text(old)).includes('OLD attempt1 stderr'), 'Prior-attempt stderr did not load');
  assert.ok(!(await text(old)).includes('CURRENT attempt3'), 'Prior attempt borrowed the latest stderr');
  const empty = await openAttempt(shared, 2);
  await openLogs(empty);
  await until(async () => /empty|no.*lines/i.test(await status(empty)), 'Empty stdout was not distinguished');
  assert.equal(await text(empty), '');
  await stream(empty, 'err');
  await until(async () => /missing|not.*record|not.*found|unavailable/i.test(await status(empty)), 'Missing prior stderr was not reported');
  assert.equal(await text(empty), '');

  const archiveHost = await openAttempt(archive, 3);
  const beforeArchive = remoteRequests().length;
  await openLogs(archiveHost);
  await until(async () => /missing|not.*record|not.*found|unavailable/i.test(await status(archiveHost)), 'Missing archive stdout was not reported');
  assert.equal(await text(archiveHost), '');
  await stream(archiveHost, 'err');
  await until(async () => (await text(archiveHost)).includes('ARCHIVE attempt3 stderr'), 'The same-ID archive did not use its own stderr');
  assert.equal(remoteRequests().length, beforeArchive, 'Archive logs fell back to the same-ID live remote run');
  assert.ok(!(await text(archiveHost)).includes('CURRENT attempt3'));
  const archiveOld = await openAttempt(archive, 1);
  await openLogs(archiveOld); await stream(archiveOld, 'err');
  await until(async () => (await text(archiveOld)).includes('ARCHIVE attempt1 stderr'), 'Archived old attempt did not select its own file');
  assert.equal(remoteRequests().length, beforeArchive);

  const recorded = await openAttempt(generic, 4);
  await openLogs(recorded); await stream(recorded, 'err');
  await until(async () => (await text(recorded)).includes('RECORDED attempt4 stderr'), 'Recorded local error log did not load');
  assert.equal(remoteRequests().length, beforeArchive);
  await closeLogs(recorded);

  const agentId = 'recorded--' + fixture.agent;
  const agentRecord = response.value.runs.find(row => row.history_id === agentId);
  const operation = agentRecord.operations.find(operation => operation.record_file === 'genotype_tcga.json');
  const plan = agentRecord.operations.find(operation => operation.record_file === 'network.plan.json');
  await openRun(agentId);
  const operationDetails = `#ml-run-${agentId} [data-history-operation="genotype_tcga"][data-history-operation-record="genotype_tcga.json"]`;
  const operationHost = operationDetails + ' [data-history-job-logs]';
  await click(operationDetails + ' > summary');
  const beforeOperation = requests().length;
  await openLogs(operationHost);
  await until(async () => (await text(operationHost)).includes('AGENT operation stdout'), 'Original Agent operation stdout did not load');
  assert.equal(requests().length, beforeOperation + 1);
  const operationURL = new URL('http://localhost' + JSON.parse(requests().at(-1)));
  assert.equal(operationURL.pathname, `/signet/history/${agentId}/operations/genotype_tcga/log`);
  assert.equal(operationURL.searchParams.get('record_revision'), operation.record_revision);
  assert.ok(!(await text(operationHost)).includes('OUTSIDE operation pointer'));
  await stream(operationHost, 'err');
  await until(async () => (await text(operationHost)).includes('AGENT operation stderr'), 'Original Agent operation stderr did not load');
  assert.ok(!(await text(operationHost)).includes('OUTSIDE operation pointer'));
  assert.equal(remoteRequests().length, beforeArchive, 'A local Agent operation made a remote request');
  const staleOperation = new URL(operationURL);
  staleOperation.searchParams.set('record_revision', '0'.repeat(64));
  assert.equal((await request(staleOperation.pathname + staleOperation.search)).status, 409);
  const planDetails = `#ml-run-${agentId} [data-history-operation="network"][data-history-operation-record="network.plan.json"]`;
  const planHost = planDetails + ' [data-history-job-logs]';
  await click(planDetails + ' > summary');
  const beforePlan = requests().length;
  await openLogs(planHost); await frames();
  assert.match(await status(planHost), /prepared plan/);
  for (const control of ['[data-job-log-stream="out"]', '[data-job-log-stream="err"]', '[data-job-log-refresh]']) {
    assert.equal(await js(`document.querySelector(${JSON.stringify(planHost + ' ' + control)}).disabled`), true);
    await click(planHost + ' ' + control);
  }
  await frames();
  assert.equal(requests().length, beforePlan, 'A prepared plan requested execution logs');
  const planQuery = new URLSearchParams({identity: agentRecord.record_identity, record_revision: plan.record_revision, stream: 'out', lines: '50'});
  assert.equal((await request(`/signet/history/${agentId}/operations/network/log?${planQuery}`)).status, 404);
  await closeLogs(planHost);

  setControl({connected: false});
  await context(false);
  await openRun(shared);
  await click(`[data-history-id="${shared}"][data-run-stage="2"]`);
  await openLogs(live);
  await until(async () => await logState(live) === 'error', 'Disconnected remote log did not report an error');
  assert.match(await status(live), /disconnected/);
  assert.equal(await text(live), '');
  await closeLogs(live);
  const disconnected = await request(logURL(run, 3, '1003'));
  assert.equal(disconnected.status, 412);
  const offlineArchive = await request(logURL(archived, 3, '2003'));
  assert.equal(offlineArchive.status, 200, 'Local archive required an unnecessary connection');
  assert.ok(offlineArchive.value.lines.join('\n').includes('ARCHIVE attempt3'));
  setControl({connected: true, fail_remote: true});
  await context(true);
  const lost = await request(logURL(run, 3, '1003'));
  assert.equal(lost.status, 502);
  setControl({fail_remote: false});
  assert.deepEqual(fingerprints(frozenFolders), original, 'Reading logs modified source data, snapshots, log files or result metadata');

  await running.backend.stop();
  replacement = new Backend(running.backend.options);
  assert.equal(await replacement.start(), running.origin);
  const loaded = once(window.webContents, 'did-finish-load');
  window.webContents.reload(); await loaded;
  const reopened = await request(logURL(run, 1, '1001'));
  assert.equal(reopened.status, 200);
  assert.ok(reopened.value.lines.join('\n').includes('OLD attempt1 stderr'));
  const restarted = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.equal(restarted.starts.length, 2);
  assert.notEqual(restarted.starts[0], restarted.starts[1]);
  assert.deepEqual(fingerprints(frozenFolders), original);
  assert.equal(existsSync(path.join(temporary, 'forbidden.ndjson')), false, 'A log reader attempted a mutation, unrelated path or analysis operation');
  assert.deepEqual(await geometry(), [1650, 894, 53, 542]);
  await replacement.stop(); replacement = undefined;
  await running.quit();
  console.log('PASS: explicit live-stage and saved-attempt stdout/stderr, bounded text, empty/missing/unreadable/disconnected distinctions, exact source/job/attempt and stale identity guards, same-ID archives without remote fallback, revision-bound Agent operations ignoring hostile log pointers, prepared plans without log requests, safe HTML text, closed-panel no requests, Python restart, immutable files and fixed geometry; read-only owned fixture only, no actual SSH/jobs/analysis');
}

verify().catch(async error => {console.error(error); await replacement?.forceStop(); await running?.backend.forceStop(); app.exit(1);});
