import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EnvironmentService} from '../main/environment/EnvironmentService';
import {installEnvironmentHandlers} from '../main/environment/ipc';
import {installSource,installImage,probe,verify} from '../main/environment/scripts';
import type {SshConnectionService} from '../main/ssh/SshConnectionService';
import type {EnvironmentConfig} from '../shared/environment/types';
const inventory={repository:'https://github.com/signet4grn/SIGNET.git',revision:'a'.repeat(40),scripts:[{path:'signet',sha256:'b'.repeat(64)}],support_files:[]};
class FakeSsh extends EventEmitter {
 connected=true;source=false;image=false;slurm=true;runtimeModule='';failStep='';commands:string[]=[];pause?:()=>Promise<void>;
 getSnapshot(){return {selectedProfile:{id:'profile',username:'user',host:'host',port:22},connection:{status:this.connected?'connected':'disconnected',connectedAt:'now'}}}
 async exec(command:string,input:Buffer){assert.equal(command,'bash -s');const s=input.toString();this.commands.push(s);await this.pause?.();
  if(s.includes('printf \'home='))return {returncode:0,stderr:Buffer.alloc(0),stdout:Buffer.from(`home=/home/user\nroot=/home/user/signet\n${['bash','git','tar','sha256sum','timeout','python3','setsid','sbatch','scontrol','sinfo','squeue'].map(t=>`${t}=${t==='sbatch'&&!this.slurm?'no':'yes'}`).join('\n')}\nexecutor=/usr/bin/apptainer\nruntime_module=${this.runtimeModule}\npartition=standard\nwritable=yes\nsource=${this.source?'exists':'missing'}\nimage=${this.image?'exists':'missing'}\n`)};
  if(s.includes('git -C'))this.source=true;
  if(s.includes(' pull ')&&!this.failStep)this.image=true;
  return {returncode:this.failStep&&s.includes(this.failStep)?1:0,stdout:Buffer.alloc(0),stderr:Buffer.from(this.failStep&&s.includes(this.failStep)?'Download unavailable':'')};
 }
}
async function fixture(t:any){const dir=await mkdtemp(path.join(tmpdir(),'signet-env-'));t.after(()=>rm(dir,{recursive:true,force:true}));const ssh=new FakeSsh(),file=path.join(dir,'settings.json'),service=new EnvironmentService(ssh as unknown as SshConnectionService,inventory,file);t.after(()=>service.dispose());return {ssh,service,file}}
test('checks require confirmation before downloading, install verifies then persists ready configuration',async t=>{
 const {ssh,service,file}=await fixture(t),phases:string[]=[],logs:any[]=[];service.on('snapshot',v=>phases.push(v.phase));ssh.on('diagnostic',v=>logs.push(v));
 assert.equal((await service.check()).phase,'needs-install');assert.equal(ssh.commands.length,1);
 assert.equal((await service.install()).phase,'ready');
 assert.ok(phases.includes('installing-source'));assert.ok(phases.includes('installing-image'));assert.ok(phases.includes('verifying'));
 assert.ok(logs.some(v=>v.stage==='environment:install-image'&&v.message.includes('Finished')));
 assert.equal(service.getSnapshot().config?.executor,'/usr/bin/apptainer');assert.match(await readFile(file,'utf8'),/standard/);
});
test('missing Slurm blocks environment setup without disconnecting SSH',async t=>{const {ssh,service}=await fixture(t);ssh.slurm=false;assert.equal((await service.check()).phase,'blocked');assert.equal(ssh.connected,true);await assert.rejects(()=>service.install())});
test('failures stay actionable, never become ready and can be retried',async t=>{const {ssh,service}=await fixture(t);await service.check();ssh.failStep=' pull ';await assert.rejects(()=>service.install());assert.equal(service.getSnapshot().phase,'error');assert.equal(ssh.connected,true);ssh.failStep='';assert.equal((await service.check()).phase,'needs-install');assert.equal((await service.install()).phase,'ready')});
test('connection changes discard stale environment results',async t=>{
 const {ssh,service}=await fixture(t);let release!:()=>void;ssh.pause=()=>new Promise<void>(r=>{release=r});ssh.emit('snapshot');
 assert.equal(service.getSnapshot().phase,'checking');ssh.connected=false;ssh.emit('snapshot');release();await new Promise(r=>setTimeout(r,0));assert.equal(service.getSnapshot().phase,'disconnected');
});
test('invalid paths and unauthorized IPC never execute remote commands',async t=>{
 const {ssh,service}=await fixture(t);await assert.rejects(()=>service.check('/home/user/../other'));assert.equal(ssh.commands.length,0);
 const handlers=new Map<string,Function>();const dispose=installEnvironmentHandlers({handle:(n:string,f:Function)=>handlers.set(n,f),removeHandler:(n:string)=>handlers.delete(n)} as any,()=>null,service,()=> 'http://127.0.0.1:1');
 assert.equal((await handlers.get('environment:install')!({})).ok,false);assert.equal(ssh.commands.length,0);dispose();
});
test('installation scripts pin source and container and publish without replacing existing files',()=>{
 const c:EnvironmentConfig={root:'/home/user/signet',source:'/home/user/signet/software/rev',image:'/home/user/signet/images/signet.sif',executor:'/usr/bin/apptainer',workRoot:'/home/user/signet/runs',revision:inventory.revision,partition:'standard'};
 assert.match(installSource(c,inventory),/sha256sum --check --status/);assert.match(installSource(c,inventory),/git .* archive/);assert.doesNotMatch(installSource(c,inventory),/git pull/);
 assert.match(installImage(c),/library:\/\/jiang548\/signet\/signet:0.0.6/);assert.match(installImage(c),/ln "\$stage\/signet.sif"/);
 assert.doesNotMatch(probe('', '',inventory.revision),/mkdir|bashrc/);assert.match(verify(c),/sinfo -h -p 'standard'/);
});

test('generated remote commands have valid Bash syntax',async()=>{
 const {execFileSync}=await import('node:child_process');
 const c:EnvironmentConfig={root:'/home/user/signet',source:'/home/user/signet/software/rev',image:'/home/user/signet/images/signet.sif',executor:'/usr/bin/apptainer',workRoot:'/home/user/signet/runs',revision:inventory.revision,partition:'standard'};
 for(const script of [probe('', '',inventory.revision),installSource(c,inventory),installImage(c),verify(c)])execFileSync('/bin/bash',['-n'],{input:script});
});

test('environment retains a validated module descriptor and rejects unsafe remote module metadata',async t=>{
 const {ssh,service}=await fixture(t);ssh.runtimeModule='singularity/3.9.4';
 assert.equal((await service.check()).config?.runtimeModule,'singularity/3.9.4');
 ssh.runtimeModule='singularity/3.9.4; unsafe';
 await assert.rejects(()=>service.check(),/Invalid container runtime module/);
 assert.equal(service.getSnapshot().phase,'error');
});
