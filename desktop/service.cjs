const {Worker}=require('node:worker_threads');
const path=require('node:path');
const {Visualization}=require('./core/visualization.cjs');

// Background computation runs outside the Electron main thread; no HTTP server.
class Service{
 constructor(root){this.root=root;this.worker=null;this.next=0;this.pending=new Map();this.visualization=new Visualization(root);}
 async connect(){
  if(!this.worker){
   this.worker=new Worker(path.join(__dirname,'core/task-worker.cjs'),{workerData:{root:this.root}});
   this.worker.on('message',m=>{const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);m.ok?p.resolve(m.value):p.reject(Error(m.error));});
   this.worker.on('error',e=>this.fail(e));
   this.worker.on('exit',code=>{this.worker=null;this.fail(Error('Analysis controller thread exited: '+code));});
  }
  await this.call('schema');return this.status();
 }
 fail(error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error)}this.pending.clear();}
 status(){return {root:this.root,ownership:'electron',transport:'restricted IPC',connected:!!this.worker};}
 async call(method,...args){
  if(!this.worker)throw Error('Analysis controller is not ready; reconnect');
  return new Promise((resolve,reject)=>{
   const id=++this.next,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Operation is still pending; inspect the analysis list before retrying creation or launch.'));},120000);
   this.pending.set(id,{resolve,reject,timer});this.worker.postMessage({id,method,args});
  });
 }
 async stopOwned(){await this.visualization.stop();if(this.worker){const w=this.worker;this.worker=null;await w.terminate();}}
}
module.exports={Service};
