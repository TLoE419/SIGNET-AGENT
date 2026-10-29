'use strict';
const assert=require('node:assert/strict');
const {mkdtempSync,writeFileSync,rmSync}=require('node:fs');
const path=require('node:path'),os=require('node:os'),net=require('node:net');
const {app}=require('electron');
const {Server,utils}=require('ssh2');
const {createHash}=require('node:crypto');
const {launch}=require('../main.cjs');
const {HostKeyTrustStore}=require('../build/ssh/index.cjs');
const directory=mkdtempSync(path.join(os.tmpdir(),'signet-dev-terminal-'));
let running,server,connections=0,input='',shellCloses=0,duoAnswers=[],geometry,resized;
const deadline=setTimeout(()=>{console.error('Dev terminal smoke timeout');app.exit(1)},45000);
app.on('will-quit',()=>{clearTimeout(deadline);server?.close();rmSync(directory,{recursive:true,force:true})});
async function until(check){for(let attempt=0;attempt<150;attempt++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,25))}throw Error('UI condition timed out')}
(async()=>{
 const host=utils.generateKeyPairSync('ed25519',{}),key=utils.generateKeyPairSync('ed25519',{passphrase:'test-only-passphrase',cipher:'aes256-ctr',rounds:4});const keyPath=path.join(directory,'key');writeFileSync(keyPath,key.private,{mode:0o600});
 server=new Server({hostKeys:[host.private]},client=>{connections++;client.on('error',()=>{});client.on('authentication',ctx=>{
  if(ctx.method==='publickey'){ctx.accept();return}
  if(ctx.method==='keyboard-interactive'){ctx.prompt([{prompt:'Password:',echo:false},{prompt:'Passcode or option (1-2):',echo:true}],'Duo two-factor login for testuser','Enter a passcode or select one of the following options:\n\n1. Duo Push to XXX-XXX-1234\n2. Duo Push to XXX-XXX-5678',answers=>{duoAnswers=answers;answers[0]==='account-secret'&&answers[1]==='2'?ctx.accept():ctx.reject()});return}
  ctx.reject(['password','keyboard-interactive','publickey']);
 });client.on('ready',()=>client.on('session',accept=>{const session=accept();session.on('pty',(acceptPty,_reject,info)=>{geometry=info;acceptPty?.()});session.on('window-change',(acceptResize,_reject,info)=>{resized=info;acceptResize?.()});session.on('shell',acceptShell=>{const stream=acceptShell();stream.write('\x1b[32mLocal SSH test shell ready\x1b[0m\r\n[testuser@login-test:~] $ ');stream.on('data',data=>{input+=data.toString();stream.write(data)});stream.on('close',()=>shellCloses++)});session.on('exec',(acceptExec,_reject,info)=>{const stream=acceptExec();if(info.command.includes('command -v sbatch')){stream.write('host=login-test\nuser=testuser\nslurm=yes\n');stream.exit(0);stream.end();return}stream.write('Scientific task running\n');stream.stderr.write('Progress: 100%\n');stream.exit(0);stream.end()})}))});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port,userData=path.join(directory,'app data'),trust=new HostKeyTrustStore(path.join(userData,'ssh')),blob=Buffer.from(host.public.split(' ')[1],'base64');await trust.load();await trust.trust({host:'127.0.0.1',port,algorithm:'ssh-ed25519',fingerprint:'SHA256:'+createHash('sha256').update(blob).digest('base64').replace(/=+$/,''),publicKey:blob.toString('base64')});
 running=await launch({devMode:true,visible:false,userData,stateFile:path.join(directory,'state.json')});const {window,backend}=running;
 const js=source=>window.webContents.executeJavaScript(source);
 await until(()=>js(`!!document.querySelector('.ssh-dev-launch')`));
 const duoProfile=await js(`window.signetDesktop.ssh.saveProfile(${JSON.stringify({name:'Local Duo test',host:'127.0.0.1',port,username:'testuser',auth:{method:'duo'}})})`);assert.equal(duoProfile.ok,true);
 await until(()=>js(`document.querySelector('.ssh-identity')?.textContent.includes('Local Duo test')`));
 await js(`document.querySelector('.ssh-identity').click()`);await until(()=>js(`document.querySelector('.ssh-modal[open] input[aria-label="UCInetID / username"]')?.value==='testuser'`));
 await js(`document.querySelector('.ssh-modal[open] .ssh-primary').click()`);await until(()=>js(`!!document.querySelector('.ssh-account-login[open]')`));assert.equal(connections,0);
 await js(`(()=>{const input=document.querySelector('.ssh-account-login input[aria-label="UCInetID password"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'account-secret');input.dispatchEvent(new Event('input',{bubbles:true}))})()`);await new Promise(resolve=>setTimeout(resolve,50));await js(`document.querySelector('.ssh-account-login form').requestSubmit()`);
 await until(()=>js(`!![...document.querySelectorAll('.ssh-auth-challenge button')].find(button=>button.textContent.includes('XXX-XXX-5678'))`));
 assert.match(await js(`document.querySelector('.ssh-auth-challenge').textContent`),/Duo two-factor login for testuser/);assert.match(await js(`document.querySelector('.ssh-auth-challenge').textContent`),/Passcode or option \(1-2\)/);
 writeFileSync(path.join(os.tmpdir(),'signet-duo-challenge.png'),(await window.webContents.capturePage()).toPNG());
 await js(`[...document.querySelectorAll('.ssh-auth-challenge button')].find(button=>button.textContent.includes('XXX-XXX-5678')).click()`);await until(async()=> (await js(`window.signetDesktop.ssh.getSnapshot()`)).value.connection.status==='connected');assert.deepEqual(duoAnswers,['account-secret','2']);
 const duoHistory=await js(`window.signetDesktop.devTerminal.history()`);assert.ok(duoHistory.value.some(event=>event.message==='Authentication response submitted (contents omitted).'));assert.doesNotMatch(JSON.stringify(duoHistory),/account-secret|XXX-XXX-1234/);
 const duoRaw=await js(`window.signetDesktop.devTerminal.rawHistory()`);assert.ok(duoRaw.ok);assert.match(JSON.stringify(duoRaw.value),/Duo two-factor login for testuser/);assert.match(JSON.stringify(duoRaw.value),/1\. Duo Push to XXX-XXX-1234/);assert.doesNotMatch(JSON.stringify(duoRaw.value),/account-secret/);
 await js(`window.signetDesktop.ssh.disconnect(${JSON.stringify(duoProfile.value.id)})`);
 const saved=await js(`window.signetDesktop.ssh.saveProfile(${JSON.stringify({name:'Local SSH test',host:'127.0.0.1',port,username:'testuser',auth:{method:'private-key',privateKeyPath:keyPath}})})`);assert.equal(saved.ok,true);
 await until(()=>js(`document.querySelector('.ssh-identity')?.textContent.includes('Local SSH test')`));
 await js(`document.querySelector('[role=switch]').click()`);await until(()=>js(`!!document.querySelector('.ssh-unlock[open]')`));
 assert.equal((await js(`window.signetDesktop.ssh.getSnapshot()`)).value.connection.status,'disconnected');
 const unlock=secret=>js(`(()=>{const input=document.querySelector('.ssh-unlock input[type=password]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(secret)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await unlock('wrong-test-secret');await js(`document.querySelector('.ssh-unlock form').requestSubmit()`);await until(async()=> (await js(`window.signetDesktop.ssh.getSnapshot()`)).value.connection.error?.code==='INVALID_PASSPHRASE');
 writeFileSync(path.join(os.tmpdir(),'signet-ssh-login-diagnostics.png'),(await window.webContents.capturePage()).toPNG());
 await unlock('test-only-passphrase');await js(`document.querySelector('.ssh-unlock form').requestSubmit()`);await until(async()=> (await js(`window.signetDesktop.ssh.getSnapshot()`)).value.connection.status==='connected');
 const history=await js(`window.signetDesktop.devTerminal.history()`);assert.ok(history.ok);assert.ok(history.value.some(event=>event.stage==='transport'));assert.ok(history.value.some(event=>event.stage==='session'));assert.ok(history.value.some(event=>event.stage==='health'));assert.doesNotMatch(JSON.stringify(history),/test-only-passphrase|wrong-test-secret|BEGIN.*PRIVATE/);

 await js(`document.querySelector('.ssh-dev-launch').click()`);await until(()=>js(`!!document.querySelector('.ssh-dev-panel')`));
 const button=text=>js(`[...document.querySelectorAll('.ssh-dev-panel button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);
 await button('Raw SSH log');await until(()=>js(`document.querySelector('[aria-label="Raw SSH log"]')?.textContent.includes('Duo two-factor login for testuser')`));const rawLog=await js(`document.querySelector('[aria-label="Raw SSH log"]').textContent`);assert.match(rawLog,/1\. Duo Push to XXX-XXX-1234/);assert.doesNotMatch(rawLog,/account-secret/);writeFileSync(path.join(os.tmpdir(),'signet-raw-ssh-log.png'),(await window.webContents.capturePage()).toPNG());
 await button('Interactive shell');await until(()=>js(`!!document.querySelector('.xterm-helper-textarea')`));await button('Attach terminal');await until(()=>js(`document.querySelector('.xterm-rows')?.textContent.includes('Local SSH test shell ready')`));assert.ok(Number.isInteger(resized.cols)&&resized.cols>1);assert.notEqual(resized.cols,geometry.cols);
 assert.equal(await js(`getComputedStyle(document.querySelector('.xterm-helper-textarea')).opacity`),'0');
 window.show();window.focus();window.webContents.focus();await js(`document.querySelector('.xterm-helper-textarea').focus()`);for(const character of 'hello')window.webContents.sendInputEvent({type:'char',keyCode:character});window.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});await until(()=>input.includes('hello\r'));
 window.webContents.sendInputEvent({type:'keyDown',keyCode:'c',modifiers:['control']});window.webContents.sendInputEvent({type:'keyUp',keyCode:'c',modifiers:['control']});await until(()=>input.includes('\x03'));
 writeFileSync(path.join(os.tmpdir(),'signet-dev-terminal.png'),(await window.webContents.capturePage()).toPNG());
 const broker=backend.options.sshBroker;await new Promise((resolve,reject)=>{const socket=net.createConnection(broker.path,()=>socket.write(JSON.stringify({token:broker.token,action:'exec',command:'local-test-job',inputLength:0,timeoutMs:1000})+'\n'));socket.on('error',reject);socket.on('data',()=>{});socket.on('end',resolve)});
 await button('Execution activity');await until(()=>js(`document.querySelector('[aria-label="SSH execution activity"]').textContent.includes('END exit 0')`));const log=await js(`document.querySelector('[aria-label="SSH execution activity"]').textContent`);assert.match(log,/Scientific task running/);assert.match(log,/Progress: 100%/);assert.equal(connections,2);
 await button('Close panel');assert.equal(shellCloses,1);assert.equal((await js(`window.signetDesktop.ssh.getSnapshot()`)).value.connection.status,'connected');
 await js(`document.querySelector('.ssh-dev-launch').click()`);await button('Interactive shell');await button('Attach terminal');await until(()=>js(`document.querySelector('.xterm-rows')?.textContent.includes('Local SSH test shell ready')`));window.webContents.reload();await until(()=>js(`!!document.querySelector('.ssh-dev-launch')`));assert.equal(shellCloses,1);assert.equal(connections,2);assert.ok((await js(`window.signetDesktop.devTerminal.history()`)).value.some(event=>event.stage==='session'&&event.message==='Persistent PTY login shell opened.'));
 await running.quit();await until(()=>shellCloses===2);
 console.log('PASS: native Duo selection, raw SSH text, dev PTY input/Ctrl-C, broker activity, shared transport and app-owned cleanup');
})().catch(async error=>{
 let snapshot,diagnostics,raw;
 try{
  snapshot=await running?.window.webContents.executeJavaScript(`window.signetDesktop.ssh.getSnapshot()`);
  diagnostics=await running?.window.webContents.executeJavaScript(`window.signetDesktop.devTerminal.history()`);
  raw=await running?.window.webContents.executeJavaScript(`window.signetDesktop.devTerminal.rawHistory()`);
 }catch{}
 const evidence=JSON.stringify({snapshot,diagnostics,raw}).replaceAll('account-secret','[REDACTED]');
 console.error(error,'Test input received:',JSON.stringify(input),'SSH evidence:',evidence);
 await running?.backend.forceStop();app.exit(1);
});
