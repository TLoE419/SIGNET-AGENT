import {EventEmitter} from 'node:events';
import {spawn as spawnChild} from 'node:child_process';
import {mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import * as pty from 'node-pty';
import type {Profile} from '../../../shared/ssh/types';
import {SshFailure} from '../../../shared/ssh/validation';

export interface RemoteResult {returncode:number;signal:string|null;stdout:Buffer;stderr:Buffer}
export interface TransportChallenge {name:string;instructions:string;prompts:{prompt:string;echo:boolean}[];respond:(answers:string[])=>void}
export interface ShellChannel extends EventEmitter {
 stderr:EventEmitter;writableLength:number;write(data:string|Buffer):boolean;setWindow(rows:number,cols:number,height:number,width:number):void;
 pause():void;resume():void;end():void;destroy():void;
}
export interface SshTransport extends EventEmitter {
 connect(secret:string):Promise<void>;exec(command:string,input:Buffer,timeoutMs:number):Promise<RemoteResult>;
 openShell(cols:number,rows:number):Promise<ShellChannel>;close():Promise<void>;
}
type ReadinessProbe=()=>Promise<number>;
type PtyFactory=(file:string,args:string[],options:pty.IPtyForkOptions)=>pty.IPty;

function clean(value:string){return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\r/g,'')}
function configValue(value:string){
 if(/[\0\r\n]/.test(value))throw new SshFailure('UNKNOWN','Unsafe OpenSSH configuration path.');
 return `"${value.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`;
}
function failureFromOutput(text:string){
 if(/REMOTE HOST IDENTIFICATION HAS CHANGED|Offending .* key/i.test(text))return new SshFailure('HOST_KEY_CHANGED','SECURITY WARNING: saved host identity changed. Connection blocked.');
 if(/No .* host key is known|Host key verification failed/i.test(text))return new SshFailure('HOST_KEY_UNKNOWN','OpenSSH could not verify the saved host identity. Connection blocked.');
 if(/Permission denied|Authentication failed/i.test(text))return new SshFailure('AUTH_FAILED','HPC3 rejected authentication. Check the account password, Duo response, username, or SSH key.');
 if(/Could not resolve hostname/i.test(text))return new SshFailure('DNS_FAILED','The SSH host name could not be resolved. Check your internet connection and the host in Advanced connection settings.');
 if(/Connection refused|No route to host|Network is unreachable/i.test(text))return new SshFailure('NETWORK_UNREACHABLE','Cannot reach the SSH host. Connect to the UCI VPN or campus network, then retry.');
 if(/Operation timed out|Connection timed out/i.test(text))return new SshFailure('CONNECTION_TIMEOUT','The SSH connection timed out. Check your network or UCI VPN, then retry.');
 return new SshFailure('SESSION_CLOSED','The OpenSSH session closed before the login shell was ready.');
}

class AttachedShell extends EventEmitter implements ShellChannel {
 readonly stderr=new EventEmitter();writableLength=0;private active=true;
 constructor(private owner:OpenSshTransport,cols:number,rows:number){super();owner.resize(cols,rows)}
 write(data:string|Buffer){if(!this.active)return false;this.owner.write(typeof data==='string'?data:data.toString('utf8'));return true}
 setWindow(rows:number,cols:number){if(this.active)this.owner.resize(cols,rows)}
 pause(){}resume(){}
 end(){this.destroy()}
 destroy(){if(!this.active)return;this.active=false;this.owner.detach(this);this.emit('close')}
 push(data:string){if(this.active)this.emit('data',Buffer.from(data,'utf8'))}
}

