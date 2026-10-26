'use strict';
const {app, BrowserWindow, dialog, session, Menu} = require('electron');
const path = require('node:path');
const {Backend} = require('./backend.cjs');
const {localURL, navigationAllowed} = require('./policy.cjs');

async function launch({provider = 'codex', visible = true, userData, stateFile, startupMs} = {}) {
  if (process.platform === 'win32') throw Error('This desktop launcher currently supports macOS and Linux. Use the browser launcher on other platforms.');
  app.setName('SIGNET Research Assistant');
  app.setPath('userData', userData || path.join(app.getPath('appData'), 'SIGNET Research Assistant'));
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  let window, quitting = false, finished = false;
  const backend = new Backend({provider, startupMs, stateFile: stateFile || path.join(app.getPath('userData'), 'state', '.chat-state.json')});
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', event => {
    if (finished) return;
    event.preventDefault();
    void quit();
  });
  app.on('window-all-closed', () => { void quit(); });
  async function quit() {
    if (quitting) return;
    quitting = true;
    window?.hide();
    const closing = backend.stop();
    let closed = false;
    void closing.then(() => { closed = true; });
    while (!closed) {
      let timer;
      await Promise.race([closing, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
      clearTimeout(timer);
      if (closed) break;
      const {response} = await dialog.showMessageBox({type: 'question', title: 'SIGNET is finishing work',
        message: 'The Python service is still finishing active requests.',
        detail: 'Wait to preserve results. Force quit may interrupt local work and leave remote jobs running. Check recorded job status before retrying.',
        buttons: ['Keep waiting', 'Force quit'], defaultId: 0, cancelId: 0, noLink: true});
      if (response === 1) { await backend.forceStop(); break; }
    }
    finished = true;
    app.quit();
  }
  await app.whenReady();
  if (quitting) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{role: 'appMenu'}] : []),
    {role: 'fileMenu'}, {role: 'editMenu'},
    {label: 'View', submenu: [{role: 'reload'}, {role: 'resetZoom'}, {role: 'zoomIn'}, {role: 'zoomOut'}, {role: 'togglefullscreen'}]},
    {role: 'windowMenu'},
  ]));
  let origin;
  try { origin = await backend.start(); }
  catch (error) {
    if (!quitting) await dialog.showMessageBox({type: 'error', title: 'SIGNET could not start', message: error.message});
    await quit();
    return;
  }
  if (quitting) return;
  backend.on('closed', async () => {
    if (quitting || backend.stopping) return;
    window?.hide();
    await dialog.showMessageBox({type: 'error', title: 'SIGNET service stopped',
      message: 'The Python service exited unexpectedly.',
      detail: 'Restart SIGNET and inspect recorded work status before retrying. No tools were automatically replayed.'});
    await quit();
  });
  const isolated = session.fromPartition('signet-shell');
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) => callback({cancel: !localURL(details.url, origin)}));
  isolated.on('will-download', (event, item, contents) => {
    if (contents !== window?.webContents || !localURL(item.getURL(), origin) || new URL(item.getURL()).pathname !== '/stage6/file') event.preventDefault();
    // Valid result downloads retain Chromium's normal save dialog.
  });
  window = new BrowserWindow({width: 1320, height: 900, minWidth: 760, minHeight: 540, show: false,
    title: 'SIGNET Research Assistant', webPreferences: {session: isolated, nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false}});
  window.on('close', event => { if (!finished) { event.preventDefault(); void quit(); } });
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-navigate', (event, url) => { if (!navigationAllowed(url, origin)) event.preventDefault(); });
  window.webContents.on('will-redirect', (event, url) => { if (!navigationAllowed(url, origin)) event.preventDefault(); });
  window.webContents.on('will-frame-navigate', event => {
    if (!event.isMainFrame || !navigationAllowed(event.url, origin)) event.preventDefault();
  });
  window.webContents.on('render-process-gone', () => { void quit(); });
  try {
    await window.loadURL(origin + '/');
    if (visible && !quitting) window.show();
  } catch (error) {
    if (!quitting) await dialog.showMessageBox({type: 'error', title: 'SIGNET could not load', message: 'Could not load the local interface.'});
    await quit();
    return;
  }
  return {window, backend, quit, origin};
}

function providerFromArgs(argv) {
  const index = argv.indexOf('--provider');
  const provider = index < 0 ? 'codex' : argv[index + 1];
  if (!['codex', 'gemini', 'groq'].includes(provider)) throw Error('Use --provider codex, gemini or groq.');
  return provider;
}
module.exports = {launch, providerFromArgs};
