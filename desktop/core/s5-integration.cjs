'use strict';
// Core-only authority enters at construction; renderer requests never contain roots, grants or paths.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {PackageIndex}=require('./s5/package.cjs'),{METHODS}=require('./s5-api.cjs');
const fail=code=>{throw Object.assign(Error(code),{code});};
const plain=x=>x!==null&&typeof x==='object'&&Object.getPrototypeOf(x)===Object.prototype;
const copy=x=>JSON.parse(JSON.stringify(x)),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const token=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function exact(p,keys,limit=16384){if(!plain(p)||Object.keys(p).length!==keys.length||Object.keys(p).some(k=>!keys.includes(k))||Buffer.byteLength(JSON.stringify(p))>limit)fail('schema_invalid');}
function view(s){
 const network=s.network?{...s.network,genes:s.network.genes.slice(0,100),sources:s.network.sources.slice(0,100),targets:s.network.targets.slice(0,100),edges:s.network.edges.slice(0,200),geneCount:s.network.genes.length,edgeCount:s.network.edges.length,previewLimit:200,previewTruncated:s.network.edges.length>200||s.network.genes.length>100}:null;
 return {...s,network};
}
class Packages{
 constructor(root,{authority=null}={}){
  this.index=null;this.sources=[];
  if(authority===null)return;
  exact(authority,['roots','sources'],512*1024);
  if(!Array.isArray(authority.sources)||authority.sources.length>128||Buffer.byteLength(JSON.stringify(authority))>512*1024)fail('entry_limit');
  const grants=new Map();
  for(const item of authority.sources){exact(item,['sourceToken','label','grant'],65536);if(!token(item.sourceToken)||typeof item.label!=='string'||!item.label.trim()||item.label.length>80||/[\x00-\x1f\x7f]/.test(item.label)||grants.has(item.sourceToken))fail('schema_invalid');grants.set(item.sourceToken,copy(item.grant));this.sources.push({sourceToken:item.sourceToken,label:item.label});}
  this.index=new PackageIndex({stateRoot:path.join(root,'s5','packages'),roots:copy(authority.roots),resolveSource:async key=>grants.has(key)?copy(grants.get(key)):null});
 }
 readSelection(){
  const file=path.join(this.index.stateRoot,'selected.json');let fd;
  try{const st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isFile()||st.size>4096)fail('state_invalid');fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const before=fs.fstatSync(fd);if(before.dev!==st.dev||before.ino!==st.ino||before.size!==st.size)fail('state_invalid');const bytes=Buffer.alloc(before.size);let offset=0,n;while(offset<bytes.length&&(n=fs.readSync(fd,bytes,offset,bytes.length-offset,null)))offset+=n;const after=fs.fstatSync(fd),current=fs.lstatSync(file);if(offset!==bytes.length||current.isSymbolicLink()||['dev','ino','size','mtimeMs','ctimeMs'].some(k=>before[k]!==after[k]||before[k]!==current[k]))fail('state_invalid');
   const e=JSON.parse(bytes);exact(e,['state','sha256']);exact(e.state,['schemaVersion','revision','selection']);const r=e.state;exact(r.selection,['packageId','packageHash','artifactId']);if(e.sha256!==sha(JSON.stringify(r))||r.schemaVersion!==1||!Number.isSafeInteger(r.revision)||r.revision<1||!token(r.selection.packageId)||!digest(r.selection.packageHash)||!token(r.selection.artifactId))fail('state_invalid');return r;
  }catch(e){if(e.code==='ENOENT')return {schemaVersion:1,revision:0,selection:null};fail('state_invalid');}finally{if(fd!==undefined)fs.closeSync(fd);}
 }
 identity(){const root=fs.lstatSync(this.index.stateRoot),lock=fs.lstatSync(path.join(this.index.stateRoot,'index.lock'));if(root.isSymbolicLink()||!root.isDirectory()||lock.isSymbolicLink()||!lock.isFile())fail('io_conflict');return [root.dev,root.ino,lock.dev,lock.ino].join(':');}
 writeSelection(state,identity){
  if(this.identity()!==identity)fail('io_conflict');
  const file=path.join(this.index.stateRoot,'selected.json'),temp=path.join(this.index.stateRoot,'selection-'+crypto.randomUUID()+'.tmp');let fd;
  try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({state,sha256:sha(JSON.stringify(state))}));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;if(this.identity()!==identity)fail('io_conflict');fs.renameSync(temp,file);const dir=fs.openSync(this.index.stateRoot,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
  finally{if(fd!==undefined)fs.closeSync(fd);if(this.identity()===identity&&fs.existsSync(temp))fs.unlinkSync(temp);}
 }
 async selection(){
  return this.index.transaction(async state=>{const saved=this.readSelection();if(!saved.selection)return {status:'none',revision:0,selection:null,executeEnabled:false};
   try{const s=await this.index.current(state,saved.selection.packageId,saved.selection.packageHash),a=s.artifacts.find(a=>a.artifactId===saved.selection.artifactId);if(a?.state!=='ready')fail('not_ready');return {status:'selected',...saved,package:view(s),artifact:a,executeEnabled:false};}
   catch(e){return {status:'blocked',...saved,package:null,artifact:null,error:e.code||'source_unavailable',executeEnabled:false};}
  });
 }
 async call(method,p={}){
  if(!METHODS.includes(method))fail('schema_invalid');
  if(['packageList','packageSelection'].includes(method))exact(p,[]);
  if(!this.index){if(method==='packageList'||method==='packageSelection')return {status:'blocked',missing:['trusted_source_authority'],packages:[],sources:[],selection:null,executeEnabled:false};fail('source_authority_unavailable');}
  if(method==='packageList'){
   const packages=await this.index.transaction(s=>Object.entries(s.packages).map(([packageId,p])=>({packageId,packageHash:p.packageHash,integrity:'not-rechecked'})));
   return {status:'local-index',sources:copy(this.sources),packages,selected:await this.selection(),executeEnabled:false,scientificStatus:'unknown'};
  }
  if(method==='packageSelection')return this.selection();
  if(method==='packageInspect')return view(await this.index.inspect(p));
  if(method==='packageRegister')return view(await this.index.register(p));
  if(method==='packageGet')return view(await this.index.get(p));
  if(method==='packageSelect'){
   exact(p,['packageId','packageHash','artifactId','expectedRevision']);if(!token(p.packageId)||!digest(p.packageHash)||!token(p.artifactId)||!Number.isSafeInteger(p.expectedRevision)||p.expectedRevision<0)fail('schema_invalid');
   return this.index.transaction(async state=>{const identity=this.identity(),previous=this.readSelection();if(previous.revision!==p.expectedRevision)fail('reference_drift');const s=await this.index.current(state,p.packageId,p.packageHash),a=s.artifacts.find(a=>a.artifactId===p.artifactId);if(!a||a.state!=='ready')fail('not_ready');
    const next={schemaVersion:1,revision:previous.revision+1,selection:{packageId:p.packageId,packageHash:p.packageHash,artifactId:p.artifactId}};if(!Number.isSafeInteger(next.revision))fail('entry_limit');this.writeSelection(next,identity);return {status:'selected',...next,package:view(s),artifact:a,executeEnabled:false};});
  }
  const plan=method==='packageImportPlan'?await this.index.importPlan(p):await this.index.exportPlan(p);
  return {...plan,status:'blocked',missing:method==='packageImportPlan'?['accepted_import_executor','new_draft_authorization']:['accepted_export_executor','authorized_destination'],actualDownloadPerformed:false,actualDraftCreated:false};
 }
}
module.exports={Packages};
