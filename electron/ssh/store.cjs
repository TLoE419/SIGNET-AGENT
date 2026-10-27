'use strict';

const {constants} = require('node:fs');
const {mkdir, open, chmod, lstat, rename, unlink} = require('node:fs/promises');
const path = require('node:path');
const {randomUUID, createHash} = require('node:crypto');
const {utils} = require('ssh2');
const {profileInput, fail, text} = require('./validation.cjs');
const {generateKeyPair} = require('./key-worker-client.cjs');

class PrivateJsonFile {
  constructor(file, validate, empty) { this.file = file; this.validate = validate; this.empty = empty; }
  async prepare() {
    const directory = path.dirname(this.file);
    await mkdir(directory, {recursive: true, mode: 0o700});
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
      throw Error('Unsafe SSH configuration directory.');
    }
    if (process.platform !== 'win32') await chmod(directory, 0o700);
  }
  async load() {
    await this.prepare();
    let file;
    try { file = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (error.code === 'ENOENT') return this.empty(); throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024 ||
          (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))) throw Error();
      return this.validate(JSON.parse(await file.readFile('utf8')));
    } catch {
      throw Error('SSH configuration is corrupt or has unsafe permissions. Existing files were preserved.');
    } finally { await file.close(); }
  }
  async write(value) {
    this.validate(value);
    await this.prepare();
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.file);
      if (process.platform !== 'win32') await chmod(this.file, 0o600);
    } finally { await unlink(temporary).catch(() => {}); }
  }
}

function validateProfiles(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 100 ||
      !['string', 'object'].includes(typeof value.selectedProfileId) ||
      Object.keys(value).some(key => !['version', 'profiles', 'selectedProfileId'].includes(key))) throw Error();
  const profiles = value.profiles.map(profile => {
    const valid = profileInput(profile);
    if (!valid.id) throw Error();
    return valid;
  });
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length ||
      (value.selectedProfileId !== null && !profiles.some(profile => profile.id === value.selectedProfileId))) throw Error();
  return {version: 1, selectedProfileId: value.selectedProfileId, profiles};
}

