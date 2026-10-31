'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, rm, readFile} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const readline = require('node:readline');
const {Backend} = require('../main/backend/backend.cjs');
const {localURL, navigationAllowed} = require('../main/security/policy.cjs');

// Use node:http so the suite also works on hosts where Node fetch's socket
// priority tuning is unavailable. Exercise actual HTTP responses, not mocks.
function request(url, {method = 'GET', headers = {}, body, signal} = {}) {
  return new Promise((resolve, reject) => {
    const req = require('node:http').request(url, {method, headers, signal, agent: false}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({status: response.statusCode,
        headers: {get: name => response.headers[name]},
        text: async () => Buffer.concat(chunks).toString()}));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(Error('HTTP request timed out')));
    req.end(body);
  });
}

async function fixture(t, extra = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'signet-shell-test-'));
  const stateFile = path.join(directory, '.chat-state.json');
  const backend = new Backend({stateFile, ...extra});
  t.after(async () => { await backend.forceStop(); await rm(directory, {recursive: true, force: true}); });
  return {backend, stateFile};
}

test('navigation and request policy reject other ports, schemes, credentials and host lookalikes', () => {
  const origin = 'http://127.0.0.1:43210';
  for (const url of ['http://127.0.0.1:43211/', 'http://127.0.0.1.evil:43210/', 'https://127.0.0.1:43210/',
    'file:///tmp/secret', 'javascript:alert(1)', 'http://user@127.0.0.1:43210/', 'https://example.com']) {
    assert.equal(localURL(url, origin), false, url);
  }
  assert.equal(navigationAllowed(origin + '/?session=abc', origin), true);
  assert.equal(navigationAllowed(origin + '/stage6/file?name=result', origin), true);
  assert.equal(navigationAllowed(origin + '/chat', origin), false);
});

test('owned API serves bootstrap without frontend assets, preserves protections and closes its port', {timeout: 20000}, async t => {
  const {backend, stateFile} = await fixture(t);
  const origin = await backend.start();
  const response = await request(origin + '/bootstrap');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await response.text();
  assert.deepEqual(JSON.parse(html).initial,{sessions:[]});
  assert.equal((await request(origin)).status,404);
  assert.equal((await request(origin + '/chat.js')).status,404);
  assert.doesNotMatch(html, /__TOKEN__|__MODEL__/);
  assert.equal((await request(origin + '/.env')).status, 404);
  assert.equal((await request(origin + '/chat', {method: 'POST', body: '{}'})).status, 403);
  const token = JSON.parse(html).token;
  assert.equal((await request(origin + '/chat', {method: 'POST', headers: {'Origin': origin, 'X-Chat-Token': token}, body: '{}'})).status, 400);
  await backend.stop();
  await assert.rejects(request(origin));
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.deepEqual(state.histories, {});
});

test('invalid executable and startup deadline fail without leaving an owned server', {timeout: 15000}, async t => {
  const missing = await fixture(t, {python: '/nonexistent-signet-python'});
  await assert.rejects(missing.backend.start(), /Could not launch Python/);
  await missing.backend.closed;
  const slow = await fixture(t, {startupMs: 1});
  await assert.rejects(slow.backend.start(), /did not start/);
  await slow.backend.closed;
  assert.equal(slow.backend.exited, true);
});

test('Python notices owner death through pipe EOF and releases its listener', {timeout: 20000}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'signet-owner-test-'));
  const script = `const {Backend}=require(${JSON.stringify(path.resolve(__dirname, '../main/backend/backend.cjs'))});
    const backend=new Backend({stateFile:process.argv[1]});
    backend.start().then(origin=>console.log(JSON.stringify({origin,pid:backend.child.pid})));`;
  const owner = spawn(process.execPath, ['-e', script, path.join(directory, '.chat-state.json')], {stdio: ['ignore', 'pipe', 'inherit']});
  let pid;
  t.after(async () => {
    owner.kill('SIGKILL');
    if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    await rm(directory, {recursive: true, force: true});
  });
  const lines = readline.createInterface({input: owner.stdout});
  const [line] = await once(lines, 'line');
  const data = JSON.parse(line); pid = data.pid;
  assert.equal((await request(data.origin + '/bootstrap')).status, 200);
  const exited = once(owner, 'close'); owner.kill('SIGKILL'); await exited;
  let stopped = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await request(data.origin, {signal: AbortSignal.timeout(300)}); }
    catch { stopped = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(stopped, true);
});
