'use strict';
// Actual Electron + unchanged Web UI + real Python service. No model calls or data.
const assert = require('node:assert/strict');
const {mkdtempSync, rmSync, writeFileSync} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app} = require('electron');
const {launch} = require('../main.cjs');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'signet-electron-smoke-'));
let running;
const deadline = setTimeout(async () => {
  console.error('Electron smoke timed out');
  await running?.backend.forceStop();
  app.exit(1);
}, 45000);
app.on('will-quit', () => { clearTimeout(deadline); rmSync(temporary, {recursive: true, force: true}); });
(async () => {
  running = await launch({visible: false, userData: path.join(temporary, 'app'), stateFile: path.join(temporary, 'state', '.chat-state.json')});
  assert.ok(running);
  const {window, backend, origin} = running;
  const prefs = window.webContents.getLastWebPreferences();
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
    const deadline=Date.now()+10000;const check=()=>{if(document.querySelector('#ssh-root .ssh-status-block'))resolve();else if(Date.now()>deadline)reject(Error('SSH UI did not mount'));else setTimeout(check,25)};check();
  })`);
  const value = await window.webContents.executeJavaScript(`(async()=>({
    composer:!!document.querySelector('#composer'), stage6:!!document.querySelector('#stage6-pane'),
    language:!!document.querySelector('#language-toggle'), node:typeof window.require,
    chatStatus:(await fetch('/chat',{method:'POST',body:'{}'})).status,
    workspace:(await fetch('/stage6?session=12345678-1234-1234-1234-123456789abc',
      {headers:{'X-Chat-Token':document.querySelector('meta[name="chat-token"]').content}})).status,
    sshButton:!!document.querySelector('#ssh-root .ssh-status-block'),
    sshBridge:Object.keys(window.signetDesktop?.ssh||{}).sort(),
    resources:performance.getEntriesByType('resource').filter(x=>x.name.startsWith(location.origin)).length
  }))()`);
  assert.equal(value.composer, true); assert.equal(value.stage6, true); assert.equal(value.language, true);
  assert.equal(value.node, 'undefined'); assert.equal(value.chatStatus, 403); assert.equal(value.workspace, 200);
  assert.equal(value.sshButton, true);
  assert.deepEqual(value.sshBridge, ['addExternalKey', 'answerAuthChallenge', 'cancelRegistration', 'connect', 'disconnect', 'generateKey', 'getSnapshot', 'initialize', 'inspectPrivateKey', 'listKeys', 'listProfiles', 'pickPrivateKey', 'registerGenerated', 'saveProfile', 'selectProfile', 'subscribe', 'subscribeAuthChallenge', 'trustHost']);
  assert.equal(value.sshBridge.some(name => /exec|shell|readFile|writeFile/.test(name)), false);
  assert.ok(value.resources >= 5);
  await window.webContents.executeJavaScript(`document.querySelector('#language-toggle').click()`);
  assert.equal(await window.webContents.executeJavaScript('document.documentElement.lang'), 'zh-Hant');
  const external = await window.webContents.executeJavaScript(`fetch('http://127.0.0.1:1/').then(()=>false,()=>true)`);
  assert.equal(external, true);
  const currentURL = window.webContents.getURL();
  await window.webContents.executeJavaScript(`window.open('https://example.com'); location.assign('https://example.com')`);
  assert.equal(window.webContents.getURL(), currentURL);
  assert.equal(require('electron').BrowserWindow.getAllWindows().length, 1);
  const flow = await window.webContents.executeJavaScript(`(async()=>{
    const settle=()=>new Promise(resolve=>setTimeout(resolve,80));
    document.querySelector('.ssh-identity').click();await settle();
    const connection=document.querySelector('dialog[open]');
    const result={connection:connection.querySelector('h2').textContent,advancedCollapsed:!connection.querySelector('.ssh-advanced').open,accountPassword:!!connection.querySelector('input[aria-label="UCInetID password"]')};
    [...connection.querySelectorAll('button')].find(b=>b.textContent==='Add SSH key…').click();await settle();
    const registration=document.querySelector('dialog[open]');result.registration=registration.querySelector('h2').textContent;
    result.sources=[...registration.querySelectorAll('[role=radio]')].map(b=>b.textContent);
    registration.querySelectorAll('[role=radio]')[1].click();await settle();
    result.existing=!!registration.querySelector('input[aria-label="SSH private key"]');
    result.keyName=!!registration.querySelector('input[aria-label="Key name"]');
    result.account=!!registration.querySelector('input[aria-label="UCInetID / username"]');
    return result;
  })()`);
  assert.equal(flow.connection,'SSH connection');assert.equal(flow.advancedCollapsed,true);assert.equal(flow.accountPassword,false);
  assert.equal(flow.registration,'Add SSH key');assert.equal(flow.sources.length,2);assert.equal(flow.existing,true);assert.equal(flow.keyName,true);assert.equal(flow.account,true);
  const screenshot = await window.webContents.capturePage();
  writeFileSync(path.join(os.tmpdir(), 'signet-ssh-original-flow.png'), screenshot.toPNG());
  let shutdownVerified = false;
  app.on('before-quit', event => { if (!shutdownVerified) event.preventDefault(); });
  backend.closed.then(async () => {
    await assert.rejects(fetch(origin));
    console.log('PASS: actual Web UI, sandbox, HTTP protections, workspace, language, navigation and owned service shutdown');
    shutdownVerified = true;
    app.quit();
  }).catch(error => { console.error(error); app.exit(1); });
  window.close();
})().catch(async error => {
  console.error(error);
  clearTimeout(deadline);
  await running?.backend.forceStop();
  rmSync(temporary, {recursive: true, force: true});
  app.exit(1);
});
