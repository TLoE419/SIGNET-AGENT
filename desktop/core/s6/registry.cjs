'use strict';
// Finite local metadata only. Source and process evidence must come from trusted core providers.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const fail=code=>{throw Object.assign(Error(code),{code});};
const plain=x=>x!==null&&typeof x==='object'&&Object.getPrototypeOf(x)===Object.prototype;
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(x);
const aid=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const canonical=x=>{if(x===null||typeof x==='string'||typeof x==='boolean'||typeof x==='number'&&Number.isFinite(x))return JSON.stringify(x);if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';if(plain(x))return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';fail('SCHEMA_INVALID');};
const hash=x=>crypto.createHash('sha256').update(canonical(x)).digest('hex'),copy=x=>JSON.parse(canonical(x));
function exact(x,keys){if(!plain(x)||Object.keys(x).length!==keys.length||Object.keys(x).some(k=>!keys.includes(k)))fail('SCHEMA_INVALID');}
function safeRoot(root,create=false){if(typeof root!=='string'||!path.isAbsolute(root)||path.resolve(root)!==root||root==='/'||root==='/Users/tloe/Developer/SIGNET'||root.startsWith('/Users/tloe/Developer/SIGNET/')||/(?:^|\/)S\d(?:-[A-Za-z]+)*-source(?:\/|$)/.test(root))fail('UNSAFE_ROOT');let at=path.parse(root).root;for(const part of root.slice(at.length).split('/')){at=path.join(at,part);if(!fs.existsSync(at)){if(!create)fail('UNSAFE_ROOT');fs.mkdirSync(at,{mode:0o700});}const st=fs.lstatSync(at);if(st.isSymbolicLink()||!st.isDirectory())fail('UNSAFE_ROOT');}if(fs.realpathSync(root)!==root)fail('UNSAFE_ROOT');return root;}
class Storage{
 constructor(root,{beforePublish}={}){this.root=safeRoot(root,true);this.beforePublish=beforePublish;}
 file(name){if(!/^[a-z][a-z.-]{0,63}$/.test(name))fail('SCHEMA_INVALID');return path.join(this.root,name);}
 read(name,limit){safeRoot(this.root);const file=this.file(name);let fd,expected;
  try{expected=fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')return null;fail('STATE_INVALID');}
  if(expected.isSymbolicLink()||!expected.isFile()||expected.size>limit)fail('STATE_INVALID');
  try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const before=fs.fstatSync(fd);if(['dev','ino','size','mtimeMs','ctimeMs'].some(k=>before[k]!==expected[k]))fail('STATE_INVALID');const bytes=Buffer.alloc(before.size);let n,offset=0;while(offset<bytes.length&&(n=fs.readSync(fd,bytes,offset,bytes.length-offset,null)))offset+=n;const after=fs.fstatSync(fd),current=fs.lstatSync(file);if(offset!==bytes.length||current.isSymbolicLink()||['dev','ino','size','mtimeMs','ctimeMs'].some(k=>before[k]!==after[k]||before[k]!==current[k]))fail('STATE_INVALID');const e=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));exact(e,['body','sha256']);if(!digest(e.sha256)||e.sha256!==hash(e.body))fail('STATE_INVALID');return e.body;
  }catch{fail('STATE_INVALID');}finally{if(fd!==undefined)fs.closeSync(fd);}
 }
 write(name,body,limit,guard){guard();const bytes=canonical({body,sha256:hash(body)});if(Buffer.byteLength(bytes)>limit)fail('STATE_LIMIT');const tmp=path.join(this.root,'tmp-'+crypto.randomUUID()+'.part');let fd;
  try{fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;this.beforePublish?.({name,tempPath:tmp,phase:'temp-synced'});guard();fs.renameSync(tmp,this.file(name));const dir=fs.openSync(this.root,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
  finally{if(fd!==undefined)fs.closeSync(fd);try{guard();if(fs.existsSync(tmp))fs.unlinkSync(tmp);}catch{/* Never touch replacement roots or unknown files. */}}
 }
 async locked(fn){safeRoot(this.root);const file=this.file('registry.lock'),ownerBytes=Buffer.from(canonical({owner:crypto.randomUUID(),pid:null,birthEvidence:null}));let fd;try{fd=fs.openSync(file,'wx+',0o600);}catch{fail('LOCKED');}const root=fs.lstatSync(this.root),lock=fs.fstatSync(fd);
  const guard=()=>{safeRoot(this.root);const r=fs.lstatSync(this.root),l=fs.lstatSync(file);if(l.isSymbolicLink()||r.dev!==root.dev||r.ino!==root.ino||l.dev!==lock.dev||l.ino!==lock.ino||l.size!==ownerBytes.length)fail('LOCK_REPLACED');const observed=Buffer.alloc(ownerBytes.length);if(fs.readSync(fd,observed,0,observed.length,0)!==observed.length||!observed.equals(ownerBytes))fail('LOCK_REPLACED');};
  try{fs.writeFileSync(fd,ownerBytes);fs.fsyncSync(fd);return await fn(guard);}finally{try{guard();fs.unlinkSync(file);}catch{}finally{fs.closeSync(fd);}}
 }
}
function normalize(b){
 exact(b,['subjectRef','sourceRef','packageHash','a5Revision','parameters','networkHashes','sessionRef','sessionHash','manifestRef','manifestHash','officialHash','containerHash','evidence','scientificStatus']);exact(b.sourceRef,['sourceId','batchId','revision']);exact(b.parameters,['freq','ntop']);exact(b.networkHashes,['frequency','coefficient','positions']);exact(b.evidence,['generationRef','loadRef','verificationRef','loadState']);
 if(!id(b.subjectRef)||!aid(b.sourceRef.sourceId)||!aid(b.sourceRef.batchId)||!Number.isSafeInteger(b.sourceRef.revision)||b.sourceRef.revision<1||!Number.isSafeInteger(b.a5Revision)||b.a5Revision<1||!Number.isFinite(b.parameters.freq)||b.parameters.freq<0||b.parameters.freq>1||!Number.isInteger(b.parameters.ntop)||b.parameters.ntop<1||b.parameters.ntop>100||!['packageHash','sessionHash','manifestHash','officialHash','containerHash'].every(k=>digest(b[k]))||!Object.values(b.networkHashes).every(digest)||!id(b.sessionRef)||!id(b.manifestRef)||!['unknown','not-tested','failed','loaded'].includes(b.evidence.loadState)||!['unknown','network-run-verified'].includes(b.scientificStatus))fail('SCHEMA_INVALID');
 if(['generationRef','loadRef','verificationRef'].some(k=>b.evidence[k]!==null&&!id(b.evidence[k]))||b.evidence.loadState==='loaded'&&(!b.evidence.generationRef||!b.evidence.loadRef))fail('EVIDENCE_INVALID');
 return copy(b);
}
class Registry{
 constructor({root,resolveSource,beforePublish,sourceTimeoutMs=1000}){if(!Number.isInteger(sourceTimeoutMs)||sourceTimeoutMs<5||sourceTimeoutMs>5000)fail('SCHEMA_INVALID');this.sourceTimeoutMs=sourceTimeoutMs;if(resolveSource!==undefined&&typeof resolveSource!=='function'||beforePublish!==undefined&&typeof beforePublish!=='function')fail('SCHEMA_INVALID');this.store=new Storage(root,{beforePublish});this.resolveSource=resolveSource??(async()=>null);}
 load(){const s=this.store.read('registry.json',2*1024*1024)??{schemaVersion:1,records:[],requests:[]};exact(s,['schemaVersion','records','requests']);if(s.schemaVersion!==1||!Array.isArray(s.records)||s.records.length>128||!Array.isArray(s.requests)||s.requests.length>256)fail('STATE_INVALID');const refs=new Set(),logical=new Set();
  for(const r of s.records){exact(r,['analysisId','visualizationRevision','sourceToken','binding','bindingHash']);normalize(r.binding);if(!id(r.analysisId)||!r.analysisId.startsWith('va-')||!id(r.visualizationRevision)||!r.visualizationRevision.startsWith('vr-')||!aid(r.sourceToken)||!digest(r.bindingHash)||hash(r.binding)!==r.bindingHash||refs.has(r.visualizationRevision)||logical.has(r.binding.subjectRef+':'+r.binding.a5Revision))fail('STATE_INVALID');refs.add(r.visualizationRevision);logical.add(r.binding.subjectRef+':'+r.binding.a5Revision);}
  const requests=new Set();for(const q of s.requests){exact(q,['requestId','payloadHash','visualizationRevision']);if(!aid(q.requestId)||!digest(q.payloadHash)||!refs.has(q.visualizationRevision)||requests.has(q.requestId))fail('STATE_INVALID');requests.add(q.requestId);}return s;
 }
 project(r){return {...copy(r.binding),analysisId:r.analysisId,visualizationRevision:r.visualizationRevision,state:'unknown',serviceEvidence:'unknown',url:null};}
 async authority(token){const abort=new AbortController();let timer;try{return await Promise.race([Promise.resolve().then(()=>this.resolveSource(token,{signal:abort.signal})),new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(Object.assign(Error('SOURCE_TIMEOUT'),{code:'SOURCE_TIMEOUT'}));},this.sourceTimeoutMs);})]);}catch(e){fail(e?.code==='SOURCE_TIMEOUT'?'SOURCE_TIMEOUT':'SOURCE_UNAVAILABLE');}finally{clearTimeout(timer);}}
 async current(r){let b=await this.authority(r.sourceToken);if(b===null||b===undefined)fail('SOURCE_UNAUTHORIZED');b=normalize(b);if(hash(b)!==r.bindingHash)fail('SOURCE_CHANGED');return b;}
 async register(p){exact(p,['sourceToken','requestId']);if(!aid(p.sourceToken)||!aid(p.requestId))fail('SCHEMA_INVALID');return this.store.locked(async guard=>{const s=this.load();let b=await this.authority(p.sourceToken);if(!b)fail('SOURCE_UNAUTHORIZED');b=normalize(b);const bindingHash=hash(b),payloadHash=hash({sourceToken:p.sourceToken,bindingHash}),q=s.requests.find(q=>q.requestId===p.requestId);let r=s.records.find(r=>r.binding.subjectRef===b.subjectRef&&r.binding.a5Revision===b.a5Revision);
   if(q){if(q.payloadHash!==payloadHash)fail('REQUEST_CONFLICT');const old=s.records.find(r=>r.visualizationRevision===q.visualizationRevision);await this.current(old);guard();return {...this.project(old),duplicate:true};}
   if(r&&r.bindingHash!==bindingHash)fail('REVISION_IMMUTABLE');
   const siblings=s.records.filter(r=>r.binding.subjectRef===b.subjectRef);
   if(siblings.some(r=>r.binding.sourceRef.sourceId!==b.sourceRef.sourceId||r.binding.sourceRef.batchId!==b.sourceRef.batchId))fail('SUBJECT_SOURCE_MISMATCH');
   if(!r&&siblings.some(r=>r.binding.sessionRef===b.sessionRef||r.binding.manifestRef===b.manifestRef))fail('REFERENCE_REUSED');
   if(s.requests.length>=256||!r&&s.records.length>=128)fail('ENTRY_LIMIT');
   // Verify again after awaited provider work, including grant revocation/source replacement.
   const second=await this.authority(p.sourceToken);if(second===null||hash(normalize(second))!==bindingHash)fail('SOURCE_CHANGED');guard();
   if(!r){r={analysisId:siblings[0]?.analysisId??'va-'+crypto.randomUUID(),visualizationRevision:'vr-'+crypto.randomUUID(),sourceToken:p.sourceToken,binding:b,bindingHash};s.records.push(r);}
   s.requests.push({requestId:p.requestId,payloadHash,visualizationRevision:r.visualizationRevision});this.store.write('registry.json',s,2*1024*1024,guard);return this.project(r);
  });}
 async get(p){exact(p,['analysisId','visualizationRevision']);if(!id(p.analysisId)||!id(p.visualizationRevision))fail('SCHEMA_INVALID');return this.store.locked(async guard=>{const r=this.load().records.find(r=>r.analysisId===p.analysisId&&r.visualizationRevision===p.visualizationRevision);if(!r)fail('REVISION_UNKNOWN');await this.current(r);guard();return this.project(r);});}
 recoveryState(){const locked=fs.existsSync(this.store.file('registry.lock'));try{const exists=fs.existsSync(this.store.file('registry.json')),s=this.load();return {state:locked?'blocked':'unknown',url:null,serviceEvidence:'unknown',recovery:locked?'incomplete':'none',operationOwner:'unknown',publishedRecords:s.records.length,publicationIntegrity:exists?'valid':'missing'};}catch{return {state:'blocked',url:null,serviceEvidence:'unknown',recovery:'incomplete',operationOwner:'unknown',publishedRecords:null,publicationIntegrity:'invalid'};}}
 async list(){return this.store.locked(guard=>{const s=this.load();guard();return {state:'unknown',url:null,records:s.records.map(r=>({analysisId:r.analysisId,visualizationRevision:r.visualizationRevision,a5Revision:r.binding.a5Revision,sourceRef:r.binding.sourceRef,packageHash:r.binding.packageHash,integrity:'not-rechecked'}))};});}
}
module.exports={Registry,Storage,normalize,hash,copy,exact,id,digest,fail};
