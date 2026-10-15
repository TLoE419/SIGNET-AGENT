const {app, BrowserWindow, protocol, ipcMain, dialog, shell, session, Menu} = require('electron');
const fs = require('node:fs');
const {Buffer}=require('node:buffer');
const path = require('node:path');
const {Service} = require('./service.cjs');
const {fields} = require('./core/drafts.cjs');
const {ExportBroker}=require('./export-broker.cjs');
const {request:exportRequest}=require('./core/export-api.cjs');
const {request:importRequest,resolver:importResolver}=require('./core/import-api.cjs');
const {SourceBroker}=require('./source-broker.cjs');
const {OfficialVisualizationProvider}=require('./official-visualization-provider.cjs');
const {VisualizationCoordinator}=require('./s6-coordinator.cjs');
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
let win, service, broker, exportBroker, allowClose=false;
let packageQueue=Promise.resolve(),modeGeneration=0;
const serialPackage=fn=>{const task=packageQueue.then(fn);packageQueue=task.catch(()=>{});return task;};
async function syncAuthority(){if(broker)await service.updatePackageAuthority(broker.authority());}
const selectedInputs = new NativeInputs();
let desktopMode = 'formal';
const s1Methods = new Set(['operationStart','operationStatus','operationCancel','recoveryScan','recoveryAttach','logRead','errorExplain','checkpointReview','closeConfirm','mode','status','reconnect','schema','capabilities','list','detail','draftList','draftSave','draftLoad','inputValidate','pick','visualization','visualizationStatus','visualizationBrowser','closeVisualization']);
const {METHODS:S3_METHODS}=require('./core/s3-api.cjs');
const {METHODS:S4_METHODS}=require('./core/s4-api.cjs');
const {METHODS:S5_METHODS}=require('./core/s5-api.cjs');
for(const method of [...S3_METHODS,...S4_METHODS,...S5_METHODS])s1Methods.add(method);
for(const method of ['packageSourcePick','packageSourceRevoke','packageExport','packageExportStatus','packageImport','packageImportStatus'])s1Methods.add(method);
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
    throw Error('S2 isolated build requires explicit review userData and fixture project root');
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
function handle(name, fn,frameBound=false) {
  ipcMain.handle('desktop:' + name, async (event, ...args) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame ||
        event.senderFrame.url !== home) throw Error('Untrusted desktop request');
    try {
      if(name==='visualization'&&(args.length!==1||Buffer.byteLength(JSON.stringify(args))>4096))throw Error('INVALID_REQUEST');
      if(['visualizationStatus','visualizationBrowser','closeVisualization'].includes(name)&&args.length)throw Error('INVALID_REQUEST');
      if(name.startsWith('package')&&(args.length!==1||Buffer.byteLength(JSON.stringify(args))>16384))throw Error('schema_invalid');
      if (!s1Methods.has(name)) throw Error('Not ready: this action belongs to a later stage (S2–S7).');
      if (desktopMode === 'review' && name !== 'mode') throw Error('Design review is isolated; real operations are disabled.');
      return {ok: true, value: await fn(...args,...(frameBound?[event]:[]))};
    }
    catch (e) { if(name.startsWith('package')){const candidate=e.code??e.message,code=/^[a-z][a-z0-9_]{0,79}$/.test(candidate)?candidate:'source_unavailable';return {ok:false,error:code,code};}return {ok: false, error: e.message,code:e.code??null}; }
  });
}
function frameGuard(event){const generation=modeGeneration,frame=event.senderFrame,sender=event.sender;return ()=>{try{return !!win&&sender===win.webContents&&frame===win.webContents.mainFrame&&frame.url===home&&desktopMode==='formal'&&generation===modeGeneration;}catch{return false;}};}
function importRead(action,p,event){const valid=frameGuard(event);return serialPackage(async()=>{if(!valid())throw Error('reference_drift');await syncAuthority();if(!valid())throw Error('reference_drift');const result=await service.importCommand(action,p,importResolver(valid));if(!valid())throw Error('reference_drift');return result;});}
function installBridge() {
 handle('packageImportStatus',(p,event)=>importRead('inspect',importRequest(p,true),event),true);
 handle('packageImport',(input,event)=>{const p=importRequest(input),valid=frameGuard(event);return serialPackage(async()=>{if(!valid())throw Error('reference_drift');await syncAuthority();if(!valid())throw Error('reference_drift');await service.importCommand('prepare',p);if(!valid())throw Error('reference_drift');const choice=await dialog.showMessageBox(win,{type:'question',title:'Create imported result draft?',message:'Create a new local draft: '+p.label,detail:'Declared cohort: '+(p.cohort??'unknown')+'. TCGA/Lung schema defaults are not source facts. No scientific computation or session will start.',buttons:['Cancel','Create new draft'],defaultId:0,cancelId:0});if(!valid())throw Error('reference_drift');if(choice.response!==1){const history=await service.importCommand('inspect',{requestId:p.requestId},importResolver(valid));return {...history,status:'cancelled',canceled:true,noNewWrites:true,bindingReady:false,importView:null};}const result=await service.importCommand('execute',p,importResolver(valid,p));return valid()?result:{...result,status:result.actualDraftCreated===true?'partial':result.actualDraftCreated===null?'incomplete':'blocked',bindingReady:false,importView:null,error:'reference_drift',authorizationRevoked:true};});},true);

  handle('packageExportStatus',p=>{const generation=modeGeneration;return serialPackage(async()=>{if(desktopMode!=='formal'||generation!==modeGeneration)throw Error('reference_drift');const r=await service.exportStatus(exportRequest(p,true));if(desktopMode!=='formal'||generation!==modeGeneration)throw Error('reference_drift');return r;});});
  handle('packageExport',(input,event)=>{const p=exportRequest(input),generation=modeGeneration,frame=event.senderFrame,sender=event.sender;const valid=()=>{try{return !!win&&sender===win.webContents&&frame===win.webContents.mainFrame&&frame.url===home&&desktopMode==='formal'&&generation===modeGeneration;}catch{return false;}};
   return serialPackage(async()=>{if(!valid())throw Error('reference_drift');await syncAuthority();if(!valid())throw Error('reference_drift');const descriptor=await service.prepareExport(p);if(!valid())throw Error('reference_drift');const choice=await dialog.showOpenDialog(win,{title:'Export verified SIGNET files',message:'Select an existing private folder with access limited to your account. Existing filenames and shared writable ancestry are refused. This copies original bytes; it does not verify science.',properties:['openDirectory']});if(!valid())throw Error('reference_drift');if(choice.canceled){const history=await service.exportStatus({requestId:p.requestId});return {...history,status:'cancelled',canceled:true,noNewWrites:true};}if(choice.filePaths.length!==1)throw Error('schema_invalid');const grant=exportBroker.authorize(p,descriptor,choice.filePaths[0],valid);try{const result=await service.executeExport(p,grant.grantId,(token,payload)=>exportBroker.resolve(token,payload));if(result.status==='cancelled')return {...result,status:'blocked',error:'permission_denied'};return valid()?result:{...result,status:result.receipts.length?'partial':'blocked',error:'reference_drift',authorizationRevoked:true};}finally{exportBroker.release(grant.grantId);}});
  },true);

  for(const method of [...S3_METHODS,...S4_METHODS])handle(method,p=>service.call(method,p));
  for(const method of S5_METHODS)handle(method,p=>{const generation=modeGeneration;return serialPackage(async()=>{if(desktopMode!=='formal'||generation!==modeGeneration)throw Error('reference_drift');await syncAuthority();if(desktopMode!=='formal'||generation!==modeGeneration)throw Error('reference_drift');const result=await service.call(method,p);return method==='packageList'&&broker?{...result,sourceAccess:broker.catalog()}:result;});});
  handle('packageSourcePick',p=>{if(!p||Object.getPrototypeOf(p)!==Object.prototype||Object.keys(p).length)throw Error('schema_invalid');const generation=modeGeneration;return serialPackage(async()=>{
    if(desktopMode!=='formal'||generation!==modeGeneration)throw Error('reference_drift');
    const choice=await dialog.showOpenDialog(win,{title:'Import local SIGNET network or result package',message:'Select a result package, or a folder containing signet_Afreq, signet_CoeffMat0 and signet_net.genepos. Only those three files or declared package files are read. Matrices are copied into a local package; this does not verify scientific execution.',properties:['openDirectory']});
    if(choice.canceled)return {canceled:true};
    if(desktopMode!=='formal'||generation!==modeGeneration||!win||win.webContents.mainFrame.url!==home)throw Error('reference_drift');
    if(choice.filePaths.length!==1)throw Error('schema_invalid');const source=await broker.add(choice.filePaths[0],()=>{if(desktopMode!=='formal'||generation!==modeGeneration||!win||win.webContents.mainFrame.url!==home)throw Error('reference_drift');});await syncAuthority();return {canceled:false,...source};
  });});
  handle('packageSourceRevoke',p=>{service.visualization.invalidate?.('SOURCE_REVOKED')?.catch(()=>{});const generation=modeGeneration;return serialPackage(async()=>{if(desktopMode!=='formal'||generation!==modeGeneration)throw Error('reference_drift');const result=broker.revoke(p);await syncAuthority();return result;});});
  for(const method of ['operationStart','operationStatus','operationCancel','recoveryScan','recoveryAttach','logRead','errorExplain','checkpointReview'])handle(method,p=>service.call(method,p));
  handle('closeConfirm',async p=>{
    if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['decision','target'].includes(k)))throw Error('Invalid close request');
    const result=p.decision==='keep-running'?{shouldClose:false,cancelled:false}:p.decision==='close-anyway'?{shouldClose:true,cancelled:false,independentAnalysisStopped:false}:await service.call('closeConfirm',p);if(result.shouldClose){allowClose=true;win?.close();}return result;});
  handle('mode', mode => {if (!['formal','review'].includes(mode)) throw Error('Invalid desktop mode');desktopMode=mode;modeGeneration++;exportBroker?.revoke();service.visualization.invalidate?.('MODE_CHANGED');return mode;});
  handle('capabilities', () => service.call('capabilities'));
  handle('draftList', (_event) => importRead('list',null,_event),true);
  handle('draftSave', p => {if (!p || typeof p !== 'object' || Array.isArray(p)) throw Error('Invalid draft');return service.call('draftSave', p, selectedInputs.resolve(p));});
  handle('draftLoad', (id,event) => importRead('load',id,event),true);
  handle('inputValidate', (id, revision) => service.call('inputValidate', id, revision));
  handle('closeVisualization', () => service.visualization.stop());
  handle('visualizationStatus',()=>service.visualization.status());
  handle('visualizationBrowser',async()=>{await service.visualization.status();const url=service.visualization.url;if(!url||!service.visualization.canNavigate(url))throw Error('VISUALIZATION_NOT_READY');await shell.openExternal(url);return {opened:true};});
  handle('visualization',(p,event)=>{const valid=frameGuard(event);return serialPackage(async()=>{if(!valid())throw Error('AUTHORIZATION_REVOKED');await syncAuthority();if(!valid())throw Error('AUTHORIZATION_REVOKED');if(typeof p==='string')return {state:'blocked',url:null,error:'IMPORTED_DRAFT_REQUIRED',evidence:'unknown'};return service.visualization.open(p,{valid});});},true);
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
function installSessionPolicy(){
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest({urls: ['http://*/*','https://*/*','ws://*/*','wss://*/*','file://*/*']},
      (details,callback)=>{service.visualization.authorizeURL(details.url).then(allowed=>callback({cancel:!allowed}),()=>callback({cancel:true}));});
}
function makeWindow() {
  win = new BrowserWindow({width: 1440, height: 960, useContentSize: true, show: process.env.SIGNET_REVIEW_HIDDEN !== '1', minWidth: 850, minHeight: 650,
    title: 'SIGNET', backgroundColor: '#f5f5f5', webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, backgroundThrottling: false,
    }});
  // Popups always denied; external opening has a separate owned-URL-only command.
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  win.webContents.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame){modeGeneration++;exportBroker?.revoke();service.visualization.invalidate?.('NAVIGATION_CHANGED');}});
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('will-frame-navigate', e => {
    const url = e.url;
    if (service.visualization.canNavigate?.(url)) return;
    if (url !== home)
      e.preventDefault();
  });
  win.webContents.on('will-redirect',(e,url)=>{const target=e.url??url;if(target!==home&&!service.visualization.canNavigate?.(target))e.preventDefault();});
  win.webContents.on('will-attach-webview', e => e.preventDefault());
  win.on('close',e=>{
    if(allowClose)return;
    e.preventDefault();
    service.call('closeConfirm',{decision:'review'}).catch(()=>({confirmationRequired:true,controller:'unknown'})).then(async review=>{
      const choice=await dialog.showMessageBox(win,{type:'question',title:'Close isolated SIGNET?',message:'Close this local monitor only. Independent analyses and other windows remain untouched.',buttons:['Keep running','Close anyway'],defaultId:0,cancelId:0});
      if(choice.response===1){allowClose=true;win.close();}
    }).catch(()=>{});
  });
  win.on('closed', () => {service.visualization.invalidate?.('WINDOW_CLOSED');win = null; app.quit();});
  win.loadURL(home);
}
if (!single) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    if(process.env.SIGNET_REVIEW_HIDDEN==='1')app.dock?.hide();
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
    broker=await new SourceBroker(root).open();exportBroker=new ExportBroker(root);
    service = new Service(root,{packageAuthority:broker.authority()});
    await service.connect();
    const officialVisualization=new OfficialVisualizationProvider({root,broker,projectRoot:process.env.SIGNET_OFFICIAL_PROJECT_ROOT||root});
    service.visualization=new VisualizationCoordinator({root,readImport:(id,valid)=>service.importCommand('context',id,importResolver(valid)),providers:officialVisualization.ports()});
    installSessionPolicy();
    installBridge();
    await protocols();
    makeWindow();
  }).catch(async e => {
    await dialog.showMessageBox({type: 'error', title: 'SIGNET startup failed', message: e.message});
    app.quit();
  });
  let quitting=false,quitPending=false;
  app.on('before-quit',event=>{if(quitting)return;event.preventDefault();if(win&&!allowClose){win.close();return;}if(quitPending)return;quitPending=true;exportBroker?.revoke();service?.visualization.invalidate?.('APPLICATION_QUIT');(async()=>{let timer;try{await Promise.race([service?.visualization.shutdown?.(),new Promise(resolve=>{timer=setTimeout(resolve,5000);})]);}finally{clearTimeout(timer);broker?.close();await service?.stopOwned();quitting=true;app.quit();}})().catch(()=>{quitting=true;app.quit();});});
  app.on('window-all-closed', () => app.quit());
}
