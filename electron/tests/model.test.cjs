'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, readFile, stat, rm} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {GeminiKeyStore, ModelController, verifyGeminiKey} = require('../model/index.cjs');

const KEY = 'AIza' + 'x'.repeat(35);
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: value => Buffer.from('enc:' + value),
  decryptString: buffer => { const text = buffer.toString(); if (!text.startsWith('enc:')) throw Error('bad'); return text.slice(4); },
});
async function tempStore(available) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'signet-model-'));
  return {directory, store: new GeminiKeyStore(path.join(directory, 'model'), fakeSafeStorage(available))};
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('key store encrypts at rest with owner-only permissions and round-trips', async () => {
  const {directory, store} = await tempStore();
  try {
    assert.equal(await store.load(), null);
    await store.save(KEY);
    const raw = await readFile(store.file, 'utf8');
    assert.ok(raw.startsWith('enc:'), 'stored through safeStorage');
    assert.equal((await stat(store.file)).mode & 0o777, 0o600);
    assert.equal(await store.load(), KEY);
    await store.clear();
    assert.equal(await store.has(), false);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('key store refuses malformed keys and unavailable encryption', async () => {
  const {directory, store} = await tempStore(false);
  try {
    await assert.rejects(store.save('short'), {code: 'KEY_INVALID'});
    await assert.rejects(store.save(KEY), {code: 'ENCRYPTION_UNAVAILABLE'});
    assert.equal(await store.has(), false);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('verification sends the key only in a header and maps rejection', async () => {
  let seen;
  await verifyGeminiKey(KEY, async (url, options) => { seen = {url, options}; return {ok: true, status: 200}; });
  assert.ok(!seen.url.includes(KEY));
  assert.equal(seen.options.headers['x-goog-api-key'], KEY);
  await assert.rejects(verifyGeminiKey(KEY, async () => ({ok: false, status: 400})), {code: 'KEY_REJECTED'});
  await assert.rejects(verifyGeminiKey(KEY, async () => { throw Error('offline'); }), {code: 'NETWORK'});
});

test('controller saves only verified keys, then switches to Gemini after replying', async () => {
  const {directory, store} = await tempStore();
  try {
    const switches = [];
    let provider = 'codex';
    const controller = new ModelController({store, getProvider: () => provider,
      switchProvider: (next, key) => { switches.push([next, key]); provider = next; },
      verify: async key => { if (key !== KEY) throw Object.assign(Error('rejected'), {code: 'KEY_REJECTED'}); }});
    await assert.rejects(controller.saveGeminiKey('AIza' + 'y'.repeat(35)), {code: 'KEY_REJECTED'});
    assert.equal(await store.has(), false);
    assert.deepEqual(await controller.saveGeminiKey(KEY), {restarting: true});
    assert.deepEqual(switches, [], 'switch waits until the IPC reply is sent');
    await tick();
    assert.deepEqual(switches, [['gemini', KEY]]);
    assert.deepEqual(await controller.status(), {provider: 'gemini', geminiConfigured: true, encryptionAvailable: true});
    assert.deepEqual(await controller.clearGeminiKey(), {restarting: true});
    await tick();
    assert.deepEqual(switches.at(-1), ['codex', null]);
    assert.equal(await store.has(), false);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
