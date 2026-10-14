const {Worker}=require('node:worker_threads');
const path=require('node:path');
const S2_METHODS=new Set(['operationStart','operationStatus','operationCancel','recoveryScan','recoveryAttach','logRead','errorExplain','checkpointReview','closeConfirm']);
const {METHODS:S3_METHODS}=require('./core/s3-api.cjs');
const {METHODS:S4_METHODS}=require('./core/s4-api.cjs');
const {METHODS:S5_METHODS}=require('./core/s5-api.cjs');
const METHODS=new Set([...S5_METHODS,...S4_METHODS,...S3_METHODS,'schema','list','recordList','viewer','detail','capabilities','draftList','draftSave','draftLoad','inputValidate',...S2_METHODS]);

// Background computation runs outside the Electron main thread; no HTTP server.
class Service{
 constructor(root,{packageAuthority=null}={}){this.exportResolvers=new Map();this.packageAuthority=packageAuthority;this.authorityRevision=0;const real=require('node:fs').realpathSync(root);if(real===path.resolve(__dirname,'..')||real==='/Users/tloe/Developer/SIGNET'||real.startsWith('/Users/tloe/Developer/SIGNET/'))throw Error('S2 runtime is not isolated');this.root=real;this.worker=null;this.next=0;this.pending=new Map();this.visualization={url:null,stop:async()=>{},open:async()=>{throw Error('Not ready (S6)')}};}
 async connect(){
  if(!this.worker){
   this.worker=new Worker(path.join(__dirname,'core/task-worker.cjs'),{workerData:{root:this.root,packageAuthority:this.packageAuthority}});
   const w=this.worker;
   w.on('message',m=>{if(m.type==='export-resolve'){const active=this.exportResolvers.get(m.token);let grant=null;try{if(w===this.worker&&active)grant=active(m.token,m.payload);}catch{}w.postMessage({type:'export-resolved',queryId:m.queryId,grant});return;}const p=this.pending.get(m.id);if(!p||p.worker!==w)return;this.pending.delete(m.id);clearTimeout(p.timer);m.ok?p.resolve(m.value):p.reject(Object.assign(Error(m.error),{code:m.code??m.error}));});
   w.on('error',e=>this.fail(e,w));
   w.on('exit',code=>{if(this.worker===w)this.worker=null;this.fail(Error('Local controller exited; operation status is unknown'),w);});
  }
  await this.call('schema');return this.status();
 }
 fail(error,worker){for(const [id,p] of this.pending){if(worker&&p.worker!==worker)continue;clearTimeout(p.timer);p.reject(error);this.pending.delete(id);}}
 status(){return {root:this.root,ownership:'electron',transport:'restricted IPC',connected:!!this.worker,localController:!!this.worker?'connected':'disconnected',remoteController:'unknown',remoteConnected:false,scope:'isolated local monitor and S3/S4/S5 controlled local interfaces'};}
 async call(method,...args){
  if(!METHODS.has(method))throw Error('Unknown controlled operation; not ready outside S1/S2/S3/S4/S5');
  if((S2_METHODS.has(method)||S3_METHODS.includes(method)||S4_METHODS.includes(method)||S5_METHODS.includes(method))&&Buffer.byteLength(JSON.stringify(args))>(S3_METHODS.includes(method)?65536:16384))throw Error('Invalid bounded controlled arguments');
  if(!this.worker)throw Error('Analysis controller is not ready; reconnect');
  return new Promise((resolve,reject)=>{
   const id=++this.next,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Operation is still pending; inspect the analysis list before retrying creation or launch.'));},S2_METHODS.has(method)?5000:120000);
   this.pending.set(id,{resolve,reject,timer,worker:this.worker});this.worker.postMessage({id,method,args});
  });
 }
 async updatePackageAuthority(authority){
  if(!this.worker)throw Error('Analysis controller is not ready');
  const revision=++this.authorityRevision;
  const result=await new Promise((resolve,reject)=>{const id=++this.next,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Authority update timed out'));},120000);this.pending.set(id,{resolve,reject,timer,worker:this.worker});this.worker.postMessage({id,type:'package-authority',revision,authority});});
  this.packageAuthority=authority;return result;
 }
 async exportCommand(type,p){if(!this.worker)throw Error('Analysis controller is not ready');return new Promise((resolve,reject)=>{const id=++this.next,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Export still pending; inspect its receipt before retrying'));},120000);this.pending.set(id,{resolve,reject,timer,worker:this.worker});this.worker.postMessage({id,type,payload:p});});}
 async prepareExport(p){require('./core/export-api.cjs').request(p);return this.exportCommand('export-prepare',p);}
 async executeExport(p,token,resolver){require('./core/export-api.cjs').request(p);this.exportResolvers.set(token,resolver);try{return await this.exportCommand('export-execute',{...p,destinationToken:token});}finally{this.exportResolvers.delete(token);}}
 async exportStatus(p){require('./core/export-api.cjs').request(p,true);return this.exportCommand('export-status',p);}
 async stopOwned(){this.exportResolvers.clear();await this.visualization.stop();if(this.worker){const w=this.worker;this.worker=null;await w.terminate();}}
}
module.exports={Service};
