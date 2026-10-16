'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {SourceBroker}=require('./source-broker.cjs');
function fixture(t){const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'network-folder-'))),root=path.join(base,'runtime'),source=path.join(base,'source');fs.mkdirSync(root);fs.mkdirSync(source);const files={'signet_Afreq':'0,0.5\n1,0\n','signet_CoeffMat0':'0,-0.2\n1,0\n','signet_net.genepos':'A chr1 10 20\nB chr1 30 40\n'};for(const [n,b] of Object.entries(files))fs.writeFileSync(path.join(source,n),b);const broker=new SourceBroker(root);t.after(()=>{broker.close();fs.rmSync(base,{recursive:true,force:true});});return{broker,root,source,files};}
test('normal native folder approval imports three matrices without a hand-written package declaration',async t=>{const f=fixture(t),s=await f.broker.add(f.source),item=f.broker.authority().sources[0];assert(s.sourceToken);assert.equal(item.grant.kind,'external');assert(!fs.existsSync(path.join(f.source,'signet-package.json')));const p=await f.broker.validate(f.broker.entries[0]);assert.equal(p.grant.manifest.artifacts.length,3);assert.equal(p.grant.manifest.visualization,null);});
test('bad matrices and revoked frame do not publish a derived package or authority',async t=>{const f=fixture(t);fs.writeFileSync(path.join(f.source,'signet_Afreq'),'2,0\n0,0\n');await assert.rejects(f.broker.add(f.source));assert.equal(f.broker.entries.length,0);fs.writeFileSync(path.join(f.source,'signet_Afreq'),f.files.signet_Afreq);await assert.rejects(f.broker.add(f.source,()=>{throw Error('reference_drift');}));assert.equal(f.broker.entries.length,0);assert(!fs.existsSync(path.join(f.root,'network-imports')));});

test('raw-folder adapter preserves original runtime and ancestor exclusions',async t=>{const f=fixture(t);await assert.rejects(f.broker.add(f.root),{code:'unsafe_path'});await assert.rejects(f.broker.add(path.dirname(f.root)),{code:'unsafe_path'});assert(!fs.existsSync(path.join(f.root,'network-imports')));assert.equal(f.broker.entries.length,0);});

