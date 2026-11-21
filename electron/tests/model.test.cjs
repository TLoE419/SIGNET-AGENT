'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, readFile, stat, rm} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {GeminiKeyStore, ModelController, installModelHandlers, verifyGeminiKey} = require('../main/model/index.cjs');

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
    let provider = 'none';
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
    assert.deepEqual(switches.at(-1), ['none', null]);
    assert.equal(await store.has(), false);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('authenticated provider selection opts in to Codex and reuses the saved Gemini key on return', async () => {
  const {directory, store} = await tempStore();
  try {
    await store.save(KEY);
    const original = await readFile(store.file);
    const switches = [], handlers = new Map();
    let provider = 'gemini';
    const controller = new ModelController({store, getProvider: () => provider,
      switchProvider: (next, key) => { switches.push([next, key]); provider = next; },
      verify: () => assert.fail('Switching must not send a Gemini verification request')});
    const origin = 'http://127.0.0.1:8080';
    const mainFrame = {url: origin + '/'};
    const window = {isDestroyed: () => false, webContents: {mainFrame}};
    const event = {sender: window.webContents, senderFrame: mainFrame};
    const remove = installModelHandlers({handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name)},
      () => window, controller, () => origin);
    const select = handlers.get('model:selectProvider');

    await assert.rejects(select({...event, senderFrame: {url: 'https://example.com/'}}, 'codex'), /Unauthorized/);
    assert.equal((await select(event, 'unrecognized')).error.code, 'PROVIDER_INVALID');
    assert.deepEqual(await select(event, 'codex'), {ok: true, value: {restarting: true}});
    assert.deepEqual(switches, [], 'switch waits for the IPC reply');
    await tick();
    assert.deepEqual(switches, [['codex', null]]);
    assert.deepEqual(await handlers.get('model:getStatus')(event), {ok: true, value: {
      provider: 'codex', geminiConfigured: true, encryptionAvailable: true,
    }});
    assert.deepEqual(await select(event, 'codex'), {ok: true, value: {restarting: false}});
    assert.deepEqual(await select(event, 'gemini'), {ok: true, value: {restarting: true}});
    await tick();
    assert.deepEqual(switches, [['codex', null], ['gemini', KEY]]);
    assert.deepEqual(await readFile(store.file), original);
    remove();
    assert.equal(handlers.size, 0);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

 test('model writes remain locked until the scheduled switch settles',async()=>{
  const {directory,store}=await tempStore();let release;
  const controller=new ModelController({store,getProvider:()=> 'none',verify:async()=>{},switchProvider:()=>new Promise(resolve=>{release=resolve})});
  try{
   await controller.saveGeminiKey(KEY);
   await assert.rejects(controller.clearGeminiKey(),{code:'BUSY'});
   await tick();
   await assert.rejects(controller.saveGeminiKey(KEY),{code:'BUSY'});
   release();await tick();
   assert.deepEqual(await controller.clearGeminiKey(),{restarting:false});
  }finally{await rm(directory,{recursive:true,force:true})}
 });
 test('rejected asynchronous switches surface a recoverable status error',async()=>{
  const {directory,store}=await tempStore();
  const controller=new ModelController({store,getProvider:()=> 'none',verify:async()=>{},switchProvider:async()=>{throw Error('fixture failure')}});
  try{await controller.saveGeminiKey(KEY);await tick();await tick();await assert.rejects(controller.status(),{code:'SWITCH_FAILED'});assert.equal(controller.switching,false)}
  finally{await rm(directory,{recursive:true,force:true})}
 });

test('failed replacement retains the encrypted saved key and does not switch model', async () => {
 const {directory, store} = await tempStore();
 try {
  await store.save(KEY);
  const original = await readFile(store.file);
  let switched = false;
  const controller = new ModelController({store, getProvider: () => 'gemini',
   verify: async () => {throw Object.assign(Error('rejected'), {code: 'KEY_REJECTED'});},
   switchProvider: () => {switched = true;}});
  await assert.rejects(controller.saveGeminiKey('AIza' + 'z'.repeat(35)), {code: 'KEY_REJECTED'});
  await tick();
  assert.deepEqual(await readFile(store.file), original);
  assert.equal(switched, false);
  assert.equal((await controller.status()).provider, 'gemini');
 } finally {await rm(directory, {recursive: true, force: true});}
});
