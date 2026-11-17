'use strict';
// Full local OpenSSH connection; remote software installation is deliberately simulated.
const {once} = require('node:events');
const assert=require('node:assert/strict');
const {mkdtempSync,writeFileSync,rmSync}=require('node:fs');
const path=require('node:path'),os=require('node:os');
const {createHash}=require('node:crypto');
const {app,Menu}=require('electron');
const {Server,utils}=require('ssh2');
const {launch}=require('../main/app/main.cjs');
const {HostKeyTrustStore}=require('../build/ssh/index.cjs');
const inventory=require('../../signet_inventory.json');
const directory=mkdtempSync(path.join(os.tmpdir(),'signet-environment-local-'));
let running,server,source=false,image=false,failVerification=true,connections=0;
let readinessMode='normal',readinessDelay=80;
const commands=[],readinessCommands=[];
const setupCommands=()=>commands.filter(script=>!script.includes('say workspace_path "$W"'));
const checkIds=['connection','workspace','slurm','apptainer','signet_source','container','reference_ref',
 'reference_gmap','reference_gtf','reference_clinical','imputation_reference'];
const deadline=setTimeout(()=>{console.error('Local environment smoke timeout');app.exit(1)},60000);
app.on('will-quit',()=>{clearTimeout(deadline);server?.close();rmSync(directory,{recursive:true,force:true})});
async function until(check,description='Local environment condition timed out'){for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,25))}throw Error(description)}
(async()=>{
 const host=utils.generateKeyPairSync('ed25519',{}),key=utils.generateKeyPairSync('ed25519',{passphrase:'local-test-passphrase',cipher:'aes256-ctr',rounds:4});
 const keyPath=path.join(directory,'key');writeFileSync(keyPath,key.private,{mode:0o600});
 server=new Server({hostKeys:[host.private]},client=>{
  connections++;client.on('error',()=>{});client.on('authentication',ctx=>ctx.method==='publickey'?ctx.accept():ctx.reject(['publickey']));
  client.on('ready',()=>client.on('session',accept=>{
   const session=accept();session.on('pty',acceptPty=>acceptPty?.());
   session.on('shell',acceptShell=>{const stream=acceptShell();stream.write('[testuser@login-mock:~] $ ')});
   session.on('exec',(acceptExec,_reject,info)=>{
    const stream=acceptExec();stream.on('error',()=>{});
    if(info.command!=='bash -s'){stream.write('host=login-mock\nuser=testuser\nslurm=yes\n');stream.exit(0);stream.end();return}
    let script='';stream.on('data',chunk=>{script+=chunk.toString()});stream.on('end',()=>{
     commands.push(script);let out='',err='',code=0,delay=80;
     if(script.includes("printf 'home="))out=`home=/home/testuser\nroot=/home/testuser/mock-signet\n${['bash','git','tar','sha256sum','timeout','python3','setsid','sbatch','scontrol','sinfo','squeue'].map(t=>t+'=yes').join('\n')}\nexecutor=/usr/bin/apptainer\npartition=mock\nwritable=yes\nsource=${source?'exists':'missing'}\nexample=${source?'exists':'missing'}\nimage=${image?'exists':'missing'}\n`;
     else if(script.includes('say workspace_path "$W"')){
      readinessCommands.push(script);delay=readinessDelay;
      const values={user:'testuser',host:'login-mock',workspace_path:'/home/testuser/mock-signet',
       workspace:'yes',workspace_writable:'yes',sbatch:'yes',apptainer:'apptainer version 1.3.2',
       signet:source?'yes':'no',signet_integrity:'verified',signet_revision:inventory.revision,
       signet_example:'verified',file_container:image?'4096':'no',file_ref:'8192',file_gmap:'2048',
       file_gtf:'16384',file_clinical:'1024',file_prepare:'512'};
      if(['infra-failed','workspace'].includes(readinessMode))values.workspace_writable='no';
      if(['infra-failed','slurm'].includes(readinessMode))values.sbatch='no';
      if(['infra-failed','apptainer'].includes(readinessMode))values.apptainer='no';
      if(readinessMode==='missing-file')values.file_gtf='no';
      out=Object.entries(values).map(([key,value])=>`@@${key}\t${value}\n`).join('');
     }
     else if(script.includes('git -C'))source=true;
     else if(script.includes('Rscript -e')&&failVerification){err='MOCK: SIGNET settings verification failed: config.ini unreadable\n';code=1}
     setTimeout(()=>{if(stream.destroyed)return;if(out)stream.write(out);if(err)stream.stderr.write(err);stream.exit(code);stream.end()},delay);
    });
   });
  }));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port,userData=path.join(directory,'app');
 const trust=new HostKeyTrustStore(path.join(userData,'ssh')),blob=Buffer.from(host.public.split(' ')[1],'base64');await trust.load();await trust.trust({host:'127.0.0.1',port,algorithm:'ssh-ed25519',fingerprint:'SHA256:'+createHash('sha256').update(blob).digest('base64').replace(/=+$/,''),publicKey:blob.toString('base64')});
 running=await launch({devMode:true,visible:false,userData,stateFile:path.join(directory,'state.json')});const window=running.window,js=s=>window.webContents.executeJavaScript(s);
 const switchView=async id=>{
  const loaded=once(window.webContents,'did-finish-load');
  Menu.getApplicationMenu().getMenuItemById(id).click();
  await loaded;
 };
 const clickSelector=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
 const geometry=()=>js(`(()=>{const root=document.querySelector('.ml-app');return [root.offsetWidth,root.offsetHeight,root.querySelector('.ml-rail').offsetWidth,root.querySelector('.ml-chat').offsetWidth]})()`);
 const readiness=()=>js(`(()=>{const section=document.querySelector('.ml-remote-readiness');return {
  summary:document.querySelector('#ml-check-summary').textContent,
  overall:section.dataset.ready,disabled:document.querySelector('#ml-check-environment').disabled,
  rows:[...document.querySelectorAll('#ml-environment-checks li')].map(row=>({
   id:row.dataset.checkId,status:row.dataset.status,ready:row.querySelector('[data-ready]')?.dataset.ready,
   detail:row.querySelector('.ml-settings-check-detail')?.textContent||'',
   visibleDetail:!!row.querySelector('.ml-settings-check-detail')?.getClientRects().length}))}})()`);
 const settled=async(ready,statuses={})=>{
  await until(async()=>{const state=await readiness();return !state.disabled&&state.summary.includes(ready+'/11')&&
   Object.entries(statuses).every(([id,status])=>state.rows.find(row=>row.id===id)?.status===status)},
  'Full readiness results did not settle: '+ready+'/11 '+JSON.stringify(statuses));
  const result=await readiness();
  assert.deepEqual(result.rows.map(row=>row.id),checkIds,'Every readiness prerequisite has its own row');
  assert.equal(result.rows.filter(row=>row.ready==='true').length,ready);
  assert.equal(result.overall,ready===11?'true':'false','Overall readiness must include all eleven prerequisites');
  assert.equal(result.summary.includes('7/7'),false,'The old seven-file summary must not imply full readiness');
  return result;
 };
 const checkAgain=async(mode,ready,statuses)=>{
  readinessMode=mode;
  const before=readinessCommands.length;
  await clickSelector('#ml-check-environment');
  const result=await settled(ready,statuses);
  assert.equal(readinessCommands.length,before+1,'A manual recheck issues one read-only inspection');
  return result;
 };
 const connectionSwitch=()=>js(`document.querySelector('#ml-remote-switch')?.getAttribute('aria-checked')`);
 const connectionState=async()=> (await js('window.signetDesktop.ssh.getSnapshot()')).value.connection?.status;
 const observeEnvironment=phases=>js(`window.envPhases=${JSON.stringify(phases)};window.signetDesktop.environment.subscribe(s=>window.envPhases.push(s.phase));true;`);
 const originalGeometry=await geometry();
 assert.deepEqual(originalGeometry,[1650,894,53,542]);
 await clickSelector('[data-nav-target="settings"]');
 await observeEnvironment([]);
 const saved=await js(`window.signetDesktop.ssh.saveProfile(${JSON.stringify({name:'Local mock',host:'127.0.0.1',port,username:'testuser',auth:{method:'private-key',privateKeyPath:keyPath}})})`);assert.ok(saved.ok);
 await until(()=>js(`document.querySelector('#ml-remote-switch:not(:disabled)')?.getClientRects().length>0`));
 assert.equal(await connectionSwitch(),'false');
 assert.ok(await js(`document.querySelector('#ml-check-environment').disabled`));
 await clickSelector('#ml-remote-switch');
 await until(()=>js(`!!document.querySelector('.ssh-unlock[open]')`));
 assert.equal(connections,0,'opening the credential prompt does not connect');
 await js(`(()=>{
  const input=document.querySelector('.ssh-unlock input[type=password]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'local-test-passphrase');
  input.dispatchEvent(new Event('input',{bubbles:true}));
 })()`);
 await js(`document.querySelector('.ssh-unlock form').requestSubmit()`);
 await until(async()=>await connectionSwitch()==='true');
 await until(()=>js(`document.querySelector('.ml-remote-readiness')?.dataset.phase==='needs-install'`));
 assert.equal(await connectionState(),'connected');
 await settled(9,{connection:'ok',workspace:'ok',slurm:'ok',apptainer:'ok',signet_source:'missing',container:'missing'});
 assert.ok(readinessCommands.length>=1,'Connecting while Settings is open automatically inspects readiness');
 const startingPhases=await js('window.envPhases');
 await switchView('classic-view');
 await until(()=>js(`document.querySelector('.ssh-environment-status')?.dataset.phase==='needs-install'`));
 await observeEnvironment(startingPhases);
 assert.equal(setupCommands().length,1,'automatic probes and readiness inspection must not install software');
 assert.ok(await js(`document.querySelector('.ssh-status-subtitle').textContent.includes('testuser@127.0.0.1:')`));
 await js(`document.querySelector('.ssh-environment-status').click()`);
 const click=label=>js(`[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
 await until(()=>js(`!!document.querySelector('.ssh-environment-modal[open]')`));
 assert.equal(await js(`[...document.querySelectorAll('dialog[open] button')].some(b=>b.textContent.startsWith('Install'))`),false,'settings must not offer installation');
 const {promisify}=require('node:util'),execFile=promisify(require('node:child_process').execFile),broker=running.backend.options.sshBroker;
 const pythonEnvironment=name=>execFile(running.backend.options.python,['-c',`import json; from agent.runtime import ssh_transport; print(json.dumps(ssh_transport.${name}()))`],{cwd:path.resolve(__dirname,'../..'),env:{...process.env,SIGNET_SSH_BROKER:broker.path,SIGNET_SSH_BROKER_TOKEN:broker.token},timeout:10000});
 assert.equal(JSON.parse((await pythonEnvironment('setup_environment')).stdout).partition,'mock','setup checks work before the container exists');
 await assert.rejects(pythonEnvironment('environment'),/Prepare the SIGNET environment/,'science stays blocked until verified');
 assert.ok((await js('window.signetDesktop.environment.install()')).ok);
 await until(()=>js(`document.querySelector('.ssh-environment-status')?.dataset.phase==='needs-install'&&window.envPhases.includes('installing-source')`));
 assert.equal(commands.some(s=>s.includes(' pull ')||s.includes('library://')),false,'the login node must not download the container');
 assert.equal(setupCommands().length,4,'probe, source install, probe, source integrity');
 image=true;await click('Check environment');
 await until(()=>js(`document.querySelector('.ssh-environment-status')?.dataset.phase==='error'`));
 await until(()=>js(`document.querySelector('.ssh-environment-modal').textContent.includes('runtime-verification failed')`));
 assert.equal((await js('window.signetDesktop.environment.getSnapshot()')).value.phase,'error');
 assert.equal((await js('window.signetDesktop.ssh.getSnapshot()')).value.connection.status,'connected');
 assert.equal(JSON.parse((await pythonEnvironment('setup_environment')).stdout).partition,'mock','the panel keeps working after a failed verification');
 const history=await js('window.signetDesktop.devTerminal.history()');
 assert.ok(history.value.some(e=>e.stage==='environment:runtime-verification'&&e.message.includes('MOCK:')));
 failVerification=false;await click('Check environment');
 await until(()=>js(`document.querySelector('.ssh-environment-status')?.dataset.phase==='ready'`));
 assert.equal(await js(`document.querySelector('.ssh-collapse').getAttribute('aria-expanded')`),'false');
 await new Promise(r=>setTimeout(r,300));
 const compact=await js(`(()=>{const root=document.querySelector('.ssh-status-block'),toggle=root.querySelector('.ssh-toggle'),led=root.querySelector('.ssh-indicator');const box=root.getBoundingClientRect();return {width:box.width,switchWidth:toggle.getBoundingClientRect().width,ledWidth:led.getBoundingClientRect().width,overflow:root.scrollWidth>root.clientWidth}})()`);
 assert.equal(compact.switchWidth,36);assert.equal(compact.ledWidth,20);assert.equal(compact.overflow,false);assert.ok(compact.width<160);
 await js(`document.querySelector('.ssh-environment-modal .ssh-modal-close').click()`);
 await new Promise(r=>setTimeout(r,250));
 writeFileSync(path.join(os.tmpdir(),'signet-status-collapsed.png'),(await window.webContents.capturePage()).toPNG());
 await js(`document.querySelector('.ssh-collapse').click()`);
 assert.equal(await js(`document.querySelector('.ssh-collapse').getAttribute('aria-expanded')`),'true');
 await js(`document.querySelector('.ssh-environment-status').click()`);
 const phases=await js('window.envPhases');for(const phase of ['checking','needs-install','installing-source','error','verifying','ready'])assert.ok(phases.includes(phase),phase);
 assert.ok(commands.some(s=>s.includes(inventory.revision)));assert.equal(connections,1,'initialization reuses one local SSH connection');
 const config=await js('window.signetDesktop.environment.getSnapshot()');assert.equal(config.value.config.partition,'mock');
 const python=await pythonEnvironment('environment');
 assert.equal(JSON.parse(python.stdout).image,config.value.config.image);assert.equal(JSON.parse(python.stdout).partition,'mock');
 writeFileSync(path.join(os.tmpdir(),'signet-environment-local.png'),(await window.webContents.capturePage()).toPNG());
 const beforeSettings=readinessCommands.length;
 await switchView('workspace-view');
 await clickSelector('[data-nav-target="settings"]');
 await until(async()=>await connectionSwitch()==='true');
 const status=()=>js(`document.querySelector('#ml-remote-status').textContent.trim()`);
 const currentStatus=await status();
 await clickSelector('#ml-language');
 await until(async()=>await status()!==currentStatus);
 assert.equal(await connectionSwitch(),'true');
 assert.equal(connections,1,'switching interfaces keeps the original SSH connection');
 await until(()=>js(`document.querySelector('.ml-remote-readiness')?.dataset.phase==='ready'`));
 await settled(11);
 assert.equal(readinessCommands.length,beforeSettings+1,'Opening Settings on an existing connection automatically inspects all prerequisites');
 assert.deepEqual(await geometry(),originalGeometry,'Full readiness leaves workspace width and sidebar dimensions unchanged');
 await checkAgain('normal',11);

 const blocked=await checkAgain('infra-failed',8,{workspace:'problem',slurm:'problem',apptainer:'problem'});
 const detail=(state,id)=>state.rows.find(row=>row.id===id);
 for(const id of ['workspace','slurm','apptainer'])assert.equal(detail(blocked,id).visibleDetail,true,id+' failure details must be visible');
 assert.match(detail(blocked,'workspace').detail,/\/home\/testuser\/mock-signet.*not writable/);
 assert.match(detail(blocked,'slurm').detail,/sbatch.*unavailable/);
 assert.match(detail(blocked,'apptainer').detail,/Singularity or Apptainer.*not found/);
 for(const [mode,id,expected] of [['workspace','workspace',/not writable/],['slurm','slurm',/sbatch.*unavailable/],
  ['apptainer','apptainer',/not found/],['missing-file','reference_gtf',/refdata\/gencode\.v22\.genes\.gtf.*missing/]]){
  const result=await checkAgain(mode,10,{[id]:mode==='missing-file'?'missing':'problem'});
  assert.equal(detail(result,id).visibleDetail,true,'The affected readiness explanation is visible without hovering');
  assert.match(detail(result,id).detail,expected);
 }

 // An incomplete response must remain incomplete even if its overall flag says
 // ready. Only this isolated renderer's next real /hpc/check response is varied.
 await js(`window.readinessOriginalFetch=window.fetch;window.omitReadinessItem='apptainer';window.fetch=async(...args)=>{
  const reply=await window.readinessOriginalFetch(...args);
  if(String(args[0]).includes('/hpc/check')&&window.omitReadinessItem){
   const result=await reply.json(),id=window.omitReadinessItem;window.omitReadinessItem=null;
   return new Response(JSON.stringify({...result,ready:true,checks:result.checks.filter(check=>check.item!==id)}),
    {status:reply.status,headers:reply.headers});
  }return reply};true`);
 await checkAgain('normal',10,{apptainer:'unknown'});
 await js(`window.fetch=window.readinessOriginalFetch;delete window.readinessOriginalFetch;true`);
 await checkAgain('normal',11);
 assert.deepEqual(await geometry(),originalGeometry,'Error and missing rows do not change the original layout widths');

 const beforeReopen=readinessCommands.length;
 await clickSelector('[data-nav-target="data"]');
 await clickSelector('[data-nav-target="settings"]');
 await settled(11);
 assert.equal(readinessCommands.length,beforeReopen+1,'Re-entering Settings refreshes the existing connection’s readiness');
 readinessDelay=500;
 const beforeDisconnect=readinessCommands.length;
 await clickSelector('#ml-check-environment');
 await until(()=>readinessCommands.length===beforeDisconnect+1,'The delayed read-only inspection did not start');
 await clickSelector('#ml-remote-switch');
 await until(async()=>await connectionSwitch()==='false'&&await connectionState()==='disconnected');
 await until(()=>js(`document.querySelector('#ml-check-environment').disabled&&document.querySelectorAll('#ml-environment-checks [data-ready="true"]').length===0`));
 const disconnected=await readiness();
 assert.equal(disconnected.overall,'false');
 assert.equal(disconnected.rows.length,11);
 assert.ok(disconnected.rows.every(row=>row.status==='unknown'&&!row.detail),'Disconnect clears all old readiness states and details');
 await new Promise(resolve=>setTimeout(resolve,650));
 const afterLateReply=await readiness();
 assert.ok(afterLateReply.rows.every(row=>row.status==='unknown'&&row.ready!=='true'&&!row.detail),
  'A late inspection reply must not restore readiness after disconnect');
 assert.equal(afterLateReply.overall,'false');
 assert.deepEqual(await geometry(),originalGeometry);
 await running.quit();console.log('PASS: workspace SSH login, full eleven-item readiness with automatic and manual inspection, visible prerequisite failures, incomplete-response handling, stale-reply disconnect clearing, unchanged layout, shared connection, and localhost setup verification');
})().catch(async error=>{console.error(error);await running?.backend.forceStop();app.exit(1)});
