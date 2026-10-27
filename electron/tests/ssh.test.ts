import {test} from 'node:test';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
const compiled=createRequire(import.meta.url)('../build/ssh/index.cjs') as typeof import('../src/ssh');
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,chmod,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {utils,Client,Server} from 'ssh2';
import {inspectPrivateKey,inspectBytes} from '../src/ssh/PrivateKeyInspector';
import {unlockPrivateKey} from '../src/ssh/PrivateKeyUnlocker';
import {SshProfileRepository,HostKeyTrustStore,hostIdentity} from '../src/ssh/stores';
import {SshConnectionService} from '../src/ssh/SshConnectionService';
import {installSshHandlers} from '../src/ssh/sshIpcHandlers';
import {AppManagedKeyStore} from '../src/ssh/AppManagedKeyStore';
import type {FormInput} from '../modules/ssh/types';
const phrase='test-only-passphrase';
test('flat integration profiles and pinned public blobs remain readable without rewriting durable files',async t=>{
 const f=await fixture(t),dir=path.join(f.dir,'ssh');await mkdir(dir,{mode:0o700});
 const raw={version:1,selectedProfileId:'existing',profiles:[{id:'existing',name:'Saved HPC3',host:'hpc3.rcic.uci.edu',port:22,username:'testuser',privateKeyPath:f.key}]};
 const file=path.join(dir,'profiles.json'),before=JSON.stringify(raw);await writeFile(file,before,{mode:0o600});
 const pin=hostIdentity('hpc3.rcic.uci.edu',22,publicBlob(plain.public));await writeFile(path.join(dir,'host-trust.json'),JSON.stringify({version:1,hosts:[pin]}),{mode:0o600});
 const repo=new SshProfileRepository(dir),trust=new HostKeyTrustStore(dir);await trust.load();assert.equal(trust.check(pin),'match');
 const profile=(await repo.list())[0];assert.equal(profile.auth.privateKeyPath,f.key);assert.equal(await readFile(file,'utf8'),before);
 await repo.upsert({...profile,name:'Renamed HPC3'});const stored=JSON.parse(await readFile(file,'utf8'));assert.equal(stored.version,1);assert.equal(stored.profiles[0].privateKeyPath,f.key);assert.equal(stored.profiles[0].auth,undefined);
});
test('cancelling registration before a profile exists closes the temporary client and never saves',async t=>{
 const f=await fixture(t),client=new FakeClient(),repo=new SshProfileRepository(path.join(f.dir,'ssh')),trust=new HostKeyTrustStore(path.join(f.dir,'ssh'));
 const key={keyId:'managed',privateKeyPath:f.key,publicKey:plain.public};
 const service=new SshConnectionService(repo,trust,keyOps,()=>client as unknown as Client,{get:async()=>key} as any);await service.initialize();
 const run=service.registerGenerated({profile:{...f.input,auth:{...f.input.auth,keyId:key.keyId,managed:true}},keyId:key.keyId,passphrase:phrase,password:'account-test'});
 const rejected=assert.rejects(run,{code:'SESSION_CLOSED'});await until(()=>client.calls===1);await service.shutdown();await rejected;
 assert.ok(client.destroyed>0);assert.equal((await repo.list()).length,0);assert.equal(service.getSnapshot().selectedProfile,null);
});
const encrypted=utils.generateKeyPairSync('ed25519',{passphrase:phrase,cipher:'aes256-ctr',rounds:4});
const plain=utils.generateKeyPairSync('ed25519',{});
const rsa=utils.generateKeyPairSync('rsa',{bits:2048,passphrase:phrase,cipher:'aes256-ctr',rounds:4});
const ec=utils.generateKeyPairSync('ecdsa',{bits:256,passphrase:phrase,cipher:'aes256-ctr',rounds:4});
const ec384=utils.generateKeyPairSync('ecdsa',{bits:384,passphrase:phrase,cipher:'aes256-ctr',rounds:4});
const ec521=utils.generateKeyPairSync('ecdsa',{bits:521,passphrase:phrase,cipher:'aes256-ctr',rounds:4});
const publicBlob=(pub:string)=>Buffer.from(pub.split(' ')[1],'base64');
async function fixture(t:any){const dir=await mkdtemp(path.join(tmpdir(),'signet-ssh-'));t.after(()=>rm(dir,{recursive:true,force:true}));const key=path.join(dir,'private');await writeFile(key,encrypted.private,{mode:0o600});const input:FormInput={name:'UCI HPC3',host:'hpc3.rcic.uci.edu',port:22,username:'testuser',auth:{method:'private-key',privateKeyPath:key},presetId:'uci-hpc3'};return {dir,key,input}}
const keyOps={inspect:inspectPrivateKey,unlock:unlockPrivateKey};
class FakeClient extends EventEmitter {
 calls=0;ended=0;destroyed=0;config:any;
 connect(config:any){this.config=config;this.calls++;return this}end(){this.ended++;this.emit('close');return this}destroy(){this.destroyed++;return this}
}
async function setup(t:any){const f=await fixture(t),client=new FakeClient(),repo=new SshProfileRepository(path.join(f.dir,'ssh')),trust=new HostKeyTrustStore(path.join(f.dir,'ssh'));let clients=0;const service=new SshConnectionService(repo,trust,keyOps,()=>{clients++;return client as unknown as Client});await service.initialize();return {...f,client,repo,trust,service,clients:()=>clients}}
async function until(fn:()=>boolean){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5))}throw Error('Condition timed out')}
test('offline inspection: supported encrypted key algorithms and real local unlock',async t=>{const {key}=await fixture(t);for(const k of [encrypted,rsa,ec,ec384,ec521]){await writeFile(key,k.private);assert.equal((await inspectPrivateKey(key)).status,'encrypted');assert.ok(!(utils.parseKey(await unlockPrivateKey(key,phrase)) instanceof Error))}assert.equal(inspectBytes(Buffer.from(plain.private)).status,'unencrypted')});
test('app-managed generation writes only encrypted owner-private keys and public metadata',async t=>{const dir=await mkdtemp(path.join(tmpdir(),'signet-managed-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new compiled.AppManagedKeyStore(path.join(dir,'ssh'));await assert.rejects(store.generate({label:'UCI HPC3',username:'testuser',passphrase:'short'}),{code:'PASSPHRASE_REQUIRED'});const key=await store.generate({label:'UCI HPC3',username:'testuser',passphrase:phrase});assert.equal((await inspectPrivateKey(key.privateKeyPath)).status,'encrypted');assert.ok(!(utils.parseKey(await unlockPrivateKey(key.privateKeyPath,phrase)) instanceof Error));assert.match(key.fingerprint,/^SHA256:[A-Za-z0-9+/]{43}$/);const metadata=await readFile(path.join(dir,'ssh','keys.json'),'utf8');assert.ok(!metadata.includes(phrase));assert.doesNotMatch(metadata,/BEGIN .*PRIVATE KEY/);const {stat}=await import('node:fs/promises');if(process.platform!=='win32'){assert.equal((await stat(path.join(dir,'ssh','keys'))).mode&0o777,0o700);assert.equal((await stat(key.privateKeyPath)).mode&0o777,0o600)}});
test('named external keys persist account metadata and deduplicate the same key',async t=>{const f=await fixture(t),store=new compiled.AppManagedKeyStore(path.join(f.dir,'managed'));const input={label:'Office Mac key',username:'testuser',privateKeyPath:f.key};const first=await store.addExternal(input),duplicate=await store.addExternal(input),listed=await store.list();assert.equal(first.keyId,duplicate.keyId);assert.equal(first.label,'Office Mac key');assert.equal(first.username,'testuser');assert.equal(first.source,'external');assert.equal(listed.length,1);assert.equal(listed[0].fingerprint,first.fingerprint);const raw=JSON.parse(await readFile(path.join(f.dir,'managed','keys.json'),'utf8'));assert.equal(raw.keys[0].source,undefined)});
test('file and envelope failures are distinct and never falsely encrypted',async t=>{
 const {key,dir}=await fixture(t);for(const [value,status] of [[plain.private,'unencrypted'],[plain.public,'invalid'],['garbage','invalid'],[encrypted.private.slice(0,-40),'invalid'],['-----BEGIN ENCRYPTED PRIVATE KEY-----\nabc\n-----END ENCRYPTED PRIVATE KEY-----','unsupported']] as const){await writeFile(key,value);assert.equal((await inspectPrivateKey(key)).status,status)}
 assert.equal((await inspectPrivateKey(path.join(dir,'missing'))).status,'unreadable');assert.equal((await inspectPrivateKey(dir)).status,'unreadable');await chmod(key,0o644);assert.equal((await inspectPrivateKey(key)).status,'unreadable');await chmod(key,0o000);assert.equal((await inspectPrivateKey(key)).status,'unreadable');await chmod(key,0o600);await symlink(key,path.join(dir,'link'));assert.equal((await inspectPrivateKey(path.join(dir,'link'))).status,'unreadable');await writeFile(key,Buffer.alloc(128*1024+1));assert.equal((await inspectPrivateKey(key)).status,'unreadable');
});
test('no auto-connect; Save persists only; wrong/empty passphrase and replaced key never construct a client',async t=>{
 const s=await setup(t);assert.deepEqual(s.service.getSnapshot(),{selectedProfile:null,connection:null});assert.equal(s.clients(),0);const p=await s.service.saveProfile(s.input);assert.equal(s.clients(),0);
 for(const [secret,code] of [['','PASSPHRASE_REQUIRED'],['wrong','INVALID_PASSPHRASE']])await assert.rejects(s.service.connect(p.id,secret),{code});assert.equal(s.clients(),0);
 await writeFile(s.key,plain.private);await assert.rejects(s.service.connect(p.id,phrase),{code:'KEY_UNENCRYPTED'});await assert.rejects(s.service.saveProfile({...s.input,id:p.id}),{code:'KEY_UNENCRYPTED'});assert.equal(s.clients(),0);
 const doc=await readFile(path.join(s.dir,'ssh','profiles.json'),'utf8');assert.ok(!doc.includes(phrase));assert.doesNotMatch(doc,/BEGIN|passphrase|password|connectedAt|status/);assert.equal((await s.repo.list()).length,1);
 const restarted=new SshConnectionService(s.repo,s.trust,keyOps);assert.equal((await restarted.initialize()).connection?.status,'disconnected');
});
test('profile store rejects corruption, old/future versions and unknown fields without overwrite',async t=>{
 const s=await setup(t);await s.service.saveProfile(s.input);const file=path.join(s.dir,'ssh','profiles.json');for(const content of ['{broken',JSON.stringify({version:2,profiles:[{auth:{method:'ssh-agent'}}]}),JSON.stringify({version:99,profiles:[]})]){await writeFile(file,content);await assert.rejects(s.repo.load());await assert.rejects(s.repo.upsert({...s.input,id:'test'}));assert.equal(await readFile(file,'utf8'),content)}
 await assert.rejects(s.service.saveProfile({...s.input,passphrase:'secret'} as any),{code:'INVALID_PROFILE'});
});
test('host fingerprints are canonical SHA256, unknown and changed rejected, matching accepted',async t=>{
 const s=await setup(t);for(const key of [encrypted,rsa,ec,ec384,ec521]){const identity=hostIdentity(s.input.host,22,publicBlob(key.public));assert.match(identity.fingerprint,/^SHA256:[A-Za-z0-9+/]{43}$/)}
 const p=await s.service.saveProfile(s.input),run=s.service.connect(p.id,phrase);await until(()=>s.client.calls===1);assert.equal(s.client.config.hostVerifier(publicBlob(plain.public)),false);s.client.emit('error',Error('Do not leak arbitrary server message'));await assert.rejects(run,{code:'HOST_KEY_UNKNOWN'});const pending=s.service.getSnapshot().pendingHost!;assert.ok(pending);await assert.rejects(s.service.trustHost({...pending,fingerprint:'SHA256:'+'B'.repeat(43)}));await s.service.trustHost(pending);assert.equal(s.trust.check(pending),'match');assert.equal(s.trust.check(hostIdentity(s.input.host,22,publicBlob(encrypted.public))),'changed');
 const reloaded=new HostKeyTrustStore(path.join(s.dir,'ssh'));await reloaded.load();assert.equal(reloaded.check(pending),'match');await assert.rejects(reloaded.trust({...pending,fingerprint:'SHA256:'+'B'.repeat(43)}),{code:'HOST_KEY_CHANGED'});
});
test('double connect, ready, edit protection, explicit disconnect and stale ready',async t=>{
 const s=await setup(t),p=await s.service.saveProfile(s.input);const a=s.service.connect(p.id,phrase),b=s.service.connect(p.id,phrase);assert.equal(a,b);await until(()=>s.client.calls===1);assert.equal(s.service.getSnapshot().connection?.status,'connecting');s.client.emit('ready');await a;assert.equal(s.service.getSnapshot().connection?.status,'connected');await s.service.connect(p.id,phrase);assert.equal(s.client.calls,1);await assert.rejects(s.service.saveProfile({...p,host:'other.example'}));await s.service.disconnect(p.id);assert.equal(s.client.ended,1);assert.equal(s.service.getSnapshot().connection?.status,'disconnected');s.client.emit('ready');assert.equal(s.service.getSnapshot().connection?.status,'disconnected');
});
test('disconnect during local unlock cancels before network; stale events cannot resurrect state',async t=>{
 const s=await setup(t);let release!:(v:string)=>void;const gate=new Promise<string>(r=>release=r);const service=new SshConnectionService(s.repo,s.trust,{...keyOps,unlock:()=>gate},()=>s.client as unknown as Client);await service.initialize();const p=await service.saveProfile(s.input);const run=service.connect(p.id,phrase);const rejected=assert.rejects(run,{code:'SESSION_CLOSED'});const stop=service.disconnect(p.id);release('unused');await stop;await rejected;assert.equal(s.client.calls,0);assert.equal(service.getSnapshot().connection?.status,'disconnected');
});
test('disconnect during handshake, server close and authentication errors are sanitized',async t=>{
 for(const mode of ['cancel','close','auth'] as const){const s=await setup(t),p=await s.service.saveProfile(s.input),run=s.service.connect(p.id,phrase),failure=assert.rejects(run,{code:mode==='auth'?'AUTH_FAILED':'SESSION_CLOSED'});await until(()=>s.client.calls===1);if(mode==='cancel')await s.service.disconnect(p.id);else if(mode==='close')s.client.emit('close');else s.client.emit('error',Object.assign(Error(phrase),{level:'client-authentication'}));await failure;assert.ok(!JSON.stringify(s.service.getSnapshot()).includes(phrase))}
});
test('IPC rejects wrong sender, subframes, malformed payloads; broadcasts snapshots only',async t=>{
 const s=await setup(t),handlers=new Map<string,Function>(),sent:any[]=[];const frame={url:'signet://app/index.html'},wc={mainFrame:frame,send:(...v:any[])=>sent.push(v)},win={isDestroyed:()=>false,webContents:wc};const ipc={handle:(n:string,f:Function)=>handlers.set(n,f),removeHandler:(n:string)=>handlers.delete(n)};const dispose=installSshHandlers(ipc as any,()=>win as any,s.service,async()=>({canceled:false,path:'/selected/key',name:'key'}));const event={sender:wc,senderFrame:frame};
 assert.equal((await handlers.get('ssh:getSnapshot')!({...event,sender:{}})).ok,false);assert.equal((await handlers.get('ssh:getSnapshot')!({...event,senderFrame:{url:frame.url}})).ok,false);assert.equal((await handlers.get('ssh:connect')!(event,'id',{secret:phrase})).ok,false);assert.equal((await handlers.get('ssh:inspectPrivateKey')!(event,'relative')).ok,false);assert.equal((await handlers.get('ssh:saveProfile')!(event,{...s.input,password:phrase})).ok,false);
 assert.equal((await handlers.get('ssh:pickPrivateKey')!(event,'unexpected')).ok,false);assert.deepEqual(await handlers.get('ssh:pickPrivateKey')!(event),{ok:true,value:{canceled:false,path:'/selected/key',name:'key'}});
 await handlers.get('ssh:saveProfile')!(event,s.input);assert.ok(sent.length);assert.ok(!JSON.stringify(sent).includes(phrase));assert.ok(![...handlers.keys()].some(v=>/exec|shell|readFile/.test(v)));dispose();assert.equal(handlers.size,0);
});
test('controlled localhost ssh2 integration: strict host verification and live ready/close',async t=>{
 const f=await fixture(t);const server=new Server({hostKeys:[plain.private]},client=>{client.on('error',()=>{});client.on('authentication',ctx=>{if(ctx.method==='publickey'&&ctx.username==='testuser'&&ctx.key.data.equals(publicBlob(encrypted.public)))ctx.accept();else ctx.reject()});client.on('ready',()=>client.on('session',accept=>{accept().on('exec',acceptExec=>{const stream=acceptExec();stream.write(Buffer.from([0,1,255]));stream.stderr.write('notice');stream.exit(7);stream.end()})}));});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});t.after(()=>new Promise<void>(r=>server.close(()=>r())));const port=(server.address() as {port:number}).port;
 const repo=new compiled.SshProfileRepository(path.join(f.dir,'ssh')),trust=new compiled.HostKeyTrustStore(path.join(f.dir,'ssh')),service=new compiled.SshConnectionService(repo,trust);await service.initialize();t.after(()=>service.shutdown());const p=await service.saveProfile({...f.input,host:'127.0.0.1',port});await assert.rejects(service.connect(p.id,phrase),{code:'HOST_KEY_UNKNOWN'});await service.trustHost(service.getSnapshot().pendingHost!);await service.connect(p.id,phrase);assert.equal(service.getSnapshot().connection?.status,'connected');const result=await service.exec('printf test',Buffer.alloc(0),1000);assert.equal(result.returncode,7);assert.deepEqual(result.stdout,Buffer.from([0,1,255]));assert.equal(result.stderr.toString(),'notice');await service.disconnect(p.id);assert.equal(service.getSnapshot().connection?.status,'disconnected');
});
test('managed onboarding transports real keyboard challenges, appends public key, and verifies a fresh key session',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'signet-onboarding-'));t.after(()=>rm(dir,{recursive:true,force:true}));const sshDir=path.join(dir,'ssh'),store=new compiled.AppManagedKeyStore(sshDir),managed=await store.generate({label:'Onboarding test',username:'testuser',passphrase:phrase});const managedBlob=publicBlob(managed.publicKey);let installed=false,temporarySessions=0,keySessions=0;
 const server=new Server({hostKeys:[plain.private]},client=>{client.on('error',()=>{});client.on('authentication',ctx=>{if(ctx.method==='keyboard-interactive'){temporarySessions++;ctx.prompt([{prompt:'UCInetID password:',echo:false},{prompt:'Duo code:',echo:false}],answers=>answers[0]==='account-secret'&&answers[1]==='123456'?ctx.accept():ctx.reject());return}if(ctx.method==='publickey'&&ctx.username==='testuser'&&ctx.key.data.equals(managedBlob)){keySessions++;ctx.accept();return}ctx.reject(['keyboard-interactive','publickey'])});client.on('ready',()=>client.on('session',accept=>{const session=accept();session.on('exec',(acceptExec,_reject,info)=>{assert.match(info.command,/authorized_keys/);const stream=acceptExec();installed=true;stream.write('ADDED');stream.exit(0);stream.end()})}))});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));const port=(server.address() as {port:number}).port,repo=new compiled.SshProfileRepository(sshDir),trust=new compiled.HostKeyTrustStore(sshDir);await trust.load();await trust.trust(hostIdentity('127.0.0.1',port,publicBlob(plain.public)));const service=new compiled.SshConnectionService(repo,trust,undefined,undefined,store);await service.initialize();t.after(()=>service.shutdown());
 const challenge=new Promise<any>(resolve=>service.once('challenge',resolve)),request=service.registerGenerated({profile:{name:'Local onboarding',host:'127.0.0.1',port,username:'testuser',auth:{method:'private-key',privateKeyPath:managed.privateKeyPath,keyId:managed.keyId,managed:true}},keyId:managed.keyId,passphrase:phrase,password:'account-secret'});const prompt=await challenge;assert.deepEqual(prompt.prompts.map((item:any)=>item.prompt),['UCInetID password:','Duo code:']);service.answerAuthChallenge(prompt.sessionId,prompt.challengeId,['account-secret','123456']);const result=await request;assert.deepEqual(result,{alreadyPresent:false,verified:true});assert.equal(installed,true);assert.ok(temporarySessions>=1);assert.ok(keySessions>=1);assert.equal(service.getSnapshot().connection?.status,'connected');assert.equal(service.getSnapshot().selectedProfile?.auth.keyId,managed.keyId);const persisted=await readFile(path.join(sshDir,'profiles.json'),'utf8');assert.ok(!persisted.includes(phrase));assert.ok(!persisted.includes('account-secret'));await service.disconnect(service.getSnapshot().selectedProfile!.id);
});
test('forced owner process termination releases its localhost SSH socket',async t=>{
 const f=await fixture(t);let observedClose!:()=>void;const closed=new Promise<void>(r=>observedClose=r);
 const server=new Server({hostKeys:[plain.private]},client=>{client.on('error',()=>{});client.on('authentication',ctx=>ctx.method==='publickey'?ctx.accept():ctx.reject());client.on('close',observedClose)});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});const port=(server.address() as {port:number}).port;
 const dir=path.join(f.dir,'ssh'),repo=new SshProfileRepository(dir),trust=new HostKeyTrustStore(dir);await trust.load();await trust.trust(hostIdentity('127.0.0.1',port,publicBlob(plain.public)));await repo.upsert({...f.input,id:'child',host:'127.0.0.1',port});
 const child=spawn(process.execPath,['-e',`const {SshConnectionService,SshProfileRepository,HostKeyTrustStore}=require('./build/ssh/index.cjs');const s=new SshConnectionService(new SshProfileRepository(process.argv[1]),new HostKeyTrustStore(process.argv[1]));(async()=>{await s.initialize();await s.connect('child','test-only-passphrase');console.log('READY')})().catch(()=>process.exit(1));`,dir],{cwd:path.resolve(import.meta.dirname,'..'),stdio:['ignore','pipe','pipe']});
 t.after(()=>{child.kill('SIGKILL');server.close()});
 await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Child did not connect')),10000);child.stdout.on('data',b=>{if(b.toString().includes('READY')){clearTimeout(timeout);resolve()}});child.once('exit',()=>{clearTimeout(timeout);reject(Error('Child exited before ready'))})});
 child.kill('SIGKILL');await Promise.race([closed,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Owned socket remained open')),3000);timer.unref()})]);
});
test('bounded disconnect destroys an uncooperative client and restart does not resurrect it',async t=>{
 const s=await setup(t),p=await s.service.saveProfile(s.input),run=s.service.connect(p.id,phrase);await until(()=>s.client.calls===1);s.client.emit('ready');await run;s.client.end=()=>{s.client.ended++;return s.client};await s.service.shutdown();assert.ok(s.client.destroyed>0);assert.equal(s.service.getSnapshot().connection?.status,'disconnected');
});
test('portable module boundary and permission modes',async t=>{
 const s=await setup(t);await s.service.saveProfile(s.input);const {stat,readdir}=await import('node:fs/promises');if(process.platform!=='win32'){assert.equal((await stat(path.join(s.dir,'ssh'))).mode&0o777,0o700);assert.equal((await stat(path.join(s.dir,'ssh','profiles.json'))).mode&0o777,0o600)}
 for(const file of await readdir(path.resolve(import.meta.dirname,'../modules/ssh'))){if(!/\.tsx?$/.test(file))continue;const source=await readFile(path.resolve(import.meta.dirname,'../modules/ssh',file),'utf8');assert.doesNotMatch(source,/from ['"](?:electron|node:|ssh2|.*pty\/)/)}
 for(const file of await readdir(path.resolve(import.meta.dirname,'../src/ssh'))){if(!/\.tsx?$/.test(file))continue;const source=await readFile(path.resolve(import.meta.dirname,'../src/ssh',file),'utf8');assert.doesNotMatch(source,/from ['"].*pty\//);assert.doesNotMatch(source,/ControlMaster|node-pty|xterm/)}
});
test('late ready after failure stays failed; repeated disconnect shares bounded cleanup',async t=>{
 const s=await setup(t),p=await s.service.saveProfile(s.input),run=s.service.connect(p.id,phrase),failed=assert.rejects(run,{code:'NETWORK_UNREACHABLE'});await until(()=>s.client.calls===1);s.client.emit('error',Object.assign(Error('untrusted'),{code:'ECONNREFUSED'}));await failed;s.client.emit('ready');assert.equal(s.service.getSnapshot().connection?.status,'error');
 s.client.end=()=>{s.client.ended++;return s.client};const first=s.service.disconnect(p.id),second=s.service.disconnect(p.id);assert.equal(first,second);await assert.rejects(s.service.connect(p.id,phrase),{code:'SESSION_CLOSED'});await first;assert.equal(s.client.ended,1);assert.equal(s.service.getSnapshot().connection?.status,'disconnected');
});
