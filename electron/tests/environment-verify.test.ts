import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access,symlink,rename} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {verify} from '../main/environment/scripts';
import type {EnvironmentConfig} from '../shared/environment/types';

const defaults='[basic]\ncohort = TCGA\n\n[network]\nnboots = 2\n';
async function fixture(t:any){
 const root=await mkdtemp(path.join(tmpdir(),'signet-settings-check-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),bin=path.join(root,'bin'),temp=path.join(root,'temporary');
 await Promise.all([mkdir(source),mkdir(bin),mkdir(temp)]);
 const executor=path.join(bin,'container');
 await writeFile(executor,'#!/bin/bash\nwhile [ "$#" -gt 0 ] && [ "$1" != bash ]; do shift; done\n[ "$#" -gt 0 ] || exit 90\nshift\nexec /bin/bash "$@"\n',{mode:0o700});
 for(const name of ['Rscript','ParaFly','getopt'])await writeFile(path.join(bin,name),'#!/bin/bash\nexit 0\n',{mode:0o700});
 await writeFile(path.join(bin,'sinfo'),'#!/bin/bash\nprintf "standard\\n"\n',{mode:0o700});
 const entry=path.join(source,'signet'),template=path.join(source,'config.ini.default'),config=path.join(source,'config.ini');
 // Reproduce the real upstream wrapper: its final exit masks a failed settings reader.
 await writeFile(entry,'#!/bin/bash\ncd "$(dirname "$0")"\nprintf "\\n"\ncat config.ini\nprintf "\\n"\nexit 0\n',{mode:0o700});
 await writeFile(template,defaults);
 const c:EnvironmentConfig={root,source,image:path.join(root,'image.sif'),executor,workRoot:path.join(root,'runs'),revision:'a'.repeat(40),partition:'standard'};
 const run=()=>spawnSync('/bin/bash',['-s'],{input:verify(c),encoding:'utf8',env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,TMPDIR:temp}});
 return {root,source,entry,template,config,c,run};
}

test('verification initializes a disposable config from defaults and leaves installed source unchanged',async t=>{
 const f=await fixture(t),result=f.run();
 assert.equal(result.status,0,result.stderr);
 assert.equal(result.stderr,'');
 assert.match(result.stdout,/cohort = TCGA/);
 await assert.rejects(access(f.config));
 assert.equal(await readFile(f.template,'utf8'),defaults);
});
test('a missing default and missing config cannot pass verification',async t=>{
 const f=await fixture(t);await rm(f.template);
 const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/config\.ini/);
 await assert.rejects(access(f.c.workRoot));
});
test('an existing empty config fails instead of being silently replaced',async t=>{
 const f=await fixture(t);await writeFile(f.config,'');
 const result=f.run();assert.notEqual(result.status,0);assert.equal(await readFile(f.config,'utf8'),'');
});
test('an empty default cannot initialize a usable configuration',async t=>{
 const f=await fixture(t);await writeFile(f.template,'');
 const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/config\.ini\.default/);
 await assert.rejects(access(f.config));
});
test('verification preserves an existing configuration and does not require its defaults',async t=>{
 const f=await fixture(t),custom='[basic]\ncohort = GTEx\n';await writeFile(f.config,custom);await rm(f.template);
 const result=f.run();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/cohort = GTEx/);
 assert.equal(await readFile(f.config,'utf8'),custom);
});
for(const output of ['', 'unexpected settings'])test(`upstream exit zero with ${output?'wrong':'missing'} settings output still fails`,async t=>{
 const f=await fixture(t);await writeFile(f.entry,`#!/bin/bash\nprintf '${output}\\n'\necho 'settings reader failed' >&2\nexit 0\n`,{mode:0o700});
 const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/settings/);
 await assert.rejects(access(f.c.workRoot));
});
test('a configuration symlink is rejected without writing outside the disposable copy',async t=>{
 const f=await fixture(t),outside=path.join(f.root,'untouched.ini');await symlink(outside,f.config);
 const result=f.run();assert.notEqual(result.status,0);await assert.rejects(access(outside));
});
test('a symlinked source cannot redirect config initialization into the installed source',async t=>{
 const f=await fixture(t),installed=path.join(f.root,'installed-source');
 await rename(f.source,installed);await symlink(installed,f.source);
 const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/copied directory/);
 await assert.rejects(access(path.join(installed,'config.ini')));
});
