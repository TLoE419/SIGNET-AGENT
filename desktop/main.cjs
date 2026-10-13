const {app, BrowserWindow, protocol, ipcMain, dialog, shell, session, Menu} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {Service} = require('./service.cjs');
const {fields} = require('./core/drafts.cjs');
const {NativeInputs} = require('./native-inputs.cjs');
const {lookup: localResource} = require('./design-static.cjs');

protocol.registerSchemesAsPrivileged([{scheme: 'signet', privileges: {
  standard: true, secure: true, supportFetchAPI: true,
}}]);
// A separate user-data directory also isolates Electron's single-instance lock.
const reviewData = process.env.SIGNET_REVIEW_USER_DATA;
if (reviewData) {
  if (!path.isAbsolute(reviewData)) throw Error('Review userData must be absolute');
  app.setPath('userData', reviewData);
} else if (!app.isPackaged) app.setPath('userData', path.join(__dirname, '.runtime'));
app.commandLine.appendSwitch('force-renderer-accessibility');
const single = app.requestSingleInstanceLock();
let win, service;
const selectedInputs = new NativeInputs();
let desktopMode = 'formal';
const s1Methods = new Set(['mode','status','reconnect','schema','capabilities','list','detail','draftList','draftSave','draftLoad','inputValidate','pick']);
const home = 'signet://app/index.html';
const aidPattern = /^(a-[0-9]{8}T[0-9]{6}-[a-f0-9]{12}|macos-vm-smoke-20261006)$/;
const artifacts = new Set(['network.html', 'edges.csv', 'network.json', 'Afreq', 'CoeffMat0',
  'positions', 'verification.json', 'scheduler-jobs.json']);
