'use strict';
const {mkdir, open, readFile, rename, unlink, lstat, chmod} = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

const KEY_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;

class ModelKeyError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function validGeminiKey(value) {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

/** Gemini API key encrypted by the OS keychain; plaintext never reaches disk or the renderer. */
class GeminiKeyStore {
  constructor(directory, safeStorage) {
    this.directory = directory;
    this.file = path.join(directory, 'gemini.key');
    this.safeStorage = safeStorage;
  }
  encryptionAvailable() {
    try { return this.safeStorage.isEncryptionAvailable(); } catch { return false; }
  }
  async prepare() {
    await mkdir(this.directory, {recursive: true, mode: 0o700});
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
      throw new ModelKeyError('UNSAFE_STORAGE', 'Unsafe model key directory.');
    }
    if (process.platform !== 'win32') await chmod(this.directory, 0o700);
  }
  async has() {
    try { return (await lstat(this.file)).isFile(); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async load() {
    if (!await this.has()) return null;
    if (!this.encryptionAvailable()) throw new ModelKeyError('ENCRYPTION_UNAVAILABLE', 'System keychain encryption is unavailable.');
    let value;
    try { value = this.safeStorage.decryptString(await readFile(this.file)); }
    catch { throw new ModelKeyError('KEY_UNREADABLE', 'The saved Gemini key could not be decrypted. Remove it and enter it again.'); }
    if (!validGeminiKey(value)) throw new ModelKeyError('KEY_UNREADABLE', 'The saved Gemini key is invalid. Remove it and enter it again.');
    return value;
  }
  async save(value) {
    if (!validGeminiKey(value)) throw new ModelKeyError('KEY_INVALID', 'This does not look like a Gemini API key.');
    if (!this.encryptionAvailable()) throw new ModelKeyError('ENCRYPTION_UNAVAILABLE', 'System keychain encryption is unavailable, so the key was not saved.');
    await this.prepare();
    const encrypted = this.safeStorage.encryptString(value);
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(encrypted); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async clear() {
    await unlink(this.file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

module.exports = {GeminiKeyStore, ModelKeyError, validGeminiKey};