function importedBatches(f){const root=path.join(f.root,'network-imports');return fs.existsSync(root)?fs.readdirSync(root).sort().map(name=>({name,files:fs.readdirSync(path.join(root,name)).sort().map(file=>({file,bytes:fs.readFileSync(path.join(root,name,file)).toString('hex')}))})):[];}
function rawSource(f,name,frequency){const dir=path.join(path.dirname(f.root),name);fs.mkdirSync(dir);for(const[n,b]of Object.entries({...f.files,signet_Afreq:`0,${frequency}\n1,0\n`}))fs.writeFileSync(path.join(dir,n),b);return dir;}
test('partial copied file is removed by identity, its FD closes and unchanged source retries',async t=>{
 const f=fixture(t),open=fs.openSync,write=fs.writeFileSync;let fd,injected=false;
 fs.openSync=function(file,...a){const value=Reflect.apply(open,this,[file,...a]);if(typeof file==='string'&&file.startsWith(path.join(f.root,'network-imports')+'/')&&file.endsWith('/signet_Afreq'))fd=value;return value;};
 fs.writeFileSync=function(file,bytes,...a){if(file===fd&&!injected){injected=true;fs.writeSync(file,bytes.subarray(0,1));throw Object.assign(Error('controlled partial copy'),{code:'ENOSPC'});}return Reflect.apply(write,this,[file,bytes,...a]);};
 try{await assert.rejects(f.broker.add(f.source),{code:'ENOSPC'});}finally{fs.openSync=open;fs.writeFileSync=write;}
 assert(injected);assert.throws(()=>fs.fstatSync(fd),{code:'EBADF'});assert.deepEqual(importedBatches(f),[]);assert.equal(f.broker.entries.length,0);
 const approved=await f.broker.add(f.source);assert(approved.sourceToken);for(const[n,b]of Object.entries(f.files))assert.equal(fs.readFileSync(path.join(f.source,n),'utf8'),b);
});
for(const check of [2,3])test(`authorization rejection at check ${check} rolls back only this new batch`,async t=>{
 const f=fixture(t);let calls=0;await assert.rejects(f.broker.add(f.source,()=>{if(++calls===check)throw Object.assign(Error('controlled revoked choice'),{code:'reference_drift'});}),{code:'reference_drift'});assert.equal(calls,check);assert.deepEqual(importedBatches(f),[]);assert.equal(f.broker.entries.length,0);assert((await f.broker.add(f.source)).sourceToken);
});
test('capacity refusals leave no new bytes, full reuse works and revoked token never revives',async t=>{
 const f=fixture(t),sources=[],tokens=[];for(let i=1;i<=8;i++){sources.push(rawSource(f,'raw-'+i,i/10));tokens.push((await f.broker.add(sources.at(-1))).sourceToken);}const before=importedBatches(f);
 for(let i=9;i<=11;i++)await assert.rejects(f.broker.add(rawSource(f,'raw-'+i,i/1000)),{code:'entry_limit'});
 assert.deepEqual(importedBatches(f),before);assert.equal((await f.broker.add(sources[0])).sourceToken,tokens[0]);assert.deepEqual(importedBatches(f),before);
 f.broker.revoke({sourceToken:tokens[0]});const next=await f.broker.add(sources[0]);assert.notEqual(next.sourceToken,tokens[0]);assert(!f.broker.authority().sources.some(s=>s.sourceToken===tokens[0]));assert.equal(f.broker.entries.filter(e=>!e.revoked).length,8);assert.deepEqual(importedBatches(f),before);
});
test('failed reapproval cannot remove a shared existing batch',async t=>{
 const f=fixture(t),first=await f.broker.add(f.source),before=importedBatches(f);let calls=0;await assert.rejects(f.broker.add(f.source,()=>{if(++calls===3)throw Object.assign(Error('controlled cancelled reapproval'),{code:'reference_drift'});}),{code:'reference_drift'});assert.deepEqual(importedBatches(f),before);assert.equal((await f.broker.add(f.source)).sourceToken,first.sourceToken);
});
test('rollback retains an unknown extra file rather than recursively removing the batch',async t=>{
 const f=fixture(t);let calls=0,unknown;await assert.rejects(f.broker.add(f.source,()=>{if(++calls===2){const parent=path.join(f.root,'network-imports'),batch=path.join(parent,fs.readdirSync(parent)[0]);unknown=path.join(batch,'foreign.keep');fs.writeFileSync(unknown,'retain unknown');throw Object.assign(Error('controlled cancel'),{code:'reference_drift'});}}),{code:'reference_drift'});assert.equal(fs.readFileSync(unknown,'utf8'),'retain unknown');assert.deepEqual(fs.readdirSync(path.dirname(unknown)),['foreign.keep']);assert.equal(f.broker.entries.length,0);
});
test('rollback leaves a different inode at a created file path untouched',async t=>{
 const f=fixture(t),foreign=path.join(path.dirname(f.root),'foreign');fs.writeFileSync(foreign,'foreign inode');const inode=fs.statSync(foreign).ino;let calls=0,replaced;
 await assert.rejects(f.broker.add(f.source,()=>{if(++calls===2){const parent=path.join(f.root,'network-imports');replaced=path.join(parent,fs.readdirSync(parent)[0],'signet_Afreq');fs.unlinkSync(replaced);fs.renameSync(foreign,replaced);throw Object.assign(Error('controlled replacement'),{code:'reference_drift'});}}),{code:'reference_drift'});assert.equal(fs.statSync(replaced).ino,inode);assert.equal(fs.readFileSync(replaced,'utf8'),'foreign inode');assert.equal(f.broker.entries.length,0);
});
test('rollback leaves a replaced parent directory and relocated old files untouched',async t=>{
 const f=fixture(t);let calls=0,replaced,moved;await assert.rejects(f.broker.add(f.source,()=>{if(++calls===2){const parent=path.join(f.root,'network-imports');replaced=path.join(parent,fs.readdirSync(parent)[0]);moved=path.join(path.dirname(f.root),'relocated');fs.renameSync(replaced,moved);fs.mkdirSync(replaced);fs.writeFileSync(path.join(replaced,'foreign.keep'),'new parent');throw Object.assign(Error('controlled parent replacement'),{code:'reference_drift'});}}),{code:'reference_drift'});assert.equal(fs.readFileSync(path.join(replaced,'foreign.keep'),'utf8'),'new parent');assert.equal(fs.readdirSync(moved).length,4);assert.equal(f.broker.entries.length,0);
});

test('lost broker lock ownership prevents rollback from removing possibly shared copies',async t=>{
 const f=fixture(t),savedLock=path.join(path.dirname(f.root),'owned-lock');let calls=0,batch;
 try{
  await assert.rejects(f.broker.add(f.source,()=>{if(++calls===2){const parent=path.join(f.root,'network-imports');batch=path.join(parent,fs.readdirSync(parent)[0]);fs.renameSync(f.broker.lock,savedLock);fs.writeFileSync(f.broker.lock,'foreign lock');throw Object.assign(Error('controlled loss of owner'),{code:'reference_drift'});}}),{code:'reference_drift'});
  assert.equal(fs.readFileSync(f.broker.lock,'utf8'),'foreign lock');assert.equal(fs.readdirSync(batch).length,4);assert.equal(f.broker.entries.length,0);
 }finally{if(fs.existsSync(savedLock)){fs.unlinkSync(f.broker.lock);fs.renameSync(savedLock,f.broker.lock);}}
});
