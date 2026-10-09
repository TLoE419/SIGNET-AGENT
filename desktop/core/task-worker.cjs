const {parentPort,workerData}=require('node:worker_threads');
const {Store}=require('./store.cjs');
const {schema}=require('./stages.cjs');
const store=new Store(workerData.root);
const methods={schema:()=>schema(),list:()=>store.list(),detail:id=>{store.recover();return store.detail(id)},logs:id=>store.logs(id),
 create:p=>store.create(p),start:(id,stage)=>store.start(id,stage),cancel:id=>store.cancel(id),
 artifact:(id,name)=>{store.artifact(id,name);return true},saveArtifact:(id,name,destination)=>store.saveArtifact(id,name,destination),viewer:id=>store.viewer(id)};
let queue=Promise.resolve();
parentPort.on('message',message=>{queue=queue.then(async()=>{
 try{if(!Object.hasOwn(methods,message.method))throw Error('Unknown controlled operation');const value=await methods[message.method](...message.args);parentPort.postMessage({id:message.id,ok:true,value});}
 catch(e){parentPort.postMessage({id:message.id,ok:false,error:e.message});}
});});
