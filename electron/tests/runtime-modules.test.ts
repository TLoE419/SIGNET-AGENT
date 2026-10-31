import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {probe,installImage,verify} from '../main/environment/scripts';
import type {EnvironmentConfig} from '../shared/environment/types';
async function fixture(t:any){
 const root=await mkdtemp(path.join(tmpdir(),'signet-modules-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const bin=path.join(root,'runtime-bin'),log=path.join(root,'loads');await mkdir(bin);
 const runtime=path.join(bin,'singularity');
 await writeFile(runtime,`#!/bin/bash
[ "\${SIGNET_MODULE_LOADED:-}" = yes ] && [ "\${LD_LIBRARY_PATH:-}" = /fixture/lib ] || exit 73
case "$1" in
 --version) [ "\${SIGNET_TEST_RUNTIME_FAIL_VERSION:-no}" != yes ] || exit 72; echo fixture-singularity-3.9.4;;
 pull) printf image > "$2";;
 exec) exit 0;;
 *) exit 74;;
esac
`,{mode:0o700});
 const init=path.join(root,'modules.sh');
 await writeFile(init,`export MODULEPATH=/fixture/modules
module(){
 case "$1" in
  -t) if [ "\${SIGNET_TEST_MODULES:-yes}" = yes ] && [ "$3" = singularity ]; then printf '%s\\n' 'singularity/3.9.4' 'singularity/3.11.3'; fi; if [ \"\${SIGNET_TEST_APPTAINER:-no}\" = yes ] && [ \"$3\" = apptainer ]; then printf '%s\\n' 'apptainer/1.4.5'; fi;;
  load) printf '%s\\n' "$2" >> '${log}'; [ "\${SIGNET_TEST_FAIL_LOAD:-no}" != yes ] || return 1; export PATH='${bin}':"$PATH" SIGNET_MODULE_LOADED=yes LD_LIBRARY_PATH=/fixture/lib;;
 esac
}
`);
 const env={...process.env,HOME:root,BASH_ENV:init,PATH:'/usr/bin:/bin:/usr/sbin:/sbin'};
 const run=(script:string,extra:Record<string,string>={})=>spawnSync('/bin/bash',['-s'],{input:script,env:{...env,...extra},encoding:'utf8',timeout:10000});
 const config:EnvironmentConfig & {runtimeModule:string}={root,source:path.join(root,'source'),image:path.join(root,'images/image.sif'),executor:runtime,workRoot:path.join(root,'runs'),revision:'a'.repeat(40),partition:'standard',runtimeModule:'singularity/3.9.4'};
 return{root,bin,log,run,config};
}
const values=(text:string)=>Object.fromEntries(text.trim().split('\n').map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)]}));
test('probe loads an available versioned module instead of reporting the installed runtime missing',async t=>{
 const f=await fixture(t),result=f.run(probe(f.root,'standard','a'.repeat(40)));
 assert.equal(result.status,0,result.stderr);const found=values(result.stdout);
 assert.equal(found.executor,f.config.executor);assert.equal(found.runtime_module,'singularity/3.9.4');
 assert.equal((await readFile(f.log,'utf8')).trim(),'singularity/3.9.4');
});
test('image installation and verification reload the module in separate fresh shells',async t=>{
 const f=await fixture(t);await mkdir(f.config.source);await writeFile(path.join(f.config.source,'signet'),'fixture');
 await writeFile(path.join(f.bin,'sinfo'),'#!/bin/sh\necho standard\n',{mode:0o700});
 const installed=f.run(installImage(f.config));assert.equal(installed.status,0,installed.stderr);assert.equal(await readFile(f.config.image,'utf8'),'image');
 const verified=f.run(verify(f.config));assert.equal(verified.status,0,verified.stderr);
 assert.deepEqual((await readFile(f.log,'utf8')).trim().split('\n'),['singularity/3.9.4','singularity/3.9.4']);
});
test('missing or unloadable modules keep the runtime unresolved',async t=>{
 const f=await fixture(t);
 const failures:Record<string,string>[]=[{SIGNET_TEST_MODULES:'no'},{SIGNET_TEST_FAIL_LOAD:'yes'},{SIGNET_TEST_RUNTIME_FAIL_VERSION:'yes'}];
 for(const extra of failures){
  const result=f.run(probe(f.root,'standard','a'.repeat(40)),extra);
  assert.equal(result.status,0,result.stderr);assert.equal(values(result.stdout).executor,'');
 }
});
test('an already available runtime needs no module operation',async t=>{
 const f=await fixture(t),result=f.run(probe(f.root,'standard','a'.repeat(40)),{PATH:f.bin+':/usr/bin:/bin',SIGNET_MODULE_LOADED:'yes',LD_LIBRARY_PATH:'/fixture/lib'});
 assert.equal(result.status,0,result.stderr);assert.equal(values(result.stdout).executor,f.config.executor);
 assert.equal(values(result.stdout).runtime_module,'');await assert.rejects(readFile(f.log));
});
test('invalid module names cannot become generated shell code',async t=>{
 const f=await fixture(t);assert.throws(()=>installImage({...f.config,runtimeModule:'singularity/3.9.4; touch /tmp/unsafe'}),/module/i);
});

test('Apptainer versioned modules are discovered when Singularity is unavailable',async t=>{
 const f=await fixture(t);await rename(f.config.executor,path.join(f.bin,'apptainer'));
 const result=f.run(probe(f.root,'standard','a'.repeat(40)),{SIGNET_TEST_MODULES:'no',SIGNET_TEST_APPTAINER:'yes'});
 assert.equal(result.status,0,result.stderr);const found=values(result.stdout);
 assert.equal(found.executor,path.join(f.bin,'apptainer'));assert.equal(found.runtime_module,'apptainer/1.4.5');
});
