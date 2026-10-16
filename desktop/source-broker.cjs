'use strict';
// Main-owned local authority. Only an explicit native directory choice can add a source.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {PackageIndex,parseNetwork,LIMITS}=require('./core/s5/package.cjs');
const fail=code=>{throw Object.assign(Error(code),{code});},sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function exact(x,keys){if(!x||Object.getPrototypeOf(x)!==Object.prototype||Object.keys(x).length!==keys.length||Object.keys(x).some(k=>!keys.includes(k)))fail('schema_invalid');}
function directory(p,create=false){if(typeof p!=='string'||!path.isAbsolute(p)||path.resolve(p)!==p||p==='/')fail('unsafe_path');let at='/';for(const part of p.slice(1).split('/')){at=path.join(at,part);let st;try{st=fs.lstatSync(at);}catch(e){if(e.code!=='ENOENT'||!create)throw e;fs.mkdirSync(at,{mode:0o700});st=fs.lstatSync(at);}if(st.isSymbolicLink()||!st.isDirectory())fail('unsafe_path');}const st=fs.statSync(p);return `${st.dev}:${st.ino}`;}
function read(p,max){directory(path.dirname(p));let fd;try{const st=fs.lstatSync(p);if(!st.isFile()||st.isSymbolicLink()||st.size>max)fail('state_invalid');fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const before=fs.fstatSync(fd);if(['dev','ino','size','mtimeMs','ctimeMs'].some(k=>before[k]!==st[k]))fail('source_changed');const b=Buffer.alloc(st.size);let off=0,n;while(off<b.length&&(n=fs.readSync(fd,b,off,b.length-off,null)))off+=n;const after=fs.fstatSync(fd),now=fs.lstatSync(p);if(off!==b.length||now.isSymbolicLink()||['dev','ino','size','mtimeMs','ctimeMs'].some(k=>before[k]!==after[k]||before[k]!==now[k]))fail('source_changed');return b;}finally{if(fd!==undefined)fs.closeSync(fd);}}
// Roll back only entries created by this attempt, under the same verified parent.
function rollbackCopies(created){
 for(const item of [...created].reverse())try{
  if(directory(path.dirname(item.path))!==item.parent)continue;
  const st=fs.lstatSync(item.path);
  if(st.isSymbolicLink()||`${st.dev}:${st.ino}`!==item.identity)continue;
  if(item.directory){if(st.isDirectory())fs.rmdirSync(item.path);}else if(st.isFile()&&st.nlink===1)fs.unlinkSync(item.path);
 }catch{/* A replaced path, nonempty directory or uncertain cleanup must be retained. */}
}
class SourceBroker{
 constructor(root){
  this.root=root;this.dir=path.join(root,'s5/provider');this.identity=directory(this.dir,true);this.file=path.join(this.dir,'catalog.json');this.lock=path.join(this.dir,'provider.lock');this.fd=fs.openSync(this.lock,'wx',0o600);this.lockIdentity=fs.fstatSync(this.fd);this.entries=[];
  try{let raw;try{raw=read(this.file,512*1024);}catch(e){if(e.code!=='ENOENT')throw e;}if(raw){const env=JSON.parse(raw);exact(env,['state','sha256']);exact(env.state,['schemaVersion','entries']);if(env.state.schemaVersion!==1||sha(JSON.stringify(env.state))!==env.sha256||!Array.isArray(env.state.entries)||env.state.entries.length>128)fail('state_invalid');const seen=new Set();for(const e of env.state.entries){exact(e,['token','root','identity','manifestHash','revoked']);if(!/^local-[a-f0-9]{32}$/.test(e.token)||seen.has(e.token)||typeof e.root!=='string'||e.root.length>2048||typeof e.identity!=='string'||!/^\d+:\d+$/.test(e.identity)||! /^[a-f0-9]{64}$/.test(e.manifestHash)||typeof e.revoked!=='boolean')fail('state_invalid');seen.add(e.token);}this.entries=env.state.entries;if(this.entries.filter(e=>!e.revoked).length>8)fail('entry_limit');}
   this.empty=path.join(this.dir,'empty-source');directory(this.empty,true);
  }catch(e){this.close();throw e;}
 }
 guard(){const s=fs.lstatSync(this.lock);if(directory(this.dir)!==this.identity||s.isSymbolicLink()||s.dev!==this.lockIdentity.dev||s.ino!==this.lockIdentity.ino)fail('io_conflict');}
 save(entries){this.guard();const state={schemaVersion:1,entries},bytes=JSON.stringify({state,sha256:sha(JSON.stringify(state))});if(Buffer.byteLength(bytes)>512*1024)fail('entry_limit');const temp=path.join(this.dir,'catalog-'+crypto.randomUUID()+'.tmp');let fd;try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;this.guard();fs.renameSync(temp,this.file);const d=fs.openSync(this.dir,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}this.entries=entries;}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}}
 declaration(root){if(typeof root!=='string'||root.length>2048)fail('unsafe_path');const identity=directory(root);if(root===this.root||root.startsWith(this.root+'/s5/')||this.root.startsWith(root+'/'))fail('unsafe_path');const raw=read(path.join(root,'signet-package.json'),65536),d=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));exact(d,['schemaVersion','kind','label','manifest']);if(directory(root)!==identity)fail('source_changed');if(d.schemaVersion!==1||!['external','synthetic'].includes(d.kind)||typeof d.label!=='string'||!d.label.trim()||d.label.length>80||/[\x00-\x1f\x7f]/.test(d.label))fail('schema_invalid');return {identity,manifestHash:sha(raw),d};}
 source(e){if(e.revoked)fail('permission_denied');const {identity,manifestHash,d}=this.declaration(e.root);if(identity!==e.identity||manifestHash!==e.manifestHash)fail('reference_drift');return {sourceToken:e.token,label:d.label,grant:{rootId:e.token,sourceRef:d.manifest?.sourceRef,kind:d.kind,complete:true,manifest:d.manifest}};}
 async validate(e){const source=this.source(e),api=new PackageIndex({stateRoot:path.join(this.dir,'check'),roots:[{rootId:e.token,path:e.root}],resolveSource:async token=>token===e.token?this.source(e).grant:null});const snapshot=await api.inspect({sourceToken:e.token});if(snapshot.artifacts.some(a=>a.state!=='ready'))fail('not_ready');return source;}
 async open(){// Cold startup never trusts the saved reference alone.
  for(const e of this.entries.filter(e=>!e.revoked)){try{await this.validate(e);}catch{this.invalid??=new Set();this.invalid.add(e.token);}}
  return this;
 }
 prepareMatrices(source,authorize,created){
  if(source===this.root||source.startsWith(this.root+'/s5/')||this.root.startsWith(source+'/'))fail('unsafe_path');
  const identity=directory(source),names=['signet_Afreq','signet_CoeffMat0','signet_net.genepos'],roles=['matrix-frequency','matrix-coefficient','gene-positions'];
  const bytes=names.map(n=>read(path.join(source,n),LIMITS.fileBytes));if(bytes.reduce((n,b)=>n+b.length,0)>LIMITS.totalBytes)fail('size_limit');
  const decode=b=>new TextDecoder('utf-8',{fatal:true}).decode(b);parseNetwork({frequencyText:decode(bytes[0]),coefficientText:decode(bytes[1]),positionsText:decode(bytes[2]),direction:'column/source->row/target',axes:null});
  const hashes=bytes.map(sha),official=['d38bbcf94c5b4e722eabaaaa3d6b627a94ef05dac0f4f2e8fc43a9c946457193','354f56d2d1d19029474e77306d04ebb167a2d0705d6ee378fa911a99bb7b02f9','8f4ffd71673f512b5451cc13f9b041e166be4b33d6278d9deead4cfe227843b8'].every((h,i)=>h===hashes[i]);
  const batch=sha(JSON.stringify(hashes)),sourceRef={sourceId:official?'official-netvis-simulated':'local-network-matrices',batchId:'sha-'+batch.slice(0,32),revision:1};
  const declaration={schemaVersion:1,kind:official?'synthetic':'external',label:official?'Official SIGNET example (simulated)':'Local network matrices (unverified)',manifest:{schemaVersion:1,sourceRef,direction:'column/source->row/target',axes:null,claims:official?{status:'simulated',sourceCommit:'bed55b3e121de0edf5fd43da683dc59850ff82d3'}:null,visualization:null,artifacts:names.map((relativePath,i)=>({artifactId:['frequency','coefficient','positions'][i],role:roles[i],relativePath,bytes:bytes[i].length,sha256:hashes[i],sourceRef}))}};
  // Validate the exact native choice again before creating only derived, bounded bytes.
  authorize();if(directory(source)!==identity||names.some((n,i)=>!read(path.join(source,n),LIMITS.fileBytes).equals(bytes[i])))fail('source_changed');
  const target=path.join(this.root,'network-imports',batch);
  for(const dir of [path.dirname(target),target]){
   const parent=directory(path.dirname(dir));
   try{fs.mkdirSync(dir,{mode:0o700});const st=fs.lstatSync(dir);created.push({path:dir,parent,identity:`${st.dev}:${st.ino}`,directory:true});}catch(e){if(e.code!=='EEXIST')throw e;}
   directory(dir);
  }
  const parent=directory(target);
  for(const [n,b] of [...names.map((n,i)=>[n,bytes[i]]),['signet-package.json',Buffer.from(JSON.stringify(declaration))]]){
   const file=path.join(target,n);if(fs.existsSync(file)){if(!read(file,n==='signet-package.json'?65536:LIMITS.fileBytes).equals(b))fail('source_changed');continue;}
   const fd=fs.openSync(file,'wx',0o600);try{const st=fs.fstatSync(fd);created.push({path:file,parent,identity:`${st.dev}:${st.ino}`,directory:false});fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }
  authorize();return target;
 }
 async add(root,authorize=()=>{}){
  const created=[];let saving=false;
  try{this.guard();directory(root);if(!fs.existsSync(path.join(root,'signet-package.json')))root=this.prepareMatrices(root,authorize,created);const d=this.declaration(root),old=this.entries.find(e=>!e.revoked&&e.root===root&&e.manifestHash===d.manifestHash&&e.identity===d.identity);if(old){await this.validate(old);authorize();this.invalid?.delete(old.token);return {sourceToken:old.token,label:d.d.label};}if(this.entries.length>=128||this.entries.filter(e=>!e.revoked).length>=8)fail('entry_limit');const e={token:'local-'+crypto.randomBytes(16).toString('hex'),root,identity:d.identity,manifestHash:d.manifestHash,revoked:false};await this.validate(e);const source=this.source(e),authority=this.authority(),item={...source,localGuard:{manifestHash:e.manifestHash,identity:e.identity}};if(Buffer.byteLength(JSON.stringify(item))>65536)fail('entry_limit');const prospective={roots:[...authority.roots.filter(r=>r.rootId!=='empty'),{rootId:e.token,path:e.root}],sources:[...authority.sources,item]};if(Buffer.byteLength(JSON.stringify(prospective))>512*1024)fail('entry_limit');authorize();saving=true;this.save([...this.entries,e]);return {sourceToken:e.token,label:d.d.label};}
  catch(e){
   // A catalog write may already have committed; retain its referenced bytes on uncertain failure.
   if(!saving)try{this.guard();rollbackCopies(created);}catch{/* Lost broker ownership: retain all uncertain copies. */}
   throw e;
  }
 }
 async networkFiles(binding){
  const e=this.entries.find(e=>e.token===binding.sourceToken&&!e.revoked);if(!e)fail('permission_denied');const current=this.source(e),index=new PackageIndex({stateRoot:path.join(this.dir,'check'),roots:[{rootId:e.token,path:e.root}],resolveSource:async token=>token===e.token?this.source(e).grant:null}),snapshot=await index.inspect({sourceToken:e.token});
  if(snapshot.packageHash!==binding.packageHash||['frequency','coefficient','positions'].some(k=>snapshot.networkHashes[k]!==binding.networkHashes[k]))fail('reference_drift');
  const result={};for(const [name,role] of [['frequency','matrix-frequency'],['coefficient','matrix-coefficient'],['positions','gene-positions']]){const a=current.grant.manifest.artifacts.find(a=>a.role===role);if(!a)fail('not_ready');const b=read(path.join(e.root,a.relativePath),LIMITS.fileBytes);if(sha(b)!==binding.networkHashes[name]||b.length!==a.bytes)fail('source_changed');result[name]=b;}
  if(this.source(e).sourceToken!==binding.sourceToken)fail('reference_drift');return result;
 }
 revoke(p){exact(p,['sourceToken']);if(typeof p.sourceToken!=='string')fail('schema_invalid');const e=this.entries.find(e=>e.token===p.sourceToken);if(!e)fail('permission_denied');if(!e.revoked)this.save(this.entries.map(x=>x===e?{...e,revoked:true}:x));return {revoked:true,sourceToken:e.token};}
 catalog(){return this.entries.filter(e=>!e.revoked).map(e=>{try{if(this.invalid?.has(e.token))throw Error();this.source(e);return {sourceToken:e.token,status:'approved'};}catch{return {sourceToken:e.token,status:'blocked'};}});}
 authority(){this.guard();const sources=[],roots=[];for(const e of this.entries){if(e.revoked||this.invalid?.has(e.token))continue;try{const s=this.source(e);sources.push({...s,localGuard:{manifestHash:e.manifestHash,identity:e.identity}});roots.push({rootId:e.token,path:e.root});}catch{}}return {roots:roots.length?roots:[{rootId:'empty',path:this.empty}],sources};}
 close(){if(this.fd===undefined)return;try{this.guard();fs.unlinkSync(this.lock);}finally{fs.closeSync(this.fd);this.fd=undefined;}}
}
function checkLocal(root,guard){exact(guard,['manifestHash','identity']);if(directory(root)!==guard.identity||sha(read(path.join(root,'signet-package.json'),65536))!==guard.manifestHash||directory(root)!==guard.identity)fail('reference_drift');}
module.exports={SourceBroker,checkLocal};
