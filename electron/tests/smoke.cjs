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
  const value = await window.webContents.executeJavaScript(`(async()=>({
    composer:!!document.querySelector('#composer'), stage6:!!document.querySelector('#stage6-pane'),
    language:!!document.querySelector('#language-toggle'), node:typeof window.require,
    chatStatus:(await fetch('/chat',{method:'POST',body:'{}'})).status,
    workspace:(await fetch('/stage6?session=12345678-1234-1234-1234-123456789abc',
      {headers:{'X-Chat-Token':document.querySelector('meta[name="chat-token"]').content}})).status,
    resources:performance.getEntriesByType('resource').filter(x=>x.name.startsWith(location.origin)).length
  }))()`);
  assert.equal(value.composer, true); assert.equal(value.stage6, true); assert.equal(value.language, true);
  assert.equal(value.node, 'undefined'); assert.equal(value.chatStatus, 403); assert.equal(value.workspace, 200);
  assert.ok(value.resources >= 5);
  await window.webContents.executeJavaScript(`document.querySelector('#language-toggle').click()`);
  assert.equal(await window.webContents.executeJavaScript('document.documentElement.lang'), 'zh-Hant');
  const external = await window.webContents.executeJavaScript(`fetch('http://127.0.0.1:1/').then(()=>false,()=>true)`);
  assert.equal(external, true);
  const currentURL = window.webContents.getURL();
  await window.webContents.executeJavaScript(`window.open('https://example.com'); location.assign('https://example.com')`);
  assert.equal(window.webContents.getURL(), currentURL);
  assert.equal(require('electron').BrowserWindow.getAllWindows().length, 1);
  const screenshot = await window.webContents.capturePage();
  writeFileSync(path.join(os.tmpdir(), 'signet-electron-shell.png'), screenshot.toPNG());
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
