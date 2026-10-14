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
const {Exporter}=require('./s5/exporter.cjs'),{request:exportRequest}=require('./export-api.cjs');
const exportQueries=new Map();let exportQuery=0;
function resolveDestination(payload){return new Promise(resolve=>{const queryId=++exportQuery,timer=setTimeout(()=>{exportQueries.delete(queryId);resolve(null);},5000);exportQueries.set(queryId,{resolve,timer});parentPort.postMessage({type:'export-resolve',queryId,token:payload.destinationToken,payload});});}
function exporter(){if(!packages.index)throw Error('source_authority_unavailable');return new Exporter({stateRoot:require('node:path').join(workerData.root,'s5/exports'),packageIndex:packages.index,resolveDestination,owner:operations.owner,now:Date.now});}
const {Imports}=require('./import-integration.cjs');
const importQueries=new Map();let importQuery=0,importCommandId=null;
function resolveImport(request){return new Promise(resolve=>{const queryId=++importQuery,timer=setTimeout(()=>{importQueries.delete(queryId);resolve(null);},5000);importQueries.set(queryId,{resolve,timer});parentPort.postMessage({type:'import-resolve',queryId,commandId:importCommandId,payload:{owner:operations.owner,request}});});}
function imports(){return new Imports(workerData.root,packages,operations.owner,resolveImport);}
methods.draftList=()=>imports().list();methods.draftLoad=id=>imports().load(id);
methods.draftSave=async(p,sources)=>{if(p?.workflow==='import'||p?.id&&(await imports().load(p.id)).importOnly)throw Error('use_package_import');return store.draftSave(p,sources);};
let queue=Promise.resolve();
parentPort.on('message',message=>{
 if(message.type==='import-resolved'){const pending=importQueries.get(message.queryId);if(pending){importQueries.delete(message.queryId);clearTimeout(pending.timer);pending.resolve(message.grant);}return;}
 if(message.type==='export-resolved'){const pending=exportQueries.get(message.queryId);if(pending){exportQueries.delete(message.queryId);clearTimeout(pending.timer);pending.resolve(message.grant);}return;}

 if(Object.hasOwn(s2,message.method)){
  try{const value=s2[message.method](...message.args);parentPort.postMessage({id:message.id,ok:true,value});}
  catch(e){parentPort.postMessage({id:message.id,ok:false,error:e.code||e.message});}return;
 }
 queue=queue.then(async()=>{
 try{if(message.type==='import-command'){importCommandId=message.id;try{const api=imports();let value;if(message.action==='prepare')value=await api.prepare(message.payload);else if(message.action==='execute')value=await api.execute(message.payload);else if(message.action==='inspect')value=await api.inspect(message.payload);else if(message.action==='list')value=await api.list();else if(message.action==='load')value=await api.load(message.payload);else if(message.action==='context')value=await api.context(message.payload);else throw Error('schema_invalid');parentPort.postMessage({id:message.id,ok:true,value});}finally{importCommandId=null;}return;}if(message.type==='export-prepare'){const p=exportRequest(message.payload),s=await packages.call('packageGet',{packageId:p.packageId});if(s.packageHash!==p.packageHash)throw Error('reference_drift');for(const id of p.artifactIds)if(!s.artifacts.some(a=>a.artifactId===id&&a.state==='ready'))throw Error('not_ready');parentPort.postMessage({id:message.id,ok:true,value:{owner:operations.owner,packageId:s.packageId,packageHash:s.packageHash,artifacts:s.artifacts}});return;}if(message.type==='export-execute'){const {destinationToken,...p}=message.payload;exportRequest(p);const result=await exporter().execute({...p,destinationToken});parentPort.postMessage({id:message.id,ok:true,value:result});return;}if(message.type==='export-status'){exportRequest(message.payload,true);const result=exporter().status(message.payload);parentPort.postMessage({id:message.id,ok:true,value:{...result,historicalOnly:true,destinationReauthorizationRequired:true}});return;}if(message.type==='package-authority'){if(!Number.isSafeInteger(message.revision)||message.revision<=authorityRevision)throw Error('reference_drift');const next=new Packages(workerData.root,{authority:message.authority});packages=next;authorityRevision=message.revision;parentPort.postMessage({id:message.id,ok:true,value:{revision:authorityRevision}});return;}if(!Object.hasOwn(methods,message.method))throw Error('Unknown controlled operation');const value=await methods[message.method](...message.args);parentPort.postMessage({id:message.id,ok:true,value});}
 catch(e){parentPort.postMessage({id:message.id,ok:false,error:e.code||e.message,code:e.code??null});}
});});
