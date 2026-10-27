import {Client} from 'ssh2';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {SshProfileRepository,HostKeyTrustStore,hostIdentity,validIdentity} from './stores';
import {keyOperations} from './keyWorkerClient';
import {fail,profileInput,SshFailure} from '../../modules/ssh/validation';
import type {Snapshot,FormInput,HostIdentity,Inspection} from '../../modules/ssh/types';
import type {AuthChallenge,KeyMetadata,RegistrationResult} from '../../modules/ssh/types';
import {AppManagedKeyStore} from './AppManagedKeyStore';
function safeError(e:unknown):SshFailure {
 if(e instanceof SshFailure)return e;
 const err=e as {code?:string;level?:string};
 if(['ECONNREFUSED','ENOTFOUND','EHOSTUNREACH','ENETUNREACH','ECONNRESET','EAI_AGAIN'].includes(err?.code||''))return new SshFailure('NETWORK_UNREACHABLE','Cannot reach host. Check the address, campus network or UCI VPN.');
 if(err?.code==='ETIMEDOUT'||err?.level==='client-timeout')return new SshFailure('CONNECTION_TIMEOUT','Connection timed out. Check network or VPN.');
 if(err?.level==='client-authentication')return new SshFailure('AUTH_FAILED','Host rejected authentication. Check the username, account approval, credentials, and public-key enrollment.');
 return new SshFailure('UNKNOWN','SSH operation failed. Retry after checking local configuration and connectivity.');
}
export class SshConnectionService extends EventEmitter {
 private snapshot:Snapshot={selectedProfile:null,connection:null};private client?:Client;private attempt=0;private inFlight?:Promise<void>;private cancel?:()=>void;private editing=false;private stopping=false;private closing?:Promise<void>;private initializationError?:SshFailure;
 private registrationCancel?:()=>void;private registrationAttempt=0;private registrationClients=new Set<Client>();
 private pendingChallenge?:{sessionId:string;challengeId:string;finish:(answers:string[])=>void;timer:NodeJS.Timeout};private onboarding=false;
 constructor(readonly profiles:SshProfileRepository,readonly trust:HostKeyTrustStore,private keys:{inspect:(path:string)=>Promise<Inspection>;unlock:(path:string,passphrase:string)=>Promise<string>}=keyOperations,private clientFactory=()=>new Client(),private managedKeys?:AppManagedKeyStore){super()}
 private publish(){this.emit('snapshot',this.getSnapshot())}
 getSnapshot():Snapshot{return structuredClone(this.snapshot)}
 initialSnapshot(){if(this.initializationError)throw this.initializationError;return this.getSnapshot()}
 async initialize(){try{await this.trust.load();const d=await this.profiles.load();this.snapshot.selectedProfile=d.profiles.find(p=>p.id===d.selectedProfileId)||null;this.snapshot.connection=this.snapshot.selectedProfile?{profileId:this.snapshot.selectedProfile.id,status:'disconnected'}:null;this.initializationError=undefined;return this.getSnapshot()}catch{this.initializationError=new SshFailure('UNKNOWN','SSH configuration could not be loaded. Existing files were preserved. Back up and repair profiles.json / host-trust.json in the app userData/ssh directory, then restart.');throw this.initializationError}}
 listProfiles(){return this.profiles.list()}
 inspectPrivateKey(p:string):Promise<Inspection>{return this.keys.inspect(p)}
 listKeys():Promise<KeyMetadata[]>{if(!this.managedKeys)return Promise.resolve([]);return this.managedKeys.list()}
 generateKey(input:{label:string;username?:string;passphrase:string}):Promise<KeyMetadata>{if(!this.managedKeys)return Promise.reject(new SshFailure('UNKNOWN','App-managed key storage is unavailable.'));return this.managedKeys.generate(input)}
 addExternalKey(input:{label:string;username?:string;privateKeyPath:string}){if(!this.managedKeys)return Promise.reject(new SshFailure('UNKNOWN','SSH key storage is unavailable.'));return this.managedKeys.addExternal(input)}
 answerAuthChallenge(sessionId:string,challengeId:string,answers:string[]){const pending=this.pendingChallenge;if(!pending||pending.sessionId!==sessionId||pending.challengeId!==challengeId)fail('AUTH_FAILED','Authentication challenge expired. Retry registration.');if(!Array.isArray(answers)||answers.some(answer=>typeof answer!=='string'||answer.length>4096))fail('AUTH_FAILED','Invalid authentication response.');clearTimeout(pending.timer);this.pendingChallenge=undefined;this.emit('challenge',null);pending.finish(answers)}
 private clearChallenge(sessionId?:string){
  const pending=this.pendingChallenge;if(!pending||(sessionId&&pending.sessionId!==sessionId))return;
  clearTimeout(pending.timer);this.pendingChallenge=undefined;this.emit('challenge',null);pending.finish([]);
 }
 private forwardChallenges(client:Client,sessionId:string,active:()=>boolean){
  client.on('keyboard-interactive',(name,instructions,_language,prompts,finishChallenge)=>{
   if(!active()||prompts.length>16){finishChallenge([]);return}
   this.clearChallenge();
   const challengeId=randomUUID(),timer=setTimeout(()=>this.clearChallenge(sessionId),120000);
   this.pendingChallenge={sessionId,challengeId,finish:finishChallenge,timer};
   this.emit('challenge',{sessionId,challengeId,name:String(name||'').slice(0,1024),instructions:String(instructions||'').slice(0,8192),prompts:prompts.map(item=>({prompt:String(item.prompt||'').slice(0,4096),echo:!!item.echo}))} satisfies AuthChallenge);
  });
 }
 private registrationHostVerifier(profile:FormInput,setError:(error:SshFailure)=>void){return (key:Buffer)=>{try{const identity=hostIdentity(profile.host,profile.port,key),state=this.trust.check(identity);if(state==='match')return true;if(state==='unknown')this.snapshot.pendingHost=identity;setError(new SshFailure(state==='unknown'?'HOST_KEY_UNKNOWN':'HOST_KEY_CHANGED',state==='unknown'?'Unknown host. Verify the displayed fingerprint independently, trust it, then retry.':'SECURITY WARNING: saved host identity changed. Registration was blocked.'));this.publish();return false}catch{setError(new SshFailure('UNKNOWN','Invalid host public key.'));return false}}}
 async registerGenerated(input:{profile:FormInput;keyId:string;passphrase:string;password:string}):Promise<RegistrationResult>{
  if(this.onboarding||this.inFlight||this.editing||this.stopping||this.closing||['connected','connecting','disconnecting'].includes(this.snapshot.connection?.status||''))fail('UNKNOWN','Another SSH operation is in progress.');if(!this.managedKeys)fail('UNKNOWN','App-managed key storage is unavailable.');
  const profile=profileInput(input.profile),key=await this.managedKeys.get(input.keyId);if(profile.auth.method!=='private-key'||profile.auth.privateKeyPath!==key.privateKeyPath||profile.auth.keyId!==key.keyId||profile.auth.managed!==true)fail('KEY_INVALID','Generated key reference does not match this profile.');if(typeof input.password!=='string'||!input.password.length||input.password.length>4096)fail('AUTH_FAILED','Enter your UCInetID password for temporary registration.');
  const registrationToken=++this.registrationAttempt;const checkActive=()=>{if(this.stopping||registrationToken!==this.registrationAttempt)fail('SESSION_CLOSED','Key registration cancelled.');};
  this.onboarding=true;let privateKey:string|undefined,password=input.password;input.password='';const sessionId=randomUUID();let alreadyPresent=false,temporary:Client|undefined,verifiedClient:Client|undefined;
  try{privateKey=await this.keys.unlock(key.privateKeyPath,input.passphrase);input.passphrase='';checkActive();let hostError:SshFailure|undefined;const temp=this.clientFactory();temporary=temp;this.registrationClients.add(temp);
   await new Promise<void>((resolve,reject)=>{let settled=false;const timer=setTimeout(()=>finish(new SshFailure('CONNECTION_TIMEOUT','Registration timed out. Check network or VPN.')),180000);const finish=(error?:SshFailure)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve()};this.registrationCancel=()=>finish(new SshFailure('SESSION_CLOSED','Key registration cancelled.'));this.forwardChallenges(temp,sessionId,()=>registrationToken===this.registrationAttempt&&!this.stopping);temp.on('ready',()=>finish());temp.on('error',e=>finish(hostError||safeError(e)));temp.on('close',()=>finish(hostError||new SshFailure('SESSION_CLOSED','Registration session closed before authentication.')));try{temp.connect({host:profile.host,port:profile.port,username:profile.username,password,tryKeyboard:true,readyTimeout:180000,authHandler:['password','keyboard-interactive'],keepaliveInterval:15000,keepaliveCountMax:3,agentForward:false,hostVerifier:this.registrationHostVerifier(profile,error=>hostError=error)})}catch(e){finish(safeError(e))}});password='';checkActive();
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
   const candidate={...profile,id:profile.id||randomUUID()},verifyClient=this.clientFactory();verifiedClient=verifyClient;this.registrationClients.add(verifyClient);let verifyError:SshFailure|undefined;
   await new Promise<void>((resolve,reject)=>{let settled=false;const timer=setTimeout(()=>finish(new SshFailure('CONNECTION_TIMEOUT','Fresh key verification timed out. The generated key was retained for retry.')),25000);const finish=(error?:SshFailure)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve()};this.registrationCancel=()=>finish(new SshFailure('SESSION_CLOSED','Key registration cancelled.'));verifyClient.on('ready',()=>finish());verifyClient.on('error',e=>finish(verifyError||safeError(e)));verifyClient.on('close',()=>finish(verifyError||new SshFailure('SESSION_CLOSED','Fresh key verification closed before authentication.')));verifyClient.connect({host:candidate.host,port:candidate.port,username:candidate.username,privateKey,tryKeyboard:false,agentForward:false,readyTimeout:20000,keepaliveInterval:15000,keepaliveCountMax:3,authHandler:['publickey'],hostVerifier:this.registrationHostVerifier(candidate,error=>verifyError=error)})});
   checkActive();await this.managedKeys.associate(key.keyId,candidate.username);checkActive();const saved=await this.profiles.upsert(candidate);checkActive();this.client=verifyClient;this.registrationClients.delete(verifyClient);verifiedClient=undefined;
   const closed=()=>{if(this.client!==verifyClient)return;this.client=undefined;this.snapshot.connection={profileId:saved.id,status:'disconnected'};this.publish()};verifyClient.once('close',closed);verifyClient.once('end',closed);verifyClient.on('error',()=>{verifyClient.destroy();closed()});this.snapshot={selectedProfile:saved,connection:{profileId:saved.id,status:'connected',connectedAt:new Date().toISOString()}};this.publish();return {alreadyPresent,verified:true};
  }catch(e){const error=safeError(e);if(profile.id)this.snapshot.connection={profileId:profile.id,status:'error',error:{code:error.code,message:error.message}};this.publish();throw error}
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
  const token=++this.attempt;delete this.snapshot.pendingHost;this.snapshot.connection={profileId:id,status:'connecting'};this.publish();
  const run=(async()=>{
   let privateKey:string|undefined;
   try{
    if(p.auth.method==='private-key'){privateKey=await this.keys.unlock(p.auth.privateKeyPath,passphrase);passphrase='';}
    else if(typeof passphrase!=='string'||!passphrase.length||passphrase.length>4096)fail('PASSWORD_REQUIRED','Enter your account password to continue with Duo.');
    if(token!==this.attempt)fail('SESSION_CLOSED','Connection cancelled.');
    await new Promise<void>((resolve,reject)=>{
     const client=this.clientFactory();this.client=client;let ready=false,terminal=false;let hostError:SshFailure|undefined;
     const timer=setTimeout(()=>finish(new SshFailure('CONNECTION_TIMEOUT','Connection timed out.')),p.auth.method==='duo'?180000:25000);
     const finish=(error:SshFailure)=>{clearTimeout(timer);if(token!==this.attempt||terminal)return;terminal=true;reject(error);if(ready){this.snapshot.connection={profileId:id,status:'error',error:{code:error.code,message:error.message}};this.publish()}client.destroy();};
     this.cancel=()=>{clearTimeout(timer);reject(new SshFailure('SESSION_CLOSED','Connection cancelled.'))};
     client.on('ready',()=>{if(token!==this.attempt||terminal){client.destroy();return}clearTimeout(timer);ready=true;this.cancel=undefined;this.snapshot.connection={profileId:id,status:'connected',connectedAt:new Date().toISOString()};this.publish();resolve()});
     client.on('error',e=>finish(hostError||safeError(e)));
     const closed=()=>{clearTimeout(timer);if(token!==this.attempt)return;terminal=true;if(!ready)reject(hostError||new SshFailure('SESSION_CLOSED','SSH session closed before authentication.'));else if(this.snapshot.connection?.status==='connected'){this.snapshot.connection={profileId:id,status:'disconnected'};this.publish()}if(this.client===client)this.client=undefined};
     client.on('end',closed);client.on('close',closed);
     if(p.auth.method==='duo')this.forwardChallenges(client,`connection-${token}`,()=>token===this.attempt&&!terminal&&!ready);
     try{client.connect({host:p.host,port:p.port,username:p.username,...(p.auth.method==='private-key'?{privateKey,tryKeyboard:false,authHandler:['publickey']}:{password:passphrase,tryKeyboard:true,authHandler:['password','keyboard-interactive']}),readyTimeout:p.auth.method==='duo'?180000:20000,keepaliveInterval:15000,keepaliveCountMax:3,agentForward:false,hostVerifier:(key:Buffer)=>{
       if(token!==this.attempt)return false;
       try{const identity=hostIdentity(p.host,p.port,key),state=this.trust.check(identity);if(state==='match')return true;
        if(state==='unknown')this.snapshot.pendingHost=identity;
        hostError=new SshFailure(state==='unknown'?'HOST_KEY_UNKNOWN':'HOST_KEY_CHANGED',state==='unknown'?'Unknown host. Verify the displayed fingerprint independently with your administrator, then trust and retry.':'SECURITY WARNING: host identity changed. Connection blocked. Contact your administrator; do not replace trust based on this connection.');return false;
       }catch{hostError=new SshFailure('UNKNOWN','Invalid host public key.');return false}
      }});
     }catch(e){finish(safeError(e))}
    });
   }catch(e){const error=safeError(e);if(token===this.attempt){this.snapshot.connection=['PASSWORD_REQUIRED','PASSPHRASE_REQUIRED'].includes(error.code)?{profileId:id,status:'disconnected'}:{profileId:id,status:'error',error:{code:error.code,message:error.message}};this.publish()}throw error}
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
  const previousAttempt=this.attempt;++this.attempt;this.clearChallenge(`connection-${previousAttempt}`);this.cancel?.();this.cancel=undefined;const pending=this.inFlight;const client=this.client;this.client=undefined;
  this.snapshot.connection={profileId:id,status:'disconnecting'};this.publish();
  if(client)await new Promise<void>(resolve=>{const timer=setTimeout(()=>{client.destroy();resolve()},750);client.once('close',()=>{clearTimeout(timer);resolve()});client.end()});
  await pending?.catch(()=>{});
  this.snapshot.connection={profileId:id,status:'disconnected'};delete this.snapshot.pendingHost;this.publish();
 }
  async exec(command:string, input:Buffer, timeoutMs = 30000) {
    if (!this.client || this.snapshot.connection?.status !== 'connected') fail('SESSION_CLOSED', 'Connect SSH before running remote work.');
    if (typeof command !== 'string' || !command || command.length > 131072 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60 * 1000) {
      fail('UNKNOWN', 'Invalid SSH execution request.');
    }
    const client = this.client;
    return new Promise<{returncode:number;signal:string|null;stdout:Buffer;stderr:Buffer}>((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) { reject(safeError(error)); return; }
        const stdout:Buffer[] = [], stderr:Buffer[] = [];
        let size = 0, finished = false;
        const timer = setTimeout(() => { stream.close(); done(new SshFailure('CONNECTION_TIMEOUT', 'The remote command timed out.')); }, timeoutMs);
        const collect = (target:Buffer[]) => (chunk:Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024 * 1024) { stream.close(); done(new SshFailure('UNKNOWN', 'Remote output exceeded 1 GiB.')); }
          else target.push(Buffer.from(chunk));
        };
        const done = (failure:SshFailure|null, code = 255, signal:string|null = null) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          failure ? reject(failure) : resolve({returncode: Number.isInteger(code) ? code : 255, signal,
            stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr)});
        };
        stream.on('data', collect(stdout));
        stream.stderr.on('data', collect(stderr));
        stream.once('error', (error:Error) => done(safeError(error)));
        stream.once('close', (code:number, signal:string|null) => done(null, code, signal));
        if (input?.length) stream.end(input); else stream.end();
      });
    });
  }

 cancelRegistration(){++this.registrationAttempt;this.registrationCancel?.();for(const client of this.registrationClients)client.destroy();this.clearChallenge()}
 async shutdown(){this.stopping=true;this.cancelRegistration();if(this.snapshot.selectedProfile)await this.disconnect(this.snapshot.selectedProfile.id)}
}
