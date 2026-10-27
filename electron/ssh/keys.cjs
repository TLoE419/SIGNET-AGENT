'use strict';

const {constants} = require('node:fs');
const {open, realpath} = require('node:fs/promises');
const {utils} = require('ssh2');
const {fail, absolutePath} = require('./validation.cjs');

async function readPrivateKey(keyPath) {
  if (!absolutePath(keyPath)) fail('KEY_UNREADABLE', 'Select an absolute private-key path.');
  let file;
  try { file = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { fail(error.code === 'ENOENT' ? 'KEY_NOT_FOUND' : 'KEY_UNREADABLE', 'Cannot read the selected private key.'); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > 128 * 1024) fail('KEY_INVALID', 'Use a private-key file smaller than 128 KiB.');
    if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || !(stat.mode & 0o400) || (process.getuid && stat.uid !== process.getuid()))) {
      fail('KEY_UNREADABLE', 'The private key must be owned by you with permissions set to 0600.');
    }
    await realpath(keyPath);
    const bytes = Buffer.alloc(stat.size + 1);
    const {bytesRead} = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) fail('KEY_UNREADABLE', 'The private key changed while it was being read.');
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}

async function inspectPrivateKey(keyPath) {
  const bytes = await readPrivateKey(keyPath);
  try {
    const source = bytes.toString('utf8').trim();
    if (!source.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')) {
      return {status: 'unsupported', reason: 'Use a passphrase-protected OpenSSH private key.'};
    }
    const parsed = utils.parseKey(bytes);
    if (!(parsed instanceof Error)) return {status: 'unencrypted', reason: 'The selected key has no passphrase.'};
    if (/encrypted|passphrase/i.test(parsed.message)) return {status: 'encrypted', format: 'OpenSSH'};
    return {status: 'invalid', reason: 'The selected OpenSSH private key is invalid.'};
  } finally { bytes.fill(0); }
}

async function unlockPrivateKey(keyPath, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length === 0 || passphrase.length > 4096) {
    fail('PASSPHRASE_REQUIRED', 'Enter the private-key passphrase.');
  }
  const bytes = await readPrivateKey(keyPath);
  try {
    const parsed = utils.parseKey(bytes, passphrase);
    if (parsed instanceof Error) fail('INVALID_PASSPHRASE', 'Unable to unlock the key. Check the passphrase and key file.');
    const keys = Array.isArray(parsed) ? parsed : [parsed];
    if (keys.length !== 1 || !keys[0].isPrivateKey()) fail('KEY_INVALID', 'The selected file is not one private key.');
    return Buffer.from(bytes);
  } finally { bytes.fill(0); }
}

module.exports = {readPrivateKey, inspectPrivateKey, unlockPrivateKey};
