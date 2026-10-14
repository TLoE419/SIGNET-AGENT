'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const {Host}=require('./host.cjs');
const {Storage,copy,hash,exact,id,fail}=require('./registry.cjs');
const same=(a,b)=>hash(a)===hash(b);
function ownerCheck(o){exact(o,['ownerId','token','birthRef','pid','osBirthEvidence']);if(!id(o.ownerId)||!id(o.token)||!id(o.birthRef)||o.pid!==null||o.osBirthEvidence!==null)fail('OWNER_INVALID');}
function leaseCheck(l){exact(l,['analysisId','visualizationRevision','ownerId','token','birthId','port','pid','osBirthEvidence']);if(!['analysisId','visualizationRevision','ownerId','token','birthId'].every(k=>id(l[k]))||l.port!==null&&(!Number.isInteger(l.port)||l.port<1024||l.port>65535)||l.pid!==null||l.osBirthEvidence!==null)fail('LEASE_INVALID');}
class Ownership{
 #fd;#rootIdentity;#lockIdentity;
 constructor({root,beforePublish}){this.store=new Storage(root,{beforePublish});this.owner={ownerId:'co-'+crypto.randomUUID(),token:crypto.randomUUID(),birthRef:'logical-'+crypto.randomUUID(),pid:null,osBirthEvidence:null};}
 journal(){const j=this.store.read('journal.json',16384);if(j===null)return null;exact(j,['schemaVersion','owner','phase','lease','recovery']);ownerCheck(j.owner);if(j.schemaVersion!==1||!['claimed','reserved','active','cleanup-required','clean'].includes(j.phase))fail('JOURNAL_INVALID');if(j.lease!==null)leaseCheck(j.lease);if(j.recovery!==null){exact(j.recovery,['evidenceClass','evidenceRef']);if(j.recovery.evidenceClass!=='synthetic'||!id(j.recovery.evidenceRef))fail('JOURNAL_INVALID');}if(['reserved','active','cleanup-required'].includes(j.phase)!==(j.lease!==null))fail('JOURNAL_INVALID');return j;}
 lock(){const o=this.store.read('owner.lock',4096);if(o!==null)ownerCheck(o);return o;}
 inspect(){let owner,journal;try{owner=this.lock();journal=this.journal();}catch{return {state:'blocked',url:null,evidence:'unknown',recovery:'incomplete',error:'OWNER_OR_JOURNAL_INVALID'};}
  const incomplete=!!journal&&journal.phase!=='clean',operationUnknown=fs.existsSync(this.store.file('registry.lock'));return {state:owner||incomplete||operationUnknown?'blocked':'unknown',url:null,evidence:'unknown',recovery:incomplete?'incomplete':'none',ownerRef:owner,leaseRef:journal?.lease??null,error:owner?'OWNER_UNKNOWN':incomplete?'JOURNAL_INCOMPLETE':operationUnknown?'METADATA_LOCK_UNKNOWN':null,registryOperationUnknown:operationUnknown};
 }
 guard(){if(this.#fd===undefined)fail('OWNER_NOT_HELD');const r=fs.lstatSync(this.store.root),l=fs.lstatSync(this.store.file('owner.lock'));if(r.isSymbolicLink()||l.isSymbolicLink()||r.dev!==this.#rootIdentity.dev||r.ino!==this.#rootIdentity.ino||l.dev!==this.#lockIdentity.dev||l.ino!==this.#lockIdentity.ino||!same(this.lock(),this.owner))fail('OWNER_REPLACED');}
 held(){if(this.#fd===undefined)return false;this.guard();return true;}
 detach(){if(this.#fd!==undefined){fs.closeSync(this.#fd);this.#fd=undefined;}return this.inspect();}
 claim(){if(this.#fd!==undefined){this.guard();return;}
  const state=this.inspect();if(state.error)fail(state.error==='OWNER_UNKNOWN'?'OWNER_BUSY':state.error);
  let fd;try{fd=fs.openSync(this.store.file('owner.lock'),'wx',0o600);}catch{fail('OWNER_BUSY');}
  this.#fd=fd;this.#rootIdentity=fs.lstatSync(this.store.root);this.#lockIdentity=fs.fstatSync(fd);
  fs.writeFileSync(fd,JSON.stringify({body:this.owner,sha256:hash(this.owner)}));fs.fsyncSync(fd);
  this.store.write('journal.json',{schemaVersion:1,owner:this.owner,phase:'claimed',lease:null,recovery:null},16384,()=>this.guard());
 }
 write(phase,lease,recovery=null){this.guard();const j=this.journal();if(j&&!same(j.owner,this.owner))fail('OWNER_REPLACED');if(lease!==null)leaseCheck(lease);this.store.write('journal.json',{schemaVersion:1,owner:this.owner,phase,lease,recovery},16384,()=>this.guard());}
 reserve(lease){this.guard();const j=this.journal();if(j?.lease)fail('CLEANUP_UNKNOWN');this.write('reserved',copy(lease));}
 update(phase,lease){this.guard();const old=this.journal()?.lease;if(!old||!['analysisId','visualizationRevision','ownerId','token','birthId'].every(k=>old[k]===lease[k]))fail('LEASE_MISMATCH');this.write(phase,copy(lease));}
 clear(lease){this.guard();const old=this.journal()?.lease;if(!old||!same(old,lease))fail('LEASE_MISMATCH');this.write('clean',null);}
 release(){this.guard();const j=this.journal();if(j?.lease)fail('CLEANUP_UNKNOWN');this.write('clean',null);this.guard();fs.unlinkSync(this.store.file('owner.lock'));fs.closeSync(this.#fd);this.#fd=undefined;}
 // Only a trusted reconciliation port can clear an abandoned logical/synthetic owner.
 // No PID inference or OS process cleanup is implemented by this module.
 async recover(reconcile){
  if(typeof reconcile!=='function')return this.inspect();
  return this.store.locked(async guard=>{
   const owner=this.lock(),journal=this.journal();if(!owner)return this.inspect();
   const root=fs.lstatSync(this.store.root),lock=fs.lstatSync(this.store.file('owner.lock')),journalHash=hash(journal);
   if(!journal||!same(journal.owner,owner))fail('RECOVERY_INCOMPLETE');
   let proof;try{proof=await reconcile({owner:copy(owner),lease:copy(journal.lease)});}catch{fail('RECOVERY_UNKNOWN');}
   if(!proof||!same(proof.owner,owner)||!same(proof.lease,journal.lease)||proof.outcome!=='stopped'||proof.evidenceClass!=='synthetic'||!id(proof.evidenceRef))fail('RECOVERY_UNKNOWN');
   guard();const r=fs.lstatSync(this.store.root),l=fs.lstatSync(this.store.file('owner.lock'));if(r.dev!==root.dev||r.ino!==root.ino||l.dev!==lock.dev||l.ino!==lock.ino||!same(this.lock(),owner)||hash(this.journal())!==journalHash)fail('RECOVERY_RACE');
   const check=()=>{guard();const x=fs.lstatSync(this.store.file('owner.lock'));if(x.dev!==lock.dev||x.ino!==lock.ino||!same(this.lock(),owner))fail('RECOVERY_RACE');};
   this.store.write('journal.json',{schemaVersion:1,owner,phase:'clean',lease:null,recovery:{evidenceClass:'synthetic',evidenceRef:proof.evidenceRef}},16384,check);check();fs.unlinkSync(this.store.file('owner.lock'));
   return {state:'unknown',url:null,evidence:'unknown',recovery:'synthetic-contract-cleared'};
  });
 }
}
function descriptor(r){return {analysisId:r.analysisId,visualizationRevision:r.visualizationRevision,sessionRef:r.sessionRef,manifestRef:r.manifestRef,sessionHash:r.sessionHash,manifestHash:r.manifestHash,officialHash:r.officialHash,containerHash:r.containerHash,parameters:copy(r.parameters),networkHashes:copy(r.networkHashes)};}
class PersistentHost{
 #host;#registry;#ownership;#providers;#lease=null;#blocked=null;#pending=null;#pendingKey=null;
 constructor({root,registry,providers={},timeoutMs=15000,cleanupTimeoutMs=3000,beforePublish}){
  if(!registry||typeof registry.get!=='function')fail('SCHEMA_INVALID');this.#registry=registry;this.#ownership=new Ownership({root,beforePublish});this.#providers={...providers};this.#blocked=this.#ownership.inspect().error;
  this.#host=new Host({timeoutMs,cleanupTimeoutMs,ports:{resolve:async request=>descriptor(await this.#registry.get(request)),verify:async(binding,{signal})=>{const record=await this.#registry.get({analysisId:binding.analysisId,visualizationRevision:binding.visualizationRevision});if(!same(descriptor(record),binding))fail('SOURCE_CHANGED');return this.#providers.verifySession({record,binding,signal});},start:input=>this.#start(input)}});
 }
 #start(input){
  this.#ownership.guard();const birthId='lease-'+crypto.randomUUID(),lease={analysisId:input.session.analysisId,visualizationRevision:input.session.visualizationRevision,ownerId:input.ownerId,token:input.token,birthId,port:null,pid:null,osBirthEvidence:null};
  this.#ownership.reserve(lease);this.#lease=lease;
  const l=this.#providers.start({...input,birthId});
  if(!l||l.ownerId!==input.ownerId||l.token!==input.token||l.birthId!==birthId||!Number.isInteger(l.port)||l.port<1024||l.port>65535||typeof l.ready!=='function'||typeof l.stop!=='function')fail('LEASE_MISMATCH');
  lease.port=l.port;this.#ownership.update('active',lease);
  return {ownerId:l.ownerId,token:l.token,birthId:l.birthId,port:l.port,ready:p=>l.ready(p),stop:async identity=>{
   if(!same(identity,{ownerId:lease.ownerId,token:lease.token,birthId:lease.birthId}))fail('LEASE_MISMATCH');
   this.#ownership.update('cleanup-required',lease);await l.stop(identity);this.#ownership.clear(lease);this.#lease=null;
  }};
 }
 open(request){
  try{exact(request,['analysisId','visualizationRevision']);if(!id(request.analysisId)||!id(request.visualizationRevision))fail('SCHEMA_INVALID');}catch{return Promise.resolve({state:'error',url:null,evidence:'unknown',error:'INVALID_REQUEST'});}
  const key=request.analysisId+':'+request.visualizationRevision;
  if(this.#pending)return key===this.#pendingKey?this.#pending:Promise.resolve({state:'blocked',url:null,evidence:'unknown',error:'HOST_BUSY'});
  if(typeof this.#providers.verifySession!=='function'||typeof this.#providers.start!=='function')return Promise.resolve({state:'blocked',url:null,evidence:'unknown',error:'PROVIDER_UNAVAILABLE'});
  try{this.#ownership.claim();if(this.#ownership.journal()?.lease&&this.#host.status().state!=='ready')fail('CLEANUP_UNKNOWN');}catch(e){this.#blocked=e.code??'OWNER_UNKNOWN';return Promise.resolve(this.status());}
  this.#blocked=null;this.#pendingKey=key;
  this.#pending=this.#host.open(request).then(result=>{if(this.#host.status().state!=='ready'&&this.#ownership.journal()?.lease)this.#blocked='CLEANUP_UNKNOWN';return this.#blocked||result.state==='ready'?this.status():result;}).finally(()=>{this.#pending=null;this.#pendingKey=null;});return this.#pending;
 }
 status(){const h=this.#host.status();if(h.state==='ready'){try{this.#ownership.guard();const j=this.#ownership.journal();if(j?.phase!=='active'||!this.#lease||!same(j.lease,this.#lease))fail('OWNERSHIP_LOST');}catch{this.#blocked='OWNERSHIP_LOST';}}if(this.#blocked)return {...h,state:'blocked',url:null,origin:null,evidence:'unknown',error:this.#blocked};return h;}
 canNavigate(url){return this.status().state==='ready'&&this.#host.canNavigate(url);}
 browserURL(){return this.status().state==='ready'?this.#host.browserURL():null;}
 async close(){await this.#host.close();try{if(!this.#ownership.held()){this.#blocked=this.#blocked??this.#ownership.inspect().error;return this.status();}if(this.#ownership.journal()?.lease)this.#blocked='CLEANUP_UNKNOWN';else this.#blocked=null;}catch{this.#blocked='JOURNAL_INCOMPLETE';}return this.status();}
 async shutdown(){await this.close();if(this.#blocked)return this.status();try{this.#ownership.release();}catch(e){if(e.code!=='OWNER_NOT_HELD')this.#blocked=e.code??'OWNER_UNKNOWN';}return this.status();}
 inspectRecovery(){return this.#ownership.inspect();}
}
module.exports={Ownership,PersistentHost};