function validHost(value) {
  if (!value || !text(value.host, 253) || !/^[a-z0-9:][a-z0-9.:-]*$/.test(value.host) ||
      !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      !text(value.algorithm, 128) || !/^[a-zA-Z0-9@._-]+$/.test(value.algorithm) ||
      !/^SHA256:[A-Za-z0-9+/]{43}$/.test(value.fingerprint) || !text(value.publicKey, 32768) ||
      Object.keys(value).length !== 5) return false;
  const key = Buffer.from(value.publicKey, 'base64');
  if (!key.length || key.toString('base64') !== value.publicKey ||
      utils.parseKey(`${value.algorithm} ${value.publicKey}`) instanceof Error) return false;
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` === value.fingerprint;
}
function validateTrust(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.hosts) || value.hosts.length > 100 ||
      Object.keys(value).some(key => !['version', 'hosts'].includes(key)) || !value.hosts.every(validHost) ||
      new Set(value.hosts.map(host => `${host.host}:${host.port}`)).size !== value.hosts.length) throw Error();
  return structuredClone(value);
}

function validateKeys(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.keys) || value.keys.length > 100 ||
      Object.keys(value).some(key => !['version', 'keys'].includes(key))) throw Error();
  for (const key of value.keys) {
    if (!key || Object.keys(key).some(name => !['keyId', 'label', 'username', 'algorithm', 'publicKey', 'fingerprint', 'createdAt', 'privateKeyPath'].includes(name)) ||
        !text(key.keyId, 80) || !text(key.label, 120) || !text(key.username, 128) ||
        !text(key.algorithm, 80) || !text(key.publicKey, 16384) || !text(key.privateKeyPath, 4096) ||
        !/^SHA256:[A-Za-z0-9+/]{43}$/.test(key.fingerprint) || !text(key.createdAt, 64)) throw Error();
  }
  return structuredClone(value);
}

class SshStore {
  constructor(directory) {
    this.directory = directory;
    this.keysDirectory = path.join(directory, 'keys');
    this.profiles = new PrivateJsonFile(path.join(directory, 'profiles.json'), validateProfiles,
      () => ({version: 1, selectedProfileId: null, profiles: []}));
    this.trust = new PrivateJsonFile(path.join(directory, 'host-trust.json'), validateTrust,
      () => ({version: 1, hosts: []}));
    this.keys = new PrivateJsonFile(path.join(directory, 'keys.json'), validateKeys,
      () => ({version: 1, keys: []}));
    this.queue = Promise.resolve();
  }
  async load() {
    const [profiles, trust, keys] = await Promise.all([this.profiles.load(), this.trust.load(), this.keys.load()]);
    return {profiles, trust, keys};
  }
  mutate(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  saveProfile(input) {
    return this.mutate(async () => {
      const document = await this.profiles.load();
      const profile = profileInput({...input, id: input.id || `profile-${randomUUID()}`});
      const index = document.profiles.findIndex(item => item.id === profile.id);
      if (index < 0) document.profiles.push(profile); else document.profiles[index] = profile;
      document.selectedProfileId = profile.id;
      await this.profiles.write(document);
      return profile;
    });
  }
  selectProfile(id) {
    return this.mutate(async () => {
      const document = await this.profiles.load();
      if (!document.profiles.some(profile => profile.id === id)) fail('INVALID_PROFILE', 'SSH profile not found.');
      document.selectedProfileId = id;
      await this.profiles.write(document);
    });
  }
  trustHost(identity) {
    return this.mutate(async () => {
      const document = await this.trust.load();
      const existing = document.hosts.find(item => item.host === identity.host && item.port === identity.port);
      if (existing) fail('HOST_KEY_CHANGED', 'An existing host identity cannot be replaced from the application.');
      document.hosts.push(identity);
      await this.trust.write(document);
    });
  }
  listKeys() { return this.keys.load().then(document => document.keys); }
  generateKey(input) {
    return this.mutate(async () => {
      if (!input || !text(input.label, 120) || !text(input.username, 128) || !/^[a-zA-Z0-9_.@-]+$/.test(input.username) ||
          typeof input.passphrase !== 'string' || input.passphrase.length < 10 || input.passphrase.length > 4096) {
        fail('INVALID_PROFILE', 'Enter a key name, username and a passphrase of at least 10 characters.');
      }
      await mkdir(this.keysDirectory, {recursive: true, mode: 0o700});
      const directoryStat = await lstat(this.keysDirectory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
          (process.getuid && directoryStat.uid !== process.getuid())) throw Error('Unsafe SSH key directory.');
      if (process.platform !== 'win32') await chmod(this.keysDirectory, 0o700);
      const generated = await generateKeyPair(input.passphrase, input.label);
      input.passphrase = '';
      const parsed = utils.parseKey(generated.public);
      if (parsed instanceof Error || Array.isArray(parsed)) fail('KEY_INVALID', 'Generated public key could not be verified.');
      const keyId = `key-${randomUUID()}`;
      const privateKeyPath = path.join(this.keysDirectory, keyId);
      const publicPath = `${privateKeyPath}.pub`;
      const metadata = {keyId, label: input.label, username: input.username, algorithm: parsed.type,
        publicKey: generated.public.trim(),
        fingerprint: `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`,
        createdAt: new Date().toISOString(), privateKeyPath};
      try {
        const privateFile = await open(privateKeyPath, 'wx', 0o600);
        try { await privateFile.writeFile(generated.private); await privateFile.sync(); } finally { await privateFile.close(); }
        const publicFile = await open(publicPath, 'wx', 0o600);
        try { await publicFile.writeFile(`${metadata.publicKey}\n`); await publicFile.sync(); } finally { await publicFile.close(); }
        const document = await this.keys.load();
        document.keys.push(metadata);
        await this.keys.write(document);
        return metadata;
      } catch (error) {
        await unlink(privateKeyPath).catch(() => {});
        await unlink(publicPath).catch(() => {});
        throw error;
      } finally {
        generated.private = '';
        generated.public = '';
      }
    });
  }
}

module.exports = {PrivateJsonFile, SshStore, validateProfiles, validateTrust, validateKeys};
