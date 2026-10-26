'use strict';
// Exercise the package entry, including startup dispatch, rather than calling launch directly.
const assert = require('node:assert/strict');
const {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} = require('node:fs');
const {once} = require('node:events');
const {randomBytes} = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const {app, BrowserWindow} = require('electron');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'signet-entry-test-'));
app.setPath('appData', temporary);
const stateFile = path.join(temporary, 'SIGNET Research Assistant', 'state', '.chat-state.json');
const histories = Object.fromEntries(Array.from({length: 32}, (_, index) => [
  `${index.toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`,
  [{role: 'user', parts: [{text: `Saved conversation ${index}`}]}],
]));
const oldest = Object.keys(histories)[0], latest = Object.keys(histories).at(-1);
mkdirSync(path.dirname(stateFile), {recursive: true});
writeFileSync(stateFile, JSON.stringify({token: randomBytes(32).toString('hex'), histories,
  events: {[oldest]: [['Retained work event']]}}));
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
      const snapshot = () => window.webContents.executeJavaScript(`({
        initial: JSON.parse(document.querySelector('#initial-chat').textContent),
        text: document.querySelector('#messages').textContent,
        choices: document.querySelector('#saved-chats').options.length,
        welcome: !!document.querySelector('#welcome')
      })`);
      const navigate = async script => {
        const loaded = once(window.webContents, 'did-finish-load');
        await window.webContents.executeJavaScript(script);
        await loaded;
      };
      let page = await snapshot();
      assert.equal(page.initial.session, latest);
      assert.match(page.text, /Saved conversation 31/);
      assert.equal(page.choices, 33);
      await navigate(`document.querySelector('#saved-chats').value=${JSON.stringify(oldest)};
        document.querySelector('#saved-chats').dispatchEvent(new Event('change')); true`);
      page = await snapshot();
      assert.equal(page.initial.session, oldest);
      assert.match(page.text, /Saved conversation 0/);
      await navigate("document.querySelector('#new-chat').click(); true");
      page = await snapshot();
      assert.equal(page.welcome, true);
      assert.equal(page.initial.session, undefined);
      assert.equal(page.choices, 33);
      const loaded = once(window.webContents, 'did-finish-load');
      await window.loadURL(new URL('/', window.webContents.getURL()).href);
      await loaded;
      assert.equal((await snapshot()).initial.session, oldest);
      const stored = JSON.parse(readFileSync(stateFile, 'utf8'));
      assert.equal(stored.active_session, oldest);
      assert.deepEqual(stored.histories, histories);
      assert.deepEqual(stored.events[oldest], [['Retained work event']]);
      console.log('PASS: package entry creates a visible window; legacy histories restore, switch and survive explicit new chat without replay');
      window.close();
    } catch (error) { fail(error); }
  }));
});
const pkg = require('../package.json');
require(path.resolve(__dirname, '..', pkg.main));
