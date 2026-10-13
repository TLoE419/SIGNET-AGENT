const {Worker}=require('node:worker_threads');
const path=require('node:path');
const S2_METHODS=new Set(['operationStart','operationStatus','operationCancel','recoveryScan','recoveryAttach','logRead','errorExplain','checkpointReview','closeConfirm']);
const METHODS=new Set(['schema','list','recordList','viewer','detail','capabilities','draftList','draftSave','draftLoad','inputValidate',...S2_METHODS]);

// Background computation runs outside the Electron main thread; no HTTP server.
class Service{
 constructor(root){const real=require('node:fs').realpathSync(root);if(real===path.resolve(__dirname,'..')||real==='/Users/tloe/Developer/SIGNET'||real.startsWith('/Users/tloe/Developer/SIGNET/'))throw Error('S2 runtime is not isolated');this.root=real;this.worker=null;this.next=0;this.pending=new Map();this.visualization={url:null,stop:async()=>{},open:async()=>{throw Error('Not ready (S6)')}};}
 async connect(){
  if(!this.worker){
   this.worker=new Worker(path.join(__dirname,'core/task-worker.cjs'),{workerData:{root:this.root}});
   const w=this.worker;
   w.on('message',m=>{const p=this.pending.get(m.id);if(!p||p.worker!==w)return;this.pending.delete(m.id);clearTimeout(p.timer);m.ok?p.resolve(m.value):p.reject(Error(m.error));});
   w.on('error',e=>this.fail(e,w));
   w.on('exit',code=>{if(this.worker===w)this.worker=null;this.fail(Error('Local controller exited; operation status is unknown'),w);});
  }
  await this.call('schema');return this.status();
 }
 fail(error,worker){for(const [id,p] of this.pending){if(worker&&p.worker!==worker)continue;clearTimeout(p.timer);p.reject(error);this.pending.delete(id);}}
 status(){return {root:this.root,ownership:'electron',transport:'restricted IPC',connected:!!this.worker,localController:!!this.worker?'connected':'disconnected',remoteController:'unknown',remoteConnected:false,scope:'S2 isolated local monitor'};}
 async call(method,...args){
  if(!METHODS.has(method))throw Error('Unknown controlled operation; not ready outside S1/S2');
  if(S2_METHODS.has(method)&&Buffer.byteLength(JSON.stringify(args))>16384)throw Error('Invalid bounded S2 arguments');
  if(!this.worker)throw Error('Analysis controller is not ready; reconnect');
  return new Promise((resolve,reject)=>{
   const id=++this.next,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Operation is still pending; inspect the analysis list before retrying creation or launch.'));},S2_METHODS.has(method)?5000:120000);
   this.pending.set(id,{resolve,reject,timer,worker:this.worker});this.worker.postMessage({id,method,args});
  });
 }
 async stopOwned(){await this.visualization.stop();if(this.worker){const w=this.worker;this.worker=null;await w.terminate();}}
}
module.exports={Service};
