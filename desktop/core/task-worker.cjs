const {parentPort,workerData}=require('node:worker_threads');
const {Store}=require('./store.cjs');
const {schema}=require('./stages.cjs');
const store=new Store(workerData.root);
const {Operations}=require('./operations.cjs');
const operations=new Operations(workerData.root);
const {Configuration}=require('./s3-integration.cjs'),{METHODS:S3_METHODS}=require('./s3-api.cjs');
const configuration=new Configuration(workerData.root,store,operations);
const s2={operationStart:p=>operations.start(p),operationStatus:p=>operations.status(p),operationCancel:p=>operations.cancel(p),recoveryScan:p=>operations.scan(p),recoveryAttach:p=>operations.attach(p),logRead:p=>operations.logRead(p),errorExplain:p=>operations.explain(p),checkpointReview:p=>operations.checkpoint(p),closeConfirm:p=>operations.close(p)};
const methods={schema:()=>schema(),list:()=>store.recordList(),recordList:()=>store.recordList(),capabilities:()=>store.capabilities(),draftList:()=>store.draftList(),draftSave:(p,sources)=>store.draftSave(p,sources),draftLoad:id=>store.draftLoad(id),inputValidate:(id,revision)=>store.inputValidate(id,revision),detail:id=>store.recordDetail(id),viewer:id=>store.viewer(id),
};
for(const method of S3_METHODS)methods[method]=p=>configuration.call(method,p);
const {Stages}=require('./s4-integration.cjs'),{METHODS:S4_METHODS}=require('./s4-api.cjs');
const stages=new Stages(configuration,operations);
for(const method of S4_METHODS)methods[method]=p=>stages.call(method,p);
const {Packages}=require('./s5-integration.cjs'),{METHODS:S5_METHODS}=require('./s5-api.cjs');
let packages=new Packages(workerData.root,{authority:workerData.packageAuthority??null});
for(const method of S5_METHODS)methods[method]=p=>packages.call(method,p);
let authorityRevision=0;
let queue=Promise.resolve();
parentPort.on('message',message=>{
 if(Object.hasOwn(s2,message.method)){
  try{const value=s2[message.method](...message.args);parentPort.postMessage({id:message.id,ok:true,value});}
  catch(e){parentPort.postMessage({id:message.id,ok:false,error:e.code||e.message});}return;
 }
 queue=queue.then(async()=>{
 try{if(message.type==='package-authority'){if(!Number.isSafeInteger(message.revision)||message.revision<=authorityRevision)throw Error('reference_drift');const next=new Packages(workerData.root,{authority:message.authority});packages=next;authorityRevision=message.revision;parentPort.postMessage({id:message.id,ok:true,value:{revision:authorityRevision}});return;}if(!Object.hasOwn(methods,message.method))throw Error('Unknown controlled operation');const value=await methods[message.method](...message.args);parentPort.postMessage({id:message.id,ok:true,value});}
 catch(e){parentPort.postMessage({id:message.id,ok:false,error:e.code||e.message,code:e.code??null});}
});});
