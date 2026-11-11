import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EnvironmentService} from '../main/environment/EnvironmentService';
import {installEnvironmentHandlers} from '../main/environment/ipc';
import {installSource,installExample,exampleCheck,probe,verify} from '../main/environment/scripts';
import type {SshConnectionService} from '../main/ssh/SshConnectionService';
import type {EnvironmentConfig} from '../shared/environment/types';
const inventory={repository:'https://github.com/signet4grn/SIGNET.git',revision:'a'.repeat(40),scripts:[{path:'signet',sha256:'b'.repeat(64)}],support_files:[],example_files:[{path:'example/geno/example.ped',sha256:'c'.repeat(64)}]};
class FakeSsh extends EventEmitter {
 connected=true;source=false;example=true;image=false;slurm=true;runtimeModule='';failStep='';commands:string[]=[];pause?:()=>Promise<void>;
 getSnapshot(){return {selectedProfile:{id:'profile',username:'user',host:'host',port:22},connection:{status:this.connected?'connected':'disconnected',connectedAt:'now'}}}
 async exec(command:string,input:Buffer){assert.equal(command,'bash -s');const s=input.toString();this.commands.push(s);await this.pause?.();
  if(s.includes('printf \'home='))return {returncode:0,stderr:Buffer.alloc(0),stdout:Buffer.from(`home=/home/user\nroot=/home/user/signet\n${['bash','git','tar','sha256sum','timeout','python3','setsid','sbatch','scontrol','sinfo','squeue'].map(t=>`${t}=${t==='sbatch'&&!this.slurm?'no':'yes'}`).join('\n')}\nexecutor=/usr/bin/apptainer\nruntime_module=${this.runtimeModule}\npartition=standard\nwritable=yes\nsource=${this.source?'exists':'missing'}\nexample=${this.source&&this.example?'exists':'missing'}\nimage=${this.image?'exists':'missing'}\n`)};
  if(s.includes('.example-XXXXXX')){if(!this.failStep)this.example=true}
  else if(s.includes('git -C')&&!this.failStep)this.source=true;
  return {returncode:this.failStep&&s.includes(this.failStep)?1:0,stdout:Buffer.alloc(0),stderr:Buffer.from(this.failStep&&s.includes(this.failStep)?'Download unavailable':'')};
 }
}
async function fixture(t:any){const dir=await mkdtemp(path.join(tmpdir(),'signet-env-'));t.after(()=>rm(dir,{recursive:true,force:true}));const ssh=new FakeSsh(),file=path.join(dir,'settings.json'),service=new EnvironmentService(ssh as unknown as SshConnectionService,inventory,file);t.after(()=>service.dispose());return {ssh,service,file}}
test('install adds only the source; a later check verifies the downloaded container and persists ready',async t=>{
 const {ssh,service,file}=await fixture(t),phases:string[]=[],logs:any[]=[];service.on('snapshot',v=>phases.push(v.phase));ssh.on('diagnostic',v=>logs.push(v));
 assert.equal((await service.check()).phase,'needs-install');assert.equal(ssh.commands.length,1);
 const installed=await service.install();assert.equal(installed.phase,'needs-install');assert.deepEqual(installed.missing,['SIGNET container']);
 assert.ok(phases.includes('installing-source'));assert.ok(logs.some(v=>v.stage==='environment:install-source'&&v.message.includes('Finished')));
 assert.equal(ssh.commands.some(s=>/ pull |library:\/\//.test(s)),false,'the login node must not download the container');
 await assert.rejects(()=>service.install(),/Workflow panel/);
 ssh.image=true;assert.equal((await service.check()).phase,'ready');assert.ok(phases.includes('verifying'));
 assert.equal(service.getSnapshot().config?.executor,'/usr/bin/apptainer');assert.match(await readFile(file,'utf8'),/standard/);
});
test('an installation made before the example data existed is offered only the example data',async t=>{
 const {ssh,service}=await fixture(t);ssh.source=true;ssh.example=false;
 const checked=await service.check();assert.equal(checked.phase,'needs-install');assert.deepEqual(checked.missing,['SIGNET example data','SIGNET container']);
 assert.doesNotMatch(ssh.commands.at(-1)!,/SIGNET_EXAMPLE_HASHES/,'a missing folder is installed, not reported as modified');
 const installed=await service.install();assert.deepEqual(installed.missing,['SIGNET container']);
 assert.ok(ssh.commands.some(s=>s.includes('.example-XXXXXX')));
 assert.equal(ssh.commands.some(s=>s.includes('mv -T -n "$stage/source" ')),false,'the existing source is never reinstalled');
 assert.match(ssh.commands.at(-1)!,/SIGNET_EXAMPLE_HASHES/,'the next check verifies the example data');
});
test('a fresh source installation includes and verifies the example data',()=>{
 const c:EnvironmentConfig={root:'/r',source:'/r/software/rev',image:'/r/images/s.sif',executor:'/usr/bin/apptainer',workRoot:'/r/runs',revision:inventory.revision,partition:'standard'};
 const script=installSource(c,inventory);
 assert.match(script,/archive .*'example\/geno\/example\.ped'/);assert.match(script,new RegExp('c'.repeat(64)+'  example/geno/example.ped'));
 assert.match(script,/SIGNET_EXAMPLE_HASHES/);
 assert.equal(exampleCheck(c,{...inventory,example_files:[]}),'true','an inventory without example data checks nothing');
});
test('example data is added to a real installation, verified, and never replaced',async t=>{
 const {execFileSync,spawnSync}=await import('node:child_process'),{mkdir,writeFile,readFile:read,chmod}=await import('node:fs/promises'),{createHash}=await import('node:crypto');
 const dir=await mkdtemp(path.join(tmpdir(),'signet-example-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const repo=path.join(dir,'upstream'),git=(...args:string[])=>execFileSync('git',['-C',repo,'-c','user.name=t','-c','user.email=t@t',...args],{encoding:'utf8'});
 await mkdir(path.join(repo,'example','geno'),{recursive:true});await writeFile(path.join(repo,'example','geno','example.ped'),'FAM1 IND1\n');await writeFile(path.join(repo,'signet'),'#!/bin/bash\n');
 git('init','-q');git('add','.');git('commit','-qm','fixture');git('config','uploadpack.allowAnySHA1InWant','true');
 const revision=git('rev-parse','HEAD').trim(),digest=createHash('sha256').update('FAM1 IND1\n').digest('hex');
 const local={repository:'file://'+repo,revision,scripts:[],support_files:[],example_files:[{path:'example/geno/example.ped',sha256:digest}]};
 const root=path.join(dir,'install'),c:EnvironmentConfig={root,source:`${root}/software/${revision}`,image:`${root}/images/s.sif`,executor:'/usr/bin/apptainer',workRoot:`${root}/runs`,revision,partition:'standard'};
 await mkdir(c.source,{recursive:true});await writeFile(path.join(c.source,'signet'),'kept');
 // HPC3 has GNU tools; these stand-ins give macOS the same behavior.
 const bin=path.join(dir,'bin');await mkdir(bin);await writeFile(path.join(bin,'mv'),'#!/bin/sh\nfor a in "$@"; do shift; [ "$a" = -T ] || set -- "$@" "$a"; done\nexec /bin/mv "$@"\n');await chmod(path.join(bin,'mv'),0o755);
 // macOS sha256sum lacks GNU --check/--status; shasum accepts the same lines and options.
 await writeFile(path.join(bin,'sha256sum'),'#!/bin/sh\nexec shasum -a 256 "$@"\n');await chmod(path.join(bin,'sha256sum'),0o755);
 const run=(script:string)=>spawnSync('/bin/bash',['-c',script],{encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`}});
 const first=run(installExample(c,local));assert.equal(first.status,0,first.stderr);
 assert.equal(await read(path.join(c.source,'example','geno','example.ped'),'utf8'),'FAM1 IND1\n');
 assert.equal(await read(path.join(c.source,'signet'),'utf8'),'kept','nothing already installed changes');
 const again=run(installExample(c,local));assert.notEqual(again.status,0);assert.match(again.stderr,/already exists/);
 await writeFile(path.join(c.source,'example','geno','example.ped'),'edited\n');
 assert.notEqual(run(exampleCheck(c,local)).status,0,'modified example data fails verification');
 const tampered={...local,example_files:[{path:'example/geno/example.ped',sha256:'0'.repeat(64)}]};
 await rm(path.join(c.source,'example'),{recursive:true});
 assert.notEqual(run(installExample(c,tampered)).status,0);await assert.rejects(read(path.join(c.source,'example','geno','example.ped')),'unverified data is never published');
});
test('missing Slurm blocks environment setup without disconnecting SSH',async t=>{const {ssh,service}=await fixture(t);ssh.slurm=false;assert.equal((await service.check()).phase,'blocked');assert.equal(ssh.connected,true);await assert.rejects(()=>service.install())});
test('failures stay actionable, never become ready and can be retried',async t=>{const {ssh,service}=await fixture(t);await service.check();ssh.failStep='git -C';await assert.rejects(()=>service.install());assert.equal(service.getSnapshot().phase,'error');assert.equal(ssh.connected,true);ssh.failStep='';assert.equal((await service.check()).phase,'needs-install');assert.equal((await service.install()).phase,'needs-install');ssh.image=true;assert.equal((await service.check()).phase,'ready')});
test('runtime verification failure never persists a ready configuration',async t=>{
 const {ssh,service,file}=await fixture(t);ssh.source=true;ssh.image=true;ssh.failStep='Rscript -e';
 const phases:string[]=[];service.on('snapshot',value=>phases.push(value.phase));
 await assert.rejects(()=>service.check(),/runtime-verification failed/);
 assert.equal(service.getSnapshot().phase,'error');assert.equal(phases.includes('ready'),false);
 await assert.rejects(readFile(file));
 ssh.failStep='';assert.equal((await service.check()).phase,'ready');
});
test('connection changes discard stale environment results',async t=>{
 const {ssh,service}=await fixture(t);let release!:()=>void;ssh.pause=()=>new Promise<void>(r=>{release=r});ssh.emit('snapshot');
 assert.equal(service.getSnapshot().phase,'checking');ssh.connected=false;ssh.emit('snapshot');release();await new Promise(r=>setTimeout(r,0));assert.equal(service.getSnapshot().phase,'disconnected');
});
test('invalid paths and unauthorized IPC never execute remote commands',async t=>{
 const {ssh,service}=await fixture(t);await assert.rejects(()=>service.check('/home/user/../other'));assert.equal(ssh.commands.length,0);
 const handlers=new Map<string,Function>();const dispose=installEnvironmentHandlers({handle:(n:string,f:Function)=>handlers.set(n,f),removeHandler:(n:string)=>handlers.delete(n)} as any,()=>null,service,()=> 'http://127.0.0.1:1');
 assert.equal((await handlers.get('environment:install')!({})).ok,false);assert.equal(ssh.commands.length,0);dispose();
});
test('source installation is pinned and probing changes nothing',()=>{
 const c:EnvironmentConfig={root:'/home/user/signet',source:'/home/user/signet/software/rev',image:'/home/user/signet/images/signet.sif',executor:'/usr/bin/apptainer',workRoot:'/home/user/signet/runs',revision:inventory.revision,partition:'standard'};
 assert.match(installSource(c,inventory),/sha256sum --check --status/);assert.match(installSource(c,inventory),/git .* archive/);assert.doesNotMatch(installSource(c,inventory),/git pull/);
 assert.doesNotMatch(probe('', '',inventory.revision),/mkdir|bashrc/);assert.match(verify(c),/sinfo -h -p 'standard'/);
});

test('the default root is the user /pub folder when writable, otherwise the home directory',async t=>{
 const {execFileSync}=await import('node:child_process'),{mkdir}=await import('node:fs/promises'),{userInfo}=await import('node:os');
 const dir=await mkdtemp(path.join(tmpdir(),'signet-root-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const rootOf=()=>/^root=(.*)$/m.exec(execFileSync('/bin/bash',['-s'],{input:probe('','',inventory.revision).replaceAll('/pub/',dir+'/pub/'),env:{...process.env,HOME:dir+'/home',MODULEPATH:''},encoding:'utf8'}))![1];
 await mkdir(dir+'/home');assert.equal(rootOf(),dir+'/home/.local/share/signet-agent');
 await mkdir(dir+'/pub/'+userInfo().username,{recursive:true});assert.equal(rootOf(),dir+'/pub/'+userInfo().username+'/signet-agent');
 assert.match(probe('/chosen/root','',inventory.revision),/root='\/chosen\/root'/);
});

test('generated remote commands have valid Bash syntax',async()=>{
 const {execFileSync}=await import('node:child_process');
 const c:EnvironmentConfig={root:'/home/user/signet',source:'/home/user/signet/software/rev',image:'/home/user/signet/images/signet.sif',executor:'/usr/bin/apptainer',workRoot:'/home/user/signet/runs',revision:inventory.revision,partition:'standard'};
 for(const script of [probe('', '',inventory.revision),installSource(c,inventory),installExample(c,inventory),verify(c)])execFileSync('/bin/bash',['-n'],{input:script});
});

test('environment retains a validated module descriptor and rejects unsafe remote module metadata',async t=>{
 const {ssh,service}=await fixture(t);ssh.runtimeModule='singularity/3.9.4';
 assert.equal((await service.check()).config?.runtimeModule,'singularity/3.9.4');
 ssh.runtimeModule='singularity/3.9.4; unsafe';
 await assert.rejects(()=>service.check(),/Invalid container runtime module/);
 assert.equal(service.getSnapshot().phase,'error');
});
