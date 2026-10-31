import {EventEmitter} from 'node:events';
import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {SshConnectionService} from '../ssh/SshConnectionService';
import type {EnvironmentConfig,EnvironmentSnapshot,EnvironmentPhase} from '../../shared/environment/types';
import {validRuntimeModule} from './runtimeModules';
import {probe,sourceCheck,installSource,installImage,verify,validRemotePath,type Inventory} from './scripts';

export class EnvironmentService extends EventEmitter {
 private snapshot:EnvironmentSnapshot={phase:'disconnected',message:'Connect SSH to prepare the remote environment.'};
 private generation=0;private connectionKey='';private running?:Promise<EnvironmentSnapshot>;
 private settings:Record<string,{root:string;partition:string}>={};
 private sessionKey='';
 constructor(private ssh:SshConnectionService,private inventory:Inventory,private file:string){super();ssh.on('snapshot',this.observe)}
 async load(){try{const value=JSON.parse(await readFile(this.file,'utf8'));if(value&&typeof value==='object'&&!Array.isArray(value))for(const [key,item] of Object.entries(value)){const v=item as {root?:unknown;partition?:unknown};if(v&&typeof v.root==='string'&&validRemotePath(v.root)&&typeof v.partition==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v.partition))this.settings[key]={root:v.root,partition:v.partition}}}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')this.log('preferences','Saved environment preferences could not be loaded; using defaults.')}}
 getSnapshot(){return structuredClone(this.snapshot)}
 private log(stage:string,message:string){this.ssh.emit('diagnostic',{id:`environment-${this.generation}`,stage:`environment:${stage}`,message,time:new Date().toISOString()})}
 private set(phase:EnvironmentPhase,message:string,extra:Partial<EnvironmentSnapshot>={}){this.snapshot={...this.snapshot,...extra,phase,message};this.log(phase,message);this.emit('snapshot',this.getSnapshot())}
 private observe=()=>{
  const s=this.ssh.getSnapshot(),c=s.connection,p=s.selectedProfile;
  if(!p||c?.status!=='connected'){
   if(this.connectionKey){this.connectionKey='';this.generation++;this.running=undefined;this.snapshot={phase:'disconnected',message:'Connect SSH to prepare the remote environment.'};this.emit('snapshot',this.getSnapshot())}
   return;
  }
  const key=`${p.id}:${c.connectedAt}`;
  if(key===this.connectionKey)return;
  this.connectionKey=key;this.sessionKey=JSON.stringify([p.username,p.host,p.port]);this.generation++;this.running=undefined;
  const saved=this.settings[this.sessionKey];void this.check(saved?.root,saved?.partition).catch(()=>{});
 };
 private active(token:number){if(token!==this.generation||this.ssh.getSnapshot().connection?.status!=='connected')throw Error('SSH connection changed. Reconnect and check the environment again.')}
 private async command(script:string,token:number,step:string,timeout=30000){
  this.active(token);const start=Date.now();this.log(step,'Started.');
  const result=await this.ssh.exec('bash -s',Buffer.from(script),timeout).catch(error=>{this.log(step,`Failed after ${Date.now()-start} ms: ${(error as Error).message}`);throw error});this.active(token);
  this.log(step,`Finished in ${Date.now()-start} ms; exit=${result.returncode}.`);
  if(result.stderr.length)this.log(step,result.stderr.toString('utf8').slice(-4096).replace(/[\x00-\x08\x0b-\x1f\x7f]/g,''));
  if(result.returncode!==0)throw Error(`${step} failed (exit ${result.returncode}). Review development diagnostics or choose another installation root.`);
  return result.stdout.toString('utf8');
 }
 private run(action:(token:number)=>Promise<void>){
  if(this.running)return this.running;
  const token=this.generation;
  const run=(async()=>{try{await action(token)}catch(e){if(token===this.generation)this.set('error',(e as Error).message);throw e}return this.getSnapshot()})();
  this.running=run;void run.finally(()=>{if(this.running===run)this.running=undefined}).catch(()=>{});return run;
 }
 check(root='',partition=''){
  if(this.ssh.getSnapshot().connection?.status!=='connected')return Promise.reject(Error('Connect SSH before checking the environment.'));
  if(root&&!validRemotePath(root))return Promise.reject(Error('Use an absolute installation path containing letters, numbers, _, -, . or /.'));
  if(partition&&!/^[A-Za-z0-9_-]{1,80}$/.test(partition))return Promise.reject(Error('Invalid Slurm partition.'));
  return this.run(token=>this.inspect(root,partition,token));
 }
 private async inspect(root:string,partition:string,token:number){
  this.set('checking','Checking remote paths, SIGNET, container runtime and Slurm.',{config:undefined,missing:undefined,checkedAt:undefined});
  const output=await this.command(probe(root,partition,this.inventory.revision),token,'probe');
  const values=Object.fromEntries(output.trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)]}));
  if(!validRemotePath(values.root||''))throw Error('The remote installation path is unsupported. Choose an absolute path without spaces.');
  if(values.runtime_module&&!validRuntimeModule(values.runtime_module))throw Error('Invalid container runtime module returned by remote check.');
  const config:EnvironmentConfig={...(values.runtime_module?{runtimeModule:values.runtime_module}:{}),root:values.root,source:`${values.root}/software/${this.inventory.revision}`,image:`${values.root}/images/signet-0.0.6.sif`,workRoot:`${values.root}/runs`,executor:values.executor,revision:this.inventory.revision,partition:values.partition};
  const missing=['bash','tar','sha256sum','timeout','python3','setsid','sbatch','scontrol','sinfo','squeue'].filter(tool=>values[tool]!=='yes');
  if(values.source==='missing'&&values.git!=='yes')missing.push('git');
  if(!validRemotePath(config.executor||''))missing.push('Singularity or Apptainer');
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(config.partition||''))missing.push('Slurm partition (select one)');
  if(values.writable!=='yes')missing.push('Writable installation root');
  if(missing.length){this.set('blocked',`Missing prerequisites: ${missing.join(', ')}.`,{config,missing});return}
  if(values.source==='exists')await this.command(`set -e\n${sourceCheck(config,this.inventory)}`,token,'source-integrity');
  const absent=[...(values.source==='missing'?['SIGNET source']:[]),...(values.image==='missing'?['SIGNET container']:[])];
  if(absent.length){this.set('needs-install',`Installation required: ${absent.join(', ')}.`,{config,missing:absent});return}
  this.set('verifying','Validating SIGNET and container tools; checking the Slurm partition.',{config,missing:[]});
  await this.command(verify(config),token,'runtime-verification',120000);
  this.active(token);const sessionKey=this.sessionKey;await mkdir(path.dirname(this.file),{recursive:true,mode:0o700});this.active(token);
  const settings={...this.settings,[sessionKey]:{root:config.root,partition:config.partition}},temporary=this.file+'.'+randomUUID()+'.tmp';
  try{await writeFile(temporary,JSON.stringify(settings,null,2)+'\n',{mode:0o600,flag:'wx'});this.active(token);await rename(temporary,this.file);this.active(token);this.settings=settings}finally{await unlink(temporary).catch(()=>{})}
  this.set('ready','SIGNET environment verified. Analysis inputs and job resources are checked separately.',{config,missing:[],checkedAt:new Date().toISOString()});
 }
 install(){
  if(this.running)return Promise.reject(Error('An environment operation is already running.'));
  if(this.snapshot.phase!=='needs-install'||!this.snapshot.config)return Promise.reject(Error('Check the remote environment before installing.'));
  const c=structuredClone(this.snapshot.config),missing=this.snapshot.missing||[];
  return this.run(async token=>{
   if(missing.includes('SIGNET source')){this.set('installing-source','Downloading and verifying the pinned SIGNET source.');await this.command(installSource(c,this.inventory),token,'install-source',600000)}
   if(missing.includes('SIGNET container')){this.set('installing-image','Downloading SIGNET container 0.0.6. This may take several minutes.');await this.command(installImage(c),token,'install-image',1800000)}
   await this.inspect(c.root,c.partition,token);
  });
 }
 dispose(){this.generation++;this.ssh.off('snapshot',this.observe);this.removeAllListeners()}
}
