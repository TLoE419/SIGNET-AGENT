'use strict';
// Local planning only. Provider ports are core-owned and never accepted over IPC.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {hash,canonical}=require('./s3/registry.cjs'),J=require('./s4/planning.cjs');
const ADAPTER='SIGNET-J4-O2-adapter-v1',O2_BASE='4e5e735d20686014a4761d4fb5cc115d294a5128';
const STAGES=['genotype','expression','adjustment','ciseqtl','network','visualization'];
const KEYS={stagePlanPrepare:['draftId','stage','mode','requestId'],stagePlanList:['draftId'],stagePlanStatus:['operationId'],stageGraphExpand:['operationId','revision','expectedGraphRevision'],stageReserve:['operationId','revision','expectedGraphRevision','nodeId','requestId'],stageReconcile:['operationId','revision'],stageCancellation:['operationId','revision','confirmed'],stageRetry:['operationId','revision','requestId']};
const fail=code=>{throw Object.assign(Error(code),{code});},same=(a,b)=>canonical(a)===canonical(b),uid=()=> 'at-'+crypto.randomBytes(16).toString('hex');
function exact(p,keys){if(!p||Object.getPrototypeOf(p)!==Object.prototype||Object.keys(p).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(p,k))||Buffer.byteLength(canonical(p))>16384)fail('schema_invalid');}
function token(v){if(typeof v!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(v))fail('schema_invalid');}
const ref=(x,k)=>({[k]:x[k],revision:x.revision,contentHash:x.contentHash});
class Stages{
 constructor(configuration,operations,ports={}){this.c=configuration;this.o=operations;this.ports=ports;this.now=ports.now??Date.now;this.base=path.join(operations.root,'s4');operations.ensure(this.base);}
 records(){return this.o.names().map(n=>this.o.record(n.slice(0,-5))).filter(r=>r.kind==='s4-plan');}
 async snapshot(draftId){
  token(draftId);const d=this.c.store.draftLoad(draftId),source=this.c.readDraft(draftId),bound=await this.c.registry.bindingLoad({draftId}),b=bound.binding,missing=[];
  const draftRef={draftId:d.draft.id,revision:d.draft.revision,contentHash:d.contentHash};
  if(!source)missing.push('source_unavailable');if(!source?.validationRef)missing.push('input_validation_missing');if(!b)missing.push('binding_missing');if(bound.status==='stale')missing.push('reference_drift');
  const refs={draftRef,bindingRef:b?ref(b,'bindingId'):null,profileRef:b?.content.profileRef??null,resourceRef:b?.content.resourceRef??null,capabilityRefs:[]};
  if(b){if(!same(b.content.draftRef,draftRef))missing.push('reference_drift');if(!refs.profileRef)missing.push('profile_missing');if(!refs.resourceRef)missing.push('resource_missing');if(refs.resourceRef)try{const r=await this.c.registry.transaction(s=>this.c.registry.record(s,'resourcePlan',refs.resourceRef));refs.capabilityRefs=r.content.capabilityRef?[r.content.capabilityRef]:[];}catch(e){missing.push(e.code??'reference_drift');}}
  return {draft:d.draft,source,refs,missing:[...new Set(missing)],validationRef:source?.validationRef??null,inputManifestHash:source?.inputManifestHash??null};
 }
 stages(d){const a=STAGES.indexOf(d.entryStage),b=STAGES.indexOf(d.finishAfter);return STAGES.map((stage,i)=>({stage,dependencies:i?[STAGES[i-1]]:[],required:a>=0&&b>=a&&i>=a&&i<=b,externalInputBoundary:i===a}));}
 async prepare(p,retryOf=null){
  token(p.requestId);if(p.requestId.length<8)fail('schema_invalid');if(!STAGES.includes(p.stage))fail('schema_invalid');if(!['single-stage-batch','network-controller-batches','network-allocation-steps'].includes(p.mode)||(p.stage==='network')===(p.mode==='single-stage-batch'))fail('mode_conflict');
  const snap=await this.snapshot(p.draftId),selection={...p,retryOf:retryOf?.operationId??null};
  const old=this.records().find(r=>r.requestId===p.requestId);if(old){if(!same(old.frozen.selection,selection))fail('operation_conflict');if(!same(old.frozen.refs,snap.refs)||!same(old.frozen.validationRef,snap.validationRef)||!same(old.frozen.inputManifestHash,snap.inputManifestHash))fail('reference_drift');return this.status(old);}
  if(this.records().length>=128)fail('record-limit');const attemptId=uid(),owner=this.o.owner,analysisId='draft-'+p.draftId,stages=this.stages(snap.draft),index=stages.findIndex(x=>x.stage===p.stage),missing=[...snap.missing];
  if(!stages[index].required)missing.push('stage_outside_saved_workflow');
  let plan=null,sourceIntent=null;const refs={...snap.refs,o2:{version:'O2-schema2',commit:O2_BASE}};
  let provided=null;
  if(!missing.length&&this.ports.preflight)provided=await this.ports.preflight({selection,refs,analysisId,attemptId,owner,validationRef:snap.validationRef,inputManifestHash:snap.inputManifestHash});
  if(!provided)missing.push('trusted_preflight_provider_missing');
  if(index>0&&stages[index-1].required&&!provided?.priorStages?.some(x=>x.stage===stages[index-1].stage&&x.verified===true&&same(x.draftRef,snap.refs.draftRef)&&x.inputManifestHash===snap.inputManifestHash&&/^[a-f0-9]{64}$/.test(x.outputManifestHash??'')))missing.push('prior_stage_output_unverified');
  if(refs.bindingRef&&refs.profileRef&&refs.resourceRef){
   const input={schemaVersion:1,analysisId,attemptId,owner,stage:p.stage,mode:p.mode,nboots:snap.draft.parameters.nboots,refs,official:provided?.official??{commit:null,sourceHash:null,containerHash:null},rootRefs:provided?.rootRefs??Object.fromEntries(['workspace','tools','container','inputs','outputs'].map(k=>[k,null])),controllerResource:provided?.controllerResource??null,phaseResources:provided?.phaseResources??{},approvalBudgetRef:provided?.approvalBudgetRef??null};
   if(provided){
    // Resolve every exact resource, including children, from the saved P3 registry.
    await this.c.registry.transaction(s=>{for(const r of [input.controllerResource,...Object.values(input.phaseResources)].filter(Boolean)){const v=this.c.registry.record(s,'resourcePlan',r.p3Ref).content;if(!same(v.profileRef,refs.profileRef)||v.cores!==r.p3Cores||v.account!==r.account||v.partition!==r.partition||v.qos!==r.qos||v.memoryMiB!==r.memoryMiB||v.walltimeSeconds!==r.walltimeSeconds||!same(v.capabilityRef,refs.capabilityRefs[0])||r.memoryMode!=='per-node')fail('reference_drift');}return true;});
   }
   plan=J.stagePlanBuild(input,provided?.evidence??null,this.now());missing.push(...plan.blockedIssues);
   if(provided&&plan.preflightReady){
    try{sourceIntent=await this.c.registry.submissionPlanInput({bindingRef:refs.bindingRef,stagePlanHash:plan.planHash,requestId:'s4-src-'+hash(selection).slice(0,32)});
     const v=sourceIntent.plan;if(!same(v.capabilityRefs,refs.capabilityRefs)||v.inputManifestHash!==snap.inputManifestHash||v.rootMappingHash!==provided.evidence.rootMappingHash)fail('reference_drift');
     const cap=await this.c.registry.readCapability(refs.capabilityRefs[0]);if(!cap||Date.parse(cap.checkedAt)!==provided.evidence.checkedAt||Date.parse(cap.expiresAt)!==provided.evidence.expiresAt||cap.artifactHashes?.tools!==input.official.sourceHash||cap.artifactHashes?.container!==input.official.containerHash||cap.officialCommit!==input.official.commit)fail('reference_drift');
     for(const [role,r] of Object.entries(input.rootRefs)){const configured=await this.c.registry.transaction(s=>this.c.registry.record(s,'profile',refs.profileRef).content.roots.find(x=>x.role===role));if(!configured||r?.rootId!==configured.rootId||r.contentHash!==hash({rootId:configured.rootId,access:cap.rootAccess[configured.rootId]}))fail('reference_drift');}
    }catch(e){missing.push(e.code??'capability_unknown');sourceIntent=null;}
   }
  }
  if(retryOf&&!['succeeded','failed','cancelled'].includes(retryOf.local.result?.status)&&retryOf.local.cancellation?.status!=='cancelled')missing.push('previous_attempt_status_unverified');
  missing.push('executor_unavailable');if(p.stage==='network')missing.push('generated_batch_manifest_required');
  const frozen={adapterVersion:ADAPTER,selection,refs:snap.refs,validationRef:snap.validationRef,inputManifestHash:snap.inputManifestHash,stages,plan,sourceIntent,missing:[...new Set(missing)],retry:retryOf&&plan?J.retryPlan({plan,previousAttemptId:retryOf.attemptId,newAttemptId:attemptId,scope:'full-required-stage',purge:false,oldRunSucceeded:retryOf.local.result?.status==='succeeded'}):null};
  return this.status(this.o.registerStage({requestId:p.requestId,attemptId,frozen}));
 }
 ledger(r){if(!r.frozen.plan)fail('plan_unavailable');const dir=path.join(this.base,r.attemptId);this.o.ensure(dir);return new J.GraphLedger(dir,r.frozen.plan,this.now);}
 graph(r){const dir=path.join(this.base,r.attemptId),file=path.join(dir,'graph.json');if(!fs.existsSync(file))return {revision:0,actualGeneratedBatches:0,intents:[],expansionStopped:r.local?.expansionStopped??false};this.ledger(r);const stat=fs.lstatSync(this.o.safe(file));if(!stat.isFile()||stat.size>4*1024*1024)fail('record-limit');const s=JSON.parse(fs.readFileSync(file,'utf8'));if(s.planHash!==r.frozen.plan.planHash||!same(s.frozenRefs,r.frozen.plan.content.refs))fail('reference_drift');return {revision:s.graphRevision,actualGeneratedBatches:Object.keys(s.batches).length,intents:Object.values(s.intents).map(x=>({intentId:x.intentId,nodeId:x.payload.node.nodeId,status:x.status})),expansionStopped:s.expansionStopped,batches:Object.values(s.batches)};}
 status(r){const graph=this.graph(r);return {...r,local:{...r.local,expansionStopped:graph.expansionStopped},graph,resources:r.frozen.plan?[r.frozen.plan.content.controllerResource,...Object.values(r.frozen.plan.content.phaseResources)].filter(Boolean).map(resource=>J.resourceRenderAndParse({resource,mode:'render',stage:r.frozen.selection.stage})):[],projection:{...this.o.projection(r),resourceApplication:'not-applied',schedulerResources:'unknown',actualCancellationPerformed:false},executeEnabled:false};}
 async current(r){const s=await this.snapshot(r.frozen.selection.draftId);if(!same(s.refs,r.frozen.refs)||!same(s.validationRef,r.frozen.validationRef)||!same(s.inputManifestHash,r.frozen.inputManifestHash)||s.missing.length)fail('reference_drift');const unresolved=r.frozen.missing.filter(x=>!['executor_unavailable','generated_batch_manifest_required'].includes(x));if(unresolved.length)fail(unresolved[0]);if(!r.frozen.plan?.preflightReady||!r.frozen.sourceIntent)fail('capability_stale');const check=await this.c.registry.submissionPlanInput({bindingRef:s.refs.bindingRef,stagePlanHash:r.frozen.plan.planHash,requestId:r.frozen.sourceIntent.requestId??'s4-src-'+hash(r.frozen.selection).slice(0,32)});if(!same(check,r.frozen.sourceIntent))fail('reference_drift');}
 key(r,key){const p=r.frozen.plan.content;if(['analysisId','attemptId','owner'].some(k=>key?.[k]!==p[k]))fail('lineage_mismatch');const nodes=[...p.plannedGraph,...(this.graph(r).batches??[])],n=nodes.find(n=>n.nodeId===key.nodeId);if(!n||n.kind==='scientific-unit'||n.phase!==key.phase)fail('lineage_mismatch');const step=n.kind==='allocation-step';if(step!==Object.hasOwn(key,'parentJobId')||step!==Object.hasOwn(key,'stepId'))fail('lineage_mismatch');if(n.paramsHash&&n.paramsHash!==key.paramsHash||n.subscriptHash&&n.subscriptHash!==key.subscriptHash)fail('lineage_mismatch');if(n.phase===null&&(key.paramsHash!==null||key.subscriptHash!==null))fail('lineage_mismatch');return key;}
 async call(method,p){
  if(!Object.hasOwn(KEYS,method))fail('schema_invalid');exact(p,KEYS[method]);const file=path.join(this.c.registry.root,'adapter.lock');let fd;try{fd=fs.openSync(file,'wx',0o600);}catch{fail('io_conflict');}
  try{
   if(method==='stagePlanPrepare')return await this.prepare(p);
   if(method==='stagePlanList'){token(p.draftId);const all=this.records().filter(r=>r.frozen.selection.draftId===p.draftId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));return {operations:all.slice(0,100).map(r=>({operationId:r.operationId,attemptId:r.attemptId,revision:r.revision,stage:r.frozen.selection.stage,mode:r.frozen.selection.mode,status:r.status,missing:r.frozen.missing,local:r.local})),truncated:all.length>100,executeEnabled:false};}
   const r=this.o.record(p.operationId);if(r.kind!=='s4-plan')fail('identity-mismatch');if(method==='stagePlanStatus')return this.status(r);
   if(!Number.isSafeInteger(p.revision)||r.revision!==p.revision)fail('stale-revision');
   if(method==='stageCancellation'){
    if(typeof p.confirmed!=='boolean')fail('schema_invalid');if(!p.confirmed)return {...this.status(r),confirmationRequired:true};
    if(r.frozen.plan)this.ledger(r).stopExpansion();let cancellation=null;
    if(r.frozen.plan&&this.ports.cancellation){const c=await this.ports.cancellation(r);if(c){c.ownedKeys.forEach(k=>this.key(r,k));cancellation=J.cancellationPlan({plan:r.frozen.plan,keys:c.ownedKeys,observations:c.observations,confirmation:true,controllerStopped:c.controllerStopped,noResidualEvidence:c.noResidualEvidence},{planHash:r.frozen.plan.planHash,ownedKeys:r.local.schedulerKeys??[],now:this.now()});}}
    return this.status(this.o.stageUpdate(r,{...r.local,expansionStopped:true,actualCancellationPerformed:false,cancellation,state:'cancellation-planned',missing:cancellation?[]:['owned_cancellation_provider_missing']}));
   }
   if(method==='stageRetry'&&!r.frozen.plan)fail('plan_unavailable');
   if(method==='stageRetry')return await this.prepare({requestId:p.requestId,draftId:r.frozen.selection.draftId,stage:r.frozen.selection.stage,mode:r.frozen.selection.mode},r);
   const ledger=this.ledger(r);if(['stageGraphExpand','stageReserve'].includes(method)&&this.graph(r).revision!==p.expectedGraphRevision)fail('revision_conflict');await this.current(r);if(r.local.expansionStopped)fail('submission_unknown');let result;
   if(method==='stageGraphExpand'){
    if(!Number.isSafeInteger(p.expectedGraphRevision)||p.expectedGraphRevision<0)fail('schema_invalid');if(!this.ports.generated)fail('producer_missing');const generated=await this.ports.generated(r);await this.current(r);if(!generated)fail('batch_manifest_incomplete');result=ledger.expand({expectedRevision:p.expectedGraphRevision,generated});result={graphRevision:result.ledger.graphRevision,actualGeneratedBatches:result.actualGeneratedBatches,usage:result.usage};
   }else if(method==='stageReserve'){
    token(p.nodeId);token(p.requestId);const phase1Proof=this.ports.phase1Proof?await this.ports.phase1Proof(r):undefined;await this.current(r);result=ledger.reserve({expectedRevision:p.expectedGraphRevision,nodeId:p.nodeId,requestId:p.requestId,...(phase1Proof?{phase1Proof}:{})});result={intentId:result.intentId,nodeId:p.nodeId,status:result.status,resubmit:false,executeEnabled:false};
   }else if(method==='stageReconcile'){
    if(!this.ports.observe)fail('observation_provider_missing');const a=await this.ports.observe(r);await this.current(r);if(!a)fail('observation_provider_missing');this.key(r,a.owned);result=J.submissionSnapshotParse({...a,now:this.now()});
   }
   if(!result)fail('schema_invalid');const schedulerKeys=[...(r.local.schedulerKeys??[])];for(const key of result.schedulerKeys??[]){const known=schedulerKeys.find(k=>k.nodeId===key.nodeId);if(known&&!same(known,key))fail('lineage_mismatch');if(!known)schedulerKeys.push(key);}if(schedulerKeys.length>32)fail('record-limit');return this.status(this.o.stageUpdate(r,{...r.local,state:method,result,schedulerKeys}));
  }catch(e){const code=typeof e.code==='string'&&/^[a-z][a-z_-]{1,60}$/.test(e.code)?e.code:'io_conflict';fail(code);}finally{fs.closeSync(fd);fs.unlinkSync(file);}
 }
}
module.exports={Stages,ADAPTER,STAGES};
