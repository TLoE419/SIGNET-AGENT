'use strict';
// Exercise the package entry, including startup dispatch, rather than calling launch directly.
const assert = require('node:assert/strict');
const {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} = require('node:fs');
const {once} = require('node:events');
const {randomBytes} = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const {app, BrowserWindow, Menu} = require('electron');
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
  active_session: latest, events: {[oldest]: [['Retained work event']]}}));
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
      const workspace = await window.webContents.executeJavaScript(`({
        title: document.querySelector('#ml-chat-title').textContent,
        draft: document.querySelector('#ml-input').value,
        messages: document.querySelectorAll('#ml-chat-transcripts .ml-chat-message').length,
        saved: document.querySelectorAll('#ml-chat-records > .ml-chat-record:not([hidden])').length,
        session: JSON.parse(document.querySelector('#initial-chat').textContent).session
      })`);
      assert.deepEqual(workspace, {title: 'New chat', draft: '', messages: 0, saved: 32, session: undefined});
      const classicLoaded = once(window.webContents, 'did-finish-load');
      Menu.getApplicationMenu().getMenuItemById('classic-view').click();
      await classicLoaded;
      assert.equal(await window.webContents.executeJavaScript('!!document.querySelector("#composer")'), true);
      const snapshot = () => window.webContents.executeJavaScript(`({
        initial: JSON.parse(document.querySelector('#initial-chat').textContent),
        text: document.querySelector('#messages').textContent,
        choices: document.querySelectorAll('#chat-list .chat-link').length,
        welcome: !!document.querySelector('#welcome')
      })`);
      const navigate = async selector => {
        const loaded = once(window.webContents, 'did-finish-load');
        const found = await window.webContents.executeJavaScript(`(() => {
          const button = document.querySelector(${JSON.stringify(selector)});
          if (!button) return false;
          setTimeout(() => button.click(), 0);
          return true;
        })()`);
        assert.equal(found, true, `Missing navigation control ${selector}`);
        await loaded;
      };
      let page = await snapshot();
      assert.equal(page.initial.session, latest);
      assert.match(page.text, /Saved conversation 31/);
      assert.equal(page.choices, 32);
      await navigate(`#chat-list [data-session=${JSON.stringify(oldest)}]`);
      page = await snapshot();
      assert.equal(page.initial.session, oldest);
      assert.match(page.text, /Saved conversation 0/);
      await navigate('#new-chat');
      page = await snapshot();
      assert.equal(page.welcome, true);
      assert.equal(page.initial.session, undefined);
      const loaded = once(window.webContents, 'did-finish-load');
      await window.loadURL(new URL('/classic', window.webContents.getURL()).href);
      await loaded;
      assert.equal((await snapshot()).initial.session, oldest);
      const stored = JSON.parse(readFileSync(stateFile, 'utf8'));
      assert.equal(stored.active_session, oldest);
      assert.deepEqual(stored.histories, histories);
      assert.deepEqual(stored.events[oldest], [['Retained work event']]);

      const workspaceLoaded = once(window.webContents, 'did-finish-load');
      Menu.getApplicationMenu().getMenuItemById('workspace-view').click();
      await workspaceLoaded;
      const deleted = await window.webContents.executeJavaScript(`(async () => {
        document.querySelector('#ml-chat-list-toggle').click();
        const savedCount = () => document.querySelectorAll('.ml-chat-record:not([hidden])').length;
        const before = savedCount();
        const row = [...document.querySelectorAll('.ml-chat-record')].find(node =>
          node.querySelector('strong').textContent === 'Saved conversation 0');
        row.querySelector('[data-delete-chat]').click();
        const dialog = document.querySelector('#ml-delete-chat-dialog');
        const opened = dialog.open;
        const focus = document.activeElement.id;
        if (!opened || focus !== 'ml-delete-chat-cancel') return {opened, focus};
        document.querySelector('#ml-delete-chat-confirm').click();
        for (let index = 0; index < 100 && dialog.open; index++) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        return {opened, focus, closed: !dialog.open, removed: !row.isConnected,
          removedCount: before - savedCount(),
          error: document.querySelector('#ml-delete-chat-error').textContent};
      })()`);
      assert.deepEqual(deleted, {opened: true, focus: 'ml-delete-chat-cancel', closed: true,
        removed: true, removedCount: 1, error: ''});
      const afterDelete = JSON.parse(readFileSync(stateFile, 'utf8'));
      const {[oldest]: removed, ...remainingHistories} = histories;
      assert.ok(removed);
      assert.deepEqual(afterDelete.histories, remainingHistories);
      assert.equal(afterDelete.events[oldest], undefined);
      console.log('PASS: new workspace chats, classic history, and authenticated removal of one saved chat');
      window.close();
    } catch (error) { fail(error); }
  }));
});
const pkg = require('../package.json');
require(path.resolve(__dirname, '..', pkg.main));
