'use strict';
// Exercise the package entry, including startup dispatch, rather than calling launch directly.
const assert = require('node:assert/strict');
const {mkdtempSync, rmSync} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app, BrowserWindow} = require('electron');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'signet-entry-test-'));
app.setPath('appData', temporary);
function fail(error) {
  console.error(error);
  clearTimeout(deadline);
  rmSync(temporary, {recursive: true, force: true});
  app.exit(1);
}
const deadline = setTimeout(() => fail('FAIL: package entry did not create and close a visible SIGNET window'), 45000);
app.on('will-quit', () => {
  clearTimeout(deadline);
  rmSync(temporary, {recursive: true, force: true});
});
app.once('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => setImmediate(async () => {
    try {
      assert.equal(BrowserWindow.getAllWindows().length, 1);
      assert.equal(window.isVisible(), true);
      assert.match(window.webContents.getURL(), /^http:\/\/127\.0\.0\.1:/);
      assert.equal(await window.webContents.executeJavaScript('!!document.querySelector("#composer")'), true);
      console.log('PASS: package entry creates a visible SIGNET window with the chat interface');
      window.close();
    } catch (error) { fail(error); }
  }));
});
const pkg = require('../package.json');
require(path.resolve(__dirname, '..', pkg.main));
