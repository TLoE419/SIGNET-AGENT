'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, rm, readFile} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {validGeminiKey, GeminiKeyStore, ModelController} = require('../main/model/index.cjs');

// Synthetic credentials only; no request goes to Google.
const AUTH_KEY = 'AQ.' + 'x'.repeat(300) + '._-+/=';
test('legacy keys and longer authorization keys pass local transport validation', () => {
  assert.equal(validGeminiKey('AIza' + 'x'.repeat(35)), true);
  assert.equal(validGeminiKey('AQ.' + 'x'.repeat(35)), true);
  assert.equal(validGeminiKey(AUTH_KEY), true);
});

test('malformed, multiline and unbounded values remain rejected', () => {
  for (const key of [null, 123, '', 'short', 'x'.repeat(8193), AUTH_KEY + '\n', AUTH_KEY + '\r', AUTH_KEY + '\r\nx-extra: injected',
    AUTH_KEY + '\u200b', AUTH_KEY.slice(0, 20) + ' ' + AUTH_KEY.slice(20), '"' + AUTH_KEY + '"']) {
    assert.equal(validGeminiKey(key), false);
  }
});

test('authorization keys are verified before saving and round-trip through encrypted storage', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'signet-auth-key-test-'));
  const store = new GeminiKeyStore(directory, {
    isEncryptionAvailable: () => true,
    encryptString: key => Buffer.from('fixture-encrypted:' + Buffer.from(key).toString('base64')),
    decryptString: data => Buffer.from(data.toString().slice('fixture-encrypted:'.length), 'base64').toString(),
  });
  let accepted = false, calls = 0;
  const controller = new ModelController({store, getProvider: () => 'codex', switchProvider: async () => {},
    verify: async key => {calls++; assert.equal(key, AUTH_KEY); if (!accepted) throw Error('fixture Google rejection');}});
  try {
    await assert.rejects(controller.saveGeminiKey(AUTH_KEY), /fixture Google rejection/);
    assert.equal(await store.has(), false);
    accepted = true;
    assert.deepEqual(await controller.saveGeminiKey(AUTH_KEY), {restarting: true});
    assert.equal(calls, 2);
    assert.equal(await store.load(), AUTH_KEY);
    assert.equal((await readFile(store.file)).includes(Buffer.from(AUTH_KEY)), false);
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
