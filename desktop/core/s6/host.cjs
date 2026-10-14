'use strict';
// Pure host coordinator. All effects require trusted main-process adapters; none are installed here.
const {randomUUID}=require('node:crypto');
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const plain=v=>v!==null&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype;
const fault=code=>Object.assign(new Error(code),{code});
function requestKey(r){
 if(!plain(r)||Object.keys(r).sort().join(',')!=='analysisId,visualizationRevision'||!id(r.analysisId)||!id(r.visualizationRevision))throw fault('INVALID_REQUEST');
 return r.analysisId+':'+r.visualizationRevision;
}
function binding(d,r){
 if(!plain(d)||!plain(d.parameters)||!plain(d.networkHashes)||d.analysisId!==r.analysisId||d.visualizationRevision!==r.visualizationRevision||
  !id(d.sessionRef)||!id(d.manifestRef)||!Number.isFinite(d.parameters.freq)||d.parameters.freq<0||d.parameters.freq>1||
  !Number.isInteger(d.parameters.ntop)||d.parameters.ntop<1||d.parameters.ntop>100||
  !['sessionHash','manifestHash','officialHash','containerHash'].every(k=>hash(d[k]))||
  !['frequency','coefficient','positions'].every(k=>hash(d.networkHashes[k])))throw fault('SESSION_INVALID');
 return Object.freeze({analysisId:d.analysisId,visualizationRevision:d.visualizationRevision,sessionRef:d.sessionRef,manifestRef:d.manifestRef,
  sessionHash:d.sessionHash,manifestHash:d.manifestHash,officialHash:d.officialHash,containerHash:d.containerHash,
  parameters:Object.freeze({freq:d.parameters.freq,ntop:d.parameters.ntop}),networkHashes:Object.freeze({frequency:d.networkHashes.frequency,coefficient:d.networkHashes.coefficient,positions:d.networkHashes.positions})});
}
function exactURL(value,port){
 // Reject URL parser normalization of alternative loopback spellings, credentials and backslashes.
 if(typeof value!=='string'||value.length>2048||!Number.isInteger(port)||port<1024||port>65535||
  !value.startsWith('http://127.0.0.1:'+port+'/')||/[\\\s\x00-\x1f\x7f]/.test(value))return false;
 try{const u=new URL(value);return u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.port===String(port)&&!u.username&&!u.password&&u.origin==='http://127.0.0.1:'+port;}catch{return false;}
}
class Host {
 #ports;#timeout;#cleanupTimeout;#active=null;#pending=null;#bindings=new Map();#sessions=new Map();#manifests=new Map();#quarantined=false;
 #state={state:'stopped',url:null,origin:null,ownerId:null,revision:null,error:null,evidence:'unknown'};
 constructor({ports={},timeoutMs=15000,cleanupTimeoutMs=3000}={}){
  if(!Number.isInteger(timeoutMs)||timeoutMs<5||timeoutMs>30000||!Number.isInteger(cleanupTimeoutMs)||cleanupTimeoutMs<5||cleanupTimeoutMs>10000)throw fault('INVALID_LIMIT');
  this.#ports=Object.freeze({...ports});this.#timeout=timeoutMs;this.#cleanupTimeout=cleanupTimeoutMs;
 }
 status(){return {...this.#state};}
 #set(state,run,error=null,url=null){
  this.#state={state,url,origin:url?new URL(url).origin:null,ownerId:run?.ownerId||null,revision:run?.request.visualizationRevision||null,error,evidence:state==='ready'?'service-only':'unknown'};
  return this.status();
 }
 #wait(promise,signal,ms,code){
  return new Promise((resolve,reject)=>{
   if(signal?.aborted){Promise.resolve(promise).catch(()=>{});reject(fault('STOPPED'));return;}
   let done=false;
   const finish=(fn,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);fn(value);};
   const abort=()=>finish(reject,fault('STOPPED'));
   const timer=setTimeout(()=>finish(reject,fault(code)),ms);
   signal?.addEventListener('abort',abort,{once:true});
   Promise.resolve(promise).then(v=>finish(resolve,v),e=>finish(reject,e));
  });
 }
 #current(run){if(this.#active!==run||run.abort.signal.aborted)throw fault('STOPPED');}
 #remember(key,d){
  const encoded=JSON.stringify(d),old=this.#bindings.get(key);
  if(old&&old!==encoded)throw fault('SESSION_REVISION_MISMATCH');
  const sessionKey=d.analysisId+':'+d.sessionRef;
  if(this.#sessions.has(sessionKey)&&this.#sessions.get(sessionKey)!==key)throw fault('SESSION_REUSED');
  const manifestKey=d.analysisId+':'+d.manifestRef;
  if(this.#manifests.has(manifestKey)&&this.#manifests.get(manifestKey)!==key)throw fault('MANIFEST_REUSED');
  if(!old&&this.#bindings.size>=128)throw fault('REVISION_LIMIT');
  this.#bindings.set(key,encoded);this.#sessions.set(sessionKey,key);this.#manifests.set(manifestKey,key);
 }
 async #resolve(run){
  const d=binding(await this.#ports.resolve({...run.request},{signal:run.abort.signal}),run.request);
  this.#current(run);
  const proof=await this.#ports.verify(d,{signal:run.abort.signal});
  this.#current(run);
  if(!plain(proof)||proof.generated!==true||proof.loadState!=='loaded'||proof.sessionHash!==d.sessionHash)throw fault(proof?.loadState==='failed'?'SESSION_LOAD_FAILED':'SESSION_UNVERIFIED');
  if(JSON.stringify(binding(proof.binding,run.request))!==JSON.stringify(d))throw fault('SESSION_HASH_MISMATCH');
  this.#remember(run.key,d);return d;
 }
 #proof(run,p){
  const l=run.lease;
  if(!plain(p)||p.ownerId!==run.ownerId||p.token!==run.token||p.birthId!==l.birthId||p.port!==l.port||p.listening!==true||p.httpOk!==true||!exactURL(p.url,l.port))throw fault('READY_UNVERIFIED');
  return p.url;
 }
 async #release(run){
  if(run.cleanup)return run.cleanup;
  if(!run.lease){if(this.#active===run)this.#active=null;return;}
  const cleanup=this.#wait(Promise.resolve().then(()=>run.lease.stop(Object.freeze({ownerId:run.ownerId,token:run.token,birthId:run.lease.birthId}))),null,this.#cleanupTimeout,'CLEANUP_TIMEOUT');
  run.cleanup=cleanup;
  try{await cleanup;run.lease=null;if(this.#active===run)this.#active=null;}
  catch{run.cleanup=null;this.#set('blocked',run,'CLEANUP_FAILED');throw fault('CLEANUP_FAILED');}
 }
 open(request){
  let key;
  try{key=requestKey(request);}catch(e){return Promise.resolve({...this.status(),state:'error',url:null,origin:null,evidence:'unknown',error:e.code});}
  if(this.#quarantined)return Promise.resolve(this.#set('blocked',this.#active,'OWNERSHIP_MISMATCH'));
  if(this.#pending)return key===this.#active?.key?this.#pending:Promise.resolve({...this.status(),state:'blocked',url:null,origin:null,evidence:'unknown',error:'HOST_BUSY'});
  if(this.#state.error==='CLEANUP_FAILED')return Promise.resolve(this.status());
  if(this.#active&&(this.#active.key!==key||this.#active.abort.signal.aborted))return Promise.resolve({...this.status(),state:'blocked',url:null,origin:null,evidence:'unknown',error:'HOST_BUSY'});
  if(!['resolve','verify','start'].every(k=>typeof this.#ports[k]==='function'))return Promise.resolve(this.#set('blocked',null,'PROVIDER_UNAVAILABLE'));
  const run=this.#active||{key,request:Object.freeze({...request}),ownerId:randomUUID(),token:randomUUID(),abort:new AbortController(),lease:null,cleanup:null};
  this.#active=run;this.#set('starting',run);
  const operation=this.#operate(run);
  this.#pending=operation.finally(()=>{this.#pending=null;});return this.#pending;
 }
 async #operate(run){
  try{
   const work=(async()=>{
    const session=await this.#resolve(run);this.#current(run);
    if(!run.lease){
     // Adapter must return an owned lease synchronously BEFORE any async launch; never a Promise.
     const l=this.#ports.start(Object.freeze({ownerId:run.ownerId,token:run.token,session,signal:run.abort.signal,onExit:()=>this.#exit(run)}));
     if(!l||l.ownerId!==run.ownerId||l.token!==run.token||!id(l.birthId)||!Number.isInteger(l.port)||l.port<1024||l.port>65535||typeof l.ready!=='function'||typeof l.stop!=='function'){
      this.#quarantined=true;throw fault('OWNERSHIP_MISMATCH');
     }
     run.lease=Object.freeze({ownerId:l.ownerId,token:l.token,birthId:l.birthId,port:l.port,ready:l.ready.bind(l),stop:l.stop.bind(l)});
    }
    this.#current(run);
    const p=await run.lease.ready({signal:run.abort.signal});this.#current(run);return this.#proof(run,p);
   })();
   const url=await this.#wait(work,run.abort.signal,this.#timeout,'START_TIMEOUT');this.#current(run);
   return this.#set('ready',run,null,url);
  }catch(e){
   run.abort.abort();
   if(this.#active===run&&this.#state.state!=='stopped'&&this.#state.error!=='SERVICE_EXITED'){
    const allowed=new Set(['SESSION_INVALID','SESSION_UNVERIFIED','SESSION_HASH_MISMATCH','SESSION_REVISION_MISMATCH','SESSION_REUSED','MANIFEST_REUSED','REVISION_LIMIT','SESSION_LOAD_FAILED','READY_UNVERIFIED','START_TIMEOUT','OWNERSHIP_MISMATCH','PORT_OCCUPIED','R_UNAVAILABLE']);
    this.#set(this.#quarantined?'blocked':'error',run,allowed.has(e?.code)?e.code:'PROVIDER_FAILED');
   }
   try{await this.#release(run);}catch{/* cleanup remains blocked and retryable */}
   return this.status();
  }
 }
 #exit(run){
  if(this.#active!==run)return;
  this.#set('error',run,'SERVICE_EXITED');run.abort.abort();
  // Deferring allows a synchronous exit during start to finish registering its owned lease.
  queueMicrotask(()=>this.#release(run).catch(()=>{}));
 }
 async close(){
  const run=this.#active;
  if(this.#quarantined)return this.#set('blocked',run,'OWNERSHIP_MISMATCH');
  this.#set('stopped',run);if(run){run.abort.abort();try{await this.#release(run);}catch{}}
  return this.status();
 }
 canNavigate(url){return this.#state.state==='ready'&&this.#active!==null&&exactURL(url,this.#active.lease.port);}
 browserURL(){return this.#state.state==='ready'?this.#state.url:null;}
}
module.exports={Host};
