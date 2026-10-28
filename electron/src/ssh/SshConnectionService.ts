import {Client,type ClientChannel} from 'ssh2';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {SshProfileRepository,HostKeyTrustStore,hostIdentity,validIdentity} from './stores';
import {keyOperations} from './keyWorkerClient';
import {fail,profileInput,SshFailure} from '../../modules/ssh/validation';
import type {Snapshot,FormInput,HostIdentity,Inspection,ConnectionHealth,Profile} from '../../modules/ssh/types';
import type {AuthChallenge,KeyMetadata,RegistrationResult} from '../../modules/ssh/types';
import {AppManagedKeyStore} from './AppManagedKeyStore';
const HEALTH_CACHE_MS=15000;
const HEALTH_COMMAND='printf "host=%s\\nuser=%s\\n" "$(hostname)" "$(id -un)"; command -v sbatch >/dev/null && echo slurm=yes || echo slurm=no';
function safeError(e:unknown):SshFailure {
 if(e instanceof SshFailure)return e;
 const err=e as {code?:string;level?:string};
 if(['ENOTFOUND','EAI_AGAIN'].includes(err?.code||''))return new SshFailure('DNS_FAILED','The SSH host name could not be resolved. Check the address and network connection.');
 if(['ECONNREFUSED','EHOSTUNREACH','ENETUNREACH','ECONNRESET'].includes(err?.code||''))return new SshFailure('NETWORK_UNREACHABLE','Cannot reach host. Check the address, campus network or UCI VPN.');
 if(err?.code==='ETIMEDOUT'||err?.level==='client-timeout')return new SshFailure('CONNECTION_TIMEOUT','Connection timed out. Check network or VPN.');
 if(err?.level==='client-authentication')return new SshFailure('AUTH_FAILED','Host rejected authentication. Check the username, account approval, credentials, and public-key enrollment.');
 return new SshFailure('UNKNOWN','SSH operation failed. Retry after checking local configuration and connectivity.');
}
export class SshConnectionService extends EventEmitter {
 private snapshot:Snapshot={selectedProfile:null,connection:null};private client?:Client;private controlShell?:ClientChannel;private attempt=0;private inFlight?:Promise<void>;private healthInFlight?:Promise<ConnectionHealth>;private cancel?:()=>void;private editing=false;private stopping=false;private closing?:Promise<void>;private initializationError?:SshFailure;
 private registrationCancel?:()=>void;private registrationAttempt=0;private registrationClients=new Set<Client>();
 private pendingChallenge?:{sessionId:string;challengeId:string;finish:(answers:string[])=>void;timer:NodeJS.Timeout};private onboarding=false;
 constructor(readonly profiles:SshProfileRepository,readonly trust:HostKeyTrustStore,private keys:{inspect:(path:string)=>Promise<Inspection>;unlock:(path:string,passphrase:string)=>Promise<string>}=keyOperations,private clientFactory=()=>new Client(),private managedKeys?:AppManagedKeyStore){super()}
 private trace(id:string,stage:string,message:string){if(this.listenerCount('diagnostic'))this.emit('diagnostic',{id,stage,message,time:new Date().toISOString()})}
 private raw(id:string,source:string,text:string){if(this.listenerCount('raw-ssh'))this.emit('raw-ssh',{id,source,text:String(text).slice(0,65536),time:new Date().toISOString()})}
 private observeClient(client:Client,id:string){
  this.trace(id,'transport','Opening SSH transport.');
  this.raw(id,'lifecycle','Opening SSH transport.');
  client.on('banner',message=>this.raw(id,'server-banner',message));
  client.on('ready',()=>this.trace(id,'ready','SSH authentication succeeded.'));
  client.on('error',error=>this.trace(id,'error',safeError(error).code));
  client.on('close',()=>this.trace(id,'closed','SSH transport closed.'));
 }
 private protocolTrace(id:string){
  if(!this.listenerCount('diagnostic')&&!this.listenerCount('raw-ssh'))return undefined;
  // Diagnostics use an exact allowlist; dev-only raw listeners receive the original ssh2 text.
  const messages:Record<string,[string,string]>={
   'Socket connected':['tcp','TCP connection established.'],
   'Handshake completed':['handshake','SSH handshake completed.'],
   'Outbound: Sending USERAUTH_REQUEST (password)':['authentication','Trying password authentication.'],
   'Outbound: Sending USERAUTH_REQUEST (publickey -- check)':['authentication','Checking public-key acceptance.'],
   'Outbound: Sending USERAUTH_REQUEST (publickey)':['authentication','Trying public-key authentication.'],
   'Outbound: Sending USERAUTH_REQUEST (keyboard-interactive)':['authentication','Starting keyboard-interactive / Duo authentication.'],
   'Client: password auth failed':['authentication','Password phase did not complete login; checking server-requested methods.'],
   'Client: publickey auth failed':['authentication','Public-key authentication not accepted.'],
   'Client: keyboard-interactive auth failed':['authentication','Keyboard-interactive authentication not accepted.'],
  };
  return (message:string)=>{this.raw(id,'ssh2-debug',message);const item=Object.hasOwn(messages,message)?messages[message]:undefined;if(item)this.trace(id,...item)};
 }
 private createControlShell(client:Client,id:string):Promise<ClientChannel>{
  this.trace(id,'session','Authentication succeeded; opening persistent login shell.');
  return new Promise((resolve,reject)=>{let settled=false;const timer=setTimeout(()=>finish(new SshFailure('CONNECTION_TIMEOUT','SSH login shell did not open in time.')),10000),finish=(error?:SshFailure,stream?:ClientChannel)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(stream!)};
   client.shell({term:'xterm-256color',cols:120,rows:40},(error,stream)=>{if(error||!stream){finish(error?safeError(error):new SshFailure('SESSION_CLOSED','SSH login shell did not open.'));return}const output=(source:string)=>(chunk:Buffer)=>this.raw(id,source,chunk.toString('utf8'));stream.on('data',output('session-output'));stream.stderr.on('data',output('session-stderr'));this.trace(id,'session','Persistent login shell opened.');finish(undefined,stream)});
  });
 }
 private executeOn(client:Client,command:string,input:Buffer,timeoutMs:number,observe=true){
  const activityId=randomUUID(),activity=(type:string,extra:Record<string,unknown>={})=>{if(observe&&this.listenerCount('activity'))this.emit('activity',{id:activityId,type,time:new Date().toISOString(),...extra})};
  activity('start',{command:command.slice(0,4096)});let observed=0,truncated=false;
  return new Promise<{returncode:number;signal:string|null;stdout:Buffer;stderr:Buffer}>((resolve,reject)=>{client.exec(command,(error,stream)=>{
   if(error){activity('end',{error:'Could not start remote command.'});reject(safeError(error));return}
   const stdout:Buffer[]=[],stderr:Buffer[]=[];let size=0,finished=false;
   const timer=setTimeout(()=>{done(new SshFailure('CONNECTION_TIMEOUT','The remote command timed out.'));stream.close()},timeoutMs);
   const collect=(target:Buffer[],channel:string)=>(chunk:Buffer)=>{if(observe&&this.listenerCount('activity')){const remaining=Math.max(0,131072-observed);if(remaining){activity('output',{channel,data:chunk.subarray(0,remaining).toString('utf8')});observed+=Math.min(chunk.length,remaining)}if(chunk.length>remaining&&!truncated){truncated=true;activity('output',{channel:'notice',data:'Output preview truncated at 128 KiB; command continues.'})}}size+=chunk.length;if(size>1024*1024*1024){done(new SshFailure('UNKNOWN','Remote output exceeded 1 GiB.'));stream.close()}else target.push(Buffer.from(chunk))};
   const done=(failure:SshFailure|null,code=255,signal:string|null=null)=>{if(finished)return;finished=true;clearTimeout(timer);activity('end',{code,signal,error:failure?.message});failure?reject(failure):resolve({returncode:Number.isInteger(code)?code:255,signal,stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr)})};
   stream.on('data',collect(stdout,'stdout'));stream.stderr.on('data',collect(stderr,'stderr'));stream.once('error',(error:Error)=>done(safeError(error)));stream.once('close',(code:number,signal:string|null)=>done(null,code,signal));if(input.length)stream.end(input);else stream.end();
  })});
 }
 private async verifyRemote(client:Client,profile:Profile,id:string):Promise<ConnectionHealth>{
  this.trace(id,'health','Verifying remote account and Slurm availability.');
  let result;try{result=await this.executeOn(client,HEALTH_COMMAND,Buffer.alloc(0),8000,false)}catch{throw new SshFailure('STALE_CONNECTION','The SSH connection stopped responding. It may have been interrupted by sleep, VPN, or a network change.')}
  if(result.returncode!==0)throw new SshFailure('STALE_CONNECTION','The SSH connection could not run its health check. Reconnect and try again.');
  if(result.stdout.length>8192)throw new SshFailure('REMOTE_IDENTITY_MISMATCH','The remote identity response was invalid.');
  const values=new Map<string,string>();for(const line of result.stdout.toString('utf8').split('\n')){const separator=line.indexOf('=');if(separator>0)values.set(line.slice(0,separator).trim(),line.slice(separator+1).trim())}
  const hostname=values.get('host')||'',username=values.get('user')||'',slurm=values.get('slurm')==='yes';
  if(!/^[A-Za-z0-9._-]{1,253}$/.test(hostname)||username!==profile.username){this.trace(id,'health','Remote identity did not match the selected profile.');throw new SshFailure('REMOTE_IDENTITY_MISMATCH',`SSH connected as an unexpected account or host. Expected ${profile.username}; disconnecting.`)}
  if(!slurm){this.trace(id,'health','Remote host does not provide Slurm.');throw new SshFailure('SLURM_UNAVAILABLE','SSH connected, but sbatch is unavailable on the remote host. This does not appear to be an HPC3 login environment.')}
  const health:ConnectionHealth={checkedAt:new Date().toISOString(),remote:{hostname,username,slurm},steps:[{name:'transport',ok:true,detail:'SSH transport authenticated.'},{name:'session',ok:true,detail:'Persistent login shell open.'},{name:'identity',ok:true,detail:`${username} on ${hostname}`},{name:'slurm',ok:true,detail:'sbatch available.'}]};
  this.trace(id,'health',`Remote verified: ${username}@${hostname}; Slurm available.`);return health;
 }
 private publish(){this.emit('snapshot',this.getSnapshot())}
 getSnapshot():Snapshot{return structuredClone(this.snapshot)}
 initialSnapshot(){if(this.initializationError)throw this.initializationError;return this.getSnapshot()}
 async initialize(){try{await this.trust.load();const d=await this.profiles.load();this.snapshot.selectedProfile=d.profiles.find(p=>p.id===d.selectedProfileId)||null;this.snapshot.connection=this.snapshot.selectedProfile?{profileId:this.snapshot.selectedProfile.id,status:'disconnected'}:null;this.initializationError=undefined;return this.getSnapshot()}catch{this.initializationError=new SshFailure('UNKNOWN','SSH configuration could not be loaded. Existing files were preserved. Back up and repair profiles.json / host-trust.json in the app userData/ssh directory, then restart.');throw this.initializationError}}
 listProfiles(){return this.profiles.list()}
 inspectPrivateKey(p:string):Promise<Inspection>{return this.keys.inspect(p)}
 listKeys():Promise<KeyMetadata[]>{if(!this.managedKeys)return Promise.resolve([]);return this.managedKeys.list()}
 generateKey(input:{label:string;username?:string;passphrase:string}):Promise<KeyMetadata>{if(!this.managedKeys)return Promise.reject(new SshFailure('UNKNOWN','App-managed key storage is unavailable.'));return this.managedKeys.generate(input)}
 addExternalKey(input:{label:string;username?:string;privateKeyPath:string}){if(!this.managedKeys)return Promise.reject(new SshFailure('UNKNOWN','SSH key storage is unavailable.'));return this.managedKeys.addExternal(input)}
 answerAuthChallenge(sessionId:string,challengeId:string,answers:string[]){const pending=this.pendingChallenge;if(!pending||pending.sessionId!==sessionId||pending.challengeId!==challengeId)fail('AUTH_FAILED','Authentication challenge expired. Retry registration.');if(!Array.isArray(answers)||answers.some(answer=>typeof answer!=='string'||answer.length>4096))fail('AUTH_FAILED','Invalid authentication response.');clearTimeout(pending.timer);this.pendingChallenge=undefined;this.emit('challenge',null);this.trace(sessionId,'challenge','Authentication response submitted (contents omitted).');pending.finish(answers)}
 private clearChallenge(sessionId?:string){
  const pending=this.pendingChallenge;if(!pending||(sessionId&&pending.sessionId!==sessionId))return;
  clearTimeout(pending.timer);this.pendingChallenge=undefined;this.emit('challenge',null);pending.finish([]);
 }
 private forwardChallenges(client:Client,sessionId:string,active:()=>boolean){
  client.on('keyboard-interactive',(name,instructions,_language,prompts,finishChallenge)=>{
   if(!active()||prompts.length>16){finishChallenge([]);return}
   this.clearChallenge();
   this.raw(sessionId,'keyboard-interactive',[`name: ${String(name||'')}`,`instructions:\n${String(instructions||'')}`,...prompts.map((item,index)=>`prompt ${index+1} (echo=${!!item.echo}):\n${String(item.prompt||'')}`)].join('\n'));
   this.trace(sessionId,'challenge','Server requested keyboard-interactive authentication. Complete the sign-in dialog.');
   const challengeId=randomUUID(),timer=setTimeout(()=>{this.trace(sessionId,'timeout','Authentication challenge expired.');this.clearChallenge(sessionId)},120000);
   this.pendingChallenge={sessionId,challengeId,finish:finishChallenge,timer};
   this.emit('challenge',{sessionId,challengeId,name:String(name||'').slice(0,1024),instructions:String(instructions||'').slice(0,8192),prompts:prompts.map(item=>({prompt:String(item.prompt||'').slice(0,4096),echo:!!item.echo}))} satisfies AuthChallenge);
  });
 }
 private registrationHostVerifier(profile:FormInput,id:string,setError:(error:SshFailure)=>void){return (key:Buffer)=>{try{const identity=hostIdentity(profile.host,profile.port,key),state=this.trust.check(identity);this.trace(id,'host-key',state==='match'?'Host key matches saved trust.':state==='unknown'?'Unknown host key: independently verify and trust it before retrying.':'Host key changed: connection blocked.');if(state==='match')return true;if(state==='unknown')this.snapshot.pendingHost=identity;setError(new SshFailure(state==='unknown'?'HOST_KEY_UNKNOWN':'HOST_KEY_CHANGED',state==='unknown'?'Unknown host. Verify the displayed fingerprint independently, trust it, then retry.':'SECURITY WARNING: saved host identity changed. Registration was blocked.'));this.publish();return false}catch{setError(new SshFailure('UNKNOWN','Invalid host public key.'));return false}}}
 async registerGenerated(input:{profile:FormInput;keyId:string;passphrase:string;password:string}):Promise<RegistrationResult>{
  if(this.onboarding||this.inFlight||this.editing||this.stopping||this.closing||['connected','connecting','disconnecting'].includes(this.snapshot.connection?.status||''))fail('UNKNOWN','Another SSH operation is in progress.');if(!this.managedKeys)fail('UNKNOWN','App-managed key storage is unavailable.');
  const profile=profileInput(input.profile),key=await this.managedKeys.get(input.keyId);if(profile.auth.method!=='private-key'||profile.auth.privateKeyPath!==key.privateKeyPath||profile.auth.keyId!==key.keyId||profile.auth.managed!==true)fail('KEY_INVALID','Generated key reference does not match this profile.');if(typeof input.password!=='string'||!input.password.length||input.password.length>4096)fail('AUTH_FAILED','Enter your UCInetID password for temporary registration.');
  const registrationToken=++this.registrationAttempt;const checkActive=()=>{if(this.stopping||registrationToken!==this.registrationAttempt)fail('SESSION_CLOSED','Key registration cancelled.');};
  this.onboarding=true;let privateKey:string|undefined,password=input.password;input.password='';const sessionId=randomUUID();let alreadyPresent=false,temporary:Client|undefined,verifiedClient:Client|undefined;
  this.trace(sessionId,'registration',`Starting SSH key registration to ${profile.username}@${profile.host}:${profile.port}.`);
  try{this.trace(sessionId,'unlock','Unlocking the generated key locally.');privateKey=await this.keys.unlock(key.privateKeyPath,input.passphrase);input.passphrase='';checkActive();let hostError:SshFailure|undefined;const temp=this.clientFactory();temporary=temp;this.registrationClients.add(temp);this.observeClient(temp,sessionId);
   await new Promise<void>((resolve,reject)=>{let settled=false;const timer=setTimeout(()=>finish(new SshFailure('CONNECTION_TIMEOUT','Registration timed out. Check network or VPN.')),180000);const finish=(error?:SshFailure)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve()};this.registrationCancel=()=>finish(new SshFailure('SESSION_CLOSED','Key registration cancelled.'));this.forwardChallenges(temp,sessionId,()=>registrationToken===this.registrationAttempt&&!this.stopping);temp.on('ready',()=>finish());temp.on('error',e=>finish(hostError||safeError(e)));temp.on('close',()=>finish(hostError||new SshFailure('SESSION_CLOSED','Registration session closed before authentication.')));try{temp.connect({debug:this.protocolTrace(sessionId),host:profile.host,port:profile.port,username:profile.username,password,tryKeyboard:true,readyTimeout:180000,authHandler:['password','keyboard-interactive'],keepaliveInterval:15000,keepaliveCountMax:3,agentForward:false,hostVerifier:this.registrationHostVerifier(profile,sessionId,error=>hostError=error)})}catch(e){finish(safeError(e))}});password='';checkActive();
   this.trace(sessionId,'registration','Installing public key using the authenticated account.');
   const encoded=Buffer.from(key.publicKey,'utf8').toString('base64');const command=`umask 077; mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" && touch "$HOME/.ssh/authorized_keys" && chmod 600 "$HOME/.ssh/authorized_keys" && key=$(printf %s '${encoded}' | base64 -d) && if grep -Fqx -- "$key" "$HOME/.ssh/authorized_keys"; then printf EXISTS; else printf '%s\\n' "$key" >> "$HOME/.ssh/authorized_keys" && printf ADDED; fi`;
   alreadyPresent=await new Promise<boolean>((resolve,reject)=>{
    let settled=false;const finish=(error?:SshFailure,value=false)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value)};
    const timer=setTimeout(()=>finish(new SshFailure('CONNECTION_TIMEOUT','Public-key registration timed out.')),30000);
    this.registrationCancel=()=>finish(new SshFailure('SESSION_CLOSED','Key registration cancelled.'));
    temporary!.once('close',()=>finish(new SshFailure('SESSION_CLOSED','Registration connection closed.')));
    temporary!.exec(command,(error,stream)=>{
     if(error){finish(new SshFailure('AUTH_FAILED','HPC3 did not permit public-key registration. Use the manual setup instructions.'));return}
     let output='';stream.on('data',(chunk:Buffer)=>{if(output.length<64)output+=chunk.toString()});stream.stderr.on('data',()=>{});
     stream.once('error',(error:Error)=>finish(safeError(error)));
     stream.once('close',(code:number)=>{if(code!==0||!/^(ADDED|EXISTS)$/.test(output))finish(new SshFailure('AUTH_FAILED','Public-key registration could not be confirmed. Existing authorized keys were preserved.'));else finish(undefined,output==='EXISTS')});
    });
   });checkActive();temporary.destroy();this.registrationClients.delete(temporary);temporary=undefined;
   const candidate={...profile,id:profile.id||randomUUID()},verifyClient=this.clientFactory();verifiedClient=verifyClient;this.registrationClients.add(verifyClient);this.trace(sessionId,'verification','Opening a fresh connection to verify the installed key.');this.observeClient(verifyClient,sessionId);let verifyError:SshFailure|undefined,verifyShell:ClientChannel|undefined,verifiedHealth:ConnectionHealth|undefined;
   await new Promise<void>((resolve,reject)=>{let settled=false;const timer=setTimeout(()=>finish(new SshFailure('CONNECTION_TIMEOUT','Fresh key verification timed out. The generated key was retained for retry.')),25000);const finish=(error?:SshFailure)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve()};this.registrationCancel=()=>finish(new SshFailure('SESSION_CLOSED','Key registration cancelled.'));verifyClient.on('ready',()=>void this.createControlShell(verifyClient,sessionId).then(async stream=>{verifyShell=stream;stream.once('close',()=>finish(new SshFailure('SESSION_CLOSED','Fresh key login shell closed during verification.')));verifiedHealth=await this.verifyRemote(verifyClient,candidate,sessionId);finish()}).catch(finish));verifyClient.on('error',e=>finish(verifyError||safeError(e)));verifyClient.on('close',()=>finish(verifyError||new SshFailure('SESSION_CLOSED','Fresh key verification closed before authentication.')));verifyClient.connect({debug:this.protocolTrace(sessionId),host:candidate.host,port:candidate.port,username:candidate.username,privateKey,tryKeyboard:false,agentForward:false,readyTimeout:20000,keepaliveInterval:15000,keepaliveCountMax:3,authHandler:['publickey'],hostVerifier:this.registrationHostVerifier(candidate,sessionId,error=>verifyError=error)})});
   checkActive();await this.managedKeys.associate(key.keyId,candidate.username);checkActive();const saved=await this.profiles.upsert(candidate);checkActive();this.client=verifyClient;this.registrationClients.delete(verifyClient);verifiedClient=undefined;
   this.controlShell=verifyShell;const closed=()=>{if(this.client!==verifyClient)return;this.client=undefined;this.controlShell=undefined;this.snapshot.connection={profileId:saved.id,status:'disconnected'};this.publish()};verifyShell!.once('close',()=>{if(this.controlShell===verifyShell)verifyClient.end()});verifyClient.once('close',closed);verifyClient.once('end',closed);verifyClient.on('error',()=>{verifyClient.destroy();closed()});this.snapshot={selectedProfile:saved,connection:{profileId:saved.id,status:'connected',phase:'ready',connectedAt:new Date().toISOString(),health:verifiedHealth}};this.publish();return {alreadyPresent,verified:true};
  }catch(e){const error=safeError(e);this.trace(sessionId,'failed',error.code);if(profile.id)this.snapshot.connection={profileId:profile.id,status:'error',error:{code:error.code,message:error.message}};this.publish();throw error}
  finally{this.registrationCancel=undefined;for(const client of this.registrationClients)client.destroy();this.registrationClients.clear();this.onboarding=false;password='';privateKey=undefined;temporary?.destroy();verifiedClient?.destroy();this.clearChallenge(sessionId)}
 }
 private idle(){if(this.stopping||this.onboarding||this.editing||this.inFlight||['connected','connecting','disconnecting'].includes(this.snapshot.connection?.status||''))fail('INVALID_PROFILE','Disconnect the active connection before changing its profile.');}
 async saveProfile(input:FormInput){
  this.idle();this.editing=true;
  try{const p=profileInput(input);if(p.auth.method==='private-key'){const result=await this.keys.inspect(p.auth.privateKeyPath);if(result.status!=='encrypted')fail(result.status==='unencrypted'?'KEY_UNENCRYPTED':result.status==='unsupported'?'KEY_UNSUPPORTED':result.status==='unreadable'?'KEY_UNREADABLE':'KEY_INVALID',result.status==='unencrypted'?'This key has no passphrase.':('reason'in result?result.reason:'Invalid private key.'));}
   const saved=await this.profiles.upsert({...p,id:p.id||randomUUID()});this.snapshot={selectedProfile:saved,connection:{profileId:saved.id,status:'disconnected'}};this.publish();return saved;
  }finally{this.editing=false}
 }
 async selectProfile(id:string){this.idle();this.editing=true;try{await this.profiles.setSelectedProfile(id);const p=(await this.profiles.list()).find(p=>p.id===id)!;this.snapshot={selectedProfile:p,connection:{profileId:id,status:'disconnected'}};this.publish()}finally{this.editing=false}}
 async trustHost(identity:HostIdentity){this.idle();this.editing=true;try{const pending=this.snapshot.pendingHost;if(!validIdentity(identity)||!pending||Object.keys(pending).some(k=>pending[k as keyof HostIdentity]!==identity[k as keyof HostIdentity]))fail('HOST_KEY_UNKNOWN','Host verification request expired. Connect again.');await this.trust.trust(pending);delete this.snapshot.pendingHost;this.publish()}finally{this.editing=false}}
 connect(id:string,passphrase:string):Promise<void>{
  const p=this.snapshot.selectedProfile;if(!p||p.id!==id)return Promise.reject(new SshFailure('INVALID_PROFILE','Select a saved profile first.'));
  if(this.closing)return Promise.reject(new SshFailure('SESSION_CLOSED','Disconnect is still in progress.'));
  if(this.inFlight)return this.inFlight;if(this.snapshot.connection?.status==='connected')return Promise.resolve();
  if(this.onboarding||this.editing||this.stopping||this.snapshot.connection?.status==='disconnecting')return Promise.reject(new SshFailure('UNKNOWN','Another SSH operation is in progress.'));
  const token=++this.attempt,diagnosticId=`connection-${token}`;this.trace(diagnosticId,'connect',`Connect requested: ${p.auth.method==='duo'?'Duo':'SSH key'} to ${p.username}@${p.host}:${p.port}.`);delete this.snapshot.pendingHost;this.snapshot.connection={profileId:id,status:'connecting',phase:'opening-transport'};this.publish();
  const run=(async()=>{
   let privateKey:string|undefined;
   try{
    if(p.auth.method==='private-key'){this.trace(diagnosticId,'unlock',passphrase?'Unlocking private key locally.':'Waiting for private-key passphrase.');privateKey=await this.keys.unlock(p.auth.privateKeyPath,passphrase);passphrase='';}
    else if(typeof passphrase!=='string'||!passphrase.length||passphrase.length>4096){this.trace(diagnosticId,'credentials','Waiting for account password.');fail('PASSWORD_REQUIRED','Enter your account password to continue with Duo.');}
    if(token!==this.attempt)fail('SESSION_CLOSED','Connection cancelled.');
    await new Promise<void>((resolve,reject)=>{
     const client=this.clientFactory();this.client=client;this.observeClient(client,diagnosticId);let authenticated=false,connected=false,terminal=false;let hostError:SshFailure|undefined;
     const timer=setTimeout(()=>finish(new SshFailure('CONNECTION_TIMEOUT','Connection timed out.')),p.auth.method==='duo'?180000:25000);
     const finish=(error:SshFailure)=>{clearTimeout(timer);if(token!==this.attempt||terminal)return;terminal=true;reject(error);if(authenticated){this.snapshot.connection={profileId:id,status:'error',error:{code:error.code,message:error.message}};this.publish()}client.destroy();};
     this.cancel=()=>{clearTimeout(timer);reject(new SshFailure('SESSION_CLOSED','Connection cancelled.'))};
     client.on('ready',()=>{if(token!==this.attempt||terminal){client.destroy();return}authenticated=true;this.snapshot.connection={profileId:id,status:'connecting',phase:'opening-session'};this.publish();void this.createControlShell(client,diagnosticId).then(async stream=>{if(token!==this.attempt||terminal||this.client!==client){stream.destroy();return}this.controlShell=stream;stream.once('close',()=>{if(this.controlShell!==stream)return;this.controlShell=undefined;this.trace(diagnosticId,'session','Persistent login shell closed.');if(token===this.attempt&&this.client===client)client.end()});this.snapshot.connection={profileId:id,status:'connecting',phase:'verifying-remote'};this.publish();const health=await this.verifyRemote(client,p,diagnosticId);if(token!==this.attempt||terminal||this.client!==client)return;clearTimeout(timer);connected=true;this.cancel=undefined;this.snapshot.connection={profileId:id,status:'connected',phase:'ready',connectedAt:new Date().toISOString(),health};this.publish();resolve()}).catch(error=>finish(safeError(error)))});
     client.on('error',e=>finish(hostError||safeError(e)));
     const closed=()=>{clearTimeout(timer);if(token!==this.attempt)return;terminal=true;if(!connected)reject(hostError||new SshFailure('SESSION_CLOSED',authenticated?'SSH transport closed before the login shell opened.':'SSH session closed before authentication.'));else if(this.snapshot.connection?.status==='connected'){this.snapshot.connection={profileId:id,status:'disconnected'};this.publish()}if(this.client===client){this.client=undefined;this.controlShell=undefined}};
     client.on('end',closed);client.on('close',closed);
     if(p.auth.method==='duo')this.forwardChallenges(client,`connection-${token}`,()=>token===this.attempt&&!terminal&&!authenticated);
     try{client.connect({debug:this.protocolTrace(diagnosticId),host:p.host,port:p.port,username:p.username,...(p.auth.method==='private-key'?{privateKey,tryKeyboard:false,authHandler:['publickey']}:{password:passphrase,tryKeyboard:true,authHandler:['password','keyboard-interactive']}),readyTimeout:p.auth.method==='duo'?180000:20000,keepaliveInterval:15000,keepaliveCountMax:3,agentForward:false,hostVerifier:(key:Buffer)=>{
       if(token!==this.attempt)return false;
       try{const identity=hostIdentity(p.host,p.port,key),state=this.trust.check(identity);this.trace(diagnosticId,'host-key',state==='match'?'Host key matches saved trust.':state==='unknown'?'Unknown host key: independently verify and trust it before retrying.':'Host key changed: connection blocked.');if(state==='match')return true;
        if(state==='unknown')this.snapshot.pendingHost=identity;
        hostError=new SshFailure(state==='unknown'?'HOST_KEY_UNKNOWN':'HOST_KEY_CHANGED',state==='unknown'?'Unknown host. Verify the displayed fingerprint independently with your administrator, then trust and retry.':'SECURITY WARNING: host identity changed. Connection blocked. Contact your administrator; do not replace trust based on this connection.');return false;
       }catch{hostError=new SshFailure('UNKNOWN','Invalid host public key.');return false}
      }});
     }catch(e){finish(safeError(e))}
    });
   }catch(e){const error=safeError(e);this.trace(diagnosticId,'result',error.code);if(token===this.attempt){this.snapshot.connection=['PASSWORD_REQUIRED','PASSPHRASE_REQUIRED'].includes(error.code)?{profileId:id,status:'disconnected'}:{profileId:id,status:'error',error:{code:error.code,message:error.message}};this.publish()}throw error}
   finally{privateKey=undefined;passphrase='';this.clearChallenge(`connection-${token}`)}
  })();
  this.inFlight=run;void run.finally(()=>{if(this.inFlight===run)this.inFlight=undefined}).catch(()=>{});return run;
 }
 disconnect(id:string):Promise<void>{
  if(this.closing)return this.closing;
  const run=this.disconnectOwned(id);this.closing=run;
  void run.finally(()=>{if(this.closing===run)this.closing=undefined}).catch(()=>{});
  return run;
 }
 private async disconnectOwned(id:string){
  if(this.snapshot.selectedProfile?.id!==id)fail('INVALID_PROFILE','Unknown profile.');
  const previousAttempt=this.attempt;this.trace(`connection-${previousAttempt}`,'disconnect','Disconnect / cancellation requested.');++this.attempt;this.clearChallenge(`connection-${previousAttempt}`);this.cancel?.();this.cancel=undefined;const pending=this.inFlight,client=this.client,shell=this.controlShell;this.client=undefined;this.controlShell=undefined;
  this.snapshot.connection={profileId:id,status:'disconnecting'};this.publish();
  shell?.end();if(client)await new Promise<void>(resolve=>{const timer=setTimeout(()=>{client.destroy();resolve()},750);client.once('close',()=>{clearTimeout(timer);resolve()});client.end()});
  await pending?.catch(()=>{});
  this.snapshot.connection={profileId:id,status:'disconnected'};delete this.snapshot.pendingHost;this.publish();
 }
  async openShell(cols:number,rows:number):Promise<ClientChannel>{
    const client=this.client;if(!client||this.snapshot.connection?.status!=='connected')fail('SESSION_CLOSED','Connect SSH first.');
    return new Promise((resolve,reject)=>{let settled=false;const timer=setTimeout(()=>{settled=true;reject(new SshFailure('CONNECTION_TIMEOUT','Terminal opening timed out.'))},10000);
      client.shell({term:'xterm-256color',cols,rows},(error,stream)=>{clearTimeout(timer);if(settled||this.client!==client||this.snapshot.connection?.status!=='connected'){stream?.destroy();if(!settled)reject(new SshFailure('SESSION_CLOSED','SSH connection closed.'));return}settled=true;if(error)reject(safeError(error));else resolve(stream)});
    });
  }
 healthCheck(force=false):Promise<ConnectionHealth>{
  if(typeof force!=='boolean')return Promise.reject(new SshFailure('UNKNOWN','Invalid health-check request.'));
  const p=this.snapshot.selectedProfile,connection=this.snapshot.connection,client=this.client;if(!p||!client||connection?.status!=='connected')return Promise.reject(new SshFailure('SESSION_CLOSED','Connect SSH before checking its health.'));
  const cached=connection.health;if(!force&&cached&&Date.now()-Date.parse(cached.checkedAt)<HEALTH_CACHE_MS)return Promise.resolve(structuredClone(cached));
  if(this.healthInFlight)return this.healthInFlight;const token=this.attempt,id=`connection-${token}`;
  const run=(async()=>{try{const health=await this.verifyRemote(client,p,id);if(token!==this.attempt||this.client!==client||this.snapshot.connection?.status!=='connected')throw new SshFailure('SESSION_CLOSED','SSH connection changed during its health check.');this.snapshot.connection={...this.snapshot.connection,phase:'ready',health};this.publish();return structuredClone(health)}catch(e){const error=e instanceof SshFailure?e:new SshFailure('STALE_CONNECTION','The SSH connection stopped responding. Reconnect and try again.');if(token===this.attempt&&this.client===client){this.trace(id,'health',`${error.code}: closing unhealthy SSH transport.`);const shell=this.controlShell;this.controlShell=undefined;this.client=undefined;this.snapshot.connection={profileId:p.id,status:'error',error:{code:error.code,message:error.message}};this.publish();shell?.end();client.destroy()}throw error}})();
  this.healthInFlight=run;void run.finally(()=>{if(this.healthInFlight===run)this.healthInFlight=undefined}).catch(()=>{});return run;
 }
 async exec(command:string,input:Buffer,timeoutMs=30000){
  if(typeof command!=='string'||!command||command.length>131072||!Buffer.isBuffer(input)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>24*60*60*1000)fail('UNKNOWN','Invalid SSH execution request.');
  await this.healthCheck(false);const client=this.client;if(!client||this.snapshot.connection?.status!=='connected')fail('SESSION_CLOSED','Connect SSH before running remote work.');return this.executeOn(client,command,input,timeoutMs,true);
 }

 cancelRegistration(){++this.registrationAttempt;this.registrationCancel?.();for(const client of this.registrationClients)client.destroy();this.clearChallenge()}
 async shutdown(){this.stopping=true;this.cancelRegistration();if(this.snapshot.selectedProfile)await this.disconnect(this.snapshot.selectedProfile.id)}
}
