'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Registry}=require('./registry.cjs'),{PersistentHost,Ownership}=require('./port-adapter.cjs');
const base=fs.realpathSync(process.env.SIGNET_S6_INDEX_TEST_ROOT||require('node:os').tmpdir()),hash='a'.repeat(64);
function root(t){const p=fs.mkdtempSync(path.join(base,'s6-port-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
function binding(){return {subjectRef:'draft-one',sourceRef:{sourceId:'source-one',batchId:'batch-one',revision:1},packageHash:hash,a5Revision:1,parameters:{freq:0.5,ntop:2},networkHashes:{frequency:hash,coefficient:hash,positions:hash},sessionRef:'session-one',sessionHash:hash,manifestRef:'manifest-one',manifestHash:hash,officialHash:hash,containerHash:hash,evidence:{generationRef:'synthetic-generation',loadRef:'synthetic-load',verificationRef:null,loadState:'loaded'},scientificStatus:'unknown'};}
function providers(calls={stopped:0}){return {verifySession:async({binding})=>({binding,generated:true,loadState:'loaded',sessionHash:hash}),start:({ownerId,token,birthId})=>({ownerId,token,birthId,port:43123,ready:async()=>({ownerId,token,birthId,port:43123,listening:true,httpOk:true,url:'http://127.0.0.1:43123/'}),stop:async()=>{calls.stopped++;}})};}
test('single logical coordinator journals a synthetic lease; a new coordinator never inherits ready URL',async t=>{
 const p=root(t),registry=new Registry({root:path.join(p,'index'),resolveSource:async()=>binding()}),r=await registry.register({sourceToken:'source-token',requestId:'request-one'}),request={analysisId:r.analysisId,visualizationRevision:r.visualizationRevision},calls={stopped:0};
 const a=new PersistentHost({root:path.join(p,'owner'),registry,providers:providers(calls)});assert.equal((await a.open(request)).state,'ready');
 const b=new PersistentHost({root:path.join(p,'owner'),registry,providers:providers()});assert.equal(b.status().url,null);assert.equal((await b.open(request)).state,'blocked');assert.equal(b.browserURL(),null);
 await a.shutdown();assert.equal(calls.stopped,1);assert.equal((await b.open(request)).state,'ready');await b.shutdown();assert.equal(fs.existsSync(path.join(p,'owner/owner.lock')),false);
});
test('unknown owner is never cleared or inferred dead from its port; only exact trusted synthetic reconciliation can clear',async t=>{
 const p=root(t),a=new Ownership({root:p});a.claim();const lease={analysisId:'va-test',visualizationRevision:'vr-test',ownerId:'host-test',token:'test-token',birthId:'lease-test',port:43123,pid:null,osBirthEvidence:null};a.reserve(lease);a.detach();
 const cold=new Ownership({root:p}),before=fs.readFileSync(path.join(p,'owner.lock'));assert.equal(cold.inspect().recovery,'incomplete');assert.equal(cold.inspect().url,null);assert.throws(()=>cold.claim(),/OWNER_BUSY/);
 const noProof=await cold.recover();assert.equal(noProof.state,'blocked');assert.deepEqual(fs.readFileSync(path.join(p,'owner.lock')),before);
 await assert.rejects(cold.recover(async ({owner,lease})=>({owner:{...owner,token:'foreign'},lease,outcome:'stopped',evidenceClass:'synthetic',evidenceRef:'fixture-check'})),/RECOVERY_UNKNOWN/);assert.deepEqual(fs.readFileSync(path.join(p,'owner.lock')),before);
 const recovered=await cold.recover(async ({owner,lease})=>({owner,lease,outcome:'stopped',evidenceClass:'synthetic',evidenceRef:'fixture-check'}));assert.equal(recovered.state,'unknown');assert.equal(recovered.url,null);assert.equal(recovered.recovery,'synthetic-contract-cleared');assert.equal(fs.existsSync(path.join(p,'owner.lock')),false);
 cold.claim();cold.release();
});
test('cleanup failure retains journal and blocks reopen; exact retry clears own lease and no foreign lease is stopped',async t=>{
 const p=root(t),registry=new Registry({root:path.join(p,'index'),resolveSource:async()=>binding()}),r=await registry.register({sourceToken:'source-token',requestId:'request-one'});let attempts=0;const port=providers(),start=port.start;
 port.start=input=>{const l=start(input);return {...l,stop:async()=>{attempts++;if(attempts===1)throw Error('synthetic-stop-failure');}};};
 const h=new PersistentHost({root:path.join(p,'owner'),registry,providers:port});await h.open({analysisId:r.analysisId,visualizationRevision:r.visualizationRevision});assert.equal((await h.close()).state,'blocked');assert.equal(h.browserURL(),null);assert.equal(h.inspectRecovery().recovery,'incomplete');
 assert.equal((await h.open({analysisId:r.analysisId,visualizationRevision:r.visualizationRevision})).error,'CLEANUP_UNKNOWN');assert.equal(attempts,1);assert.equal((await h.shutdown()).state,'stopped');assert.equal(attempts,2);assert.equal(fs.existsSync(path.join(p,'owner/owner.lock')),false);
});
test('missing providers never create a lease or recover unknown readiness; stored loaded evidence is not a service',async t=>{
 const p=root(t),registry=new Registry({root:path.join(p,'index'),resolveSource:async()=>binding()}),r=await registry.register({sourceToken:'source-token',requestId:'request-one'}),h=new PersistentHost({root:path.join(p,'owner'),registry});
 assert.equal((await h.open({analysisId:r.analysisId,visualizationRevision:r.visualizationRevision})).error,'PROVIDER_UNAVAILABLE');assert.equal(h.status().url,null);assert.equal(fs.existsSync(path.join(p,'owner/owner.lock')),false);await h.shutdown();
});
test('unproven RData generation/load never starts a synthetic service',async t=>{
 const p=root(t),registry=new Registry({root:path.join(p,'index'),resolveSource:async()=>binding()}),r=await registry.register({sourceToken:'source-token',requestId:'request-one'});let started=0;const port=providers();port.verifySession=async({binding})=>({binding,generated:false,loadState:'unknown',sessionHash:hash});port.start=()=>{started++;throw Error('forbidden');};
 const h=new PersistentHost({root:path.join(p,'owner'),registry,providers:port});assert.equal((await h.open({analysisId:r.analysisId,visualizationRevision:r.visualizationRevision})).error,'SESSION_UNVERIFIED');assert.equal(started,0);await h.shutdown();
});
test('old owner lock replacement blocks cleanup without calling stop or deleting the replacement',async t=>{
 const p=root(t),registry=new Registry({root:path.join(p,'index'),resolveSource:async()=>binding()}),r=await registry.register({sourceToken:'source-token',requestId:'request-one'}),calls={stopped:0},h=new PersistentHost({root:path.join(p,'owner'),registry,providers:providers(calls)});
 await h.open({analysisId:r.analysisId,visualizationRevision:r.visualizationRevision});const lock=path.join(p,'owner/owner.lock');fs.renameSync(lock,path.join(p,'owner/original-lock'));fs.writeFileSync(lock,'FOREIGN');
 assert.equal((await h.close()).state,'blocked');assert.equal(calls.stopped,0);assert.equal(fs.readFileSync(lock,'utf8'),'FOREIGN');assert.equal(h.browserURL(),null);
});
test('reserve is journaled before provider side effects and a thrown start leaves incomplete, never falsely cleaned',async t=>{
 const p=root(t),registry=new Registry({root:path.join(p,'index'),resolveSource:async()=>binding()}),r=await registry.register({sourceToken:'source-token',requestId:'request-one'}),port=providers();let seen;
 port.start=input=>{seen=JSON.parse(fs.readFileSync(path.join(p,'owner/journal.json'),'utf8')).body;assert.equal(seen.phase,'reserved');assert.equal(seen.lease.pid,null);assert.equal(seen.lease.osBirthEvidence,null);assert.equal(seen.lease.birthId,input.birthId);throw Error('start-outcome-unknown');};
 const h=new PersistentHost({root:path.join(p,'owner'),registry,providers:port});assert.equal((await h.open({analysisId:r.analysisId,visualizationRevision:r.visualizationRevision})).error,'CLEANUP_UNKNOWN');assert.equal(h.inspectRecovery().recovery,'incomplete');assert.equal((await h.shutdown()).state,'blocked');
});
test('journal truncation and cross-file partial owner acquisition stay incomplete and URL revoked',async t=>{
 const p=root(t),owner=new Ownership({root:p,beforePublish:()=>{throw Error('before-journal-publish');}});assert.throws(()=>owner.claim(),/before-journal-publish/);owner.detach();const cold=new Ownership({root:p});assert.equal(cold.inspect().state,'blocked');assert.equal(cold.inspect().url,null);await assert.rejects(cold.recover(async()=>({})),/RECOVERY_INCOMPLETE/);assert.equal(fs.existsSync(path.join(p,'owner.lock')),true);
 fs.writeFileSync(path.join(p,'journal.json'),'truncated');assert.equal(cold.inspect().recovery,'incomplete');assert.throws(()=>cold.claim(),/OWNER_OR_JOURNAL_INVALID/);
});
test('recovery proof races cannot clear a replaced owner lock',async t=>{
 const p=root(t),a=new Ownership({root:p});a.claim();a.detach();const cold=new Ownership({root:p});let release;const gate=new Promise(r=>release=r);const pending=cold.recover(async x=>{await gate;return {...x,outcome:'stopped',evidenceClass:'synthetic',evidenceRef:'synthetic-proof'};});await new Promise(r=>setImmediate(r));
 const lock=path.join(p,'owner.lock');fs.renameSync(lock,path.join(p,'old-owner'));fs.writeFileSync(lock,'foreign-owner');release();await assert.rejects(pending,/RECOVERY_RACE|STATE_INVALID/);assert.equal(fs.readFileSync(lock,'utf8'),'foreign-owner');
});
test('busy different revision request does not poison a healthy owned lease or cached navigation',async t=>{
 const p=root(t),registry=new Registry({root:path.join(p,'index'),resolveSource:async()=>binding()}),r=await registry.register({sourceToken:'source-token',requestId:'request-one'}),h=new PersistentHost({root:path.join(p,'owner'),registry,providers:providers()}),request={analysisId:r.analysisId,visualizationRevision:r.visualizationRevision};
 assert.equal((await h.open(request)).state,'ready');const busy=await h.open({...request,visualizationRevision:'vr-other'});assert.equal(busy.error,'HOST_BUSY');assert.equal(h.status().state,'ready');assert.equal(h.canNavigate('http://127.0.0.1:43123/path'),true);await h.shutdown();
});
test('same open shares promise, source drift after ready clears journal and cannot reuse the URL',async t=>{
 const p=root(t);let current=binding(),starts=0;const registry=new Registry({root:path.join(p,'index'),resolveSource:async()=>current}),r=await registry.register({sourceToken:'source-token',requestId:'request-one'}),port=providers(),start=port.start;
 port.start=x=>{starts++;return start(x);};const h=new PersistentHost({root:path.join(p,'owner'),registry,providers:port}),request={analysisId:r.analysisId,visualizationRevision:r.visualizationRevision};
 const a=h.open(request),b=h.open(request);assert.equal(a,b);assert.equal((await a).state,'ready');assert.equal(starts,1);
 current={...binding(),sessionHash:'b'.repeat(64)};assert.notEqual((await h.open(request)).state,'ready');assert.equal(h.browserURL(),null);assert.equal(h.canNavigate('http://127.0.0.1:43123/'),false);await h.shutdown();assert.equal(fs.existsSync(path.join(p,'owner/owner.lock')),false);
});
test('foreign lease identity remains incomplete and never invokes a foreign stop',async t=>{
 const p=root(t),registry=new Registry({root:path.join(p,'index'),resolveSource:async()=>binding()}),r=await registry.register({sourceToken:'source-token',requestId:'request-one'});let stopped=0;const port=providers();port.start=x=>({ownerId:'foreign',token:x.token,birthId:x.birthId,port:43123,ready:async()=>({}),stop:async()=>{stopped++;}});
 const h=new PersistentHost({root:path.join(p,'owner'),registry,providers:port});assert.equal((await h.open({analysisId:r.analysisId,visualizationRevision:r.visualizationRevision})).state,'blocked');await h.shutdown();assert.equal(stopped,0);assert.equal(h.inspectRecovery().recovery,'incomplete');assert.equal(h.browserURL(),null);
});
test('status and navigation revoke the URL immediately when the owner lock is replaced',async t=>{
 const p=root(t),registry=new Registry({root:path.join(p,'index'),resolveSource:async()=>binding()}),r=await registry.register({sourceToken:'source-token',requestId:'request-one'}),h=new PersistentHost({root:path.join(p,'owner'),registry,providers:providers()});await h.open({analysisId:r.analysisId,visualizationRevision:r.visualizationRevision});
 const lock=path.join(p,'owner/owner.lock');fs.renameSync(lock,path.join(p,'owner/old-lock'));fs.writeFileSync(lock,'foreign');assert.equal(h.browserURL(),null);assert.equal(h.canNavigate('http://127.0.0.1:43123/'),false);assert.equal(h.status().state,'blocked');assert.equal(fs.readFileSync(lock,'utf8'),'foreign');
});
test('owner replacement before ready response is checked before open can return an owned URL',async t=>{
 const p=root(t),registry=new Registry({root:path.join(p,'index'),resolveSource:async()=>binding()}),r=await registry.register({sourceToken:'source-token',requestId:'request-one'}),port=providers(),start=port.start;
 port.start=x=>{const l=start(x),ready=l.ready;return {...l,ready:async()=>{const proof=await ready();const lock=path.join(p,'owner/owner.lock');fs.renameSync(lock,path.join(p,'owner/original'));fs.writeFileSync(lock,'foreign');return proof;}};};
 const h=new PersistentHost({root:path.join(p,'owner'),registry,providers:port}),result=await h.open({analysisId:r.analysisId,visualizationRevision:r.visualizationRevision});assert.equal(result.url,null);assert.equal(result.state,'blocked');assert.equal(h.browserURL(),null);
});
