'use strict';
// Full local OpenSSH connection; remote software installation is deliberately simulated.
const assert=require('node:assert/strict');
const {mkdtempSync,writeFileSync,rmSync}=require('node:fs');
const path=require('node:path'),os=require('node:os');
const {createHash}=require('node:crypto');
const {app}=require('electron');
const {Server,utils}=require('ssh2');
const {launch}=require('../main/app/main.cjs');
const {HostKeyTrustStore}=require('../build/ssh/index.cjs');
const inventory=require('../../signet_inventory.json');
const directory=mkdtempSync(path.join(os.tmpdir(),'signet-environment-local-'));
let running,server,source=false,image=false,failImage=true,connections=0;
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
     if(script.includes("printf 'home="))out=`home=/home/testuser\nroot=/home/testuser/mock-signet\n${['bash','git','tar','sha256sum','timeout','python3','setsid','sbatch','scontrol','sinfo','squeue'].map(t=>t+'=yes').join('\n')}\nexecutor=/usr/bin/apptainer\npartition=mock\nwritable=yes\nsource=${source?'exists':'missing'}\nimage=${image?'exists':'missing'}\n`;
     else if(script.includes('git -C'))source=true;
     else if(script.includes(' pull ')){if(failImage){err='MOCK: container download failed for retry test\n';code=1}else image=true}
     setTimeout(()=>{if(out)stream.write(out);if(err)stream.stderr.write(err);stream.exit(code);stream.end()},80);
    });
   });
  }));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port,userData=path.join(directory,'app');
 const trust=new HostKeyTrustStore(path.join(userData,'ssh')),blob=Buffer.from(host.public.split(' ')[1],'base64');await trust.load();await trust.trust({host:'127.0.0.1',port,algorithm:'ssh-ed25519',fingerprint:'SHA256:'+createHash('sha256').update(blob).digest('base64').replace(/=+$/,''),publicKey:blob.toString('base64')});
 running=await launch({devMode:true,visible:false,userData,stateFile:path.join(directory,'state.json')});const window=running.window,js=s=>window.webContents.executeJavaScript(s);
 await until(()=>js('!!document.querySelector(".ssh-identity")'));
 await js(`window.envPhases=[];window.signetDesktop.environment.subscribe(s=>window.envPhases.push(s.phase));true;`);
 const saved=await js(`window.signetDesktop.ssh.saveProfile(${JSON.stringify({name:'Local mock',host:'127.0.0.1',port,username:'testuser',auth:{method:'private-key',privateKeyPath:keyPath}})})`);assert.ok(saved.ok);
 assert.ok((await js(`window.signetDesktop.ssh.connect(${JSON.stringify(saved.value.id)},'local-test-passphrase')`)).ok);
 await until(()=>js(`document.querySelector('.ssh-environment-status')?.dataset.phase==='needs-install'`));
 assert.equal(commands.length,1,'automatic probe must not install software');
 assert.ok(await js(`document.querySelector('.ssh-status-subtitle').textContent.includes('testuser@127.0.0.1:')`));
 await js(`document.querySelector('.ssh-environment-status').click()`);
 const click=label=>js(`[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
 await until(()=>js(`!!document.querySelector('.ssh-environment-modal[open]')`));
 await click('Install missing components…');assert.equal(commands.length,1);
 await click('Install environment');
 await until(()=>js(`document.querySelector('.ssh-environment-status')?.dataset.phase==='error'`));
 assert.equal((await js('window.signetDesktop.ssh.getSnapshot()')).value.connection.status,'connected');
 await until(()=>js(`document.querySelector('.ssh-environment-modal').textContent.includes('install-image failed')`));
 const history=await js('window.signetDesktop.devTerminal.history()');
 assert.ok(history.value.some(e=>e.stage==='environment:install-image'&&e.message.includes('MOCK:')));
 failImage=false;await click('Check environment');
 await until(()=>js(`document.querySelector('.ssh-environment-status')?.dataset.phase==='needs-install'`));
 await click('Install missing components…');await click('Install environment');
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
 const phases=await js('window.envPhases');for(const phase of ['checking','needs-install','installing-source','installing-image','error','verifying','ready'])assert.ok(phases.includes(phase),phase);
 assert.ok(commands.some(s=>s.includes(inventory.revision)));assert.equal(connections,1,'initialization reuses one local SSH connection');
 const config=await js('window.signetDesktop.environment.getSnapshot()');assert.equal(config.value.config.partition,'mock');
 const {promisify}=require('node:util'),execFile=promisify(require('node:child_process').execFile),broker=running.backend.options.sshBroker;
 const python=await execFile(running.backend.options.python,['-c','import json, ssh_transport; print(json.dumps(ssh_transport.environment()))'],{cwd:path.resolve(__dirname,'../..'),env:{...process.env,SIGNET_SSH_BROKER:broker.path,SIGNET_SSH_BROKER_TOKEN:broker.token},timeout:10000});
 assert.equal(JSON.parse(python.stdout).image,config.value.config.image);assert.equal(JSON.parse(python.stdout).partition,'mock');
 writeFileSync(path.join(os.tmpdir(),'signet-environment-local.png'),(await window.webContents.capturePage()).toPNG());
 await running.quit();console.log('PASS: localhost SSH mock; automatic check, install confirmation, status progress, dev logs, failure/retry and ready');
})().catch(async error=>{console.error(error);await running?.backend.forceStop();app.exit(1)});
