'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Host}=require('./host.cjs');
const request={analysisId:'analysis-one',visualizationRevision:'rev-one'};
test('missing trusted providers blocks without claiming ready or returning URL',async()=>{
 const host=new Host();
 const result=await host.open(request);
 assert.equal(result.state,'blocked');assert.equal(result.error,'PROVIDER_UNAVAILABLE');assert.equal(result.url,null);
 assert.equal(host.status().evidence,'unknown');await host.close();
});
const hash='a'.repeat(64), hash2='b'.repeat(64);
function descriptor(overrides={}){
 return {analysisId:'analysis-one',visualizationRevision:'rev-one',sessionRef:'session-one',manifestRef:'manifest-one',
  sessionHash:hash,manifestHash:hash,networkHashes:{frequency:hash,coefficient:hash,positions:hash},
  parameters:{freq:0.5,ntop:2},officialHash:hash,containerHash:hash,...overrides};
}
function rig(options={}){
 const calls={started:[],stopped:[],proofs:[]};let record=descriptor();let exited;
 const ports={
  resolve:async()=>record,
  verify:async d=>({binding:d,generated:true,loadState:'loaded',sessionHash:d.sessionHash}),
  start:({ownerId,token,session,onExit})=>{
   exited=onExit;calls.started.push({ownerId,token,session});
   const birthId='synthetic-birth-'+calls.started.length;
   return {ownerId,token,birthId,port:43123,
    ready:async()=>{calls.proofs.push(ownerId);return {ownerId,token,birthId,port:43123,listening:true,httpOk:true,url:'http://127.0.0.1:43123/'};},
    stop:async identity=>{calls.stopped.push(identity);}};
  },...options
 };
 const host=new Host({ports,timeoutMs:1000,cleanupTimeoutMs:1000});
 return {host,calls,ports,setRecord:value=>{record=value;},exit:()=>exited()};
}
test('trusted session becomes owned ready and close revokes exact URL and stops only own lease',async()=>{
 const {host,calls}=rig();const result=await host.open(request);
 assert.equal(result.state,'ready');assert.equal(result.url,'http://127.0.0.1:43123/');assert.equal(result.evidence,'service-only');
 assert.equal(host.canNavigate('http://127.0.0.1:43123/enrichment'),true);
 await host.close();assert.equal(host.status().state,'stopped');assert.equal(host.status().url,null);
 assert.equal(host.canNavigate(result.url),false);assert.equal(calls.stopped.length,1);
 assert.equal(calls.stopped[0].ownerId,calls.started[0].ownerId);assert.ok(calls.stopped[0].birthId);
});
test('navigation rejects prefix spoofing, alternate ports, schemes, credentials and URL normalization',async()=>{
 const {host}=rig();await host.open(request);
 for(const url of ['http://127.0.0.1.evil:43123/','http://127.0.0.1:431230/','http://127.0.0.1:43124/','https://127.0.0.1:43123/','file:///tmp/a','http://localhost:43123/','http://127.1:43123/','http://2130706433:43123/','http://user@127.0.0.1:43123/','http://127.0.0.1:43123\\@evil/','http://127.0.0.1:043123/','http://127.0.0.1:43123/\n'])assert.equal(host.canNavigate(url),false,url);
 assert.equal(host.browserURL(),'http://127.0.0.1:43123/');await host.close();
});
test('renderer cannot choose URL, port, path or executable and mutation cannot change captured request',async()=>{
 const {host,calls}=rig();
 for(const extra of [{url:'http://evil/'},{port:22},{sessionPath:'/tmp/a'},{command:'R'}])assert.equal((await host.open({...request,...extra})).error,'INVALID_REQUEST');
 assert.equal(calls.started.length,0);
 const changed={...request};const p=host.open(changed);changed.analysisId='other';assert.equal((await p).state,'ready');await host.close();
});
test('unknown generation or failed RData load is rejected before any start',async()=>{
 for(const loadState of ['not-tested','failed']){
  const {host,calls}=rig({verify:async d=>({binding:d,generated:true,loadState,sessionHash:d.sessionHash})});
  assert.equal((await host.open(request)).error,loadState==='failed'?'SESSION_LOAD_FAILED':'SESSION_UNVERIFIED');assert.equal(calls.started.length,0);
 }
 const {host,calls}=rig({verify:async d=>({binding:d,generated:false,loadState:'loaded',sessionHash:d.sessionHash})});
 assert.equal((await host.open(request)).error,'SESSION_UNVERIFIED');assert.equal(calls.started.length,0);
});
test('changed session hash, source triple, parameters or manifest cannot reuse a committed revision',async()=>{
 for(const change of [{sessionHash:hash2},{manifestHash:hash2},{networkHashes:{frequency:hash2,coefficient:hash,positions:hash}},{parameters:{freq:1,ntop:2}},{parameters:{freq:0.5,ntop:3}},{officialHash:hash2},{containerHash:hash2}]){
  const {host,calls,setRecord}=rig();assert.equal((await host.open(request)).state,'ready');await host.close();setRecord(descriptor(change));
  assert.equal((await host.open(request)).error,'SESSION_REVISION_MISMATCH');assert.equal(calls.started.length,1);assert.equal(host.browserURL(),null);
 }
});
test('load proof must bind exact session and source hashes, not just a loaded flag',async()=>{
 const {host,calls}=rig({verify:async d=>({binding:{...d,networkHashes:{...d.networkHashes,frequency:hash2}},generated:true,loadState:'loaded',sessionHash:d.sessionHash})});
 assert.equal((await host.open(request)).error,'SESSION_HASH_MISMATCH');assert.equal(calls.started.length,0);
});
test('new revision cannot point to an old session; new immutable reference may start after close',async()=>{
 const {host,calls,setRecord}=rig();await host.open(request);await host.close();
 setRecord(descriptor({visualizationRevision:'rev-two',parameters:{freq:1,ntop:2}}));
 assert.equal((await host.open({...request,visualizationRevision:'rev-two'})).error,'SESSION_REUSED');
 setRecord(descriptor({visualizationRevision:'rev-two',sessionRef:'session-two',manifestRef:'manifest-two',parameters:{freq:1,ntop:2}}));
 assert.equal((await host.open({...request,visualizationRevision:'rev-two'})).state,'ready');assert.equal(calls.started.length,2);await host.close();
});
test('simultaneous same open shares one promise and different analysis is busy',async()=>{
 const {host,calls}=rig();const a=host.open(request),b=host.open({...request});assert.equal(a,b);
 assert.equal((await host.open({analysisId:'other',visualizationRevision:'rev-one'})).error,'HOST_BUSY');assert.equal((await a).state,'ready');assert.equal(calls.started.length,1);await host.close();
});
test('ready re-open rechecks provenance and health instead of returning cached URL',async()=>{
 const {host,calls}=rig();await host.open(request);await host.open(request);assert.equal(calls.proofs.length,2);assert.equal(calls.started.length,1);await host.close();
});
test('occupied port and missing R are bounded safe failures without stopping foreign processes',async()=>{
 for(const code of ['PORT_OCCUPIED','R_UNAVAILABLE']){
  const {host,calls}=rig({start:()=>{throw Object.assign(new Error('/private/secret'),{code});}});
  assert.equal((await host.open(request)).error,code);assert.equal(calls.stopped.length,0);assert.equal(host.browserURL(),null);
 }
});
test('stale token, missing fresh listening proof or wrong port never becomes ready and cleans own lease',async()=>{
 for(const change of [{token:'old'},{listening:false},{httpOk:false},{port:43124},{url:'http://127.0.0.1.evil:43123/'}]){
  const r=rig();const original=r.ports.start;
  // Constructor captures ports, so inject the altered system boundary into a new host.
  const host=new Host({ports:{...r.ports,start:x=>{const l=original(x),ready=l.ready;return {...l,ready:async()=>({...await ready(),...change})};}},timeoutMs:50,cleanupTimeoutMs:20});
  assert.equal((await host.open(request)).error,'READY_UNVERIFIED');assert.equal(r.calls.stopped.length,1);assert.equal(host.browserURL(),null);
 }
});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
test('startup timeout cleans own lease and late ready cannot resurrect URL',async()=>{
 const r=rig(),d=deferred(),original=r.ports.start;let proof;
 const host=new Host({ports:{...r.ports,start:x=>{const l=original(x);proof=l.ready();return {...l,ready:()=>d.promise};}},timeoutMs:10,cleanupTimeoutMs:20});
 assert.equal((await host.open(request)).error,'START_TIMEOUT');assert.equal(r.calls.stopped.length,1);
 d.resolve(await proof);await new Promise(r=>setImmediate(r));assert.equal(host.browserURL(),null);assert.equal(host.status().error,'START_TIMEOUT');
});
test('close while provider resolution hangs does not launch after late resolution',async()=>{
 const d=deferred(),r=rig({resolve:()=>d.promise});const p=r.host.open(request);await r.host.close();
 assert.equal((await p).state,'stopped');d.resolve(descriptor());await new Promise(r=>setImmediate(r));assert.equal(r.calls.started.length,0);assert.equal(r.host.browserURL(),null);
});
test('close while starting revokes URL, cleans once, and late proof cannot restore it',async()=>{
 const r=rig(),d=deferred(),original=r.ports.start;let proof;
 const host=new Host({ports:{...r.ports,start:x=>{const l=original(x);proof=l.ready();return {...l,ready:()=>d.promise};}},timeoutMs:1000,cleanupTimeoutMs:1000});
 const p=host.open(request);await new Promise(r=>setImmediate(r));await host.close();assert.equal((await p).state,'stopped');
 d.resolve(await proof);await new Promise(r=>setImmediate(r));assert.equal(host.status().state,'stopped');assert.equal(r.calls.stopped.length,1);
});
test('service exit revokes URL and repeated open receives a new owner after cleanup',async()=>{
 const r=rig();const first=await r.host.open(request);r.exit();assert.equal(r.host.browserURL(),null);
 await new Promise(r=>setImmediate(r));assert.equal(r.host.status().error,'SERVICE_EXITED');assert.equal(r.calls.stopped.length,1);
 const second=await r.host.open(request);assert.equal(second.state,'ready');assert.notEqual(second.ownerId,first.ownerId);await r.host.close();
});
test('synchronous exit during acquire still cleans the registered lease',async()=>{
 const r=rig(),original=r.ports.start;
 const host=new Host({ports:{...r.ports,start:x=>{const l=original(x);x.onExit();return l;}}});
 assert.equal((await host.open(request)).error,'SERVICE_EXITED');assert.equal(r.calls.stopped.length,1);
});
test('cleanup failure blocks reopening and permits explicit own-only retry',async()=>{
 const r=rig(),original=r.ports.start;let attempts=0;
 const host=new Host({ports:{...r.ports,start:x=>{const l=original(x);return {...l,stop:async identity=>{attempts++;if(attempts===1)throw Error('failed');return l.stop(identity);}};}}});
 await host.open(request);assert.equal((await host.close()).error,'CLEANUP_FAILED');assert.equal(host.browserURL(),null);
 assert.equal((await host.open(request)).error,'CLEANUP_FAILED');assert.equal(r.calls.started.length,1);
 assert.equal((await host.close()).state,'stopped');assert.equal(attempts,2);assert.equal(r.calls.stopped.length,1);
});
test('foreign lease identity is quarantined, never stopped, and cannot reopen',async()=>{
 const r=rig(),original=r.ports.start;
 const host=new Host({ports:{...r.ports,start:x=>({...original(x),ownerId:'foreign-owner'})}});
 assert.equal((await host.open(request)).error,'OWNERSHIP_MISMATCH');assert.equal(r.calls.stopped.length,0);assert.equal((await host.close()).state,'blocked');assert.equal((await host.open(request)).error,'OWNERSHIP_MISMATCH');
});
test('untrusted provider error details are not returned to the renderer',async()=>{
 const {host}=rig({resolve:async()=>{throw Error('ssh /private/credentials');}});const result=await host.open(request);
 assert.equal(result.error,'PROVIDER_FAILED');assert.equal(JSON.stringify(result).includes('credentials'),false);
});
test('invalid or busy response does not mislabel evidence as service-ready',async()=>{
 const {host}=rig();await host.open(request);
 const bad=await host.open({...request,url:'http://evil/'});assert.equal(bad.evidence,'unknown');
 const busy=await host.open({...request,analysisId:'other'});assert.equal(busy.evidence,'unknown');
 assert.equal(host.status().state,'ready');await host.close();
});
test('synchronous close from provider cannot leave an unhandled late rejection',async()=>{
 let host;const r=rig();host=new Host({ports:{...r.ports,resolve:()=>{void host.close();return descriptor();}}});
 assert.equal((await host.open(request)).state,'stopped');await new Promise(r=>setImmediate(r));assert.equal(r.calls.started.length,0);
});
test('pending verification times out without launch, late verified data stays revoked',async()=>{
 const d=deferred(),r=rig({verify:()=>d.promise});const host=new Host({ports:r.ports,timeoutMs:10});
 assert.equal((await host.open(request)).error,'START_TIMEOUT');d.resolve({binding:descriptor(),generated:true,loadState:'loaded',sessionHash:hash});
 await new Promise(r=>setImmediate(r));assert.equal(r.calls.started.length,0);assert.equal(host.status().url,null);
});
test('hung cleanup is bounded, visibly blocked, and late completion is never claimed cleaned',async()=>{
 const r=rig(),original=r.ports.start,d=deferred();let attempts=0;
 const host=new Host({ports:{...r.ports,start:x=>{const l=original(x);return {...l,stop:()=>{attempts++;return attempts===1?d.promise:l.stop({ownerId:l.ownerId,token:l.token,birthId:l.birthId});}};}},cleanupTimeoutMs:10});
 await host.open(request);assert.equal((await host.close()).error,'CLEANUP_FAILED');assert.equal(host.browserURL(),null);
 d.resolve();await new Promise(r=>setImmediate(r));assert.equal(host.status().state,'blocked');assert.equal((await host.open(request)).error,'CLEANUP_FAILED');
 assert.equal((await host.close()).state,'stopped');
});
test('stale exit from a closed owner cannot stop a newer owner',async()=>{
 const r=rig(),original=r.ports.start,exits=[];
 const host=new Host({ports:{...r.ports,start:x=>{exits.push(x.onExit);return original(x);}}});
 await host.open(request);await host.close();const second=await host.open(request);exits[0]();await new Promise(r=>setImmediate(r));
 assert.equal(host.status().ownerId,second.ownerId);assert.equal(host.status().state,'ready');assert.equal(r.calls.stopped.length,1);await host.close();
});
test('malformed source, invalid parameter limits and missing hashes are refused before start',async()=>{
 for(const value of [null,descriptor({sessionRef:'../../private'}),descriptor({sessionHash:'no'}),descriptor({parameters:{freq:NaN,ntop:1}}),descriptor({parameters:{freq:1.1,ntop:1}}),descriptor({parameters:{freq:1,ntop:0}}),descriptor({parameters:{freq:1,ntop:1.5}}),descriptor({parameters:{freq:1,ntop:101}}),descriptor({networkHashes:{frequency:hash,coefficient:hash}})]){
  const r=rig({resolve:async()=>value});assert.equal((await r.host.open(request)).error,'SESSION_INVALID');assert.equal(r.calls.started.length,0);
 }
});
test('revision memory is bounded without forgetting old revision bindings',async()=>{
 let current;
 const r=rig(),host=new Host({ports:{...r.ports,resolve:async()=>current}});
 for(let i=0;i<128;i++){
  current=descriptor({visualizationRevision:'revision-'+i,sessionRef:'session-'+i,manifestRef:'manifest-'+i});
  assert.equal((await host.open({...request,visualizationRevision:'revision-'+i})).state,'ready');await host.close();
 }
 current=descriptor({visualizationRevision:'revision-over',sessionRef:'session-over',manifestRef:'manifest-over'});
 assert.equal((await host.open({...request,visualizationRevision:'revision-over'})).error,'REVISION_LIMIT');
 current=descriptor({visualizationRevision:'revision-0',sessionRef:'session-0',manifestRef:'manifest-0',parameters:{freq:1,ntop:2}});
 assert.equal((await host.open({...request,visualizationRevision:'revision-0'})).error,'SESSION_REVISION_MISMATCH');
});
test('reopen during owned cleanup is busy and cannot replace the cleanup status',async()=>{
 const r=rig(),original=r.ports.start,d=deferred();
 const host=new Host({ports:{...r.ports,start:x=>{const l=original(x);return {...l,stop:()=>d.promise};}},cleanupTimeoutMs:1000});
 await host.open(request);const closing=host.close();
 assert.equal((await host.open(request)).error,'HOST_BUSY');assert.equal(host.status().state,'stopped');
 d.resolve();await closing;assert.equal(host.status().state,'stopped');
 assert.equal((await host.open(request)).state,'ready');await host.close();
});
test('exit while ready is immediately unavailable and re-open waits for own cleanup',async()=>{
 const r=rig(),original=r.ports.start,d=deferred();let exit;
 const host=new Host({ports:{...r.ports,start:x=>{exit=x.onExit;const l=original(x);return {...l,stop:()=>d.promise};}},cleanupTimeoutMs:1000});
 await host.open(request);exit();
 assert.equal(host.status().error,'SERVICE_EXITED');assert.equal(host.browserURL(),null);
 assert.equal((await host.open(request)).error,'HOST_BUSY');assert.equal(host.status().error,'SERVICE_EXITED');
 d.resolve();await new Promise(r=>setImmediate(r));assert.equal((await host.open(request)).state,'ready');await host.close();
});
test('shutdown of many concurrent callers cleans one owned lease and keeps foreign identity untouched',async()=>{
 const r=rig();const pending=Array.from({length:20},()=>r.host.open(request));await Promise.all(pending);
 const owner=r.host.status().ownerId;await Promise.all(Array.from({length:20},()=>r.host.close()));
 assert.equal(r.calls.started.length,1);assert.equal(r.calls.stopped.length,1);assert.equal(r.calls.stopped[0].ownerId,owner);
 assert.equal(r.host.status().state,'stopped');assert.equal(r.host.browserURL(),null);
});
test('new revision cannot reuse the old manifest reference even with a new session',async()=>{
 const r=rig();await r.host.open(request);await r.host.close();
 r.setRecord(descriptor({visualizationRevision:'rev-two',sessionRef:'session-two',parameters:{freq:1,ntop:2}}));
 assert.equal((await r.host.open({...request,visualizationRevision:'rev-two'})).error,'MANIFEST_REUSED');
 assert.equal(r.calls.started.length,1);
});
