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
const commands=[];
const deadline=setTimeout(()=>{console.error('Local environment smoke timeout');app.exit(1)},45000);
app.on('will-quit',()=>{clearTimeout(deadline);server?.close();rmSync(directory,{recursive:true,force:true})});
async function until(check){for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,25))}throw Error('Local environment condition timed out')}
(async()=>{
 const host=utils.generateKeyPairSync('ed25519',{}),key=utils.generateKeyPairSync('ed25519',{passphrase:'local-test-passphrase',cipher:'aes256-ctr',rounds:4});
 const keyPath=path.join(directory,'key');writeFileSync(keyPath,key.private,{mode:0o600});
 server=new Server({hostKeys:[host.private]},client=>{
  connections++;client.on('error',()=>{});client.on('authentication',ctx=>ctx.method==='publickey'?ctx.accept():ctx.reject(['publickey']));
  client.on('ready',()=>client.on('session',accept=>{
   const session=accept();session.on('pty',acceptPty=>acceptPty?.());
   session.on('shell',acceptShell=>{const stream=acceptShell();stream.write('[testuser@login-mock:~] $ ')});
   session.on('exec',(acceptExec,_reject,info)=>{
    const stream=acceptExec();
    if(info.command!=='bash -s'){stream.write('host=login-mock\nuser=testuser\nslurm=yes\n');stream.exit(0);stream.end();return}
    let script='';stream.on('data',chunk=>{script+=chunk.toString()});stream.on('end',()=>{
     commands.push(script);let out='',err='',code=0;
     if(script.includes("printf 'home="))out=`home=/home/testuser\nroot=/home/testuser/mock-signet\n${['bash','git','tar','sha256sum','timeout','python3','setsid','sbatch','scontrol','sinfo','squeue'].map(t=>t+'=yes').join('\n')}\nexecutor=/usr/bin/apptainer\npartition=mock\nwritable=yes\nsource=${source?'exists':'missing'}\nexample=${source?'exists':'missing'}\nimage=${image?'exists':'missing'}\n`;
     // The Python service's installer (agent/runtime/hpc.py) starts a background install.
     else if(script.includes('SIGNET_INSTALL')){source=true;out='@@workspace_path\t/home/testuser/mock-signet\n@@signet\tstarted\n'}
     else if(script.includes('say workspace_path "$W"'))out=Object.entries({
      workspace_path:'/home/testuser/mock-signet',signet:'yes',signet_integrity:'verified',signet_revision:inventory.revision,
      signet_example:'verified',file_container:'4096',
     }).map(([key,value])=>`@@${key}\t${value}\n`).join('');
     else if(script.includes('Rscript -e')&&failVerification){err='MOCK: SIGNET settings verification failed: config.ini unreadable\n';code=1}
     setTimeout(()=>{if(out)stream.write(out);if(err)stream.stderr.write(err);stream.exit(code);stream.end()},80);
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
 const connectionSwitch=()=>js(`document.querySelector('#ml-remote-switch')?.getAttribute('aria-checked')`);
 const connectionState=async()=> (await js('window.signetDesktop.ssh.getSnapshot()')).value.connection?.status;
 const observeEnvironment=phases=>js(`window.envPhases=${JSON.stringify(phases)};window.signetDesktop.environment.subscribe(s=>window.envPhases.push(s.phase));true;`);
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
 const startingPhases=await js('window.envPhases');
 await switchView('classic-view');
 await until(()=>js(`document.querySelector('.ssh-environment-status')?.dataset.phase==='needs-install'`));
 await observeEnvironment(startingPhases);
 assert.equal(commands.length,1,'automatic probe must not install software');
 assert.ok(await js(`document.querySelector('.ssh-status-subtitle').textContent.includes('testuser@127.0.0.1:')`));
 await js(`document.querySelector('.ssh-environment-status').click()`);
 const click=label=>js(`[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
 await until(()=>js(`!!document.querySelector('.ssh-environment-modal[open]')`));
 assert.equal(await js(`[...document.querySelectorAll('dialog[open] button')].some(b=>b.textContent.startsWith('Install'))`),false,'settings must not offer installation');
 const {promisify}=require('node:util'),execFile=promisify(require('node:child_process').execFile),broker=running.backend.options.sshBroker;
 const pythonCall=code=>execFile(running.backend.options.python,['-c',`import json; ${code}`],{cwd:path.resolve(__dirname,'../..'),env:{...process.env,SIGNET_SSH_BROKER:broker.path,SIGNET_SSH_BROKER_TOKEN:broker.token},timeout:10000});
 const pythonEnvironment=name=>pythonCall(`from agent.runtime import ssh_transport; print(json.dumps(ssh_transport.${name}()))`);
 assert.equal(JSON.parse((await pythonEnvironment('setup_environment')).stdout).partition,'mock','setup checks work before the container exists');
 await assert.rejects(pythonEnvironment('environment'),/Prepare the SIGNET environment/,'science stays blocked until verified');
 assert.equal(await js(`'install' in window.signetDesktop.environment`),false,'the desktop bridge has no installer');
 const installed=JSON.parse((await pythonCall('from agent.tools.hpc import install_signet_source; print(json.dumps(install_signet_source()))')).stdout);
 assert.equal(installed.outcome,'started','the Python service installs SIGNET over the same SSH connection');
 await click('Check environment');
 await until(()=>js(`document.querySelector('.ssh-environment-status')?.dataset.phase==='needs-install'&&window.envPhases.filter(p=>p==='checking').length>=2`));
 assert.equal(commands.some(s=>s.includes(' pull ')||s.includes('library://')),false,'the login node must not download the container');
 assert.equal(commands.length,4,'probe, Python install, probe, source integrity');
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
 const phases=await js('window.envPhases');for(const phase of ['checking','needs-install','error','verifying','ready'])assert.ok(phases.includes(phase),phase);
 assert.ok(commands.some(s=>s.includes(inventory.revision)));assert.equal(connections,1,'initialization reuses one local SSH connection');
 const config=await js('window.signetDesktop.environment.getSnapshot()');assert.equal(config.value.config.partition,'mock');
 const python=await pythonEnvironment('environment');
 assert.equal(JSON.parse(python.stdout).image,config.value.config.image);assert.equal(JSON.parse(python.stdout).partition,'mock');
 writeFileSync(path.join(os.tmpdir(),'signet-environment-local.png'),(await window.webContents.capturePage()).toPNG());
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
 await clickSelector('#ml-check-environment');
 await until(()=>js(`document.querySelector('#ml-check-summary').textContent.includes('2/7')`));
 assert.equal(await js(`document.querySelectorAll('#ml-environment-checks [data-ready="true"]').length`),2);
 await clickSelector('#ml-remote-switch');
 await until(async()=>await connectionSwitch()==='false'&&await connectionState()==='disconnected');
 await until(()=>js(`document.querySelector('#ml-check-environment').disabled&&document.querySelectorAll('#ml-environment-checks [data-ready="true"]').length===0`));
 await running.quit();console.log('PASS: workspace SSH login and disconnect, shared connection across views, and localhost environment setup and verification');
})().catch(async error=>{console.error(error);await running?.backend.forceStop();app.exit(1)});
