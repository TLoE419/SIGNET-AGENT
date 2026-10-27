'use strict';

const {parentPort, workerData} = require('node:worker_threads');
const {utils} = require('ssh2');

try {
  if (workerData.operation !== 'generate' || typeof workerData.passphrase !== 'string' || typeof workerData.label !== 'string') throw Error('Invalid key worker request.');
  const value = utils.generateKeyPairSync('rsa', {bits: 4096, passphrase: workerData.passphrase,
    cipher: 'aes256-ctr', rounds: 16, comment: workerData.label});
  parentPort.postMessage({ok: true, value});
} catch (error) {
  parentPort.postMessage({ok: false, message: error.message || 'Key generation failed.'});
} finally {
  workerData.passphrase = undefined;
}
