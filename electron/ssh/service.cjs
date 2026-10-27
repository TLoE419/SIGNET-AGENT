'use strict';

const {EventEmitter} = require('node:events');
const {createHash} = require('node:crypto');
const {utils, Client} = require('ssh2');
const {profileInput, fail, safeError, SshFailure} = require('./validation.cjs');
const {inspectPrivateKey, unlockPrivateKey} = require('./keys.cjs');

function hostIdentity(host, port, key) {
  if (!Buffer.isBuffer(key) || key.length < 5 || key.length > 16384) throw Error('Invalid host key.');
  const length = key.readUInt32BE(0);
  if (length < 1 || length > 128 || length + 4 > key.length) throw Error('Invalid host key.');
  const algorithm = key.subarray(4, 4 + length).toString('ascii');
  if (utils.parseKey(`${algorithm} ${key.toString('base64')}`) instanceof Error) throw Error('Invalid host key.');
  return {host, port, algorithm,
    fingerprint: `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`,
    publicKey: key.toString('base64')};
}

class SshService extends EventEmitter {
  constructor(store, clientFactory = () => new Client()) {
    super();
    this.store = store;
    this.clientFactory = clientFactory;
    this.snapshot = {available: true, profiles: [], selectedProfileId: null, connection: null};
    this.attempt = 0;
  }
  publicSnapshot() {
    const snapshot = structuredClone(this.snapshot);
    if (snapshot.pendingHost) delete snapshot.pendingHost.publicKey;
    return snapshot;
  }
  publish() { this.emit('snapshot', this.publicSnapshot()); }
  async initialize() {
    const {profiles} = await this.store.load();
    this.profilesDocument = profiles;
    this.snapshot.profiles = profiles.profiles;
    this.snapshot.selectedProfileId = profiles.selectedProfileId;
    this.snapshot.connection = profiles.selectedProfileId ? {profileId: profiles.selectedProfileId, status: 'disconnected'} : null;
    this.publish();
    return this.publicSnapshot();
  }
  async saveProfile(input) {
    this.assertIdle();
    const profile = profileInput(input);
    const inspection = await inspectPrivateKey(profile.privateKeyPath);
    if (inspection.status !== 'encrypted') {
      const code = inspection.status === 'unencrypted' ? 'KEY_UNENCRYPTED' : inspection.status === 'unsupported' ? 'KEY_UNSUPPORTED' : 'KEY_INVALID';
      fail(code, inspection.reason || 'Select a supported encrypted OpenSSH private key.');
    }
    const saved = await this.store.saveProfile(profile);
    await this.initialize();
    return saved;
  }
  async selectProfile(id) {
    this.assertIdle();
    await this.store.selectProfile(id);
    await this.initialize();
  }
  async inspectPrivateKey(keyPath) { return inspectPrivateKey(keyPath); }
  async listKeys() { return this.store.listKeys(); }
  async generateKey(input) { return this.store.generateKey(input); }
  assertIdle() {
    if (this.inFlight || ['connected', 'connecting', 'disconnecting'].includes(this.snapshot.connection?.status)) {
      fail('INVALID_PROFILE', 'Disconnect before changing the SSH profile.');
    }
  }
  selectedProfile(id) {
    const profile = this.snapshot.profiles.find(item => item.id === (id || this.snapshot.selectedProfileId));
    if (!profile) fail('INVALID_PROFILE', 'Select an SSH profile first.');
    return profile;
  }
  trustState(identity) {
    const known = this.trustDocument.hosts.find(item => item.host === identity.host && item.port === identity.port);
    if (!known) return 'unknown';
    return known.algorithm === identity.algorithm && known.fingerprint === identity.fingerprint && known.publicKey === identity.publicKey ? 'match' : 'changed';
  }
  async connect(id, passphrase) {
    if (this.inFlight) return this.inFlight;
    if (this.snapshot.connection?.status === 'connected') {
      if (this.snapshot.connection.profileId === id) return;
      fail('INVALID_PROFILE', 'Disconnect before connecting a different SSH profile.');
    }
    const profile = this.selectedProfile(id);
    const token = ++this.attempt;
    const run = this.connectOwned(profile, passphrase, token);
    this.inFlight = run;
    try { await run; } finally { if (this.inFlight === run) this.inFlight = undefined; passphrase = ''; }
  }
  async connectOwned(profile, passphrase, token) {
    this.snapshot.pendingHost = undefined;
    this.snapshot.connection = {profileId: profile.id, status: 'connecting'};
    this.publish();
    let privateKey;
    try {
      privateKey = await unlockPrivateKey(profile.privateKeyPath, passphrase);
      const {trust} = await this.store.load();
      this.trustDocument = trust;
      if (token !== this.attempt) fail('SESSION_CLOSED', 'SSH connection cancelled.');
      const client = this.clientFactory();
      this.client = client;
      await new Promise((resolve, reject) => {
        let settled = false;
        let hostError;
        const timer = setTimeout(() => finish(new SshFailure('CONNECTION_TIMEOUT', 'The SSH connection timed out.')), 25000);
        const finish = error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error); else resolve();
        };
        client.once('ready', () => finish());
        client.once('error', error => finish(hostError || safeError(error)));
        client.once('close', () => {
          if (!settled) finish(hostError || new SshFailure('SESSION_CLOSED', 'The SSH session closed before authentication.'));
          else if (this.client === client && this.snapshot.connection?.status === 'connected') {
            this.client = undefined;
            this.snapshot.connection = {profileId: profile.id, status: 'disconnected'};
            this.publish();
          }
        });
        try {
          client.connect({host: profile.host, port: profile.port, username: profile.username,
            privateKey, passphrase, readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 3,
            tryKeyboard: false, agentForward: false, authHandler: ['publickey'],
            hostVerifier: key => {
              if (token !== this.attempt) return false;
              try {
                const identity = hostIdentity(profile.host, profile.port, key);
                const state = this.trustState(identity);
                if (state === 'match') return true;
                if (state === 'unknown') {
                  this.pendingIdentity = identity;
                  this.snapshot.pendingHost = identity;
                  hostError = new SshFailure('HOST_KEY_UNKNOWN', 'Verify this host fingerprint independently, then trust it and reconnect.');
                } else {
                  hostError = new SshFailure('HOST_KEY_CHANGED', 'The saved SSH host identity changed. Connection was blocked.');
                }
                return false;
              } catch { hostError = new SshFailure('UNKNOWN', 'The server supplied an invalid SSH host key.'); return false; }
            }});
        } catch (error) { finish(safeError(error)); }
      });
      if (token !== this.attempt) fail('SESSION_CLOSED', 'SSH connection cancelled.');
      this.snapshot.pendingHost = undefined;
      this.pendingIdentity = undefined;
      this.snapshot.connection = {profileId: profile.id, status: 'connected', connectedAt: new Date().toISOString()};
      this.publish();
    } catch (error) {
      const failure = safeError(error);
      if (token === this.attempt) {
        this.snapshot.connection = {profileId: profile.id, status: 'error', error: {code: failure.code, message: failure.message}};
        this.publish();
      }
      this.client?.destroy();
      this.client = undefined;
      throw failure;
    } finally {
      if (privateKey) privateKey.fill(0);
      passphrase = '';
    }
  }
  async trustHost(value) {
    this.assertIdle();
    const pending = this.pendingIdentity;
    if (!pending || !value || value.host !== pending.host || value.port !== pending.port ||
        value.algorithm !== pending.algorithm || value.fingerprint !== pending.fingerprint) {
      fail('HOST_KEY_UNKNOWN', 'The host verification request expired. Connect again.');
    }
    await this.store.trustHost(pending);
    this.pendingIdentity = undefined;
    this.snapshot.pendingHost = undefined;
    this.snapshot.connection = {profileId: this.snapshot.selectedProfileId, status: 'disconnected'};
    this.publish();
  }
  async disconnect() {
    ++this.attempt;
    const client = this.client;
    this.client = undefined;
    const profileId = this.snapshot.connection?.profileId || this.snapshot.selectedProfileId;
    if (!profileId) return;
    this.snapshot.connection = {profileId, status: 'disconnecting'};
    this.publish();
    if (client) await new Promise(resolve => {
      const timer = setTimeout(() => { client.destroy(); resolve(); }, 750);
      client.once('close', () => { clearTimeout(timer); resolve(); });
      client.end();
    });
    await this.inFlight?.catch(() => {});
    this.snapshot.connection = {profileId, status: 'disconnected'};
    this.snapshot.pendingHost = undefined;
    this.pendingIdentity = undefined;
    this.publish();
  }
  async exec(command, input, timeoutMs = 30000) {
    if (!this.client || this.snapshot.connection?.status !== 'connected') fail('SESSION_CLOSED', 'Connect SSH before running remote work.');
    if (typeof command !== 'string' || !command || command.length > 131072 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60 * 1000) {
      fail('INVALID_REQUEST', 'Invalid SSH execution request.');
    }
    const client = this.client;
    return new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) { reject(safeError(error)); return; }
        const stdout = [], stderr = [];
        let size = 0, finished = false;
        const timer = setTimeout(() => { stream.close(); done(new SshFailure('CONNECTION_TIMEOUT', 'The remote command timed out.')); }, timeoutMs);
        const collect = target => chunk => {
          size += chunk.length;
          if (size > 1024 * 1024 * 1024) { stream.close(); done(new SshFailure('UNKNOWN', 'Remote output exceeded 1 GiB.')); }
          else target.push(Buffer.from(chunk));
        };
        const done = (failure, code = 255, signal = null) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          failure ? reject(failure) : resolve({returncode: Number.isInteger(code) ? code : 255, signal,
            stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr)});
        };
        stream.on('data', collect(stdout));
        stream.stderr.on('data', collect(stderr));
        stream.once('error', error => done(safeError(error)));
        stream.once('close', (code, signal) => done(null, code, signal));
        if (input?.length) stream.end(input); else stream.end();
      });
    });
  }
  async shutdown() { await this.disconnect(); }
}

module.exports = {SshService, hostIdentity};
