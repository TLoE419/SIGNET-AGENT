const {parentPort,workerData}=require('node:worker_threads');
const {Store}=require('./store.cjs');
const {schema}=require('./stages.cjs');
const store=new Store(workerData.root);
const {Operations}=require('./operations.cjs');
const operations=new Operations(workerData.root);
const s2={operationStart:p=>operations.start(p),operationStatus:p=>operations.status(p),operationCancel:p=>operations.cancel(p),recoveryScan:p=>operations.scan(p),recoveryAttach:p=>operations.attach(p),logRead:p=>operations.logRead(p),errorExplain:p=>operations.explain(p),checkpointReview:p=>operations.checkpoint(p),closeConfirm:p=>operations.close(p)};
const methods={schema:()=>schema(),list:()=>store.recordList(),recordList:()=>store.recordList(),capabilities:()=>store.capabilities(),draftList:()=>store.draftList(),draftSave:(p,sources)=>store.draftSave(p,sources),draftLoad:id=>store.draftLoad(id),inputValidate:(id,revision)=>store.inputValidate(id,revision),detail:id=>store.recordDetail(id),viewer:id=>store.viewer(id),
};
let queue=Promise.resolve();
parentPort.on('message',message=>{
 if(Object.hasOwn(s2,message.method)){
  try{const value=s2[message.method](...message.args);parentPort.postMessage({id:message.id,ok:true,value});}
  catch(e){parentPort.postMessage({id:message.id,ok:false,error:e.code||e.message});}return;
 }
 queue=queue.then(async()=>{
 try{if(!Object.hasOwn(methods,message.method))throw Error('Unknown controlled operation');const value=await methods[message.method](...message.args);parentPort.postMessage({id:message.id,ok:true,value});}
 catch(e){parentPort.postMessage({id:message.id,ok:false,error:e.message});}
});});
