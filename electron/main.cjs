'use strict';
const {app, BrowserWindow, dialog, session, Menu, ipcMain, shell, safeStorage} = require('electron');
const path = require('node:path');
const os = require('node:os');
const {randomBytes} = require('node:crypto');
const {Backend} = require('./backend.cjs');
const {localURL, navigationAllowed} = require('./policy.cjs');
const {SshConnectionService, SshProfileRepository, HostKeyTrustStore, AppManagedKeyStore, installSshHandlers, installDevTerminal} = require('./build/ssh/index.cjs');
const {SshBroker} = require('./ssh/broker.cjs');
const {GeminiKeyStore, ModelController, installModelHandlers} = require('./model/index.cjs');

async function launch({provider, visible = true, userData, stateFile, startupMs, devMode = false} = {}) {
  if (process.platform === 'win32') throw Error('This desktop launcher currently supports macOS and Linux. Use the browser launcher on other platforms.');
  app.setName('SIGNET Research Assistant');
  app.setPath('userData', userData || path.join(app.getPath('appData'), 'SIGNET Research Assistant'));
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  devMode = devMode === true && !app.isPackaged;
  let devTerminal;
  let window, origin, quitting = false, finished = false, disposeSsh, disposeModel, switching;
  const sshToken = randomBytes(32).toString('base64url');
  // macOS limits Unix socket paths to roughly 100 bytes. /tmp is the stable,
  // short alias for its much longer per-user temporary directory.
  const socketBase = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
  const sshSocket = path.join(socketBase, `signet-ssh-${randomBytes(12).toString('hex')}`, 'broker.sock');
  const sshDirectory = path.join(app.getPath('userData'), 'ssh');
  const sshService = new SshConnectionService(new SshProfileRepository(sshDirectory), new HostKeyTrustStore(sshDirectory), undefined, undefined, new AppManagedKeyStore(sshDirectory));
  const sshBroker = new SshBroker({socketPath: sshSocket, token: sshToken, service: sshService});
  const modelStore = new GeminiKeyStore(path.join(app.getPath('userData'), 'model'), safeStorage);
  // The Python service reads the provider and key only at startup, so a model change replaces it.
  let backend, activeProvider, activeKey;
  const createBackend = (nextProvider, key) => new Backend({provider: nextProvider, startupMs,
    stateFile: stateFile || path.join(app.getPath('userData'), 'state', '.chat-state.json'),
    sshBroker: {path: sshSocket, token: sshToken}, env: key ? {GEMINI_API_KEY: key} : {}});
  function watch(owned) {
    owned.on('closed', async () => {
      if (quitting || owned.stopping) return;
      window?.hide();
      await dialog.showMessageBox({type: 'error', title: 'SIGNET service stopped',
        message: 'The Python service exited unexpectedly.',
        detail: 'Restart SIGNET and inspect recorded work status before retrying. No tools were automatically replayed.'});
      await quit();
    });
  }
  async function startBackend(nextProvider, key) {
    backend = createBackend(nextProvider, key);
    origin = await backend.start();
    activeProvider = nextProvider;
    activeKey = key;
    watch(backend);
  }
  function switchProvider(nextProvider, key) {
    if (switching || quitting) return switching;
    switching = (async () => {
      const previous = {provider: activeProvider, key: activeKey};
      // stop() lets an active chat turn finish and checkpoint before the service is replaced.
      await backend.stop();
      if (quitting) return;
      try { await startBackend(nextProvider, key); }
      catch (error) {
        if (quitting) return;
        await dialog.showMessageBox({type: 'error', title: 'Could not switch model', message: error.message,
          detail: 'SIGNET restarted with the previous model.'});
        try { await startBackend(previous.provider, previous.key); }
        catch { await quit(); return; }
      }
      if (!quitting && window && !window.isDestroyed()) await window.loadURL(origin + '/');
    })().finally(() => { switching = undefined; });
    return switching;
  }
  const modelController = new ModelController({store: modelStore, getProvider: () => activeProvider, switchProvider});
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
    await switching?.catch(() => {});
    const closing = backend ? backend.stop() : Promise.resolve();
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
    await sshService.shutdown().catch(() => {});
    await sshBroker.close().catch(() => {});
    devTerminal?.dispose();
    disposeSsh?.();
    disposeModel?.();
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
  try {
    // A damaged SSH configuration should be recoverable without disabling chat.
    await sshService.initialize().catch(() => {});
    await sshBroker.start();
    disposeSsh = installSshHandlers(ipcMain, () => window, sshService, async () => {
      const choice = await dialog.showOpenDialog(window, {title:'Select an encrypted OpenSSH private key', properties:['openFile']});
      return choice.canceled || !choice.filePaths[0] ? {canceled:true} : {canceled:false,path:choice.filePaths[0],name:path.basename(choice.filePaths[0])};
    }, () => origin);
    disposeModel = installModelHandlers(ipcMain, () => window, modelController, () => origin);
    // A saved Gemini key selects Gemini unless --provider was given explicitly.
    const savedKey = await modelStore.load().catch(() => null);
    const startProvider = provider || (savedKey ? 'gemini' : 'codex');
    await startBackend(startProvider, startProvider === 'gemini' ? savedKey : null);
    if(devMode)devTerminal=installDevTerminal(ipcMain,()=>window,sshService,()=>origin);
  }
  catch (error) {
    if (!quitting) await dialog.showMessageBox({type: 'error', title: 'SIGNET could not start', message: error.message});
    await quit();
    return;
  }
  if (quitting) return;
  const isolated = session.fromPartition('signet-shell');
  // xterm generates per-size/theme CSS. Only the explicit development window
  // permits inline styles; scripts, network policy and production CSP stay strict.
  if(devMode)isolated.webRequest.onHeadersReceived((details,callback)=>{
    const headers={...details.responseHeaders};
    if(details.resourceType==='mainFrame'&&localURL(details.url,origin)){
      for(const key of Object.keys(headers))if(key.toLowerCase()==='content-security-policy')headers[key]=headers[key].map(value=>value.replace("style-src 'self'","style-src 'self' 'unsafe-inline'"));
    }
    callback({responseHeaders:headers});
  });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) => callback({cancel: !localURL(details.url, origin)}));
  isolated.on('will-download', (event, item, contents) => {
    if (contents !== window?.webContents || !localURL(item.getURL(), origin) || new URL(item.getURL()).pathname !== '/stage6/file') event.preventDefault();
    // Valid result downloads retain Chromium's normal save dialog.
  });
  window = new BrowserWindow({width: 1320, height: 900, minWidth: 760, minHeight: 540, show: false,
    title: 'SIGNET Research Assistant', webPreferences: {session: isolated, nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false,
      additionalArguments: devMode ? ['--signet-dev-terminal'] : [],
      preload: path.join(__dirname, 'preload.cjs')}});
  window.on('close', event => { if (!finished) { event.preventDefault(); void quit(); } });
  window.webContents.setWindowOpenHandler(({url}) => {
    if (localURL(window.webContents.mainFrame.url, origin) &&
        ['https://rcic.uci.edu/account/login.html', 'https://rcic.uci.edu/account/generate-ssh-keys.html',
          'https://aistudio.google.com/app/apikey'].includes(url)) {
      void shell.openExternal(url);
    }
    return {action:'deny'};
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-navigate', (event, url) => { if (!navigationAllowed(url, origin)) event.preventDefault(); });
  window.webContents.on('will-redirect', (event, url) => { if (!navigationAllowed(url, origin)) event.preventDefault(); });
  window.webContents.on('will-frame-navigate', event => {
    if (!event.isMainFrame || !navigationAllowed(event.url, origin)) event.preventDefault();
  });
  window.webContents.on('did-start-navigation',event=>{if(event.isMainFrame)devTerminal?.close()});
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
  if (index < 0) return undefined;
  const provider = argv[index + 1];
  if (!['codex', 'gemini', 'groq'].includes(provider)) throw Error('Use --provider codex, gemini or groq.');
  return provider;
}
module.exports = {launch, providerFromArgs};
