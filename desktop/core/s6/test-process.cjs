'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {Registry,Storage}=require('./registry.cjs'),{Ownership}=require('./port-adapter.cjs');
const base=fs.realpathSync(process.env.SIGNET_S6_INDEX_TEST_ROOT||require('node:os').tmpdir()),hash='a'.repeat(64);
function root(t){const p=fs.mkdtempSync(path.join(base,'s6-process-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
const source={subjectRef:'draft-one',sourceRef:{sourceId:'source-one',batchId:'batch-one',revision:1},packageHash:hash,a5Revision:1,parameters:{freq:1,ntop:1},networkHashes:{frequency:hash,coefficient:hash,positions:hash},sessionRef:'session-one',sessionHash:hash,manifestRef:'manifest-one',manifestHash:hash,officialHash:hash,containerHash:hash,evidence:{generationRef:null,loadRef:null,verificationRef:null,loadState:'unknown'},scientificStatus:'unknown'};
function child(t,script,args){
 const c=spawn(process.execPath,['-e',script,...args],{stdio:['ignore','pipe','pipe','ipc']});let stderr='';c.stderr.on('data',b=>{stderr=(stderr+b).slice(-4096)});c.stdout.resume();
 const exit=new Promise((resolve,reject)=>{c.once('exit',(code,signal)=>resolve({code,signal,stderr}));c.once('error',reject);});t.after(async()=>{if(c.exitCode===null&&c.signalCode===null)c.kill('SIGTERM');await exit;});
 const message=()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{c.removeListener('message',listener);reject(Error('Child timed out '+stderr));},5000);const listener=m=>{clearTimeout(timer);resolve(m);};c.once('message',listener);});
 return {c,exit,message};
}
test('two real local Node processes compete for one registry writer; only one commits and child handles exit',async t=>{
 const p=root(t),modulePath=require.resolve('./registry.cjs'),script=`const {Registry}=require(process.argv[1]),p=process.argv[2],b=JSON.parse(process.argv[3]);let first=true;const r=new Registry({root:p,resolveSource:async()=>{if(first&&process.argv[4]==='hold'){first=false;await new Promise(resolve=>{process.once('message',resolve);process.send({phase:'held'});});}return b;}});r.register({sourceToken:'approved-one',requestId:'request-one'}).then(x=>process.send({ok:true,id:x.visualizationRevision},()=>process.exit(0)),e=>process.send({ok:false,error:e.code},()=>process.exit(0)));`;
 const a=child(t,script,[modulePath,p,JSON.stringify(source),'hold']);assert.equal((await a.message()).phase,'held');
 const b=child(t,script,[modulePath,p,JSON.stringify(source),'run']);assert.deepEqual(await b.message(),{ok:false,error:'LOCKED'});assert.equal((await b.exit).code,0);a.c.send('release');assert.equal((await a.message()).ok,true);assert.equal((await a.exit).code,0);
 const r=new Registry({root:p,resolveSource:async()=>source});assert.equal((await r.list()).records.length,1);assert.equal(fs.existsSync(path.join(p,'registry.lock')),false);t.diagnostic('Owned fixture PIDs '+a.c.pid+' / '+b.c.pid+' exited; no OS birth proof inferred.');
});
test('cross-process logical owner exclusion and abandoned lease restart remain URL-free until explicit proof',async t=>{
 const p=root(t),modulePath=require.resolve('./port-adapter.cjs'),script=`const {Ownership}=require(process.argv[1]);const o=new Ownership({root:process.argv[2]});o.claim();o.reserve({analysisId:'va-test',visualizationRevision:'vr-test',ownerId:'host-test',token:'test-token',birthId:'lease-test',port:43123,pid:null,osBirthEvidence:null});process.send({held:true},()=>{process.once('message',()=>process.exit(0));});`;
 const a=child(t,script,[modulePath,p]);assert.equal((await a.message()).held,true);const cold=new Ownership({root:p});assert.throws(()=>cold.claim(),/OWNER_BUSY/);assert.equal(cold.inspect().url,null);const original=fs.readFileSync(path.join(p,'owner.lock'));
 a.c.send('exit-without-cleanup');assert.equal((await a.exit).code,0);assert.throws(()=>cold.claim(),/OWNER_BUSY/);assert.deepEqual(fs.readFileSync(path.join(p,'owner.lock')),original);assert.equal(cold.inspect().recovery,'incomplete');
 const noProof=await cold.recover();assert.equal(noProof.state,'blocked');
 const recovered=await cold.recover(async x=>({...x,outcome:'stopped',evidenceClass:'synthetic',evidenceRef:'synthetic-child-exit-checked'}));assert.equal(recovered.state,'unknown');cold.claim();cold.release();assert.equal(fs.existsSync(path.join(p,'owner.lock')),false);t.diagnostic('Owned fixture PID '+a.c.pid+' exited; lease was synthetic and PID/birth evidence remained null.');
});
test('actual process exit between temp fsync and publish retains old revision and blocks unknown operation lock',async t=>{
 const p=root(t),r=new Registry({root:p,resolveSource:async()=>source});await r.register({sourceToken:'approved-one',requestId:'request-one'});const bytes=fs.readFileSync(path.join(p,'registry.json')),next={...source,a5Revision:2,sessionRef:'session-two',manifestRef:'manifest-two'};
 const script=`const {Registry}=require(process.argv[1]);const r=new Registry({root:process.argv[2],resolveSource:async()=>JSON.parse(process.argv[3]),beforePublish:()=>process.exit(23)});r.register({sourceToken:'approved-one',requestId:'request-two'}).catch(()=>process.exit(24));`;
 const a=child(t,script,[require.resolve('./registry.cjs'),p,JSON.stringify(next)]);assert.equal((await a.exit).code,23);assert.deepEqual(fs.readFileSync(path.join(p,'registry.json')),bytes);
 assert.equal(fs.readdirSync(p).filter(n=>n.endsWith('.part')).length,1);await assert.rejects(r.list(),/LOCKED/);assert.equal(fs.existsSync(path.join(p,'registry.lock')),true);
 const recovered=r.recoveryState();assert.equal(recovered.state,'blocked');assert.equal(recovered.recovery,'incomplete');assert.equal(recovered.publishedRecords,1);assert.equal(recovered.url,null);const body=new Storage(p).read('registry.json',2*1024*1024);assert.equal(body.records.length,1);assert.equal(body.records[0].binding.a5Revision,1);t.diagnostic('Own crashed metadata writer left an unknown lock; no automatic deletion or half-commit promotion.');
});
