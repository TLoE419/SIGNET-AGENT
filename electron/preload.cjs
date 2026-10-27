'use strict';

const {contextBridge, ipcRenderer} = require('electron');

async function call(name, ...args) {
  const reply = await ipcRenderer.invoke(`ssh:${name}`, ...args);
  if (!reply?.ok) {
    const error = Error(reply?.error?.message || 'SSH operation failed.');
    error.code = reply?.error?.code || 'UNKNOWN';
    throw error;
  }
  return reply.value;
}

contextBridge.exposeInMainWorld('signetDesktop', Object.freeze({
  isDesktop: true,
  ssh: Object.freeze({
    snapshot: () => call('snapshot'),
    saveProfile: input => call('saveProfile', input),
    selectProfile: id => call('selectProfile', id),
    inspectPrivateKey: keyPath => call('inspectPrivateKey', keyPath),
    listKeys: () => call('listKeys'),
    generateKey: input => call('generateKey', input),
    pickPrivateKey: () => call('pickPrivateKey'),
    connect: (id, passphrase) => call('connect', id, passphrase),
    disconnect: () => call('disconnect'),
    trustHost: identity => call('trustHost', identity),
    subscribe(listener) {
      if (typeof listener !== 'function') throw TypeError('SSH listener must be a function.');
      const receive = (_event, snapshot) => listener(snapshot);
      ipcRenderer.on('ssh:snapshot', receive);
      return () => ipcRenderer.removeListener('ssh:snapshot', receive);
    },
  }),
}));
