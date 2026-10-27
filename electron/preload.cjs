'use strict';
const {contextBridge, ipcRenderer} = require('electron');
const call = (name, ...args) => ipcRenderer.invoke(`ssh:${name}`, ...args);
function subscribe(channel, listener) {
  if (typeof listener !== 'function') throw TypeError('SSH listener must be a function.');
  const receive = (_event, value) => listener(value);
  ipcRenderer.on(channel, receive);
  return () => ipcRenderer.removeListener(channel, receive);
}
const devTerminal=process.argv.includes('--signet-dev-terminal')?Object.freeze({
  open:(id,cols,rows)=>ipcRenderer.invoke('ssh-dev:open',id,cols,rows),
  input:(id,data)=>ipcRenderer.invoke('ssh-dev:input',id,data),
  resize:(id,cols,rows)=>ipcRenderer.invoke('ssh-dev:resize',id,cols,rows),
  ack:(id,bytes)=>ipcRenderer.invoke('ssh-dev:ack',id,bytes),
  close:id=>ipcRenderer.invoke('ssh-dev:close',id),
  subscribe:listener=>subscribe('ssh-dev:event',listener),
  activity:listener=>subscribe('ssh-dev:activity',listener),
  diagnostics:listener=>subscribe('ssh-dev:diagnostic',listener),
  history:()=>ipcRenderer.invoke('ssh-dev:history'),
  raw:listener=>subscribe('ssh-dev:raw',listener),
  rawHistory:()=>ipcRenderer.invoke('ssh-dev:rawHistory'),
}):undefined;
contextBridge.exposeInMainWorld('signetDesktop', Object.freeze({isDesktop:true,...(devTerminal?{devTerminal}:{}), ssh:Object.freeze({
  cancelRegistration: () => call('cancelRegistration'),
  initialize: () => call('initialize'),
  getSnapshot: () => call('getSnapshot'),
  listProfiles: () => call('listProfiles'),
  saveProfile: input => call('saveProfile', input),
  selectProfile: id => call('selectProfile', id),
  inspectPrivateKey: path => call('inspectPrivateKey', path),
  pickPrivateKey: () => call('pickPrivateKey'),
  connect: (id, passphrase) => call('connect', id, passphrase),
  disconnect: id => call('disconnect', id),
  trustHost: identity => call('trustHost', identity),
  listKeys: () => call('listKeys'),
  generateKey: input => call('generateKey', input),
  addExternalKey: input => call('addExternalKey', input),
  registerGenerated: input => call('registerGenerated', input),
  answerAuthChallenge: (sessionId, challengeId, answers) => call('answerAuthChallenge', sessionId, challengeId, answers),
  subscribe: listener => subscribe('ssh:snapshot', listener),
  subscribeAuthChallenge: listener => subscribe('ssh:auth-challenge', listener),
})}));
