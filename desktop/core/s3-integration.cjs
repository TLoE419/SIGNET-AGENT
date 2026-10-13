'use strict';
const path=require('node:path'),fs=require('node:fs');
const {Registry,VERSION,canonical,hash}=require('./s3/registry.cjs');
const ADAPTER='SIGNET-P3-O2-adapter-v1';
const fail=code=>{const e=Error(code);e.code=code;throw e;};
const copy=x=>JSON.parse(canonical(x));
const PLAN_KEYS={profileCheckPlan:['profileRef','endpointId','requestId'],transferPlan:['bindingRef','direction','sourceTokens','destinationRootId','relativePaths','requestId'],submissionPlanInput:['bindingRef','stagePlanHash','requestId']};
const ERRORS=new Set(['schema_invalid','unsupported_version','reference_not_found','reference_drift','revision_conflict','profile_in_use','needs_user_auth','host_key_unverified','host_key_mismatch','endpoint_role_mismatch','root_unverified','unsafe_path','capability_unknown','capability_expired','resource_unsupported','operation_conflict','operation_unknown','io_conflict','permission_denied','record-limit']);
const BLOCKED=new Set(['reference_not_found','reference_drift','needs_user_auth','host_key_unverified','host_key_mismatch','endpoint_role_mismatch','root_unverified','capability_unknown','capability_expired','resource_unsupported','permission_denied']);
function exact(p,keys){if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!keys.includes(k))||Buffer.byteLength(canonical(p))>65536)fail('schema_invalid');}
class Configuration{
 constructor(root,store,operations,ports={}){
  this.store=store;this.operations=operations;
  // Production has no authority provider. Only a future accepted core adapter may supply it.
  this.registry=new Registry({root:path.join(operations.root,'s3'),readDraft:id=>this.readDraft(id),readCapability:ports.readCapability??(async()=>null),authorize:ports.authorize??(async()=>null),...(ports.now?{now:ports.now}:{})});
 }
 readDraft(id){
  let d;try{d=this.store.draftLoad(id);}catch(e){if(e.code==='ENOENT')return null;fail('reference_not_found');}
  if(d.issues.length)return null;
  const result={draftId:d.draft.id,revision:d.draft.revision,contentHash:d.contentHash};
  if(d.validation?.status==='validated'){result.validationRef={validationId:d.validation.validationId,revision:d.draft.revision,contentHash:hash(d.validation)};result.inputManifestHash=hash(d.validation.inputManifest);}
  return result;
 }
 list(p={}){
  exact(p,[]);return this.registry.transaction(s=>{
   const current=(bucket,type)=>Object.values(s[bucket]).filter(e=>!e.deleted).slice(0,128).map(e=>{const v=e.versions[e.current],ref={[type+'Id']:v[type+'Id'],revision:v.revision,contentHash:v.contentHash};return this.registry.record(s,type,ref);});
   const operations=[],operationIssues=[];for(const name of this.operations.names()){try{const r=this.operations.record(name.slice(0,-5));if(r.kind==='s3-plan')operations.push({operationId:r.operationId,requestId:r.requestId,subject:r.frozen.subject,profileRef:r.frozen.refs.profileRef,method:r.frozen.method,status:r.status,error:r.error,revision:r.revision,checkedAt:r.checkedAt,executeEnabled:false});}catch(e){operationIssues.push({recordId:name.slice(0,-5),code:e.code??'corrupt-record'});}}operations.sort((a,b)=>b.checkedAt.localeCompare(a.checkedAt));
   return {contractVersion:VERSION,adapterVersion:ADAPTER,profiles:current('profiles','profile'),resources:current('resources','resourcePlan'),operations:operations.slice(0,100),operationIssues:operationIssues.slice(0,100),operationsTruncated:operations.length>100||operationIssues.length>100,truncated:Object.values(s.profiles).length>128||Object.values(s.resources).length>128,authentication:'unknown',transferReady:false,jobReady:false,executeEnabled:false,missing:['current-authority-provider','trusted-endpoint-capability','accepted-transfer-executor','S4-submit-approval']};
  });
 }
 async plan(method,args){
  exact(args,PLAN_KEYS[method]);if(Object.keys(args).length!==PLAN_KEYS[method].length||typeof args.requestId!=='string'||! /^[A-Za-z0-9_-]{8,80}$/.test(args.requestId))fail('schema_invalid');
  let subject,refs;
  if(method==='profileCheckPlan'){
   await this.registry.transaction(s=>this.registry.record(s,'profile',args.profileRef));
   subject={kind:'profile',ref:args.profileRef};refs={profileRef:args.profileRef,bindingRef:null,resourceRef:null,draftRef:null,capabilityRefs:[]};
  }else{
   const binding=await this.registry.transaction(s=>this.registry.record(s,'binding',args.bindingRef,false));
   subject={kind:'draft',ref:binding.content.draftRef};refs={bindingRef:args.bindingRef,profileRef:binding.content.profileRef,resourceRef:binding.content.resourceRef,draftRef:binding.content.draftRef,capabilityRefs:[]};
  }
  let intent=null,blocked='executor_unavailable';
  try{intent=await this.registry[method](args);refs={...refs,capabilityRefs:intent.plan.capabilityRefs??[]};}
  catch(e){if(!BLOCKED.has(e.code))throw e;blocked=e.code;}
  const frozen={adapterVersion:ADAPTER,registryVersion:VERSION,method,subject,refs,input:copy(args),intentId:intent?.operationId??null,intentHash:intent?.operationHash??null,plan:intent?.plan??null};
  const operation=this.operations.registerConfiguration({requestId:args.requestId,frozen,blocked});
  return {intent,operation,executeEnabled:false,transferReady:false,jobReady:false,blocked:operation.error.code,missing:['current-authority-provider','accepted-effect-executor'],adapterVersion:ADAPTER};
 }
 async call(method,p){
  const lock=path.join(this.registry.root,'adapter.lock');let fd;try{fd=fs.openSync(lock,'wx',0o600);}catch{fail('io_conflict');}
  try{
   if(method==='configurationList')return await this.list(p);
   if(Object.hasOwn(PLAN_KEYS,method))return await this.plan(method,p);
   if(!['profileSave','profileDelete','resourcePlanSave','bindingSave','bindingLoad'].includes(method))fail('schema_invalid');
   if(method==='profileDelete'&&p?.profileRef?.profileId)for(const name of this.operations.names()){const r=this.operations.record(name.slice(0,-5));if(r.kind==='s3-plan'&&r.frozen.refs.profileRef?.profileId===p.profileRef.profileId)fail('profile_in_use');}
   return await this.registry[method](p);
  }catch(e){if(ERRORS.has(e.code))throw e;fail('io_conflict');}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
 }

}
module.exports={Configuration,ADAPTER};
