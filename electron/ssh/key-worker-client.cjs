'use strict';

const {Worker} = require('node:worker_threads');
const path = require('node:path');
const {SshFailure} = require('./validation.cjs');

let running = 0;
function generateKeyPair(passphrase, label) {
  if (running >= 2) return Promise.reject(new SshFailure('UNKNOWN', 'Key generation is busy. Try again shortly.'));
  running++;
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'key-worker.cjs'), {workerData:{operation:'generate', passphrase, label}});
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new SshFailure('UNKNOWN', 'Key generation timed out.')), 30000);
    worker.once('message', reply => finish(reply.ok ? null : new SshFailure('UNKNOWN', reply.message), reply.value));
    worker.once('error', () => finish(new SshFailure('UNKNOWN', 'Key generation worker failed.')));
    worker.once('exit', code => { if (code !== 0 && !settled) finish(new SshFailure('UNKNOWN', 'Key generation worker stopped.')); });
  }).finally(() => { running--; passphrase = ''; });
}

module.exports = {generateKeyPair};