export class OpenSshTransport extends EventEmitter implements SshTransport {
 private process?:pty.IPty;private exit?:Promise<void>;private finishExit?:()=>void;private ready=false;private closing=false;
 private secret='';private secretSubmitted=false;private challengeOpen=false;private text='';private history='';private shells=new Set<AttachedShell>();
 readonly controlDirectory:string;readonly controlPath:string;
 constructor(readonly profile:Profile,private knownHostsPath:string,controlRoot='/tmp',private ptyFactory:PtyFactory=pty.spawn,private readinessProbe?:ReadinessProbe,private spawnCommand=spawnChild){
  super();this.controlDirectory=path.join(controlRoot,`signet-ssh-${randomUUID()}`);this.controlPath=path.join(this.controlDirectory,'master.sock');
 }
 private args(){
  const common=['-tt','-M','-S',this.controlPath,'-o','ControlPersist=no','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${configValue(this.knownHostsPath)}`,'-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-o','ClearAllForwardings=yes','-p',String(this.profile.port)];
  const auth=this.profile.auth.method==='duo'?['-o','PubkeyAuthentication=no','-o','PreferredAuthentications=keyboard-interactive','-o','KbdInteractiveAuthentication=yes','-o','NumberOfPasswordPrompts=1']:['-o','IdentitiesOnly=yes','-o','PreferredAuthentications=publickey','-i',this.profile.auth.privateKeyPath];
  return [...common,...auth,'--',`${this.profile.username}@${this.profile.host}`];
 }
 async connect(secret:string){
  if(this.process)throw new SshFailure('UNKNOWN','SSH transport is already open.');
  await mkdir(this.controlDirectory,{recursive:true,mode:0o700});this.secret=secret;this.emit('diagnostic',{stage:'transport',message:`Opening PTY-backed system OpenSSH transport to ${this.profile.username}@${this.profile.host}:${this.profile.port}.`});
  return new Promise<void>((resolve,reject)=>{
   let settled=false;let probeTimer:ReturnType<typeof setInterval>|undefined;let probing=false;const done=(error?:SshFailure)=>{if(settled)return;settled=true;clearTimeout(timer);clearInterval(probeTimer);this.secret='';error?reject(error):resolve()};
   const timer=setTimeout(()=>{done(new SshFailure('CONNECTION_TIMEOUT','OpenSSH login timed out after three minutes. Check your network or UCI VPN and complete authentication before retrying.'));void this.close()},180000);
   try{this.process=this.ptyFactory('/usr/bin/ssh',this.args(),{name:'xterm-256color',cols:120,rows:40,cwd:process.cwd(),env:{...process.env,TERM:'xterm-256color'} as Record<string,string>})}catch(error){this.emit('diagnostic',{stage:'transport',message:`PTY launch failed: ${error instanceof Error?error.message:'unknown native error'}`});done(new SshFailure('UNKNOWN','System OpenSSH or PTY support is unavailable.'));return}
   this.exit=new Promise<void>(finish=>this.finishExit=finish);
   this.process.onData(data=>{this.consume(data);});
   this.process.onExit(({exitCode})=>{this.process=undefined;this.finishExit?.();this.finishExit=undefined;const wasReady=this.ready;this.ready=false;void rm(this.controlDirectory,{recursive:true,force:true}).catch(()=>{});this.emit('diagnostic',{stage:'closed',message:'OpenSSH transport closed.'});if(!settled)done(failureFromOutput(this.text+`\nexit=${exitCode}`));else if(wasReady&&!this.closing)this.emit('failure',new SshFailure('SESSION_CLOSED','OpenSSH transport closed unexpectedly.'));this.emit('close')});
   // The local mux control socket becomes usable after authentication. Probing it
   // neither starts another login nor relies on remote shell prompt formatting.
   const activePty=this.process;
   const check=async()=>{if(settled||probing||this.closing)return;probing=true;try{
    const code=await(this.readinessProbe?this.readinessProbe():this.control('check'));
    if(code===0&&!settled&&!this.closing&&this.process===activePty){this.ready=true;this.emit('diagnostic',{stage:'session',message:'Persistent PTY login shell opened.'});done()}
   }catch{}finally{probing=false}};
   probeTimer=setInterval(()=>void check(),150);void check();
  });
 }
 private consume(data:string){
  this.emit('raw',{source:'openssh-pty',text:data});this.history=(this.history+data).slice(-262144);for(const shell of this.shells)shell.push(data);
  if(this.ready)return;
  this.text=(this.text+clean(data)).slice(-65536);const tail=this.text;
  if(!this.secretSubmitted&&this.profile.auth.method==='duo'&&/Password:\s*$/i.test(tail)){
   this.secretSubmitted=true;this.emit('diagnostic',{stage:'authentication',message:'Answering HPC3 password challenge from transient memory.'});this.write(this.secret+'\r');this.secret='';return;
  }
  if(!this.secretSubmitted&&this.profile.auth.method==='private-key'&&/Enter passphrase for key[^:]*:\s*$/i.test(tail)){
   this.secretSubmitted=true;this.emit('diagnostic',{stage:'authentication',message:'Unlocking the selected SSH key through OpenSSH.'});this.write(this.secret+'\r');this.secret='';return;
  }
  const option=tail.match(/((?:Duo[^\n]*\n)?[\s\S]{0,8192}?Passcode or option \(1-(\d+)\):\s*)$/i);
  if(option&&!this.challengeOpen){
   this.challengeOpen=true;const prompt=option[1].slice(-8192);this.emit('diagnostic',{stage:'challenge',message:'HPC3 returned Duo choices. Complete the sign-in dialog.'});
   this.emit('challenge',{name:'Duo authentication',instructions:'Select the Duo destination returned by HPC3.',prompts:[{prompt,echo:true}],respond:(answers:string[])=>{if(!this.challengeOpen)return;this.challengeOpen=false;this.write((answers[0]||'')+'\r');this.emit('diagnostic',{stage:'challenge',message:'Authentication response submitted (contents omitted).'})}} satisfies TransportChallenge);return;
  }
  if(/Permission denied|Authentication failed/i.test(tail)){void this.close();return}

 }
 write(data:string){this.process?.write(data)}
 resize(cols:number,rows:number){if(this.process)this.process.resize(Math.max(2,Math.min(500,cols)),Math.max(2,Math.min(200,rows)))}
 detach(shell:AttachedShell){this.shells.delete(shell)}
 async openShell(cols:number,rows:number){
  if(!this.process||!this.ready)throw new SshFailure('SESSION_CLOSED','Connect SSH first.');const shell=new AttachedShell(this,cols,rows);this.shells.add(shell);setImmediate(()=>{if(this.shells.has(shell)&&this.history)shell.push(this.history)});return shell;
 }
 async exec(command:string,input:Buffer,timeoutMs:number):Promise<RemoteResult>{
  if(!this.process||!this.ready)throw new SshFailure('SESSION_CLOSED','Connect SSH before running remote work.');
  const args=['-S',this.controlPath,'-o','ControlMaster=no','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${configValue(this.knownHostsPath)}`,'-p',String(this.profile.port),'--',`${this.profile.username}@${this.profile.host}`,command];
  return new Promise((resolve,reject)=>{const child=this.spawnCommand('/usr/bin/ssh',args,{stdio:['pipe','pipe','pipe']});const stdout:Buffer[]=[],stderr:Buffer[]=[];let size=0,settled=false,inputError=false;
   const done=(error?:SshFailure,code=255,signal:string|null=null)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve({returncode:code,signal,stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr)})};
   const collect=(target:Buffer[])=>(chunk:Buffer)=>{size+=chunk.length;if(size>1024*1024*1024){child.kill('SIGTERM');done(new SshFailure('UNKNOWN','Remote output exceeded 1 GiB.'))}else target.push(Buffer.from(chunk))};
   child.stdin.on('error',(error:NodeJS.ErrnoException)=>{inputError=true;if(error.code!=='EPIPE'){child.kill('SIGTERM');done(new SshFailure('UNKNOWN','Could not send input to the remote command.'))}});child.stdout.on('data',collect(stdout));child.stderr.on('data',collect(stderr));child.on('error',()=>done(new SshFailure('UNKNOWN','Could not start the system OpenSSH command.')));child.on('close',(code,signal)=>{if(inputError&&code===0)done(new SshFailure('UNKNOWN','Remote input was not fully delivered.'));else done(undefined,Number.isInteger(code)?code!:255,signal)});
   const timer=setTimeout(()=>{child.kill('SIGTERM');done(new SshFailure('CONNECTION_TIMEOUT','The remote command timed out.'))},timeoutMs);if(input.length)child.stdin.end(input);else child.stdin.end();
  });
 }
 private control(action:'check'|'exit',timeoutMs=3000){return new Promise<number>(resolve=>{const child=spawnChild('/usr/bin/ssh',['-S',this.controlPath,'-O',action,'-p',String(this.profile.port),'--',`${this.profile.username}@${this.profile.host}`],{stdio:'ignore'}),timer=setTimeout(()=>{child.kill('SIGTERM');resolve(255)},timeoutMs);child.on('error',()=>{clearTimeout(timer);resolve(255)});child.on('close',code=>{clearTimeout(timer);resolve(Number.isInteger(code)?code!:255)})})}
 async close(){
  if(this.closing)return this.exit||Promise.resolve();this.closing=true;this.challengeOpen=false;this.secret='';for(const shell of [...this.shells])shell.destroy();
  if(this.process){if(this.ready)await this.control('exit').catch(()=>255);const current=this.process;if(current){try{current.kill('SIGTERM')}catch{}await Promise.race([this.exit||Promise.resolve(),new Promise(resolve=>setTimeout(resolve,750))]);if(this.process)try{this.process.kill('SIGKILL')}catch{}}}
  await rm(this.controlDirectory,{recursive:true,force:true}).catch(()=>{});this.closing=false;
 }
}
