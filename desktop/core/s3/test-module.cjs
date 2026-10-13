const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
// Tripwires instrument attempted external effects, including rejected/exception calls.
const externalAttempts=[];
for(const [module,methods] of [['node:child_process',['exec','execSync','execFile','execFileSync','spawn','spawnSync','fork']],['node:net',['connect','createConnection']],['node:tls',['connect']],['node:http',['request','get']],['node:https',['request','get']],['node:dgram',['createSocket']],['node:dns',['lookup','resolve']]])for(const method of methods)require(module)[method]=()=>{externalAttempts.push(module+'.'+method);throw Error('Forbidden external effect');};
require('node:net').Socket.prototype.connect=()=>{externalAttempts.push('socket.connect');throw Error('Forbidden socket');};
global.fetch=()=>{externalAttempts.push('fetch');throw Error('Forbidden fetch');};
const runtime=path.resolve(__dirname,'../../../..','S3-build-evidence/runtime');
fs.mkdirSync(runtime,{recursive:true});
test('V5 unknown configuration persists without acquiring execution readiness',async()=>{
 const {Registry}=require('./registry.cjs');
 const r=new Registry({root:fs.mkdtempSync(path.join(runtime,'v5-')),readDraft:()=>null,readCapability:()=>null,authorize:()=>null});
 const p=await r.profileSave({manifest:{schemaVersion:1,kind:'hpc3',name:'Synthetic unknown',endpoints:[{endpointId:'login',role:'login',host:null,user:null,port:null,sshAlias:null,authRef:null,hostKeyRef:null}],roots:[],storageMappings:[]},expectedRevision:0});
 assert.equal(p.status,'configured'); assert.equal(p.jobReady,false);
 await assert.rejects(r.profileCheckPlan({profileRef:p.profileRef,endpointId:'login',requestId:'q1'}),{code:'needs_user_auth'});
});
function setup(){const {Registry,hash}=require('./registry.cjs');const root=fs.mkdtempSync(path.join(runtime,'owned-'));let draft={draftId:'d-synthetic',revision:1,contentHash:'a'.repeat(64)};const r=new Registry({root,readDraft:()=>({...draft}),readCapability:()=>null,authorize:()=>null});return {r,root,hash,draft};}
function unknown(){return {schemaVersion:1,kind:'hpc3',name:'Synthetic',endpoints:[{endpointId:'login',role:'login',host:null,user:null,port:null,sshAlias:null,authRef:null,hostKeyRef:null}],roots:[],storageMappings:[]};}
test('V2/V4 CAS keeps history and competing delete/bind cannot leave dangling refs',async()=>{
 const {r,draft}=setup();const p=(await r.profileSave({manifest:unknown(),expectedRevision:0})).profileRef;
 const outcomes=await Promise.allSettled([r.profileSave({manifest:{...unknown(),profileId:p.profileId,name:'A'},expectedRevision:1}),r.profileSave({manifest:{...unknown(),profileId:p.profileId,name:'B'},expectedRevision:1})]);assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
 const p2=outcomes.find(o=>o.status==='fulfilled').value.profileRef;
 const binding={schemaVersion:1,draftRef:draft,inputValidationRef:null,profileRef:p2,resourceRef:null,rootSelection:null};
 const bound=await r.bindingSave({binding,expectedRevision:0});assert.equal(bound.status,'configured');
 await assert.rejects(r.bindingSave({binding,expectedRevision:0}),{code:'revision_conflict'});
 await assert.rejects(r.profileDelete({profileRef:p2,expectedRevision:2}),{code:'profile_in_use'});
 const saved=await r.resourcePlanSave({plan:{schemaVersion:1,profileRef:p2,account:null,partition:null,qos:null,cores:null,memoryMiB:null,walltimeSeconds:null,capabilityRef:null},expectedRevision:0});assert.equal(saved.jobReady,false);
});
function ready(){
 const {Registry,hash}=require('./registry.cjs');const root=fs.mkdtempSync(path.join(runtime,'ready-')),files=path.join(root,'files');fs.mkdirSync(files);fs.writeFileSync(path.join(files,'sample'),'PUBLIC SYNTHETIC\n');
 const config=unknown();config.endpoints=['login','transfer'].map(role=>({endpointId:role,role,host:role+'.invalid',user:'synthetic',port:2222,sshAlias:null,authRef:'auth-'+role,hostKeyRef:'key-'+role}));
 config.roots=['inputs','workspace','outputs','tools','container'].map(role=>({rootId:role,role,endpointPaths:{login:'/synthetic/'+role,transfer:'/synthetic/'+role},access:'read-write',canonicalEvidenceRef:'root-proof',permissionPolicy:'preserve-destination-group'}));
 config.storageMappings=['workspace','outputs'].map(rootId=>({mappingId:'map-'+rootId,rootId,endpointIds:['login','transfer'],storageIdentityRef:'store-A'}));
 const ctx={root,files,config,draft:{draftId:'d-synthetic',revision:1,contentHash:'a'.repeat(64)},caps:{},auth:{},clock:100000,source:{token:'file-token',direction:'upload',root:files,relativePath:'sample',sha256:require('node:crypto').createHash('sha256').update('PUBLIC SYNTHETIC\n').digest('hex'),bytes:17},calls:[]};
 ctx.r=new Registry({root,now:()=>ctx.clock,readDraft:()=>({...ctx.draft}),readCapability:r=>ctx.caps[r.snapshotId],authorize:q=>{ctx.calls.push(q.kind);if(q.kind==='handle')return {ref:q.ref,handleKind:q.handleKind,authorized:config.endpoints.some(e=>e.authRef===q.ref||e.hostKeyRef===q.ref)};return q.kind==='endpoint'?ctx.auth[q.endpointId]:ctx.source;}});
 ctx.init=async()=>{
  ctx.p=(await ctx.r.profileSave({manifest:ctx.config,expectedRevision:0})).profileRef;
  for(const role of ['login','transfer']){
   const body={snapshotId:'cap-'+role,revision:1,profileRef:ctx.p,endpointId:role,checkedAt:new Date(99000).toISOString(),expiresAt:new Date(200000).toISOString(),authentication:'authenticated',reachability:'verified',environment:'verified',hostKeyRef:'key-'+role,ownerIdentityRef:'synthetic-owner',rootAccess:Object.fromEntries(config.roots.map(r=>[r.rootId,{canonicalPath:r.endpointPaths[role],storageIdentityRef:'store-A',symlinkSafe:true,read:true,write:true}])),storageMappings:Object.fromEntries(config.storageMappings.map(m=>[m.mappingId,{storageIdentityRef:'store-A',endpointIds:m.endpointIds,verified:true}])),resources:{accounts:['account-A'],partitions:['synthetic'],qos:['normal'],maxCores:8,maxMemoryMiB:8192,maxWalltimeSeconds:900},artifactHashes:{tools:'b'.repeat(64),container:'c'.repeat(64)},inputManifestHash:'d'.repeat(64),complete:true};
   const c={...body,contentHash:hash(body)};ctx.caps[c.snapshotId]=c;
   ctx.auth[role]={...config.endpoints.find(e=>e.role===role),ownerIdentityRef:'synthetic-owner',jumpHosts:[],capabilityRef:{snapshotId:c.snapshotId,revision:1,contentHash:c.contentHash}};
  }
  ctx.plan={schemaVersion:1,profileRef:ctx.p,account:'account-A',partition:'synthetic',qos:'normal',cores:2,memoryMiB:1536,walltimeSeconds:90,capabilityRef:ctx.auth.login.capabilityRef};
  ctx.resource=(await ctx.r.resourcePlanSave({plan:ctx.plan,expectedRevision:0})).resourceRef;
  ctx.binding={schemaVersion:1,draftRef:ctx.draft,inputValidationRef:null,profileRef:ctx.p,resourceRef:ctx.resource,rootSelection:{inputRootId:'inputs',workspaceRootId:'workspace',outputRootId:'outputs'}};
  ctx.b=(await ctx.r.bindingSave({binding:ctx.binding,expectedRevision:0})).bindingRef;
  ctx.upload={bindingRef:ctx.b,direction:'upload',sourceTokens:['file-token'],destinationRootId:'workspace',relativePaths:['sample'],requestId:'transfer-1'};
 };return ctx;
}
test('V1 real legacy draft and validation bytes stay unchanged by sidecar; old edits stale it',async()=>{
 const {Drafts}=require('../drafts.cjs'),{Registry,hash}=require('./registry.cjs');const root=fs.mkdtempSync(path.join(runtime,'legacy-'));const drafts=new Drafts(root);
 const input={revision:0,label:'Owned synthetic',notes:'',workflow:'network',cohort:'TCGA',entryStage:'network',finishAfter:'network',species:'9606',assembly:'hg38',inputs:{},parameters:{nboots:2,ncis:3,cor:0.3,'alpha.cis':0.05,freq:1,ntop:1}};
 const d=drafts.save(input).draft,v=drafts.validate(d.id,d.revision),file=drafts.file(d.id),before=fs.readFileSync(file),validation=fs.readFileSync(file+'.validation');
 const readDraft=()=>{const x=drafts.read(d.id);return {draftId:x.id,revision:x.revision,contentHash:x.contentHash,validationRef:{validationId:v.validationId,revision:v.revision,contentHash:v.contentHash}};};
 const r=new Registry({root:path.join(root,'s3'),readDraft,readCapability:()=>null,authorize:()=>null});const p=(await r.profileSave({manifest:unknown(),expectedRevision:0})).profileRef;
 const binding={schemaVersion:1,draftRef:{draftId:d.id,revision:1,contentHash:drafts.read(d.id).contentHash},inputValidationRef:null,profileRef:p,resourceRef:null,rootSelection:null};
 await r.bindingSave({binding,expectedRevision:0});assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(fs.readFileSync(file+'.validation'),validation);
 assert.throws(()=>drafts.save({...d,profileRef:p}),/defined/);assert.deepEqual(fs.readFileSync(file),before);
 drafts.save({...d,label:'Own explicit S1 edit'});assert.equal((await r.bindingLoad({draftId:d.id})).status,'stale');assert.equal(drafts.read(d.id).revision,2);
});
test('V3 current profile/resource/draft/hash drift blocks new plans without latest rebinding',async()=>{
 for(const change of ['profile','resource','draft','hash']){const c=ready();await c.init();
  if(change==='profile')await c.r.profileSave({manifest:{...c.config,profileId:c.p.profileId,name:'Explicit changed'},expectedRevision:1});
  if(change==='resource')await c.r.resourcePlanSave({plan:{...c.plan,resourcePlanId:c.resource.resourcePlanId,cores:3},expectedRevision:1});
  if(change==='draft')c.draft.revision=2;
  if(change==='hash')c.upload.bindingRef={...c.b,contentHash:'f'.repeat(64)};
  await assert.rejects(c.r.transferPlan(c.upload),{code:'reference_drift'});
  if(change!=='hash')assert.equal((await c.r.bindingLoad({draftId:c.draft.draftId})).status,'stale');
 }
 const c=ready();await c.init();await assert.rejects(c.r.bindingSave({binding:{...c.binding,override:true},expectedRevision:0}),{code:'schema_invalid'});
});
test('V4 both new bind/delete schedules protect refs; soft deletion retains original versions',async()=>{
 for(const bindFirst of [true,false]){const {r,root,draft}=setup();const p=(await r.profileSave({manifest:unknown(),expectedRevision:0})).profileRef;const binding={schemaVersion:1,draftRef:draft,inputValidationRef:null,profileRef:p,resourceRef:null,rootSelection:null};
  const bind=()=>r.bindingSave({binding,expectedRevision:0}),del=()=>r.profileDelete({profileRef:p,expectedRevision:1});
  const outcomes=await Promise.allSettled(bindFirst?[bind(),del()]:[del(),bind()]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  const reopen=new (require('./registry.cjs').Registry)({root,readDraft:()=>draft,readCapability:()=>null,authorize:()=>null});
  if(bindFirst)await assert.rejects(reopen.profileDelete({profileRef:p,expectedRevision:1}),{code:'profile_in_use'});
  else {assert.equal(JSON.parse(fs.readFileSync(path.join(root,'registry.json'))).profiles[p.profileId].versions[1].content.name,'Synthetic');await assert.rejects(bind(),{code:'reference_not_found'});}
 }
 const {r}=setup(),p=(await r.profileSave({manifest:unknown(),expectedRevision:0})).profileRef;
 await r.resourcePlanSave({plan:{schemaVersion:1,profileRef:p,account:null,partition:null,qos:null,cores:null,memoryMiB:null,walltimeSeconds:null,capabilityRef:null},expectedRevision:0});await assert.rejects(r.profileDelete({profileRef:p,expectedRevision:1}),{code:'profile_in_use'});
});
test('V5 secret fields and unauthorized handles fail; alias/key mismatch cannot become a probe',async()=>{
 const {r,root}=setup();for(const key of ['password','passphrase','MFA','keyPath','privateKey','sshOptions'])await assert.rejects(r.profileSave({manifest:{...unknown(),[key]:'FAKE-SECRET-DO-NOT-STORE'},expectedRevision:0}),{code:'schema_invalid'});
 assert.equal(fs.existsSync(path.join(root,'registry.json')),false);
 const c=ready();await c.init();const q={profileRef:c.p,endpointId:'login',requestId:'probe'};assert.equal((await c.r.profileCheckPlan(q)).plan.StrictHostKeyChecking,'yes');
 c.auth.login.host='wrong.invalid';await assert.rejects(c.r.profileCheckPlan(q),{code:'endpoint_role_mismatch'});c.auth.login.host='login.invalid';c.auth.login.hostKeyRef='changed';await assert.rejects(c.r.profileCheckPlan(q),{code:'host_key_mismatch'});delete c.auth.login;await assert.rejects(c.r.profileCheckPlan(q),{code:'needs_user_auth'});
});
test('V6 actual owned source hash, explicit storage mapping, paths, roles, and symlink boundaries',async()=>{
 const c=ready();await c.init();const plan=await c.r.transferPlan(c.upload);assert.equal(plan.plan.endpoint.host,'transfer.invalid');assert.equal(plan.executeEnabled,false);assert.equal(plan.plan.preserveDestinationGroup,true);
 await assert.rejects(c.r.transferPlan({...c.upload,requestId:'other',relativePaths:['../outside']}),{code:'unsafe_path'});
 await assert.rejects(c.r.transferPlan({...c.upload,requestId:'other',destinationRootId:'tools'}),{code:'endpoint_role_mismatch'});
 const outside=path.join(c.root,'outside');fs.writeFileSync(outside,'owned outside fixture');fs.symlinkSync(outside,path.join(c.files,'escape'));c.source.relativePath='escape';await assert.rejects(c.r.transferPlan({...c.upload,requestId:'other'}),{code:'unsafe_path'});
 const x=ready();await x.init();const cap=x.caps['cap-transfer'];const body={...cap};delete body.contentHash;body.storageMappings['map-workspace'].verified=false;const changed={...body,contentHash:require('./registry.cjs').hash(body)};x.caps['cap-transfer']=changed;x.auth.transfer.capabilityRef.contentHash=changed.contentHash;await assert.rejects(x.r.transferPlan(x.upload),{code:'root_unverified'});
});
test('V7 explicit memory/time vectors, unknown/invalid values, capacity and expiry equality',async()=>{
 const {memoryMiB,walltimeSeconds}=require('./registry.cjs');assert.equal(memoryMiB(1.5,'GiB'),1536);assert.equal(walltimeSeconds('00:01:30'),90);
 for(const v of [true,NaN,0,0.0001])assert.throws(()=>memoryMiB(v,'GiB'),{code:'schema_invalid'});assert.throws(()=>memoryMiB(1,'GB'),{code:'schema_invalid'});for(const v of ['00:60:00','00:00:60','1:30','00:00:00'])assert.throws(()=>walltimeSeconds(v),{code:'schema_invalid'});
 const c=ready();await c.init();const q={bindingRef:c.b,stagePlanHash:'e'.repeat(64),requestId:'job-1'};const p=await c.r.submissionPlanInput(q);assert.equal(p.plan.resources.memoryMiB,1536);assert.equal(p.plan.jobReady,false);assert.equal(p.executeEnabled,false);
 c.clock=200000;await assert.rejects(c.r.submissionPlanInput({...q,requestId:'expired'}),{code:'capability_expired'});
 const x=ready();await x.init();const resource=(await x.r.resourcePlanSave({plan:{...x.plan,resourcePlanId:x.resource.resourcePlanId,cores:9},expectedRevision:1})).resourceRef;
 const b=(await x.r.bindingSave({binding:{...x.binding,bindingId:x.b.bindingId,resourceRef:resource},expectedRevision:1})).bindingRef;await assert.rejects(x.r.submissionPlanInput({...q,bindingRef:b}),{code:'resource_unsupported'});
 for(const cores of [true,NaN,0])await assert.rejects(x.r.resourcePlanSave({plan:{...x.plan,cores},expectedRevision:0}),{code:'schema_invalid'});
});
test('V8 persisted plan intent deduplication/conflict and lost response stay unknown with frozen refs',async()=>{
 const c=ready();await c.init();const a=await c.r.transferPlan(c.upload),b=await c.r.transferPlan(c.upload);assert.equal(a.operationId,b.operationId);assert.equal(b.status,'unknown');
 await assert.rejects(c.r.transferPlan({...c.upload,relativePaths:['renamed']}),{code:'operation_conflict'});
 const before=JSON.parse(fs.readFileSync(path.join(c.root,'registry.json'))).requests['transfer-1'];
 await c.r.profileSave({manifest:{...c.config,profileId:c.p.profileId,name:'new'},expectedRevision:1});await assert.rejects(c.r.transferPlan(c.upload),{code:'reference_drift'});
 const frozen=JSON.parse(fs.readFileSync(path.join(c.root,'registry.json'))).requests['transfer-1'];assert.deepEqual(frozen,before);assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(c.root,'registry.json'))).requests).length,1);
});
test('V2 cross-instance held bind lock rejects competing new bind without overwrite',async()=>{
 const {r,root,draft}=setup();const p=(await r.profileSave({manifest:unknown(),expectedRevision:0})).profileRef;const binding={schemaVersion:1,draftRef:draft,inputValidationRef:null,profileRef:p,resourceRef:null,rootSelection:null};
 let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);let calls=0;
 const one=new (require('./registry.cjs').Registry)({root,readDraft:async()=>{if(++calls===1){entered();await gate;}return draft;},readCapability:()=>null,authorize:()=>null});
 const pending=one.bindingSave({binding,expectedRevision:0});await started;await assert.rejects(r.bindingSave({binding,expectedRevision:0}),{code:'io_conflict'});release();await pending;
 await assert.rejects(r.bindingSave({binding,expectedRevision:0}),{code:'revision_conflict'});assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(root,'registry.json'))).bindings).length,1);
});
test('V3 draft changes between the two reads reject binding; validation ref cannot be invented',async()=>{
 const {Registry}=require('./registry.cjs'),{r,root,draft}=setup();const p=(await r.profileSave({manifest:unknown(),expectedRevision:0})).profileRef;const binding={schemaVersion:1,draftRef:draft,inputValidationRef:null,profileRef:p,resourceRef:null,rootSelection:null};let n=0;
 const x=new Registry({root,readDraft:()=>({...draft,revision:++n===1?1:2}),readCapability:()=>null,authorize:()=>null});await assert.rejects(x.bindingSave({binding,expectedRevision:0}),{code:'reference_drift'});assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(root,'registry.json'))).bindings).length,0);
 await assert.rejects(r.bindingSave({binding:{...binding,inputValidationRef:{validationId:'invented',revision:1,contentHash:'a'.repeat(64)}},expectedRevision:0}),{code:'reference_drift'});
});
test('V6 download plan freezes main-authorized local destination; source changes during plan reject',async()=>{
 const c=ready();await c.init();c.source={token:'file-token',direction:'download',root:'/synthetic/outputs',relativePath:'result',sha256:'f'.repeat(64),bytes:12,symlinkSafe:true,localDestinationRef:'selected-local-target'};
 const a=await c.r.transferPlan({...c.upload,direction:'download',destinationRootId:'outputs',requestId:'download'});assert.equal(a.plan.files[0].localDestinationRef,'selected-local-target');assert.equal(a.plan.rootMapping.canonicalPath,'/synthetic/outputs');assert.equal(a.executeEnabled,false);
 const x=ready();await x.init();let n=0;const original=x.r.authorize;x.r.authorize=q=>{if(q.kind==='source'&&++n===2)return {...x.source,sha256:'f'.repeat(64)};return original(q);};await assert.rejects(x.r.transferPlan(x.upload),{code:'reference_drift'});assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(x.root,'registry.json'))).requests).length,0);
});
test('V7 schema rejects unknown versions, prototype/array, malformed endpoints and dangerous runtime roots',async()=>{
 const {Registry,canonical}=require('./registry.cjs'),{r}=setup();await assert.rejects(r.profileSave({manifest:{...unknown(),schemaVersion:2},expectedRevision:0}),{code:'unsupported_version'});
 await assert.rejects(r.profileSave({manifest:[],expectedRevision:0}),{code:'schema_invalid'});assert.throws(()=>canonical(JSON.parse('{"__proto__":{"polluted":true}}')),{code:'schema_invalid'});
 const bad=unknown();bad.endpoints[0].host='bad..invalid';await assert.rejects(r.profileSave({manifest:bad,expectedRevision:0}),{code:'schema_invalid'});
 assert.throws(()=>new Registry({root:'/Users/tloe/Developer/SIGNET/owned-forbidden',readDraft:()=>null,readCapability:()=>null,authorize:()=>null}),{code:'unsafe_path'});
 const tmp=fs.mkdtempSync(path.join(runtime,'symlink-root-'));fs.symlinkSync(runtime,path.join(tmp,'link'));assert.throws(()=>new Registry({root:path.join(tmp,'link','child'),readDraft:()=>null,readCapability:()=>null,authorize:()=>null}),{code:'unsafe_path'});
});
test('V8 planned intent remains a deletion reference even without active binding/resource index',async()=>{
 const c=ready();await c.init();await c.r.transferPlan(c.upload);const file=path.join(c.root,'registry.json'),saved=JSON.parse(fs.readFileSync(file));
 // Synthetic lost-index fixture, while the frozen intent still owns its source.
 saved.bindings={};saved.resources={};fs.writeFileSync(file,JSON.stringify(saved));await assert.rejects(c.r.profileDelete({profileRef:c.p,expectedRevision:1}),{code:'profile_in_use'});
});
test('V5 core refuses unregistered auth handles even if their spelling is harmless',async()=>{
 const {r}=setup(),config=unknown();config.endpoints[0].authRef='fake-handle';await assert.rejects(r.profileSave({manifest:config,expectedRevision:0}),{code:'needs_user_auth'});
});
test('V6/V7 wrong snapshot endpoint/hash and root read permission cannot authorize transfer',async()=>{
 for(const change of ['endpoint','hash','read']){const c=ready();await c.init();const cap=c.caps['cap-transfer'];
  if(change==='endpoint')cap.endpointId='login';
  if(change==='hash')cap.contentHash='f'.repeat(64);
  if(change==='read'){c.source={token:'file-token',direction:'download',root:'/synthetic/outputs',relativePath:'result',sha256:'f'.repeat(64),bytes:12,symlinkSafe:true,localDestinationRef:'target'};cap.rootAccess.outputs.read=false;const {contentHash,...body}=cap;cap.contentHash=require('./registry.cjs').hash(body);c.auth.transfer.capabilityRef.contentHash=cap.contentHash;}
  await assert.rejects(c.r.transferPlan(change==='read'?{...c.upload,direction:'download',destinationRootId:'outputs'}:c.upload),{code:change==='read'?'root_unverified':'reference_drift'});
 }
});
test('S3-V-01 rejects changed upload root even with identical file bytes/hash/path',async()=>{
 const c=ready();await c.init();const sibling=path.join(c.root,'same-content');fs.mkdirSync(sibling);fs.copyFileSync(path.join(c.files,'sample'),path.join(sibling,'sample'));let reads=0;const original=c.r.authorize;
 c.r.authorize=q=>q.kind==='source'?{...c.source,root:++reads===1?c.files:sibling}:original(q);
 await assert.rejects(c.r.transferPlan(c.upload),{code:'reference_drift'});assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(c.root,'registry.json'))).requests).length,0);
});
test('S3-V-01 rejects changed selected download destination while content is unchanged',async()=>{
 const c=ready();await c.init();c.source={token:'file-token',direction:'download',root:'/synthetic/outputs',relativePath:'result',sha256:'f'.repeat(64),bytes:12,symlinkSafe:true,localDestinationRef:'first-target'};let reads=0;const original=c.r.authorize;
 c.r.authorize=q=>q.kind==='source'?{...c.source,localDestinationRef:++reads===1?'first-target':'revoked-target'}:original(q);
 await assert.rejects(c.r.transferPlan({...c.upload,direction:'download',destinationRootId:'outputs'}),{code:'reference_drift'});assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(c.root,'registry.json'))).requests).length,0);
});
test('S3-V-02 rechecks submission endpoint after the final capability read changes its grant',async()=>{
 const c=ready();await c.init();let reads=0;const original=c.r.readCapability;
 c.r.readCapability=r=>{if(++reads===2)c.auth.login.host='revoked.invalid';return original(r);};
 await assert.rejects(c.r.submissionPlanInput({bindingRef:c.b,stagePlanHash:'e'.repeat(64),requestId:'changed-endpoint'}),{code:'endpoint_role_mismatch'});assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(c.root,'registry.json'))).requests).length,0);
});
test('Unchanged authorized grants still build and deduplicate transfer/submission intents',async()=>{
 const c=ready();await c.init();const a=await c.r.transferPlan(c.upload),b=await c.r.transferPlan(c.upload);assert.equal(a.operationId,b.operationId);assert.equal(a.executeEnabled,false);
 const q={bindingRef:c.b,stagePlanHash:'e'.repeat(64),requestId:'unchanged-endpoint'},one=await c.r.submissionPlanInput(q),two=await c.r.submissionPlanInput(q);assert.equal(one.operationId,two.operationId);assert.equal(one.executeEnabled,false);assert.equal(one.plan.jobReady,false);
});
test('Revoked source grant refuses a new intent and preserves the old frozen intent',async()=>{
 const c=ready();await c.init();const previous=await c.r.transferPlan(c.upload);let reads=0;const original=c.r.authorize;c.r.authorize=q=>q.kind==='source'?(++reads===1?c.source:null):original(q);
 await assert.rejects(c.r.transferPlan({...c.upload,requestId:'revoked-source'}),{code:'permission_denied'});const state=JSON.parse(fs.readFileSync(path.join(c.root,'registry.json')));assert.equal(Object.keys(state.requests).length,1);assert.deepEqual(state.requests[c.upload.requestId],previous);
});
test('In-place endpoint owner mutation is compared against the original immutable grant snapshot',async()=>{
 const c=ready();await c.init();let reads=0;const original=c.r.readCapability;c.r.readCapability=r=>{if(++reads===2)c.auth.login.ownerIdentityRef='different-owner';return original(r);};
 await assert.rejects(c.r.submissionPlanInput({bindingRef:c.b,stagePlanHash:'e'.repeat(64),requestId:'owner-change'}),{code:'reference_drift'});
});
test('Equivalent optional endpoint/source declarations do not create false authorization drift',async()=>{
 const c=ready();await c.init();let endpoints=0,sources=0;const original=c.r.authorize;
 c.r.authorize=q=>{const value=original(q);if(q.kind==='endpoint'&&++endpoints===2){const {endpointId,role,capabilityRef,...same}=value;return same;}if(q.kind==='source'&&++sources===2)return {...value,symlinkSafe:null,localDestinationRef:null};return value;};
 const plan=await c.r.submissionPlanInput({bindingRef:c.b,stagePlanHash:'e'.repeat(64),requestId:'same-effective-scope'});assert.equal(plan.executeEnabled,false);assert.equal(plan.status,'unknown');
 // Upload source has no optional flags in either effective declaration.
 c.r.authorize=q=>{const value=original(q);return q.kind==='source'&&++sources===2?{...value,symlinkSafe:null,localDestinationRef:null}:value;};sources=0;
 assert.equal((await c.r.transferPlan(c.upload)).executeEnabled,false);
});
test('V1–V8 no network, SSH, transfer, submit or scientific executor was even attempted',()=>{
 assert.deepEqual(externalAttempts,[]);fs.writeFileSync(path.join(runtime,'effect-ledger.json'),JSON.stringify({externalAttempts,network:0,SSH:0,transfer:0,submit:0,science:0,kind:'author synthetic pure-module tripwires; not station validation'},null,2));
});
