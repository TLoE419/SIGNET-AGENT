'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Registry}=require('./registry.cjs');
const base=fs.realpathSync(process.env.SIGNET_S6_INDEX_TEST_ROOT||require('node:os').tmpdir()),hash='a'.repeat(64),other='b'.repeat(64),copy=x=>JSON.parse(JSON.stringify(x));
function root(t){const p=fs.mkdtempSync(path.join(base,'s6-index-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
function source(patch={}){return {subjectRef:'import-draft-one',sourceRef:{sourceId:'source-one',batchId:'batch-one',revision:1},packageHash:hash,a5Revision:1,parameters:{freq:0.5,ntop:2},networkHashes:{frequency:hash,coefficient:hash,positions:hash},sessionRef:'session-one',sessionHash:hash,manifestRef:'manifest-one',manifestHash:hash,officialHash:hash,containerHash:hash,evidence:{generationRef:null,loadRef:null,verificationRef:null,loadState:'unknown'},scientificStatus:'unknown',...patch};}
test('positive A5 revision maps once to opaque V6 ID and unknown survives cold reopen',async t=>{
 const p=root(t),r=new Registry({root:p,resolveSource:async()=>source()});
 const a=await r.register({sourceToken:'approved-one',requestId:'request-one'});assert.match(a.visualizationRevision,/^vr-/);assert.notEqual(a.visualizationRevision,'1');assert.match(a.analysisId,/^va-/);assert.equal(a.a5Revision,1);assert.equal(a.state,'unknown');assert.equal(a.url,null);
 const cold=new Registry({root:p,resolveSource:async()=>source()}),b=await cold.get({analysisId:a.analysisId,visualizationRevision:a.visualizationRevision});assert.equal(b.visualizationRevision,a.visualizationRevision);assert.equal(b.evidence.loadState,'unknown');assert.equal(b.state,'unknown');assert.equal(b.url,null);
});
module.exports={root,source,copy,hash,other};
test('cold same-revision parameter/hash/evidence drift never overwrites original mapping',async t=>{
 const p=root(t);let current=source();const r=new Registry({root:p,resolveSource:async()=>current}),first=await r.register({sourceToken:'approved-one',requestId:'request-one'}),file=path.join(p,'registry.json'),bytes=fs.readFileSync(file);
 for(const patch of [{packageHash:other},{parameters:{freq:1,ntop:2}},{parameters:{freq:0.5,ntop:3}},{networkHashes:{frequency:other,coefficient:hash,positions:hash}},{sessionHash:other},{manifestHash:other},{officialHash:other},{containerHash:other},{sessionRef:'other-session'},{manifestRef:'other-manifest'},{evidence:{generationRef:'new-proof',loadRef:null,verificationRef:null,loadState:'unknown'}}]){
  current=source(patch);const cold=new Registry({root:p,resolveSource:async()=>current});await assert.rejects(cold.register({sourceToken:'approved-one',requestId:'new-request'}),/REVISION_IMMUTABLE/);assert.deepEqual(fs.readFileSync(file),bytes);
 }
 current=source();assert.equal((await r.get({analysisId:first.analysisId,visualizationRevision:first.visualizationRevision})).url,null);
});
test('new positive revision allocates stable new ID and refuses old session/manifest or different source batch',async t=>{
 const p=root(t);let current=source();const r=new Registry({root:p,resolveSource:async()=>current}),a=await r.register({sourceToken:'approved-one',requestId:'request-one'});
 current=source({a5Revision:2,packageHash:other,parameters:{freq:1,ntop:2}});await assert.rejects(r.register({sourceToken:'approved-one',requestId:'request-two'}),/REFERENCE_REUSED/);
 current.sessionRef='session-two';await assert.rejects(r.register({sourceToken:'approved-one',requestId:'request-two'}),/REFERENCE_REUSED/);current.manifestRef='manifest-two';
 const b=await r.register({sourceToken:'approved-one',requestId:'request-two'});assert.equal(b.analysisId,a.analysisId);assert.notEqual(b.visualizationRevision,a.visualizationRevision);
 current=source({a5Revision:3,sourceRef:{sourceId:'source-one',batchId:'other-batch',revision:1}});await assert.rejects(r.register({sourceToken:'approved-one',requestId:'request-three'}),/SUBJECT_SOURCE_MISMATCH/);
});
test('same request is idempotent, changed source payload conflicts and reads do not rewrite index',async t=>{
 const p=root(t);let current=source();const r=new Registry({root:p,resolveSource:async()=>current}),a=await r.register({sourceToken:'approved-one',requestId:'request-one'}),file=path.join(p,'registry.json'),bytes=fs.readFileSync(file),mtime=fs.statSync(file).mtimeMs;
 assert.equal((await r.register({sourceToken:'approved-one',requestId:'request-one'})).duplicate,true);await r.get({analysisId:a.analysisId,visualizationRevision:a.visualizationRevision});await r.list();assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(fs.statSync(file).mtimeMs,mtime);
 current=source({packageHash:other});await assert.rejects(r.register({sourceToken:'approved-one',requestId:'request-one'}),/REQUEST_CONFLICT/);
});
test('source revocation/replacement, extra caller path, invalid hashes and numeric revisions cannot grant access',async t=>{
 const p=root(t);let current=source();const r=new Registry({root:p,resolveSource:async()=>current}),a=await r.register({sourceToken:'approved-one',requestId:'request-one'}),request={analysisId:a.analysisId,visualizationRevision:a.visualizationRevision};
 current=source({sourceRef:{sourceId:'other-source',batchId:'batch-one',revision:1}});await assert.rejects(r.get(request),/SOURCE_CHANGED/);current=null;await assert.rejects(r.get(request),/SOURCE_UNAUTHORIZED/);
 await assert.rejects(r.register({sourceToken:'approved-one',requestId:'r',path:'/private'}),/SCHEMA_INVALID/);
 for(const patch of [{a5Revision:'1'},{a5Revision:0},{a5Revision:1.5},{packageHash:'bad'},{networkHashes:{frequency:hash,coefficient:hash}},{evidence:{generationRef:null,loadRef:null,verificationRef:null,loadState:'loaded'}}]){
  current=source(patch);await assert.rejects(r.register({sourceToken:'approved-one',requestId:'r'}),/SCHEMA_INVALID|EVIDENCE_INVALID/);
 }
});
test('truncated/corrupt hash/symlink index refuses and never resets immutable records',async t=>{
 const p=root(t),r=new Registry({root:p,resolveSource:async()=>source()});await r.register({sourceToken:'approved-one',requestId:'request-one'});const f=path.join(p,'registry.json'),bytes=fs.readFileSync(f);
 fs.writeFileSync(f,bytes.subarray(0,30));await assert.rejects(r.list(),/STATE_INVALID/);assert.equal(fs.readFileSync(f).length,30);
 const envelope=JSON.parse(bytes);envelope.sha256='0'.repeat(64);fs.writeFileSync(f,JSON.stringify(envelope));await assert.rejects(r.list(),/STATE_INVALID/);
 fs.unlinkSync(f);const target=path.join(p,'target');fs.writeFileSync(target,bytes);fs.symlinkSync(target,f);await assert.rejects(r.list(),/STATE_INVALID/);
});
test('bounded 128 revisions persist across reopen and old entries remain immutable',async t=>{
 const p=root(t);let current;const r=new Registry({root:p,resolveSource:async()=>current});let first;
 for(let i=1;i<=128;i++){current=source({a5Revision:i,sessionRef:'session-'+i,manifestRef:'manifest-'+i});const x=await r.register({sourceToken:'approved-one',requestId:'request-'+i});first??=x;}
 current=source({a5Revision:129,sessionRef:'session-129',manifestRef:'manifest-129'});await assert.rejects(new Registry({root:p,resolveSource:async()=>current}).register({sourceToken:'approved-one',requestId:'request-129'}),/ENTRY_LIMIT/);
 assert.equal((await r.list()).records.length,128);current=source({a5Revision:1,sessionRef:'session-1',manifestRef:'manifest-1'});assert.equal((await r.get({analysisId:first.analysisId,visualizationRevision:first.visualizationRevision})).visualizationRevision,first.visualizationRevision);
});
test('source timeout releases only own operation lock and late authority cannot commit',async t=>{
 const p=root(t);let resolve;const gate=new Promise(r=>resolve=r),r=new Registry({root:p,resolveSource:()=>gate,sourceTimeoutMs:10});
 await assert.rejects(r.register({sourceToken:'approved-one',requestId:'request-one'}),/SOURCE_TIMEOUT/);resolve(source());await new Promise(r=>setImmediate(r));assert.equal(fs.existsSync(path.join(p,'registry.json')),false);assert.equal(fs.existsSync(path.join(p,'registry.lock')),false);
});
test('root lock replacement during authority await refuses write and never deletes replacement lock',async t=>{
 const p=root(t);let release,calls=0;const gate=new Promise(r=>release=r),r=new Registry({root:p,resolveSource:async()=>{calls++;if(calls===1)await gate;return source();}}),pending=r.register({sourceToken:'approved-one',requestId:'request-one'});await new Promise(r=>setImmediate(r));
 const lock=path.join(p,'registry.lock');fs.renameSync(lock,path.join(p,'original-lock'));fs.writeFileSync(lock,'FOREIGN');release();await assert.rejects(pending,/LOCK_REPLACED/);assert.equal(fs.readFileSync(lock,'utf8'),'FOREIGN');assert.equal(fs.existsSync(path.join(p,'registry.json')),false);
});
test('failed publish leaves old committed index intact and a cold reader sees no half revision',async t=>{
 const p=root(t),normal=new Registry({root:p,resolveSource:async()=>source()});await normal.register({sourceToken:'approved-one',requestId:'request-one'});const bytes=fs.readFileSync(path.join(p,'registry.json'));
 const failing=new Registry({root:p,resolveSource:async()=>source({a5Revision:2,sessionRef:'session-two',manifestRef:'manifest-two'}),beforePublish:()=>{throw Error('injected-write-failure');}});
 await assert.rejects(failing.register({sourceToken:'approved-one',requestId:'request-two'}),/injected-write-failure/);assert.deepEqual(fs.readFileSync(path.join(p,'registry.json')),bytes);assert.equal((await normal.list()).records.length,1);assert.equal(fs.existsSync(path.join(p,'registry.lock')),false);
});
test('same-inode operation lock content replacement is not mistaken for the original owned lock',async t=>{
 const p=root(t);let release;const gate=new Promise(r=>release=r),r=new Registry({root:p,resolveSource:async()=>{await gate;return source();}}),pending=r.register({sourceToken:'approved-one',requestId:'request-one'});await new Promise(r=>setImmediate(r));
 const lock=path.join(p,'registry.lock');fs.writeFileSync(lock,'FOREIGN-OWNER');release();await assert.rejects(pending,/LOCK_REPLACED/);assert.equal(fs.readFileSync(lock,'utf8'),'FOREIGN-OWNER');assert.equal(fs.existsSync(path.join(p,'registry.json')),false);
});