function aid(id) {
  if (typeof id !== 'string' || !aidPattern.test(id)) throw Error('Invalid analysis ID');
  return id;
}
function artifact(id, name) {
  aid(id);
  if (!artifacts.has(name) && !/^stage-(genotype|expression|adjustment|ciseqtl|network|visualization)-\d+$/.test(name)) throw Error('Artifact filename is not allowed');
  return name;
}
async function projectRoot() {
  if (!app.isPackaged) {
    const isolated = process.env.SIGNET_REVIEW_PROJECT_ROOT;
    if (isolated) {
      if (!reviewData || !path.isAbsolute(isolated) || !fs.realpathSync(isolated).startsWith(fs.realpathSync(reviewData) + path.sep + 'fixture-project' + path.sep)) throw Error('Isolated project must be under review userData/fixture-project/');
      return fs.realpathSync(isolated);
    }
    return path.resolve(__dirname, '..');
  }
  const config = path.join(app.getPath('userData'), 'project.json');
  let root;
  try { root = JSON.parse(fs.readFileSync(config)).root; } catch {}
  const valid = p => typeof p === 'string' && ['official-signet/signet', 'tools/run-stage.sh',
    'evidence/input-validation.json'].every(f => fs.existsSync(path.join(p, f)));
  if (!valid(root)) {
    const choice = await dialog.showOpenDialog({title: 'Select the SIGNET project folder',
      message: 'The desktop app uses this project’s official source, VM, and analysis records.', properties: ['openDirectory']});
    if (choice.canceled) return null;
    root = choice.filePaths[0];
    if (!valid(root)) throw Error('The selected folder lacks SIGNET runtime or verification records.');
    fs.mkdirSync(path.dirname(config), {recursive: true});
    fs.writeFileSync(config, JSON.stringify({root}));
  }
  return root;
}
function handle(name, fn) {
  ipcMain.handle('desktop:' + name, async (event, ...args) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame ||
        event.senderFrame.url !== home) throw Error('Untrusted desktop request');
    try {
      if (!s1Methods.has(name)) throw Error('Not ready: this action belongs to a later stage (S2–S7).');
      if (desktopMode === 'review' && name !== 'mode') throw Error('Design review is isolated; real operations are disabled.');
      return {ok: true, value: await fn(...args)};
    }
    catch (e) { return {ok: false, error: e.message}; }
  });
}
function installBridge() {
  handle('mode', mode => {if (!['formal','review'].includes(mode)) throw Error('Invalid desktop mode');desktopMode=mode;return mode;});
  handle('capabilities', () => service.call('capabilities'));
  handle('draftList', () => service.call('draftList'));
  handle('draftSave', p => {if (!p || typeof p !== 'object' || Array.isArray(p)) throw Error('Invalid draft');return service.call('draftSave', p, selectedInputs.resolve(p));});
  handle('draftLoad', id => service.call('draftLoad', id));
  handle('inputValidate', (id, revision) => service.call('inputValidate', id, revision));
  handle('closeVisualization', async () => {await service.visualization.stop();return true;});
  handle('visualization', async id => {await service.call('detail',aid(id));return service.visualization.open(aid(id));});
  handle('status', () => service.status());
  handle('reconnect', () => service.connect());
  handle('schema', () => service.call('schema'));
  handle('list', () => service.call('list'));
  handle('detail', id => service.call('detail', aid(id)));
  handle('logs', id => service.call('logs', aid(id)));
  handle('pick', async (key, cohort, workflow = 'preprocessing') => {
    const field = fields(workflow,cohort).find(f => f[0] === key);
    if (!field) throw Error('Unknown input field');
    const choice = await dialog.showOpenDialog(win, {title: 'Select ' + field[1],
      properties: [field[2] === 'directory' ? 'openDirectory' : 'openFile']});
    if (choice.canceled) return {canceled: true};
    if (desktopMode !== 'formal') return {canceled:true};
    const token = selectedInputs.add(key,cohort,workflow,choice.filePaths[0]);
    return {token, name: path.basename(choice.filePaths[0])};
  });
  handle('create', params => {
    if (!params || typeof params !== 'object' || Array.isArray(params) ||
        Object.keys(params).some(k => !['label', 'dataset', 'cohort', 'parameters', 'imports', 'nboots'].includes(k)))
      throw Error('Only defined analysis settings are accepted');
    const imports = {};
    for (const [key, token] of Object.entries(params.imports || {})) {
      const selected = selectedInputs.items.get(token);
      if (!selected || selected.key !== key || selected.cohort !== params.cohort) throw Error('Import inputs through the native file picker');
      imports[key] = selected.source;
    }
    return service.call('create', {...params, imports});
  });
  handle('start', (id, stage) => {
    if (id === 'macos-vm-smoke-20261006') throw Error('Historical results cannot be rerun');
    return service.call('start', aid(id), stage);
  });
  handle('cancel', id => service.call('cancel', aid(id)));
  handle('save', async (id, name) => {
    artifact(id, name);
    // Authorize before the dialog; copy and verify large exports in the worker.
    await service.call('artifact', id, name);
    const choice = await dialog.showSaveDialog(win, {
      title: 'Save analysis result', defaultPath: path.join(app.getPath('downloads'), `${id}-${name}`),
    });
    if (choice.canceled || !choice.filePath) return {canceled: true};
    return service.call('saveArtifact', id, name, choice.filePath);
  });
  handle('reveal', async id => {
    const item = await service.call('detail', aid(id));
    const folder = path.join(service.root, item.legacy ? 'results/actual' : 'analyses/' + id);
    const error = await shell.openPath(folder);
    if (error) throw Error(error);
    return folder;
  });
}
async function protocols() {
  protocol.handle('signet', async request => {
    const url = new URL(request.url);
    if (url.host !== 'app' || request.method !== 'GET') return new Response('', {status: 403});
    const resource = localResource(url.host, request.method, url.pathname);
    if (resource) {
      const [file, mime] = resource;
      return new Response(fs.readFileSync(path.join(__dirname, file)), {headers: {
        'Content-Type': mime + '; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; frame-src http://127.0.0.1:*; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'",
      }});
    }
    return new Response('', {status: 404});
  });
}
function makeWindow() {
  win = new BrowserWindow({width: 1440, height: 960, useContentSize: true, show: process.env.SIGNET_REVIEW_HIDDEN !== '1', minWidth: 850, minHeight: 650,
    title: 'SIGNET', backgroundColor: '#f5f5f5', webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, backgroundThrottling: false,
    }});
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('will-frame-navigate', e => {
    const url = e.url;
    if (service.visualization.url && url?.startsWith(service.visualization.url)) return;
    if (url !== home)
      e.preventDefault();
  });
  win.webContents.on('will-attach-webview', e => e.preventDefault());
  win.on('closed', () => { win = null; app.quit(); });
  win.loadURL(home);
}
if (!single) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label: 'SIGNET', submenu: [{role: 'about'}, {type: 'separator'}, {role: 'quit', label: 'Quit SIGNET'}]},
      {label: 'Edit', submenu: [{role: 'undo'}, {role: 'redo'}, {type: 'separator'}, {role: 'cut'}, {role: 'copy'}, {role: 'paste'}, {role: 'selectAll'}]},
      {label: 'Window', submenu: [{role: 'minimize'}, {role: 'zoom'}]},
      {label: 'Workspace', submenu: [{label:'Local records',click:()=>win?.webContents.executeJavaScript('window.signetWorkspace.open()')}]},
      {label: 'Review', submenu: [{label: 'Design review routes', accelerator: 'CmdOrCtrl+Shift+R',
        click: () => win?.webContents.executeJavaScript('window.signetReview.openIndex()')}]},
    ]));
    const root = await projectRoot();
    if (!root) { app.quit(); return; }
    service = new Service(root);
    await service.connect();
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*', 'file://*/*']},
      (details, callback) => callback({cancel: !(service.visualization.url && details.url.startsWith(service.visualization.url))}));
    installBridge();
    await protocols();
    makeWindow();
  }).catch(async e => {
    await dialog.showMessageBox({type: 'error', title: 'SIGNET startup failed', message: e.message});
    app.quit();
  });
  app.on('before-quit', () => service?.stopOwned());
  app.on('window-all-closed', () => app.quit());
}
