'use strict';
// S2 controls local monitoring only. No transport, shell, scientific worker or timer completion.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const F=require('./files.cjs');
const SOURCE=fs.realpathSync(path.resolve(__dirname,'../..'));
const ANALYSIS=/^a-\d{8}T\d{6}-[a-f0-9]{12}$/,OP=/^op-[a-f0-9]{32}$/;
const stamp=()=>new Date().toISOString(),uuid=prefix=>prefix+crypto.randomBytes(16).toString('hex');
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const hash=x=>crypto.createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:canonical(x)).digest('hex');
const fail=code=>{const e=Error(code);e.code=code;throw e;};
function object(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail('invalid-parameters');return value;}
function bounded(file,limit=131072){const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size>limit)fail('record-limit');const b=Buffer.alloc(st.size);let offset=0,n;while(offset<b.length&&(n=fs.readSync(fd,b,offset,b.length-offset,null)))offset+=n;if(offset!==b.length)fail('record-changed');return {bytes:b,stat:st};}finally{fs.closeSync(fd);}}
const EXPLANATIONS=Object.freeze({
 'controller-lost':['Local controller observation lost','Reconnect and scan; do not resubmit an analysis.'],
 'stale-revision':['Snapshot is outdated','Refresh the selected operation before confirmation.'],
 'identity-mismatch':['Operation ownership differs','Select a record owned by this isolated runtime.'],
 'missing-checkpoint':['No verified checkpoint','Keep scientific continuation disabled.'],
 'stale-plan':['Checkpoint or selection changed','Review the new plan and confirm it again.'],
 'not-ready':['Scientific execution is unavailable','Monitoring does not submit, retry or compute PCA.'],
 'executor_unavailable':['Plan saved; execution unavailable','A plan is not a remote operation. A trusted current authority and accepted executor are required.'],
 'needs_user_auth':['Authentication is unverified','Use a separately authorized core authentication provider; never enter credentials here.'],
 'capability_unknown':['Current station capability is missing','Configuration alone cannot prove access, resources or transfer readiness.'],
 'reference_drift':['Frozen selection changed','Reload and explicitly bind the intended versions; do not resubmit the old request.'],
 'host_key_unverified':['Trusted host key is missing','Use a separately authorized host-key provider; never auto-accept a key.'],
 'root_unverified':['Remote storage is unverified','Obtain canonical root, permission and shared storage evidence.'],
 'capability_expired':['Station evidence expired','Obtain new trusted evidence before planning a new request.'],
 'resource_unsupported':['Resource capability is unverified','Configuration is not proof of account, partition or allocation limits.'],
 'operation_conflict':['Request identity conflicts','Keep the original operation; explicitly create a new reviewed request.'],
 'profile_in_use':['Connection is referenced','Preserve existing resources, bindings and operation history.'],
 'revision_conflict':['Configuration revision changed','Reload and explicitly save against the intended current revision.'],
 'permission_denied':['Authorization denied','Do not retry with a different path or unapproved source.'],
 'log-rotated':['Log snapshot changed','Read from the beginning; do not combine generations.'],
 'corrupt-record':['Persisted record is invalid','Preserve the record and inspect its original controller.'],
});
class Operations{
 constructor(root){
  this.root=fs.realpathSync(root);if(this.root===SOURCE||this.root==='/Users/tloe/Developer/SIGNET'||this.root.startsWith('/Users/tloe/Developer/SIGNET/'))fail('runtime-not-isolated');
  this.base=path.join(this.root,'s2');this.handles=new Set();this.lockDepth=0;this.ensure(this.base);
  for(const folder of ['operations','logs','checkpoints'])this.ensure(path.join(this.base,folder));
  const marker=path.join(this.base,'runtime.json');
  if(!fs.existsSync(marker))F.write(marker,{schemaVersion:2,owner:uuid('own-'),source:SOURCE});
  const saved=this.readJSON(marker);if(saved.schemaVersion!==2||saved.source!==SOURCE||!/^own-[a-f0-9]{32}$/.test(saved.owner))fail('runtime-not-isolated');this.owner=saved.owner;
 }
 ensure(folder){if(fs.existsSync(folder)&&fs.lstatSync(folder).isSymbolicLink())fail('unsafe-path');fs.mkdirSync(folder,{recursive:true});if(!fs.realpathSync(folder).startsWith(this.root+path.sep))fail('unsafe-path');}
 safe(file){let folder=path.dirname(file);while(folder!==this.root){if(!folder.startsWith(this.root+path.sep)||fs.lstatSync(folder).isSymbolicLink())fail('unsafe-path');folder=path.dirname(folder);}if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())fail('unsafe-path');return file;}
 readJSON(file){try{return JSON.parse(bounded(this.safe(file)).bytes.toString('utf8'));}catch(e){if(e.code==='ENOENT')throw e;if(e.code==='unsafe-path')throw e;fail('corrupt-record');}}
 file(operationId){if(!OP.test(operationId))fail('invalid-operation-id');return this.safe(path.join(this.base,'operations',operationId+'.json'));}
 record(operationId){const envelope=this.readJSON(this.file(operationId)),r=envelope.record;if(envelope.schemaVersion!==2||!r||hash(r)!==envelope.sha256||r.operationId!==operationId||r.owner!==this.owner||!(r.kind==='s3-plan'?r.analysisId===null&&r.frozen?.adapterVersion==='SIGNET-P3-O2-adapter-v1':ANALYSIS.test(r.analysisId))||!Number.isSafeInteger(r.revision)||!/^at-[a-f0-9]{32}$/.test(r.attemptId))fail('identity-mismatch');return r;}
 write(r){F.write(this.file(r.operationId),{schemaVersion:2,record:r,sha256:hash(r)});return structuredClone(r);}
 update(r,changes){return this.write({...r,...changes,revision:r.revision+1,checkedAt:stamp()});}
 names(){const names=[],directory=fs.opendirSync(this.safe(path.join(this.base,'operations')));try{let entry;while((entry=directory.readSync())){if(names.length>=512)fail('scan-limit');names.push(entry.name);}}finally{directory.closeSync();}return names.filter(n=>/^op-[a-f0-9]{32}\.json$/.test(n)).sort();}
 analysis(analysisId){if(!ANALYSIS.test(analysisId))fail('invalid-analysis-id');const file=path.join(this.root,'analyses',analysisId,'state.json');const state=this.readJSON(file);if(state.id!==analysisId)fail('identity-mismatch');return {state,digest:hash(state)};}
 start(params){
  const p=object(params,['requestId','analysisId','kind']);if(typeof p.requestId!=='string'||! /^[a-zA-Z0-9_-]{8,80}$/.test(p.requestId)||p.kind!=='monitor')fail('not-ready');
  const payload=hash(p);for(const name of this.names()){const r=this.record(name.slice(0,-5));if(r.requestId===p.requestId){if(r.payloadHash!==payload)fail('request-conflict');return this.status({operationId:r.operationId});}}
  const source=this.analysis(p.analysisId),r={schemaVersion:2,operationId:uuid('op-'),requestId:p.requestId,analysisId:p.analysisId,attemptId:uuid('at-'),owner:this.owner,kind:'monitor',status:'registered',revision:1,createdAt:stamp(),checkedAt:stamp(),error:null,evidenceRefs:[],payloadHash:payload,analysisHash:source.digest};
  this.write(r); // Durable intent precedes attaching a local monitor.
  this.handles.add(r.operationId);const ready=this.update(r,{status:'monitoring'});this.journal(ready,'local-monitor-attached');return this.status({operationId:r.operationId});
 }
 registerConfiguration(p){
  object(p,['requestId','frozen','blocked']);if(typeof p.requestId!=='string'||! /^[A-Za-z0-9_-]{8,80}$/.test(p.requestId)||p.frozen?.adapterVersion!=='SIGNET-P3-O2-adapter-v1'||!['profileCheckPlan','transferPlan','submissionPlanInput'].includes(p.frozen.method)||typeof p.blocked!=='string')fail('invalid-parameters');
  if(Buffer.byteLength(canonical(p.frozen))>65536)fail('record-limit');const payloadHash=hash(p.frozen);for(const name of this.names()){const r=this.record(name.slice(0,-5));if(r.requestId===p.requestId){if(r.kind!=='s3-plan'||r.payloadHash!==payloadHash)fail('operation_conflict');return this.status({operationId:r.operationId});}}
  const r={schemaVersion:2,operationId:uuid('op-'),requestId:p.requestId,analysisId:null,attemptId:uuid('at-'),owner:this.owner,kind:'s3-plan',status:'blocked',revision:1,createdAt:stamp(),checkedAt:stamp(),error:{code:p.blocked},evidenceRefs:[],payloadHash,planHash:hash(p.frozen),frozen:structuredClone(p.frozen),executeEnabled:false};
  this.write(r);return this.status({operationId:r.operationId});
 }
 projection(r){if(r.kind==='s3-plan')return {stateSource:'persisted-local-plan',checkedAt:r.checkedAt,revision:r.revision,localController:'plan-only',remoteController:'unknown',remoteJobs:'unknown',scientificCompletion:'unknown',executeEnabled:false};const a=this.analysis(r.analysisId).state;return {stateSource:'persisted-local-record',checkedAt:r.checkedAt,revision:r.revision,localController:this.handles.has(r.operationId)?'monitoring':'detached',remoteController:'unknown',remoteJobs:'unknown',scientificCompletion:'unknown',stages:(a.stages||[]).slice(0,6).map(s=>({id:s.id,localRecordedStatus:s.status,remoteStatus:'unknown',verifiedCompletion:false})),batches:'unknown'};}
 status(params){const p=object(params,['operationId']);let r=this.record(p.operationId);if(['registered','monitoring','cancelling'].includes(r.status)&&!this.handles.has(r.operationId))r=this.update(r,{status:'unknown',error:{code:'controller-lost'}});return {...r,projection:this.projection(r)};}
 target(params){const p=object(params,['operationId','analysisId','attemptId','owner','revision','confirmed']);const r=this.record(p.operationId);if(r.analysisId!==p.analysisId||r.attemptId!==p.attemptId||r.owner!==p.owner)fail('identity-mismatch');if(r.revision!==p.revision)fail('stale-revision');return r;}
 cancel(params){
  let r=this.target(params);if(r.kind!=='monitor')fail('not-ready');if(params.confirmed!==true)return {...r,confirmationRequired:true};
  if(r.status==='cancelled')return {...r,projection:this.projection(r)};
  r=this.update(r,{status:'cancelling'});this.journal(r,'cancel-intent');
  if(!this.handles.delete(r.operationId))return this.update(r,{status:'unknown',error:{code:'controller-lost'}});
  const evidence={kind:'local-monitor-released',operationId:r.operationId,attemptId:r.attemptId,owner:r.owner,checkedAt:stamp()};
  r=this.update(r,{status:'cancelled',error:null,evidenceRefs:[...r.evidenceRefs,evidence]});this.journal(r,'local-monitor-released');return {...r,projection:this.projection(r)};
 }
 scan(params){const p=object(params,['limit']);const limit=p.limit??50;if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('invalid-parameters');const names=this.names(),candidates=[],issues=[];for(const name of names.slice(0,limit)){try{candidates.push(this.status({operationId:name.slice(0,-5)}));}catch(e){issues.push({recordId:name.slice(0,-5),code:e.code||'corrupt-record'});}}return {status:issues.length?'partial':'ok',candidates,issues,truncated:names.length>limit,checkedAt:stamp(),scope:'owned-isolated-local-manifests',remote:'unknown'};}
 attach(params){let r=this.target(params);if(r.kind!=='monitor')fail('not-ready');if(params.confirmed!==undefined)fail('invalid-parameters');if(this.analysis(r.analysisId).digest!==r.analysisHash)fail('stale-source');if(r.status==='cancelled')fail('not-ready');if(this.handles.has(r.operationId))return {...r,attached:true,duplicate:true};this.handles.add(r.operationId);r=this.update(r,{status:'monitoring',error:null});this.journal(r,'local-monitor-reattached');return {...r,attached:true,scientificResubmitted:false,projection:this.projection(r)};}
 journal(r,event){const file=this.safe(path.join(this.base,'logs',r.operationId+'-controller.log'));if(fs.existsSync(file)&&fs.statSync(file).size>1024*1024)fail('log-limit');fs.appendFileSync(file,JSON.stringify({at:stamp(),event,operationId:r.operationId,status:r.status,revision:r.revision})+'\n',{mode:0o600});}
 logRead(params){
  const p=object(params,['operationId','logId','cursor','limit']);const record=this.record(p.operationId);if(!['controller','worker','stage','scheduler'].includes(p.logId))fail('invalid-log-id');const limit=p.limit??8192;if(!Number.isSafeInteger(limit)||limit<256||limit>8192)fail('invalid-parameters');
  const file=this.safe(p.logId==='worker'?path.join(this.root,'analyses',record.analysisId,'worker.log'):path.join(this.base,'logs',p.operationId+'-'+p.logId+'.log'));let raw;try{raw=bounded(file,2*1024*1024);}catch(e){if(e.code==='ENOENT')return {status:'unavailable',text:'',complete:false,error:{code:'missing-log'}};if(e.code==='record-limit')return {status:'unavailable',text:'',complete:false,truncated:true,error:{code:'log-limit'}};throw e;}
  const identity=hash(raw.bytes)+':'+raw.stat.dev+':'+raw.stat.ino;let offset=0,page=0;
  if(p.cursor!==undefined&&p.cursor!==null){if(typeof p.cursor!=='string'||p.cursor.length>512)fail('invalid-cursor');let c;try{c=JSON.parse(Buffer.from(p.cursor,'base64url'));}catch{fail('invalid-cursor');}if(c.operationId!==p.operationId||c.logId!==p.logId||!Number.isSafeInteger(c.offset)||c.offset<0||!Number.isSafeInteger(c.page)||c.page<1||c.page>=256)fail('invalid-cursor');if(c.identity!==identity)return {status:'rotated',text:'',complete:false,cursor:null,error:{code:'log-rotated'},source:'owned-local-log'};offset=c.offset;page=c.page;}
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(raw.bytes);}catch{return {status:'unavailable',text:'',complete:false,error:{code:'invalid-utf8'}};}
  // Redact the bounded snapshot BEFORE pagination, including secrets crossing raw chunks/pages.
  text=text.replace(/(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\r\n]+/gi,'$1[REDACTED]').replace(/((?:password|token|secret|api[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1[REDACTED]');
  const bytes=Buffer.from(text);if(offset<bytes.length&&(bytes[offset]&0xc0)===0x80)fail('invalid-cursor');if(offset>bytes.length)fail('invalid-cursor');let end=Math.min(bytes.length,offset+limit);while(end<bytes.length&&end>offset&&(bytes[end]&0xc0)===0x80)end--;const complete=end===bytes.length;
  const truncated=!complete&&page+1>=256;const cursor=complete||truncated?null:Buffer.from(JSON.stringify({identity,offset:end,page:page+1,operationId:p.operationId,logId:p.logId})).toString('base64url');
  return {status:'ok',text:bytes.subarray(offset,end).toString('utf8'),cursor,complete,truncated,bytes:end-offset,snapshotBytes:bytes.length,source:'owned-local-log',checkedAt:stamp(),redacted:true};
 }
 explain(params){const p=object(params,['operationId','code']);let code=p.code;if(p.operationId)code=this.record(p.operationId).error?.code;const definition=typeof code==='string'&&Object.hasOwn(EXPLANATIONS,code)?EXPLANATIONS[code]:null;return {status:definition?'explained':'unavailable',code:definition?code:null,title:definition?.[0]??'No supported explanation',advice:definition?.[1]??'Inspect the bounded source log; no model diagnosis was generated.',source:'fixed-s2-error-catalog',modelCalled:false};}
 checkpoint(params){
  const p=object(params,['analysisId','attemptId','kind','npc','batchIds','planHash','confirmed']);if(!ANALYSIS.test(p.analysisId)||!/^at-[a-f0-9]{32}$/.test(p.attemptId)||!['pca','retry'].includes(p.kind))fail('invalid-parameters');
  let c;try{c=this.readJSON(path.join(this.base,'checkpoints',p.analysisId+'.json'));}catch(e){if(e.code==='ENOENT')return {status:'not_ready',code:'missing-checkpoint',executeEnabled:false};throw e;}
  if(c.schemaVersion!==2||c.owner!==this.owner||c.analysisId!==p.analysisId||c.attemptId!==p.attemptId||typeof c.planHash!=='string'||!/^[a-f0-9]{64}$/.test(c.planHash))fail('identity-mismatch');
  const checked=Date.parse(c.checkedAt),expires=Date.parse(c.expiresAt);
  if(!Number.isFinite(checked)||!Number.isFinite(expires))return {status:'not_ready',code:'missing-checkpoint-evidence',executeEnabled:false};
  if(checked>Date.now()+1000||expires<=Date.now()||expires<=checked||expires-checked>3600000)fail('stale-plan');
  if(p.npc===undefined&&p.batchIds===undefined&&p.planHash===undefined&&p.confirmed!==true){
   return {status:'checkpoint_available',availablePCs:(c.availablePCs||[]).filter(n=>Number.isSafeInteger(n)&&n>=1&&n<=5).slice(0,5),failedBatches:(c.batches||[]).filter(b=>b.status==='failed'&&typeof b.id==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(b.id)).slice(0,100).map(b=>({id:b.id,status:'failed'})),checkpointHash:hash(c),executeEnabled:false};
  }
  if(p.kind==='pca'&&(!Number.isSafeInteger(p.npc)||p.npc<1||p.npc>5||!Array.isArray(c.availablePCs)||!c.availablePCs.includes(p.npc)))fail('invalid-npc');
  if(p.kind==='retry'&&(!Array.isArray(p.batchIds)||!p.batchIds.length||p.batchIds.length>100||new Set(p.batchIds).size!==p.batchIds.length||p.batchIds.some(id=>typeof id!=='string'||! /^[a-zA-Z0-9_-]{1,80}$/.test(id)||!c.batches?.some(b=>b.id===id&&b.status==='failed'))))fail('invalid-batches');
  const planHash=hash({checkpoint:c,kind:p.kind,npc:p.npc??null,batchIds:p.batchIds??[]});if(p.planHash!==undefined&&p.planHash!==planHash)fail('stale-plan');if(p.confirmed===true&&!p.planHash)fail('stale-plan');
  return {status:p.confirmed===true?'not_ready':'confirmation_required',planHash,checkpointHash:hash(c),executeEnabled:false,code:p.confirmed===true?'not-ready':null,scientificExecuted:false};
 }
 close(params){const p=object(params,['decision','target']);if(!['review','keep-running','close-anyway','cancel-owned'].includes(p.decision))fail('invalid-parameters');if(p.decision==='review')return {confirmationRequired:true,active:this.scan({limit:100}).candidates.filter(r=>this.handles.has(r.operationId)),shouldClose:false};if(p.decision==='keep-running')return {shouldClose:false,cancelled:false};if(p.decision==='close-anyway')return {shouldClose:true,cancelled:false,independentAnalysisStopped:false};const r=this.cancel({...p.target,confirmed:true});return {shouldClose:r.status==='cancelled',operation:r,independentAnalysisStopped:false};}
}
// All state transitions have one short durable-intent mutex, never a long await.
for(const method of ['start','status','cancel','scan','attach','registerConfiguration']){
 const original=Operations.prototype[method];
 Operations.prototype[method]=function(...args){
  if(this.lockDepth)return original.apply(this,args);
  const file=this.safe(path.join(this.base,'intent.lock'));let fd;
  try{fd=fs.openSync(file,'wx',0o600);}catch(e){if(e.code==='EEXIST')fail('controller-busy');throw e;}
  this.lockDepth++;
  try{return original.apply(this,args);}finally{this.lockDepth--;fs.closeSync(fd);fs.unlinkSync(file);}
 };
}
module.exports={Operations,hash,canonical};
