'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const forbiddenAttempts=[];
for(const [name,methods] of [['node:child_process',['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']],['node:net',['connect','createConnection']],['node:tls',['connect']],['node:http',['request','get']],['node:https',['request','get']],['node:dns',['lookup','resolve']]])for(const method of methods)require(name)[method]=()=>{forbiddenAttempts.push(name+'.'+method);throw Error('Forbidden external execution');};
require('node:net').Socket.prototype.connect=()=>{forbiddenAttempts.push('socket');throw Error('Forbidden socket');};global.fetch=()=>{forbiddenAttempts.push('fetch');throw Error('Forbidden fetch');};
const runtime=path.resolve(__dirname,'../../../..','S4-build-evidence/runtime');fs.mkdirSync(runtime,{recursive:true});
test('G4 official and scheduler time formats round-trip beyond one day without implicit conversion',()=>{
 const {timeFormats,parseTime}=require('./planning.cjs');assert.deepEqual(timeFormats(90061),{official:'25:01:01',slurm:'1-01:01:01'});assert.equal(parseTime('25:01:01','official'),90061);assert.equal(parseTime('1-01:01:01','slurm'),90061);assert.throws(()=>parseTime('1-01:01:01','official'),{code:'time_format_invalid'});for(const n of [0,-1,NaN,true])assert.throws(()=>timeFormats(n),{code:'time_format_invalid'});
});
function reference(id){return {[id]:'synthetic-'+id,revision:1,contentHash:'a'.repeat(64)};}
function resource(role='controller',cores=2){return {resourceId:'r-'+role,revision:1,role,p3Ref:{...reference('resourcePlanId'),contentHash:String(cores).repeat(64).slice(0,64)},p3Cores:cores,mappingVersion:'explicit-v1',layout:'single-process',account:'synthetic',partition:'synthetic',qos:null,nodes:1,ntasks:1,cpusPerTask:cores,memoryMode:'per-node',memoryMiB:2048,walltimeSeconds:90,paraFlyConcurrency:cores};}
function input(mode='network-controller-batches'){
 return {schemaVersion:1,analysisId:'a-synthetic',attemptId:'at-new',owner:'owner-synthetic',stage:mode==='single-stage-batch'?'genotype':'network',mode,nboots:2,refs:{draftRef:reference('draftId'),bindingRef:reference('bindingId'),profileRef:reference('profileId'),resourceRef:reference('resourcePlanId'),capabilityRefs:[reference('snapshotId')],o2:{version:'S2-unknown',commit:'b'.repeat(40)}},official:{commit:'c'.repeat(40),sourceHash:'d'.repeat(64),containerHash:'e'.repeat(64)},rootRefs:Object.fromEntries(['workspace','tools','container','inputs','outputs'].map(x=>[x,{rootId:x,contentHash:'f'.repeat(64)}])),controllerResource:resource(mode==='single-stage-batch'?'single-stage':'controller'),phaseResources:mode==='single-stage-batch'?{}:{phase1:resource(mode==='network-controller-batches'?'network-child':'network-step',4),phase2:resource(mode==='network-controller-batches'?'network-child':'network-step',4)},approvalBudgetRef:reference('budgetId')};
}
function evidence(a){return {resolvedRefs:a.refs,rootMappingHash:'a'.repeat(64),placement:'compute-allocation',endpointRole:'login',nestedSubmission:true,controllerBudgetIncludesWait:true,stepAllocation:true,containerMounts:true,schedulerVersion:'synthetic-v1',mappingVersion:'explicit-v1',chronOver24h:false,checkedAt:1000,expiresAt:100000,approval:{budgetRef:a.approvalBudgetRef,analysisId:a.analysisId,attemptId:a.attemptId,owner:a.owner,stage:a.stage,mode:a.mode,sourceHash:a.official.sourceHash,maxSchedulerJobs:20,maxConcurrentJobs:20,maxConcurrentCPUs:64,maxConcurrentMemoryMiB:65536,maxCPUSeconds:100000,maxMemoryMiBSeconds:100000000,maxControllerSeconds:1000},resolvedResources:[a.controllerResource,...Object.values(a.phaseResources)].filter(Boolean).map(r=>({resourceRef:r.p3Ref,profileRef:a.refs.profileRef,cores:r.p3Cores})),resolvedRootRefs:a.rootRefs,resolvedOfficial:a.official,resourceLimits:{maxCPUs:64,maxMemoryMiB:65536,maxWalltimeSeconds:100000}};}
test('G1 explicit network modes have distinct graphs; unknown/transfer placement never launches',()=>{
 const {stagePlanBuild}=require('./planning.cjs');const a=input(),b=stagePlanBuild(a,null,2000);assert.equal(b.launchReady,false);assert.ok(b.blockedIssues.includes('placement_unverified'));
 const f=stagePlanBuild(a,evidence(a),2000);assert.equal(f.graph.pendingKind,'batch-job');const t=input('network-allocation-steps');assert.equal(stagePlanBuild(t,evidence(t),2000).graph.pendingKind,'allocation-step');
 const wrong=evidence(a);wrong.endpointRole='transfer';assert.ok(stagePlanBuild(a,wrong,2000).blockedIssues.includes('placement_unverified'));assert.throws(()=>stagePlanBuild({...a,stage:'genotype'},null),{code:'mode_conflict'});
});
test('G2 legacy template missing memory/account is not-applied; explicit CPU mapping round-trips',()=>{
 const {resourceRenderAndParse}=require('./planning.cjs');const r=resource('network-child',8);const legacy='#!/bin/bash\n#SBATCH -p synthetic\n#SBATCH -n 8\n#SBATCH -N 1\n#SBATCH -t 00:01:30\n';const inspected=resourceRenderAndParse({resource:r,mode:'inspect',stage:'network',scriptText:legacy});assert.ok(inspected.notApplied.includes('memoryMiB'));assert.ok(inspected.notApplied.includes('account'));assert.equal(inspected.executeEnabled,false);
 const rendered=resourceRenderAndParse({resource:r,mode:'render',stage:'network',originalTemplateHash:'f'.repeat(64)});assert.equal(rendered.parsed.ntasks,1);assert.equal(rendered.parsed.cpusPerTask,8);assert.equal(rendered.parsed.memoryMiB,2048);assert.deepEqual(rendered.notApplied,[]);assert.match(rendered.patchPlan.target,/new-attempt/);
 assert.throws(()=>resourceRenderAndParse({resource:{...r,ntasks:8},mode:'render',stage:'network'}),{code:'resource_mapping_ambiguous'});
});
function compiled(mode){const {stagePlanBuild}=require('./planning.cjs');const a=input(mode);return stagePlanBuild(a,evidence(a),2000);}
function generated(p,phase=1,fileId='sub1',params='Rscript SYNTHETIC-UNIT\n'){
 const {resourceRenderAndParse}=require('./planning.cjs'),crypto=require('node:crypto');const textHash=s=>crypto.createHash('sha256').update(s).digest('hex');const r=resourceRenderAndParse({resource:p.content.phaseResources['phase'+phase],mode:'render',stage:'network'});
 return {fileId,phase,paramsText:params,paramsHash:textHash(params),subscriptText:r.script,subscriptHash:r.scriptHash,geneCount:20,units:params.split('\n').filter(l=>l.trim()).map((_,i)=>({commandIndex:i+1,bootstrapIndex:i%3,geneRange:[1,10]}))};
}
function ledger(p){const {GraphLedger}=require('./planning.cjs');return new GraphLedger(fs.mkdtempSync(path.join(runtime,'graph-')),p,()=>2000);}
function key(nodeId='controller',jobId='123',phase=null){return {cluster:'synthetic-cluster',jobId,submitTime:'2026-10-13T00:00:00.000Z',user:'synthetic',workDir:'/owned/a-synthetic/at-new',analysisId:'a-synthetic',attemptId:'at-new',owner:'owner-synthetic',nodeId,phase,paramsHash:phase?'a'.repeat(64):null,subscriptHash:phase?'b'.repeat(64):null};}
test('G3 controller cost stays distinct from children; T comments do not allocate step resources',()=>{
 const {resourceRenderAndParse}=require('./planning.cjs');const p=compiled();const l=ledger(p),out=l.expand({expectedRevision:0,generated:[generated(p)]});assert.equal(out.usage.maxConcurrentCPUs,6);assert.equal(out.usage.maxSchedulerJobs,2);
 const t=compiled('network-allocation-steps');assert.throws(()=>ledger(t).expand({expectedRevision:0,generated:[generated(t)]}),{code:'budget_exceeded'});
 const step=resourceRenderAndParse({resource:resource('network-step',4),mode:'render',stage:'network'});assert.ok(step.notApplied.includes('step-allocation-must-be-observed'));assert.equal(step.parsed.memoryMiB,undefined);assert.ok(step.stepArgv.includes('--cpus-per-task=4'));
});
test('G4 long official time requires separately proved chron support, and directives reject injection/duplicates',()=>{
 const {stagePlanBuild,resourceRenderAndParse}=require('./planning.cjs');const a=input();a.controllerResource.walltimeSeconds=90061;let e=evidence(a);assert.ok(stagePlanBuild(a,e,2000).blockedIssues.includes('time_format_invalid'));e.chronOver24h=true;assert.equal(stagePlanBuild(a,e,2000).preflightReady,true);
 const r=resource('network-child');for(const scriptText of ['#SBATCH --mem=2048M\n#SBATCH --mem-per-cpu=10M\n','#SBATCH --export=ALL\n','#SBATCH --account=$(BAD)\n','#SBATCH --ntasks=2\n#SBATCH -n 2\n'])assert.throws(()=>resourceRenderAndParse({resource:r,mode:'inspect',stage:'network',scriptText}),{code:'resource_not_applied'});
});
test('G5 actual nonempty manifests count jobs, CAS/reservations bound phase budget instead of nboots',()=>{
 const p=compiled(),l=ledger(p);assert.equal(p.graph.dynamicCount,null);
 const out=l.expand({expectedRevision:0,generated:[generated(p,1,'sub1','Rscript A\nRscript B\nRscript C\n'),generated(p,1,'sub2'),generated(p,2,'sub1')]});assert.equal(out.actualGeneratedBatches,3);assert.equal(out.schedulerJobUpperBound,4);assert.equal(out.usage.maxConcurrentCPUs,10);
 assert.throws(()=>l.expand({expectedRevision:0,generated:[]}),{code:'revision_conflict'});
 const empty=generated(p,1,'empty','');assert.throws(()=>ledger(p).expand({expectedRevision:0,generated:[empty]}),{code:'batch_manifest_incomplete'});
 const tinyInput=input(),tinyEvidence=evidence(tinyInput);tinyEvidence.approval.maxSchedulerJobs=1;const tiny=require('./planning.cjs').stagePlanBuild(tinyInput,tinyEvidence,2000);assert.throws(()=>ledger(tiny).expand({expectedRevision:0,generated:[generated(tiny)]}),{code:'budget_exceeded'});
 const bad=generated(p);bad.units[0].bootstrapIndex=3;assert.throws(()=>ledger(p).expand({expectedRevision:0,generated:[bad]}),{code:'schema_invalid'});
 const phase2=Object.values(out.ledger.batches).find(n=>n.phase===2);assert.throws(()=>l.reserve({expectedRevision:1,nodeId:phase2.nodeId,requestId:'phase2'}),{code:'output_unverified'});
});
test('G6 persisted logical request deduplicates; different node/phase/attempt cannot reuse it',()=>{
 const {GraphLedger,submissionSnapshotParse}=require('./planning.cjs');const p=compiled(),l=ledger(p),out=l.expand({expectedRevision:0,generated:[generated(p,1),generated(p,2)]});const nodes=Object.values(out.ledger.batches),one=nodes.find(n=>n.phase===1),two=nodes.find(n=>n.phase===2);
 const a=l.reserve({expectedRevision:1,nodeId:one.nodeId,requestId:'request'}),b=new GraphLedger(l.root,p,()=>2000).reserve({expectedRevision:1,nodeId:one.nodeId,requestId:'request'});assert.equal(a.intentId,b.intentId);assert.equal(b.status,'submission-unknown');
 const {hash}=require('../s3/registry.cjs');const proof={verified:true,completeGeneration:true,planHash:p.planHash,outputManifestHash:'a'.repeat(64),manifestHash:hash(nodes.filter(n=>n.phase===1))};assert.throws(()=>l.reserve({expectedRevision:1,nodeId:two.nodeId,requestId:'request',phase1Proof:proof}),{code:'operation_conflict'});
 const owned=key(one.nodeId,'123',1),now=10000;assert.equal(submissionSnapshotParse({format:'parsable',stdout:'123;synthetic-cluster\n',stderr:'',exitCode:0,owned,now}).status,'queued');
 for(const stdout of ['PID 123\n','debug 999\nSubmitted batch job 123\n','123\n123\n'])assert.equal(submissionSnapshotParse({format:'parsable',stdout,stderr:'',exitCode:0,owned,now}).status,'submission-unknown');
 const row={key:owned,state:'RUNNING',exitCode:'0:0',outputVerification:null};for(const records of [[],[row,row],[{...row,key:{...owned,attemptId:'other'}}]])assert.equal(submissionSnapshotParse({format:'history',snapshot:{checkedAt:now,records},owned,now}).status,'submission-unknown');
 assert.equal(submissionSnapshotParse({format:'history',snapshot:{checkedAt:0,records:[row]},owned,now:70000}).status,'submission-unknown');
});
test('G7 parent stopped with active child stays cancelling; cancellation requires exact frozen owned keys',()=>{
 const {cancellationPlan}=require('./planning.cjs'),p=compiled(),parent=key(),child=key('child','456',1),authority={planHash:p.planHash,ownedKeys:[parent,child],now:2000};const a={plan:p,keys:[parent,child],observations:[{key:parent,state:'CANCELLED',checkedAt:2000},{key:child,state:'RUNNING',checkedAt:2000}],confirmation:true,controllerStopped:true,noResidualEvidence:true};
 assert.equal(cancellationPlan(a,authority).status,'cancelling');a.observations[1].state='CANCELLED';assert.equal(cancellationPlan(a,authority).status,'cancelled');a.observations[1].checkedAt=-70000;assert.equal(cancellationPlan(a,authority).status,'cancelling');
 assert.throws(()=>cancellationPlan({...a,keys:[{...child,attemptId:'other'}]},authority),{code:'lineage_mismatch'});assert.throws(()=>cancellationPlan({...a,keys:[{...child,jobId:'999'}]},authority),{code:'lineage_mismatch'});
 const l=ledger(p);l.stopExpansion();assert.throws(()=>l.expand({expectedRevision:0,generated:[]}),{code:'submission_unknown'});
});
test('G8 retry is only new full-stage attempt, never purge/subset; scheduler exit zero still verifies outputs',()=>{
 const {retryPlan,submissionSnapshotParse}=require('./planning.cjs'),p=compiled(),a={plan:p,previousAttemptId:'at-old-success',newAttemptId:'at-new',scope:'full-required-stage',purge:false,oldRunSucceeded:true};assert.equal(retryPlan(a).preservePreviousOutputs,true);
 for(const patch of [{scope:'stage2-only'},{scope:'subset'},{purge:true},{newAttemptId:'at-old-success'}])assert.throws(()=>retryPlan({...a,...patch}),{code:'unsafe_retry'});
 const owned=key(),result=submissionSnapshotParse({format:'history',owned,now:2000,snapshot:{checkedAt:2000,records:[{key:owned,state:'COMPLETED',exitCode:'0:0',outputVerification:null}]}});assert.equal(result.status,'verifying');assert.equal(result.outputVerified,false);
});
test('G1 cyclic or mode-mixed DAG cannot pass schema, and frozen approval cannot be widened',()=>{
 const {stagePlanBuild,GraphLedger}=require('./planning.cjs'),a=input();a.plannedGraph=[{nodeId:'x',kind:'controller-job',phase:null,parentNodeId:null,dependencies:['y']},{nodeId:'y',kind:'batch-job',phase:1,parentNodeId:'x',dependencies:['x']}];assert.throws(()=>stagePlanBuild(a,evidence(a),2000),{code:'graph_invalid'});
 const p=compiled();p.budget.maxSchedulerJobs++;assert.throws(()=>ledger(p),{code:'capability_stale'});
});
test('G2/G3 normalized scheduler readback detects memory, tasks and unauthorized allocation mismatch',()=>{
 const {resourceReadback}=require('./planning.cjs'),r=resource('network-child',4),observed={Account:'synthetic',Partition:'synthetic',QOS:null,NumNodes:1,NumTasks:1,CPUsPerTask:4,MemoryMode:'per-node',MemoryMiB:2048,TimeLimit:'00:01:30',ReqCPUs:4,AllocCPUs:4,ReqMemoryMiB:2048,AllocMemoryMiB:2048};const a={resource:r,observed,supportedVersion:'synthetic-v1',allocationLimits:{maxAllocatedCPUs:4,maxAllocatedMemoryMiB:2048}};
 assert.equal(resourceReadback(a).status,'observed');assert.equal(resourceReadback({...a,supportedVersion:null}).status,'unknown');for(const patch of [{MemoryMiB:4096},{NumTasks:4},{AllocCPUs:8}])assert.equal(resourceReadback({...a,observed:{...observed,...patch}}).code,'scheduler_resource_mismatch');
});
test('G3 valid allocation steps count one scheduler job and barriers depend on all actual phase batches',()=>{
 const {stagePlanBuild}=require('./planning.cjs'),a=input('network-allocation-steps');a.controllerResource=resource('controller',8);a.controllerResource.memoryMiB=8192;const p=stagePlanBuild(a,evidence(a),2000),l=ledger(p),out=l.expand({expectedRevision:0,generated:[generated(p,1,'sub1'),generated(p,1,'sub2'),generated(p,2,'sub1')]});assert.equal(out.schedulerJobUpperBound,1);assert.equal(out.usage.maxConcurrentCPUs,8);assert.equal(out.expandedGraph.find(n=>n.nodeId==='phase1-verified').dependencies.length,2);
});
test('G6 capability expiry blocks even a local reservation; owner-qualified steps preserve parent identity',()=>{
 const {GraphLedger,submissionSnapshotParse}=require('./planning.cjs'),p=compiled(),l=new GraphLedger(fs.mkdtempSync(path.join(runtime,'expired-')),p,()=>100000);assert.throws(()=>l.reserve({expectedRevision:0,nodeId:'controller',requestId:'expired'}),{code:'capability_stale'});
 const owned={...key(),parentJobId:'123',stepId:'1'};assert.equal(submissionSnapshotParse({format:'history',owned,now:2000,snapshot:{checkedAt:2000,records:[{key:owned,state:'RUNNING',exitCode:'0:0',outputVerification:null}]}}).status,'running');assert.throws(()=>submissionSnapshotParse({format:'history',owned:{...owned,parentJobId:'999'},now:2000,snapshot:{checkedAt:2000,records:[]}}),{code:'lineage_mismatch'});
});
test('G6 pending submit acknowledgement needs one exact scoped history candidate and never fabricates time',()=>{
 const {submissionSnapshotParse}=require('./planning.cjs'),known=key(),pending={...known,jobId:null,submitTime:null};const ack=submissionSnapshotParse({format:'parsable',stdout:'123;synthetic-cluster\n',stderr:'',exitCode:0,owned:pending,now:2000});assert.equal(ack.status,'submission-unknown');assert.equal(ack.schedulerKeys.length,0);assert.equal(ack.acceptedCandidate.jobId,'123');
 const submitted=Date.parse(known.submitTime),row={key:known,state:'RUNNING',exitCode:'0:0',outputVerification:null};const a={format:'history',owned:pending,now:submitted+1000,submitWindow:{after:submitted-1000,before:submitted+1000},snapshot:{checkedAt:submitted+1000,records:[row]}};
 assert.equal(submissionSnapshotParse(a).schedulerKeys[0].submitTime,known.submitTime);assert.equal(submissionSnapshotParse({...a,snapshot:{...a.snapshot,records:[row,row]}}).status,'submission-unknown');
});
test('G7 omitted known child cannot make a parent-only cancel plan claim the graph stopped',()=>{
 const {cancellationPlan}=require('./planning.cjs'),p=compiled(),parent=key(),child=key('child','456',1);const a={plan:p,keys:[parent],observations:[{key:parent,state:'CANCELLED',checkedAt:2000}],confirmation:true,controllerStopped:true,noResidualEvidence:true};assert.equal(cancellationPlan(a,{planHash:p.planHash,ownedKeys:[parent,child],now:2000}).status,'cancelling');
});
test('G5/G6 phase1 completion seal prevents late expansion; two ledger instances enforce graph CAS',()=>{
 const {GraphLedger}=require('./planning.cjs'),{hash}=require('../s3/registry.cjs'),p=compiled(),l=ledger(p),second=new GraphLedger(l.root,p,()=>2000);const out=l.expand({expectedRevision:0,generated:[generated(p,1),generated(p,2)]});assert.throws(()=>second.expand({expectedRevision:0,generated:[]}),{code:'revision_conflict'});const nodes=Object.values(out.ledger.batches);l.reserve({expectedRevision:1,nodeId:nodes.find(n=>n.phase===2).nodeId,requestId:'phase2-first',phase1Proof:{verified:true,completeGeneration:true,planHash:p.planHash,outputManifestHash:'b'.repeat(64),manifestHash:hash(nodes.filter(n=>n.phase===1))}});assert.throws(()=>l.expand({expectedRevision:1,generated:[generated(p,1,'late')]}),{code:'output_unverified'});
});
test('G1 exact resource/profile, roots and official source drift blocks even matching numeric capacity',()=>{
 const {stagePlanBuild}=require('./planning.cjs'),a=input();for(const kind of ['resource','root','source']){const e=structuredClone(evidence(a));if(kind==='resource')e.resolvedResources[0].profileRef.revision=2;if(kind==='root')e.resolvedRootRefs.workspace.contentHash='0'.repeat(64);if(kind==='source')e.resolvedOfficial.sourceHash='0'.repeat(64);assert.equal(stagePlanBuild(a,e,2000).preflightReady,false);}
});
test('S4-V-01 reserve rejects future capability and preflight observations without adding intents',()=>{
 const {GraphLedger}=require('./planning.cjs'),a=input(),e=evidence(a);e.checkedAt=1500;const p=require('./planning.cjs').stagePlanBuild(a,e,2000),root=fs.mkdtempSync(path.join(runtime,'future-fix-')),l=new GraphLedger(root,p,()=>1000);
 assert.throws(()=>l.reserve({expectedRevision:0,nodeId:'controller',requestId:'future-capability'}),{code:'capability_stale'});assert.equal(fs.existsSync(path.join(root,'graph.json')),false);
});
test('S4-V-02 pending batch/controller never attach a history step with extra identity',()=>{
 const {submissionSnapshotParse}=require('./planning.cjs'),known=key(),owned={...known,jobId:null,submitTime:null},step={...known,parentJobId:known.jobId,stepId:'0'},when=Date.parse(known.submitTime);
 const result=submissionSnapshotParse({format:'history',owned,now:2000,submitWindow:{after:when-100,before:when+100},snapshot:{checkedAt:2000,records:[{key:step,state:'RUNNING',exitCode:'0:0',outputVerification:null}]}});
 assert.equal(result.status,'submission-unknown');assert.equal(result.schedulerKeys.length,0);assert.equal(result.resubmit,false);
});
test('Legal reserve at the observation boundary and matching batch/step history still succeed',()=>{
 const {stagePlanBuild,GraphLedger,submissionSnapshotParse}=require('./planning.cjs'),a=input(),e=evidence(a);e.checkedAt=2000;const p=stagePlanBuild(a,e,2000),l=new GraphLedger(fs.mkdtempSync(path.join(runtime,'valid-fix-')),p,()=>2000);assert.equal(l.reserve({expectedRevision:0,nodeId:'controller',requestId:'equal-observation'}).executeEnabled,false);
 const known=key(),when=Date.parse(known.submitTime);for(const step of [false,true]){const complete=step?{...known,parentJobId:known.jobId,stepId:'0'}:known;const owned={...complete,submitTime:null};const result=submissionSnapshotParse({format:'history',owned,now:2000,submitWindow:{after:when-100,before:when+100},snapshot:{checkedAt:2000,records:[{key:complete,state:'RUNNING',exitCode:'0:0',outputVerification:null}]}});assert.equal(result.status,'running');assert.equal(result.executeEnabled,false);}
});
test('S4-V-01 preflight future, expiry equality and invalid clocks refuse without persistent effects',()=>{
 const {GraphLedger}=require('./planning.cjs'),p=compiled();
 for(const now of [1500,100000,100001,-1,NaN,Number.MAX_SAFE_INTEGER+1]){const root=fs.mkdtempSync(path.join(runtime,'clock-boundary-'));let calls=0;const l=new GraphLedger(root,p,()=>{calls++;return now;});assert.throws(()=>l.reserve({expectedRevision:0,nodeId:'controller',requestId:'clock'}),{code:'capability_stale'});assert.equal(calls,1);assert.equal(fs.existsSync(path.join(root,'graph.json')),false);assert.equal(fs.existsSync(path.join(root,'graph.json.lock')),false);}
});
test('S4-V-01 one-hour evidence boundary succeeds before expiry; excessive lifetime and age block',()=>{
 const {stagePlanBuild,GraphLedger}=require('./planning.cjs'),a=input(),e=evidence(a);e.checkedAt=1000;e.expiresAt=3601000;const p=stagePlanBuild(a,e,1000);assert.equal(p.preflightReady,true);let calls=0;const l=new GraphLedger(fs.mkdtempSync(path.join(runtime,'age-boundary-')),p,()=>{calls++;return 3600999;});assert.equal(l.reserve({expectedRevision:0,nodeId:'controller',requestId:'last-valid'}).executeEnabled,false);assert.equal(calls,1);
 for(const [observation,buildAt,reserveAt] of [[{...e,expiresAt:3601001},1000,2000],[e,3601001,3601001],[{...e,checkedAt:-1},1000,1000]]){const blocked=stagePlanBuild(a,observation,buildAt);assert.equal(blocked.preflightReady,false);assert.ok(blocked.blockedIssues.includes('capability_stale'));assert.throws(()=>new GraphLedger(fs.mkdtempSync(path.join(runtime,'age-blocked-')),blocked,()=>reserveAt).reserve({expectedRevision:0,nodeId:'controller',requestId:'stale'}),{code:'capability_stale'});}
});
test('S4-V-01 frozen observation times cannot drift; legacy missing times keep history but refuse new reserve',()=>{
 const {GraphLedger}=require('./planning.cjs'),{hash}=require('../s3/registry.cjs');for(const change of [p=>p.content.preflightState.capabilityCheckedAt++,p=>p.checkedAt++]){const p=compiled();change(p);assert.throws(()=>ledger(p),{code:'capability_stale'});}
 const old=compiled();delete old.content.preflightState.capabilityCheckedAt;delete old.content.preflightState.maxAgeMs;old.planHash=hash(old.content);old.planId='plan-'+old.planHash.slice(0,24);const l=ledger(old);l.expand({expectedRevision:0,generated:[]});const file=path.join(l.root,'graph.json'),before=fs.readFileSync(file);assert.throws(()=>l.reserve({expectedRevision:1,nodeId:'controller',requestId:'old'}),{code:'capability_stale'});assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(JSON.parse(before).intents,{});
});
test('S4-V-02 complete batch/step identity matrix rejects kind or step-value mismatch for pending and known keys',()=>{
 const {submissionSnapshotParse}=require('./planning.cjs'),batch=key(),step={...batch,parentJobId:batch.jobId,stepId:'0'},when=Date.parse(batch.submitTime);
 for(const pending of [false,true])for(const ownedFull of [batch,step])for(const candidate of [batch,step,{...step,stepId:'1'},{...step,jobId:'456',parentJobId:'456'}]){const owned={...ownedFull,...(pending?{submitTime:null}:{})};const r=submissionSnapshotParse({format:'history',owned,now:2000,submitWindow:{after:when-100,before:when+100},snapshot:{checkedAt:2000,records:[{key:candidate,state:'RUNNING',exitCode:'0:0',outputVerification:null}]}});const exact=JSON.stringify(candidate)===JSON.stringify(ownedFull);assert.equal(r.status,exact?'running':'submission-unknown');assert.equal(r.schedulerKeys.length,exact?1:0);assert.equal(r.resubmit,false);assert.equal(r.executeEnabled,false);}
});
test('S4-V-02 half-present or undefined step identity is refused for owned and candidate records',()=>{
 const {submissionSnapshotParse}=require('./planning.cjs'),batch=key();for(const [malformed,code] of [[{...batch,parentJobId:batch.jobId},'lineage_mismatch'],[{...batch,stepId:'0'},'lineage_mismatch'],[{...batch,parentJobId:undefined,stepId:undefined},'schema_invalid'],[{...batch,parentJobId:batch.jobId,stepId:undefined},'schema_invalid']])for(const owned of [true,false])assert.throws(()=>submissionSnapshotParse({format:'history',owned:owned?malformed:batch,now:2000,snapshot:{checkedAt:2000,records:owned?[]:[{key:malformed,state:'RUNNING',exitCode:'0:0',outputVerification:null}]}}),{code});
});
test('G1–G8 attempted network/SSH/probe/Slurm/R/science ports are zero',()=>{
 assert.deepEqual(forbiddenAttempts,[]);fs.writeFileSync(path.join(runtime,'effect-ledger.json'),JSON.stringify({attempts:forbiddenAttempts,network:0,SSH:0,probe:0,submit:0,Slurm:0,R:0,science:0,kind:'Synthetic pure-module instrumented attempts, not actual site evidence'},null,2));
});
