'use strict';

// An isolated renderer acceptance check: no backend, credentials, SSH transport or scheduler.
const assert = require('node:assert/strict');
const {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} = require('node:fs');
const path = require('node:path');
const {app, BrowserWindow, protocol} = require('electron');
const {buildSync} = require('esbuild');
const sourceRoot = process.env.SIGNET_INTEGRATION_SOURCE || path.join(__dirname, '../..');
const renderer = path.join(sourceRoot, 'electron/renderer');
const workspace = path.join(renderer, 'features/workspace');
const temporary = mkdtempSync('/private/tmp/signet-integrated-native-');
const profile = path.join(temporary, 'profile');
mkdirSync(profile);
app.setPath('appData', profile);
app.setPath('userData', profile);
let window;
const timeout = setTimeout(() => {console.error('Integrated renderer native check timed out'); app.exit(1);}, 45000);
app.on('will-quit', () => {clearTimeout(timeout); rmSync(profile, {recursive: true, force: true});});
protocol.registerSchemesAsPrivileged([{scheme: 'signet-qa', privileges: {standard: true, secure: true, supportFetchAPI: true}}]);

async function until(check, message) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error(message);
}
const nativeComponents = () => buildSync({entryPoints: [path.join(renderer, 'app/main.tsx')],
  bundle: true, write: false, platform: 'browser', format: 'iife', loader: {'.css': 'text'}, jsx: 'automatic',
  target: 'chrome140', define: {'process.env.NODE_ENV': '"production"'}, logLevel: 'silent'}).outputFiles[0].text;

