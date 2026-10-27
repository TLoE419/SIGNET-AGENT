'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {mkdtemp, mkdir, writeFile, stat} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {utils, Server} = require('ssh2');
const {SshStore} = require('../ssh/store.cjs');
const {SshService} = require('../ssh/service.cjs');
const {SshBroker} = require('../ssh/broker.cjs');

class FakeStream extends EventEmitter {
  constructor() { super(); this.stderr = new EventEmitter(); }
  end(input) {
    queueMicrotask(() => {
      this.emit('data', Buffer.from(`received:${input.length}`));
      this.stderr.emit('data', Buffer.from('notice'));
      this.emit('close', 0, null);
    });
  }
  close() { this.emit('close', 255, 'TIMEOUT'); }
}
class FakeClient extends EventEmitter {
  constructor(hostKey) { super(); this.hostKey = hostKey; }
  connect(options) {
    queueMicrotask(() => {
      if (options.hostVerifier(this.hostKey)) this.emit('ready');
      else { const error = Error('host rejected'); error.level = 'handshake'; this.emit('error', error); }
    });
  }
  exec(_command, callback) { callback(null, new FakeStream()); }
  end() { queueMicrotask(() => this.emit('close')); }
  destroy() { queueMicrotask(() => this.emit('close')); }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'signet-ssh-'));
  const sshDir = path.join(root, 'ssh');
  await mkdir(sshDir, {mode: 0o700});
  const generated = utils.generateKeyPairSync('rsa', {bits: 2048, passphrase: 'test-only-passphrase', cipher: 'aes256-ctr'});
  const keyPath = path.join(root, 'id_test');
  await writeFile(keyPath, generated.private, {mode: 0o600});
  const host = utils.generateKeyPairSync('ed25519');
  return {root, sshDir, keyPath, clientPublic: utils.parseKey(generated.public).getPublicSSH(),
    serverPrivate: host.private, hostKey: utils.parseKey(host.public).getPublicSSH()};
}

test('profiles stay private and unknown hosts require explicit trust before connection', async () => {
  const value = await fixture();
  const store = new SshStore(value.sshDir);
  const service = new SshService(store, () => new FakeClient(value.hostKey));
  await service.initialize();
  const profile = await service.saveProfile({name:'Local test', host:'127.0.0.1', port:2222,
    username:'tester', privateKeyPath:value.keyPath});
  await assert.rejects(service.connect(profile.id, 'test-only-passphrase'), {code:'HOST_KEY_UNKNOWN'});
  const pending = service.publicSnapshot().pendingHost;
  assert.match(pending.fingerprint, /^SHA256:/);
  assert.equal('publicKey' in pending, false);
  await service.trustHost(pending);
  await service.connect(profile.id, 'test-only-passphrase');
  assert.equal(service.publicSnapshot().connection.status, 'connected');
  const result = await service.exec('true', Buffer.from('abc'), 1000);
  assert.equal(result.returncode, 0);
  assert.equal(result.stdout.toString(), 'received:3');
  await service.shutdown();
  assert.equal(service.publicSnapshot().connection.status, 'disconnected');
  assert.equal((await stat(path.join(value.sshDir, 'profiles.json'))).mode & 0o077, 0);
  assert.equal((await stat(path.join(value.sshDir, 'host-trust.json'))).mode & 0o077, 0);
});

test('app-managed keys are encrypted before the first private filesystem write', async () => {
  const value = await fixture();
  const store = new SshStore(value.sshDir);
  const input = {label:'Managed test', username:'tester', passphrase:'managed-test-passphrase'};
  const key = await store.generateKey(input);
  assert.equal(input.passphrase, '');
  const source = require('node:fs').readFileSync(key.privateKeyPath);
  assert.match(source.toString(), /BEGIN OPENSSH PRIVATE KEY/);
  assert.ok(utils.parseKey(source) instanceof Error);
  assert.equal(utils.parseKey(source, 'managed-test-passphrase') instanceof Error, false);
  assert.equal((await stat(key.privateKeyPath)).mode & 0o077, 0);
  assert.equal((await store.listKeys()).length, 1);
});

test('real localhost SSH handshake uses the encrypted key and pinned host identity', async () => {
  const value = await fixture();
  const server = new Server({hostKeys:[value.serverPrivate]}, client => {
    client.on('error', () => {});
    client.on('authentication', context => {
      if (context.method === 'publickey' && context.username === 'tester' && context.key.data.equals(value.clientPublic)) context.accept();
      else context.reject();
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const service = new SshService(new SshStore(value.sshDir));
  await service.initialize();
  try {
    const profile = await service.saveProfile({name:'Real local test', host:'127.0.0.1', port:server.address().port,
      username:'tester', privateKeyPath:value.keyPath});
    await assert.rejects(service.connect(profile.id, 'test-only-passphrase'), {code:'HOST_KEY_UNKNOWN'});
    await service.trustHost(service.publicSnapshot().pendingHost);
    await service.connect(profile.id, 'test-only-passphrase');
    assert.equal(service.publicSnapshot().connection.status, 'connected');
  } finally {
    await service.shutdown();
    await new Promise(resolve => server.close(resolve));
  }
});

test('private broker requires its launch token and returns binary command output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'signet-broker-'));
  const socketPath = path.join(root, 'runtime', 'broker.sock');
  const service = {publicSnapshot: () => ({connection:{status:'connected'}}),
    exec: async (_command, input) => ({returncode:0, signal:null, stdout:Buffer.from(`ok:${input.length}`), stderr:Buffer.alloc(0)})};
  const broker = new SshBroker({socketPath, token:'correct-token', service});
  await broker.start();
  async function send(request) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const chunks = [];
      socket.on('connect', () => {
        const input = request.input || Buffer.alloc(0);
        socket.write(JSON.stringify({...request, input:undefined, inputLength:input.length}) + '\n');
        socket.write(input);
      });
      socket.on('data', chunk => { chunks.push(chunk); });
      socket.on('end', () => {
        const data = Buffer.concat(chunks), newline = data.indexOf(10);
        const reply = JSON.parse(data.subarray(0, newline));
        if (reply.ok) {
          const start = newline + 1, split = start + reply.value.stdoutLength;
          reply.stdout = data.subarray(start, split);
          reply.stderr = data.subarray(split);
        }
        resolve(reply);
      });
      socket.on('error', reject);
    });
  }
  try {
    const denied = await send({token:'wrong', action:'status'});
    assert.equal(denied.ok, false);
    const reply = await send({token:'correct-token', action:'exec', command:'true', input:Buffer.from('abc'), timeoutMs:1000});
    assert.equal(reply.ok, true);
    assert.equal(reply.stdout.toString(), 'ok:3');
  } finally { await broker.close(); }
});

test('broker shutdown closes incomplete local clients without hanging', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'signet-broker-close-'));
  const socketPath = path.join(root, 'runtime', 'broker.sock');
  const broker = new SshBroker({socketPath, token:'correct-token', service:{exec: async () => assert.fail()}});
  await broker.start();
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const closed = new Promise(resolve => socket.once('close', resolve));
  await broker.close();
  await closed;
  assert.equal(socket.destroyed, true);
});
