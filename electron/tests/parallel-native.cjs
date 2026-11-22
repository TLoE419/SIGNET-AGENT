'use strict';

// Native UI and controlled race acceptance: no backend, credentials, SSH transport or scheduler.
const assert = require('node:assert/strict');
const {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} = require('node:fs');
const path = require('node:path');
const {app, BrowserWindow, protocol} = require('electron');
const {buildSync} = require('esbuild');
const sourceRoot = process.env.SIGNET_INTEGRATION_SOURCE || path.join(__dirname, '../..');
const renderer = path.join(sourceRoot, 'electron/renderer');
const workspace = path.join(renderer, 'features/workspace');
const temporary = mkdtempSync('/private/tmp/signet-adversarial-native-');
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
    .replace('__INITIAL_CHAT__', JSON.stringify({session: 'first', sessions: [{session: 'first', title: 'Current chat'}, {session: 'second', title: 'Saved failure'}], messages: [], events: []})).replace('__MODEL__', 'fixture-selected-model')
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
    window.signetQaRequests=[];window.signetQaStreams=[];window.signetQaGraphHolds=[];window.signetQaHeldGraphs=[];
    window.signetQaReleaseGraph=key=>{window.signetQaGraphHolds=window.signetQaGraphHolds.filter(value=>value!==key);for(const pending of window.signetQaHeldGraphs.filter(value=>value.key===key))pending.resolve();window.signetQaHeldGraphs=window.signetQaHeldGraphs.filter(value=>value.key!==key)};
    const chatStream=()=>{
      const chunks=[],waiting=[];let ended=false,failure=null;
      const emit=value=>{if(waiting.length)waiting.shift().resolve(value);else chunks.push(value)};
      window.signetQaStreams.push({push:events=>emit({done:false,value:new TextEncoder().encode(events.map(value=>JSON.stringify(value)).join('\\n')+'\\n')}),
        end:()=>{ended=true;while(waiting.length)waiting.shift().resolve({done:true})},
        fail:()=>{failure=new TypeError('Fixture stream interrupted');while(waiting.length)waiting.shift().reject(failure)}});
      return {ok:true,body:{getReader:()=>({read:()=>chunks.length?Promise.resolve(chunks.shift()):failure?Promise.reject(failure):ended?Promise.resolve({done:true}):new Promise((resolve,reject)=>waiting.push({resolve,reject}))})}};
    };
    window.signetQaModelBridge = {
      getStatus:async()=>({ok:true,value:{provider:'codex',geminiConfigured:false,encryptionAvailable:true}}),
      saveGeminiKey:async()=>{throw Error('No key save was requested')},clearGeminiKey:async()=>{throw Error('No key removal was requested')}
    };
    const record = (method,...args) => {window.signetQaCalls.push([method,...args]);return Promise.resolve({ok:true})};
    const terminalListeners=new Set();window.signetQaPendingTerminal=[];window.signetQaHoldTerminal=false;
    window.signetQaResolveTerminal=id=>{const entry=window.signetQaPendingTerminal.find(value=>value.id===id);entry.resolve({ok:true})};
    window.signetQaTerminalEvent=event=>{for(const listener of terminalListeners)listener(event)};
    window.signetQaTerminalBridge = {
      diagnostics:()=>()=>{},history:async()=>({ok:true,value:[]}),raw:()=>()=>{},rawHistory:async()=>({ok:true,value:[]}),
      activity:()=>()=>{},subscribe:listener=>{terminalListeners.add(listener);return()=>terminalListeners.delete(listener)},
      open:(...args)=>{record('open',...args);return window.signetQaHoldTerminal?new Promise(resolve=>window.signetQaPendingTerminal.push({id:args[0],resolve})):Promise.resolve({ok:true})},close:(...args)=>record('close',...args),
      input:(...args)=>record('input',...args),resize:(...args)=>record('resize',...args),ack:(...args)=>record('ack',...args)
    };
    const profile={id:'fixture',name:'Isolated remote',host:'fixture.invalid',port:22,username:'fixture',auth:{method:'duo'}};
    let snapshot={selectedProfile:profile,connection:{profileId:'fixture',status:'connected',connectedAt:'2026-11-17T00:00:00Z'}};
    const listeners=new Set();
    window.signetQaDisconnectTerminal=()=>{snapshot={selectedProfile:profile,connection:{profileId:'fixture',status:'disconnected'}};for(const listener of listeners)listener(snapshot)};
    window.signetQaReconnectTerminal=()=>{snapshot={selectedProfile:profile,connection:{profileId:'fixture',status:'connected',connectedAt:'2026-11-17T00:01:00Z'}};for(const listener of listeners)listener(snapshot)};
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
    const datasets=[{id:'example-chr1',name:['隔離測試資料','Isolated fixture'],inputs:{}},{id:'dataset-b',name:['第二資料組','Second dataset'],inputs:{}}];
    const run={history_id:'workspace--shared',run_id:'shared',revision:'fixture',name:['隔離執行','Isolated run'],dataset_id:'example-chr1',
      source:'live',origin:'workspace',association:{status:'recorded',method:'manifest'},status:'completed',inputs:{},issues:[],operations:[],
      capabilities:{continue_analysis:true,stage_results:['1','6'],stage6_graph:true,assign_dataset:false},
      jobs:{genotype:{state:'completed'},visualize:{state:'completed'}},graph:{genes:3,connections:2}};
    const archive={...run,history_id:'archive--shared',source:'archive',origin:'archive',capabilities:{...run.capabilities,continue_analysis:false}};
    const second={...run,history_id:'workspace--second',run_id:'second',dataset_id:'dataset-b',name:['第二執行','Second run']};
    window.fetch=async (url,options={})=>{
      window.signetQaRequests.push({url,body:options.body?JSON.parse(options.body):null});
      if(url==='/chat')return chatStream();
      return {ok:true,status:200,json:async()=>{
      if(url==='/stage6/history')return {runs:[run,archive,second],datasets};
      if(url==='/signet/datasets')return {datasets};
      if(url==='/hpc/check')return {ready:false,checks:[]};
      if(url.startsWith('/bootstrap?'))return {initial:url.includes('second')?{messages:[{role:'assistant',text:'Preserved failure evidence'}],events:[['SIGNET_TOOL '+JSON.stringify({operation_id:'b'.repeat(32),tool_name:'get_workspace_stage',status:'failed',elapsed_ms:250,result_summary:'<img src=x onerror="window.signetQaUnsafe=true">'}),'SIGNET_TURN '+JSON.stringify({status:'failed'})]]}:{messages:[],events:[]}};
      if(url.startsWith('/stage6/results?')){
        const query=new URL(url,location.href).searchParams,source=query.get('source'),id=query.get('run'),key=(source==='live'?'workspace':source)+'--'+id;
        if(window.signetQaGraphHolds.includes(key))await new Promise(resolve=>window.signetQaHeldGraphs.push({key,resolve}));
        const nodes=id==='second'?['M','C','D']:source==='archive'?['MEGF6','X','Y']:['MEGF6','A','B'];
        return {run_id:id,source,frequency:.45,top_networks:1,
        graph:{nodes,edges:[{source:nodes[0],target:nodes[1],frequency:.8,coefficient:-.12},{source:nodes[1],target:nodes[2],frequency:.6,coefficient:.4}],counts:{genes:3,connections:2}}};
      }
      throw Error('Unexpected fixture request '+url);
    }}};void 0;
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
  const nativeClick = async selector => {
    const point = await js(`(()=>{const node=document.querySelector(${JSON.stringify(selector)}),box=node.getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2}})()`);
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) window.webContents.sendInputEvent({type,
      ...(type === 'mouseMove' ? {} : {button: 'left', clickCount: 1}), x: Math.round(point.x), y: Math.round(point.y)});
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))');
  };
  await js(`window.signetQaNativeClicks=[];document.querySelector('#lens-stage6 .s6-graph').addEventListener('click',event=>window.signetQaNativeClicks.push({trusted:event.isTrusted,target:event.target.tagName,gene:event.target.closest('[data-gene]')?.dataset.gene||null}),true);void 0`);
  await nativeClick('#lens-stage6 [data-gene="MEGF6"] .s6-dot');
  const mouseSelection = await js(`(()=>{const stage=document.getElementById('lens-stage6');return {gene:stage.dataset.selectedGene,rows:stage.querySelector('tbody').rows.length,events:window.signetQaNativeClicks}})()`);
  await js(`document.querySelector('#lens-stage6 [data-gene="MEGF6"]').focus()`);
  window.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Enter'});
  window.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Enter'});
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))');
  const keyboardSelection = await js(`(()=>{const stage=document.getElementById('lens-stage6');return {gene:stage.dataset.selectedGene,rows:stage.querySelector('tbody').rows.length}})()`);
  const edgePoint = await js(`(()=>{const edge=document.querySelector('#lens-stage6 .s6-edge'),point=edge.getPointAtLength(edge.getTotalLength()/2).matrixTransform(edge.getScreenCTM()),hit=document.elementFromPoint(point.x,point.y).closest('.s6-edge');return {x:point.x,y:point.y,source:hit.dataset.source,target:hit.dataset.target}})()`);
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) window.webContents.sendInputEvent({type,
    ...(type === 'mouseMove' ? {} : {button: 'left', clickCount: 1}), x: Math.round(edgePoint.x), y: Math.round(edgePoint.y)});
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))');
  const mouseEdgeSummary = await js(`document.querySelector('#lens-stage6 .s6-summary').textContent`);
  console.log('Native click comparison:', JSON.stringify({mouseSelection,keyboardSelection,mouseEdgeSummary}));
  if (mouseSelection.gene !== 'MEGF6' || mouseSelection.rows !== 1) failures.push(Error('Trusted native mouse click failed to select MEGF6 and filter its one incident edge'));
  assert.deepEqual(keyboardSelection, {gene: 'MEGF6', rows: 1});
  assert.ok(mouseSelection.events.some(event => event.trusted), 'Selection test must use trusted browser mouse input');
  assert.ok(mouseEdgeSummary.startsWith(edgePoint.source+' → '+edgePoint.target));
  assert.match(mouseEdgeSummary, edgePoint.source === 'A' ? /0\.6.*0\.4/ : /0\.8.*-0\.12/);
  await js(`document.querySelector('#lens-stage6 .s6-edge').focus()`);
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))');
  assert.match(await js(`document.querySelector('#lens-stage6 .s6-summary').textContent`), /0\.8.*-0\.12/);
  await nativeClick('#lens-stage6 [data-gene="B"] .s6-dot');
  assert.equal(await js(`document.getElementById('lens-stage6').dataset.selectedGene`), 'B');
  const before = await js(`(()=>{const node=document.querySelector('#lens-stage6 [data-gene="A"]');node.dispatchEvent(new MouseEvent('click',{bubbles:true}));const box=node.querySelector('.s6-dot').getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2,transform:node.getAttribute('transform')}})()`);
  window.webContents.sendInputEvent({type: 'mouseMove', x: Math.round(before.x), y: Math.round(before.y)});
  window.webContents.sendInputEvent({type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(before.x), y: Math.round(before.y)});
  window.webContents.sendInputEvent({type: 'mouseMove', x: Math.round(before.x + 40), y: Math.round(before.y + 20)});
  window.webContents.sendInputEvent({type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(before.x + 40), y: Math.round(before.y + 20)});
  await until(() => js(`document.querySelector('#lens-stage6 [data-gene="A"]').getAttribute('transform')!==${JSON.stringify(before.transform)}`), 'Native pointer drag did not move the gene');
  assert.deepEqual(await js(`(()=>{const stage=document.getElementById('lens-stage6');return [stage.dataset.selectedGene,stage.querySelector('tbody').rows.length]})()`), ['A', 2]);
  const background = await js(`(()=>{const point=new DOMPoint(5,5).matrixTransform(document.querySelector('#lens-stage6 .s6-graph').getScreenCTM());return {x:point.x,y:point.y}})()`);
  for(const [type,dx,dy]of [['mouseMove',0,0],['mouseDown',0,0],['mouseMove',60,30],['mouseUp',60,30]])window.webContents.sendInputEvent({type,
    ...(type==='mouseDown'||type==='mouseUp'?{button:'left',clickCount:1}:{}),x:Math.round(background.x+dx),y:Math.round(background.y+dy)});
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))');
  assert.notEqual(await js(`document.querySelector('#lens-stage6 .s6-genes').getAttribute('transform')`),'translate(0 0)');
  assert.equal(await js(`document.getElementById('lens-stage6').dataset.selectedGene`),'A');
  assert.deepEqual(await geometry(), [1650, 894, 53, 542]);

  const startTurn=async text=>{
    const index=await js('window.signetQaStreams.length');
    await js(`document.getElementById('ml-input').value=${JSON.stringify(text)};document.getElementById('ml-composer').requestSubmit();void 0`);
    await until(()=>js(`window.signetQaStreams.length===${index+1}&&document.getElementById('ml-send').disabled`),'Chat did not start its controlled stream');
    return index;
  };
  const finishTurn=async(index,events)=>{
    await js(`window.signetQaStreams[${index}].push(${JSON.stringify(events)});window.signetQaStreams[${index}].end();void 0`);
    await until(()=>js(`!document.getElementById('ml-send').disabled`),'Chat did not finish its controlled stream');
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))');
  };
  const context=()=>js(`(()=>{const detail={context:null};window.dispatchEvent(new CustomEvent('workspace-context-request',{detail}));return detail.context})()`);
  const oldDatasetTurn=await startTurn('Inspect the original selected gene');
  await nativeClick('[data-nav-target="data"]');
  // Native OS select menus need a visible window; the preceding Data click is trusted.
  await js(`document.getElementById('ml-dataset-select').value='dataset-b';document.getElementById('ml-dataset-select').dispatchEvent(new Event('change',{bubbles:true}));void 0`);
  await until(()=>js(`document.getElementById('ml-dataset-select').value==='dataset-b'`),'Dataset did not switch');
  await nativeClick('[data-nav-target="analysis"]');
  await js(`document.getElementById('ml-stage6-run').value='workspace--second';document.getElementById('ml-stage6-run').dispatchEvent(new Event('change',{bubbles:true}));void 0`);
  await until(()=>js(`document.getElementById('lens-stage6').dataset.historyId==='workspace--second'&&document.getElementById('lens-stage6').dataset.runState==='ready'`),'Second dataset graph did not load');
  await finishTurn(oldDatasetTurn,[{type:'workspace_action',text:{version:1,action:'select_gene',history_id:'archive--shared',stage:6,gene:'X'}},
    {type:'answer',text:'Old dataset answer retained'},{type:'done',text:'Conversation complete',status:'completed'}]);
  assert.equal(await js(`document.getElementById('ml-dataset-select').value`),'dataset-b','Late old-dataset action must not restore the previous dataset');
  assert.equal(await js(`document.getElementById('lens-stage6').dataset.historyId`),'workspace--second');
  assert.deepEqual(await context(),{version:1,dataset_id:'dataset-b',history_id:'workspace--second',stage:6,selected_genes:[]});
  const nextDatasetTurn=await startTurn('Inspect the second dataset');
  const contexts=await js(`window.signetQaRequests.filter(call=>call.url==='/chat').map(call=>call.body.workspace_context)`);
  assert.deepEqual(contexts.slice(-2),[{version:1,dataset_id:'example-chr1',history_id:'workspace--shared',stage:6,selected_genes:['A']},
    {version:1,dataset_id:'dataset-b',history_id:'workspace--second',stage:6,selected_genes:[]}]);
  await finishTurn(nextDatasetTurn,[{type:'done',text:'Conversation complete',status:'completed'}]);
  console.log('PASS: trusted Data navigation plus dataset change invalidates late action; next request uses only new dataset context');

  await nativeClick('[data-nav-target="history"]');
  await js(`document.getElementById('ml-history-scope').value='all';document.getElementById('ml-history-scope').dispatchEvent(new Event('change',{bubbles:true}));void 0`);
  await nativeClick('[data-run-target="workspace--shared"]');
  await nativeClick('#ml-run-workspace--shared [data-run-stage="6"]');
  await until(()=>js(`document.getElementById('lens-stage6').dataset.historyId==='workspace--shared'&&document.getElementById('lens-stage6').dataset.runState==='ready'`),'Live result did not reopen');
  const oldRunTurn=await startTurn('Inspect the current live run');
  await nativeClick('#ml-stage6-back');
  await nativeClick('[data-run-target="archive--shared"]');
  await nativeClick('#ml-run-archive--shared [data-run-stage="6"]');
  await until(()=>js(`document.getElementById('lens-stage6').dataset.historyId==='archive--shared'&&document.getElementById('lens-stage6').dataset.runState==='ready'`),'Archive did not open');
  await nativeClick('#lens-stage6 [data-gene="X"] .s6-dot');
  await finishTurn(oldRunTurn,[{type:'workspace_action',text:{version:1,action:'select_gene',history_id:'workspace--shared',stage:6,gene:'A'}},
    {type:'done',text:'Conversation complete',status:'completed'}]);
  assert.deepEqual(await context(),{version:1,dataset_id:'example-chr1',history_id:'archive--shared',stage:6,selected_genes:['X']});
  console.log('PASS: trusted live-to-archive run switch rejects a late live-gene action');

  await js(`window.signetQaGraphHolds.push('workspace--shared');void 0`);
  const delayedTurn=await startTurn('Open a live gene after looking it up');
  await js(`window.signetQaStreams[${delayedTurn}].push([{type:'workspace_action',text:{version:1,action:'select_gene',history_id:'workspace--shared',stage:6,gene:'B'}},{type:'answer',text:'A delayed lookup result'},{type:'done',text:'Conversation complete',status:'completed'}]);window.signetQaStreams[${delayedTurn}].end();void 0`);
  await until(()=>js(`!document.getElementById('ml-send').disabled&&window.signetQaHeldGraphs.length>0`),'Delayed graph request did not remain pending after turn end');
  await nativeClick('[data-nav-target="analysis"]');
  await nativeClick('#ml-chat-list-toggle');
  await nativeClick('#ml-chat-records button:nth-child(2)');
  await until(()=>js(`document.getElementById('ml-chat-title').textContent==='Saved failure'`),'Saved chat did not switch');
  await js(`window.signetQaReleaseGraph('workspace--shared');void 0`);
  await until(()=>js(`document.getElementById('lens-stage6').dataset.runState==='ready'`),'Delayed graph did not settle');
  assert.notEqual(await js(`document.getElementById('lens-stage6').dataset.selectedGene`),'B','A late old-chat graph cannot select a gene in the new chat');
  assert.match(await js(`document.getElementById('ml-chat-status').textContent`),/failed|失敗/i);
  assert.equal(await js(`!!window.signetQaUnsafe`),false);
  assert.equal(await js(`document.querySelectorAll('#ml-chat-events img').length`),0);
  const savedStates=await js(`[...document.getElementById('ml-chat-events').children[1].querySelectorAll('.ml-chat-event-state')].map(node=>node.textContent)`);
  assert.ok(savedStates.length===2&&savedStates.every(value=>/failed|失敗/i.test(value)));
  assert.match(await js(`document.getElementById('ml-chat-events').children[0].textContent`),/Navigation ignored|未套用導覽/);
  console.log('PASS: switching saved chat during late graph load rejects the old gene action and preserves escaped failed activity');

  const interruptedTurn=await startTurn('Keep this partial answer if the connection fails');
  await js(`window.signetQaStreams[${interruptedTurn}].push([{type:'answer',text:'Partial evidence retained from interrupted stream'},{type:'progress',text:'SIGNET_TOOL '+JSON.stringify({operation_id:'c'.repeat(32),tool_name:'get_workspace_stage',status:'running',elapsed_ms:20,result_summary:'Checking saved state'})}]);void 0`);
  await nativeClick('#ml-chat-list-toggle');
  assert.equal(await js(`document.querySelector('#ml-chat-records button').disabled`),true);
  await nativeClick('#ml-chat-records button:first-child');
  assert.equal(await js(`document.getElementById('ml-chat-title').textContent`),'Saved failure','A disabled chat must not take a pending reply');
  await js(`window.signetQaStreams[${interruptedTurn}].fail();void 0`);
  await until(()=>js(`!document.getElementById('ml-send').disabled`),'Interrupted stream did not finish safely');
  assert.match(await js(`document.getElementById('ml-chat-status').textContent`),/Needs review|需要確認/);
  assert.match(await js(`document.getElementById('ml-chat-transcripts').textContent`),/Partial evidence retained from interrupted stream/);
  await nativeClick('#ml-chat-records button:first-child');
  await until(()=>js(`document.getElementById('ml-chat-title').textContent==='Current chat'`),'First chat did not reopen after the interrupted turn');
  await nativeClick('#ml-chat-list-toggle');await nativeClick('#ml-chat-records button:nth-child(2)');
  await until(()=>js(`document.getElementById('ml-chat-title').textContent==='Saved failure'`),'Interrupted chat did not reopen');
  await nativeClick('#ml-language');
  assert.match(await js(`document.getElementById('ml-chat-status').textContent`),/需要確認/);
  assert.match(await js(`document.getElementById('ml-chat-transcripts').textContent`),/Partial evidence retained from interrupted stream/);
  await nativeClick('#ml-language');
  assert.match(await js(`document.getElementById('ml-chat-status').textContent`),/Needs review/);
  console.log('PASS: pending reply locks chat switching; disconnect retains partial answer and needs-review state across reopen and both languages');

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
  await js(`window.signetQaReconnectTerminal();window.signetQaHoldTerminal=true;void 0`);
  await until(()=>js(`!!document.querySelector('.ssh-dev-switch')`),'Reconnect did not restore the disabled terminal switch');
  await js(`document.querySelector('.ssh-dev-switch').click()`);
  await until(()=>js(`window.signetQaPendingTerminal.length===1&&document.querySelector('.ssh-dev-switch').disabled`),'Controlled terminal open did not remain pending');
  const pendingId=await js(`window.signetQaPendingTerminal[0].id`);
  await js('window.signetQaDisconnectTerminal()');
  await until(()=>js(`!document.querySelector('.ssh-dev-switch')&&window.signetQaCalls.some(call=>call[0]==='close'&&call[1]===${JSON.stringify(pendingId)})`),'Disconnect did not cancel the pending shell');
  await js('window.signetQaReconnectTerminal()');
  await until(()=>js(`!!document.querySelector('.ssh-dev-switch')&&!document.querySelector('.ssh-dev-switch').disabled`),'Reconnect did not return to a disabled shell');
  await js(`window.signetQaResolveTerminal(${JSON.stringify(pendingId)});void 0`);
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))');
  assert.equal(await js(`document.querySelector('.ssh-dev-switch').getAttribute('aria-checked')`),'false','Late open acceptance cannot enable a reconnected terminal');
  await js(`window.signetQaHoldTerminal=false;document.querySelector('.ssh-dev-switch').click();void 0`);
  await until(()=>js(`document.querySelector('.ssh-dev-switch').getAttribute('aria-checked')==='true'`),'Fresh terminal enable did not complete');
  const freshId=(await js(`window.signetQaCalls.filter(call=>call[0]==='open')`)).at(-1)[1];
  assert.notEqual(freshId,pendingId);
  await js(`window.signetQaTerminalEvent({id:${JSON.stringify(pendingId)},type:'closed'});window.signetQaTerminalEvent({id:${JSON.stringify(pendingId)},type:'data',data:btoa('late old shell output')});void 0`);
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))');
  assert.equal(await js(`document.querySelector('.ssh-dev-switch').getAttribute('aria-checked')`),'true','Old session events cannot close the fresh shell');
  assert.equal(await js(`window.signetQaCalls.some(call=>call[0]==='ack'&&call[1]===${JSON.stringify(pendingId)})`),false);
  assert.equal((await js('window.signetQaCalls')).some(call=>call[0]==='input'),false);
  await js('window.signetQaDisconnectTerminal()');
  await until(()=>js(`window.signetQaCalls.some(call=>call[0]==='close'&&call[1]===${JSON.stringify(freshId)})`),'Final disconnect did not close the fresh owned shell');
  assert.equal(await js(`window.signetQaRequests.some(call=>['/submit','/cancel'].some(part=>call.url.includes(part)))`),false);
  console.log('PASS: pending shell open/disconnect/reconnect rejects late acceptance and old-session events; no terminal input or scientific mutations');
  const controllerBundle=buildSync({entryPoints:[path.join(sourceRoot,'electron/main/devtools/DevTerminal.ts')],bundle:true,
    write:false,platform:'node',format:'cjs',external:['electron','ssh2','node-pty'],logLevel:'silent'}).outputFiles[0].text;
  const controllerModule={exports:{}};
  new Function('require','module','exports',controllerBundle)(require,controllerModule,controllerModule.exports);
  const {EventEmitter}=require('node:events');
  const service=new EventEmitter();service.getSnapshot=()=>({connection:{status:'connected'}});
  let acceptShell,destroyed=0;service.openShell=()=>new Promise(resolve=>{acceptShell=resolve});
  const controller=new controllerModule.exports.DevTerminal(service);
  const pendingShell=controller.open('pending-fixture',80,24);
  controller.close('pending-fixture');
  acceptShell({destroy:()=>destroyed++});
  await assert.rejects(pendingShell,/Terminal opening cancelled/);
  assert.equal(destroyed,1,'The actual controller must destroy a shell accepted after its pending request was cancelled');
  controller.dispose();
  console.log('PASS: actual terminal controller generation guard destroys a late accepted pending shell');
  console.log(JSON.stringify({status: failures.length ? 'failed' : 'passed', geometry: [1650, 894, 53, 542], model_dialog: dialog,
    screenshot, englishScreenshot, englishDialogVisible,
    native_pointer: 'trusted mouse gene/edge clicks, keyboard selection, dragging and panning preserve linked table',
    chat_races: ['dataset/run changes reject stale actions and replace outgoing context',
      'saved-chat switch rejects delayed old-chat gene selection', 'saved failed activity escapes markup',
      'pending reply locks chat switching', 'stream interruption retains partial answer and bilingual needs-review state'],
    dataset_selection: 'controlled DOM select change after trusted Data navigation; hidden native OS menus excluded',
    terminal: 'manual enable only; pending-open/disconnect/reconnect and old-session events isolated; actual controller cancels late shell acceptance',
    isolation: 'hidden window; temporary profile; denied network; fake UI/transport; no backend'}, null, 2));
  if (failures.length) throw new AggregateError(failures, 'Native renderer acceptance failed');
  window.destroy();
  app.quit();
})().catch(async error => {
  try {if (window && !window.isDestroyed()) writeFileSync(path.join(temporary, 'failure.png'), (await window.webContents.capturePage()).toPNG());} catch {}
  console.error(error, 'Isolated evidence:', temporary);
  app.exit(1);
});