(async () => {
  const failures = [];
  const components = nativeComponents();
  await app.whenReady();
  window = new BrowserWindow({show: false, width: 1650, height: 894, useContentSize: true,
    webPreferences: {nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
      partition: 'signet-integrated-native-fixture'}});
  window.webContents.on('console-message', event => console.error('Fixture renderer:', event.message));
  window.webContents.session.webRequest.onBeforeRequest({urls: ['<all_urls>']}, (details, callback) => callback({cancel: !details.url.startsWith('signet-qa://')}));
  const html = readFileSync(path.join(workspace, 'index.html'), 'utf8')
    .replace('__INITIAL_CHAT__', '{}').replace('__MODEL__', 'fixture-selected-model')
    .replace(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]*>/, '')
    .replace(/<link\b[^>]*>/g, '').replace(/<script\b[^>]*\bsrc=[^>]*>[\s\S]*?<\/script>/g, '')
    .replace('</head>', `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'">
      <style>${readFileSync(path.join(workspace, 'workspace.css'), 'utf8')}\n${readFileSync(path.join(renderer, 'styles/ssh.css'), 'utf8')}</style></head>`);
  window.webContents.session.protocol.handle('signet-qa', () => new Response(html, {headers: {'content-type': 'text/html'}}));
  await window.loadURL('signet-qa://app/');
  const js = async source => {
    try {return await window.webContents.executeJavaScript(source);}
    catch (error) {console.error('Fixture script failed:', source.slice(0, 100)); throw error;}
  };
  await js(`
    window.signetQaCalls = [];
    window.signetQaModelBridge = {
      getStatus:async()=>({ok:true,value:{provider:'codex',geminiConfigured:false,encryptionAvailable:true}}),
      saveGeminiKey:async()=>{throw Error('No key save was requested')},clearGeminiKey:async()=>{throw Error('No key removal was requested')}
    };
    const record = (method,...args) => {window.signetQaCalls.push([method,...args]);return Promise.resolve({ok:true})};
    window.signetQaTerminalBridge = {
      diagnostics:()=>()=>{},history:async()=>({ok:true,value:[]}),raw:()=>()=>{},rawHistory:async()=>({ok:true,value:[]}),
      activity:()=>()=>{},subscribe:()=>()=>{},open:(...args)=>record('open',...args),close:(...args)=>record('close',...args),
      input:(...args)=>record('input',...args),resize:(...args)=>record('resize',...args),ack:(...args)=>record('ack',...args)
    };
    const profile={id:'fixture',name:'Isolated remote',host:'fixture.invalid',port:22,username:'fixture',auth:{method:'duo'}};
    let snapshot={selectedProfile:profile,connection:{profileId:'fixture',status:'connected',connectedAt:'2026-11-17T00:00:00Z'}};
    const listeners=new Set();
    window.signetQaDisconnectTerminal=()=>{snapshot={selectedProfile:profile,connection:{profileId:'fixture',status:'disconnected'}};for(const listener of listeners)listener(snapshot)};
    const forbidden=async()=>{throw Error('No connection or credential operation was requested')};
    window.signetDesktop={isDesktop:true,model:window.signetQaModelBridge,devTerminal:window.signetQaTerminalBridge,
      environment:{subscribe:()=>()=>{},getSnapshot:async()=>({ok:true,value:{phase:'disconnected',message:'Controlled fixture'}}),install:forbidden,check:forbidden},
      ssh:{initialize:async()=>({ok:true,value:snapshot}),getSnapshot:async()=>({ok:true,value:snapshot}),listProfiles:async()=>({ok:true,value:[profile]}),
        subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},listKeys:async()=>({ok:true,value:[]}),subscribeAuthChallenge:()=>()=>{},
        healthCheck:async()=>({ok:true,value:{checkedAt:'fixture',remote:{hostname:'fixture.invalid',username:'fixture',slurm:false},steps:[]}}),
        saveProfile:forbidden,selectProfile:forbidden,inspectPrivateKey:forbidden,pickPrivateKey:forbidden,connect:forbidden,disconnect:forbidden,
        trustHost:forbidden,updateKey:forbidden,removeKey:forbidden,generateKey:forbidden,addExternalKey:forbidden,registerGenerated:forbidden,answerAuthChallenge:forbidden,cancelRegistration:forbidden}};
    window.SignetInputValidation = {create:()=>({sync(){}})};
    for(const name of ['Genotype','Expression','Adjustment','Cis','Network','Visualization'])window['mount'+name+'Run']=()=>({setContext(){}});
    const datasets=[{id:'example-chr1',name:['隔離測試資料','Isolated fixture'],inputs:{}}];
    const run={history_id:'workspace--shared',run_id:'shared',revision:'fixture',name:['隔離執行','Isolated run'],dataset_id:'example-chr1',
      source:'live',origin:'workspace',association:{status:'recorded',method:'manifest'},status:'completed',inputs:{},issues:[],operations:[],
      capabilities:{continue_analysis:true,stage_results:['1','6'],stage6_graph:true,assign_dataset:false},
      jobs:{genotype:{state:'completed'},visualize:{state:'completed'}},graph:{genes:3,connections:2}};
    window.fetch=async url=>({ok:true,status:200,json:async()=>{
      if(url==='/stage6/history')return {runs:[run],datasets};
      if(url==='/signet/datasets')return {datasets};
      if(url==='/hpc/check')return {ready:false,checks:[]};
      if(url.startsWith('/stage6/results?'))return {run_id:'shared',source:'live',frequency:.45,top_networks:1,
        graph:{nodes:['MEGF6','A','B'],edges:[{source:'MEGF6',target:'A',frequency:.8,coefficient:-.12},{source:'A',target:'B',frequency:.6,coefficient:.4}],counts:{genes:3,connections:2}}};
      throw Error('Unexpected fixture request '+url);
    }});void 0;
  `);
  await js(readFileSync(path.join(renderer, 'features/chat/markdown.js'), 'utf8'));
  await js(readFileSync(path.join(workspace, 'workspace.js'), 'utf8'));
  await js(components);
  await until(() => js(`!!document.querySelector('[data-run-target]') && !!document.querySelector('dialog.model-key-modal')`), 'Workspace did not initialize');
  const geometry = () => js(`(()=>{const shell=document.querySelector('.ml-app');return [shell.offsetWidth,shell.offsetHeight,shell.querySelector('.ml-rail').offsetWidth,shell.querySelector('.ml-chat').offsetWidth]})()`);
  assert.deepEqual(await geometry(), [1650, 894, 53, 542]);
  assert.equal(await js('typeof window.require'), 'undefined');
  assert.equal(await js(`(()=>{const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);return ids.length===new Set(ids).size})()`), true);
  assert.equal(await js(`document.querySelector('[data-nav-left="settings"]').hidden`), true, 'Toolbar check must begin outside Settings');
  await js(`document.querySelector('.ml-composer-toolbar button.ml-chip').click()`);
  await until(() => js(`!!document.querySelector('dialog.model-key-modal[open]')`), 'Toolbar did not open model dialog');
  await until(() => js(`Number(getComputedStyle(document.querySelector('dialog.model-key-modal')).opacity)>=.99`), 'Model dialog did not finish appearing');
  const dialog = await js(`(()=>{const dialog=document.querySelector('dialog.model-key-modal'),box=dialog.getBoundingClientRect(),style=getComputedStyle(dialog);return {
    modal:dialog.matches(':modal'),visible:dialog.checkVisibility(),width:box.width,height:box.height,
    fontSize:style.fontSize,color:style.color,background:style.backgroundColor,
    model:dialog.textContent.includes('fixture-selected-model'),chip:document.getElementById('ml-model-chip').textContent,
    settingsHidden:document.querySelector('[data-nav-left="settings"]').hidden}})()`);
  assert.equal(dialog.modal, true);
  console.log('Native model dialog:', JSON.stringify(dialog));
  if (!dialog.visible || dialog.width <= 200 || dialog.height <= 100) failures.push(Error('Model toolbar opened an invisible dialog from outside Settings'));
  assert.equal(dialog.model, true);
  assert.equal(dialog.chip, 'fixture-selected-model');
  assert.equal(dialog.fontSize, '14px');
  assert.equal(dialog.color, 'rgb(34, 34, 34)');
  assert.equal(dialog.background, 'rgb(255, 255, 255)');
  const screenshot = path.join(temporary, 'model-dialog.png');
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))');
  writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
  await js(`document.querySelector('dialog.model-key-modal .ssh-modal-close').click()`);
  await until(() => js(`!document.querySelector('dialog.model-key-modal').open`), 'Model dialog did not close');
  await js(`document.getElementById('ml-language').click();document.querySelector('.ml-composer-toolbar button.ml-chip').click()`);
  await until(() => js(`document.querySelector('dialog.model-key-modal')?.open && document.querySelector('dialog.model-key-modal').textContent.includes('Current model: ')`), 'English model settings did not update');
  await until(() => js(`Number(getComputedStyle(document.querySelector('dialog.model-key-modal')).opacity)>=.99`), 'English model dialog did not finish appearing');
  const englishDialogVisible = await js(`document.querySelector('dialog.model-key-modal').checkVisibility()`);
  if (!englishDialogVisible) failures.push(Error('English model settings dialog is invisible'));
  const englishScreenshot = path.join(temporary, 'model-dialog-en.png');
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))');
  writeFileSync(englishScreenshot, (await window.webContents.capturePage()).toPNG());
  await js(`document.querySelector('dialog.model-key-modal .ssh-modal-close').click()`);
  await until(() => js(`!document.querySelector('dialog.model-key-modal').open`), 'English model dialog did not close');

  await js(`document.querySelector('[data-nav-target="history"]').click();document.querySelector('[data-run-target="workspace--shared"]').click();document.querySelector('#ml-run-workspace--shared [data-run-stage="6"]').click()`);
  await until(() => js(`document.getElementById('lens-stage6').dataset.runState==='ready'`), 'Saved graph did not load');
  const before = await js(`(()=>{const node=document.querySelector('#lens-stage6 [data-gene="A"]');node.dispatchEvent(new MouseEvent('click',{bubbles:true}));const box=node.querySelector('.s6-dot').getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2,transform:node.getAttribute('transform')}})()`);
  window.webContents.sendInputEvent({type: 'mouseMove', x: Math.round(before.x), y: Math.round(before.y)});
  window.webContents.sendInputEvent({type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(before.x), y: Math.round(before.y)});
  window.webContents.sendInputEvent({type: 'mouseMove', x: Math.round(before.x + 40), y: Math.round(before.y + 20)});
  window.webContents.sendInputEvent({type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(before.x + 40), y: Math.round(before.y + 20)});
  await until(() => js(`document.querySelector('#lens-stage6 [data-gene="A"]').getAttribute('transform')!==${JSON.stringify(before.transform)}`), 'Native pointer drag did not move the gene');
  assert.deepEqual(await js(`(()=>{const stage=document.getElementById('lens-stage6');return [stage.dataset.selectedGene,stage.querySelector('tbody').rows.length]})()`), ['A', 2]);
  assert.deepEqual(await geometry(), [1650, 894, 53, 542]);

  await js(`document.querySelector('[data-nav-target="settings"]').click()`);
  await until(() => js(`!document.querySelector('[data-nav-left="settings"]').hidden && !!document.querySelector('.ssh-dev-launch')`), 'Settings did not open its advanced terminal entry');
  await js(`document.querySelector('.ssh-dev-launch').click()`);
  await until(() => js(`!!document.querySelector('.ssh-dev-panel')`), 'Advanced terminal did not open');
  await js(`[...document.querySelectorAll('.ssh-dev-panel button')].find(button=>button.textContent==='Interactive shell').click()`);
  await until(() => js(`!!document.querySelector('.xterm-helper-textarea')`), 'Terminal view did not mount');
  assert.deepEqual(await js('window.signetQaCalls'), [], 'Opening the terminal must not send commands or start a shell');
  await js(`document.querySelector('.ssh-dev-switch').click()`);
  await until(() => js(`document.querySelector('.ssh-dev-switch').getAttribute('aria-checked')==='true'`), 'Explicit terminal enable did not complete');
  const enabledCalls = await js('window.signetQaCalls');
  assert.equal(enabledCalls.filter(call => call[0] === 'open').length, 1);
  assert.equal(enabledCalls.some(call => call[0] === 'input'), false);
  const ownedId = enabledCalls.find(call => call[0] === 'open')[1];
  await js(`document.querySelector('[data-nav-target="analysis"]').click()`);
  await until(() => js(`!document.querySelector('.ssh-dev-panel') && window.signetQaCalls.some(call=>call[0]==='close'&&call[1]===${JSON.stringify(ownedId)})`), 'Leaving Settings did not close its terminal session');
  await js(`document.querySelector('[data-nav-target="settings"]').click()`);
  await until(() => js(`!!document.querySelector('.ssh-dev-launch')`), 'Settings did not remount its advanced terminal entry');
  await js(`document.querySelector('.ssh-dev-launch').click()`);
  await until(() => js(`!!document.querySelector('.ssh-dev-panel')`), 'Advanced terminal did not reopen');
  await js(`[...document.querySelectorAll('.ssh-dev-panel button')].find(button=>button.textContent==='Interactive shell').click()`);
  assert.equal(await js(`document.querySelector('.ssh-dev-switch').getAttribute('aria-checked')`), 'false');
  assert.equal((await js('window.signetQaCalls')).filter(call => call[0] === 'open').length, 1, 'Returning to Settings must not reopen a shell');
  await js(`document.querySelector('.ssh-dev-switch').click()`);
  await until(() => js(`document.querySelector('.ssh-dev-switch').getAttribute('aria-checked')==='true'`), 'Second explicit enable did not complete');
  const secondOwnedId = (await js('window.signetQaCalls')).filter(call => call[0] === 'open')[1][1];
  await js('window.signetQaDisconnectTerminal()');
  await until(() => js(`window.signetQaCalls.some(call=>call[0]==='close'&&call[1]===${JSON.stringify(secondOwnedId)})`), 'Disconnect did not close its terminal session');
  assert.equal((await js('window.signetQaCalls')).some(call => call[0] === 'input'), false);
  assert.deepEqual(await geometry(), [1650, 894, 53, 542]);
  console.log(JSON.stringify({status: failures.length ? 'failed' : 'passed', geometry: [1650, 894, 53, 542], model_dialog: dialog,
    screenshot, englishScreenshot, englishDialogVisible, native_pointer: 'dragged with gene/table preserved', terminal: 'manual enable only; disconnected owned shell',
    isolation: 'hidden window; temporary profile; denied network; fake bridges; no backend'}, null, 2));
  if (failures.length) throw new AggregateError(failures, 'Native renderer acceptance failed');
  window.destroy();
  app.quit();
})().catch(async error => {
  try {if (window && !window.isDestroyed()) writeFileSync(path.join(temporary, 'failure.png'), (await window.webContents.capturePage()).toPNG());} catch {}
  console.error(error, 'Isolated evidence:', temporary);
  app.exit(1);
});
