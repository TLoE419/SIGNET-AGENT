import {mkdir,open,lstat,rename,unlink,chmod} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {utils} from 'ssh2';
import {profileInput,fail} from '../../modules/ssh/validation';
import type {ProfilesDocument,Profile,HostIdentity} from '../../modules/ssh/types';
class JsonFile<T> {
 constructor(readonly file:string,readonly validate:(v:unknown)=>T,readonly empty:()=>T,readonly serialize:(value:T)=>unknown=value=>value){}
 async prepare(){
  const dir=path.dirname(this.file);await mkdir(dir,{recursive:true,mode:0o700});const st=await lstat(dir);
  if(!st.isDirectory()||st.isSymbolicLink()||(process.getuid&&st.uid!==process.getuid()))throw Error('Unsafe SSH configuration directory.');
  if(process.platform!=='win32')await chmod(dir,0o700);
 }
 async load():Promise<T>{
  await this.prepare();
  let file;try{file=await open(this.file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return this.empty();throw Error('Cannot read SSH configuration; existing file was preserved.');}
  try{const st=await file.stat();if(!st.isFile()||st.size>1024*1024||(process.platform!=='win32'&&((st.mode&0o077)!==0||(process.getuid&&st.uid!==process.getuid()))))throw Error();return this.validate(JSON.parse(await file.readFile('utf8')))}
  catch{throw Error('SSH configuration is corrupt, unsupported, or has unsafe permissions. Existing file preserved; back it up and repair it before retrying.');}finally{await file.close()}
 }
 async write(value:T){
  const serialized=this.serialize(value);this.validate(serialized);await this.prepare();const temp=this.file+'.'+randomUUID()+'.tmp';
  try{const file=await open(temp,'wx',0o600);try{await file.writeFile(JSON.stringify(serialized,null,2)+'\n');await file.sync()}finally{await file.close()}await rename(temp,this.file)}finally{await unlink(temp).catch(()=>{})}
 }
}
function document(v:unknown):ProfilesDocument {
 const d=v as ProfilesDocument;
 if(!d||![3,4].includes(d.version)||!Array.isArray(d.profiles)||d.profiles.length>100||Object.keys(d).some(k=>!['version','profiles','selectedProfileId'].includes(k)))throw Error();
 const profiles=d.profiles.map(p=>{const valid=profileInput(p);if(!valid.id)throw Error();return valid as Profile});
 if(new Set(profiles.map(p=>p.id)).size!==profiles.length||(d.selectedProfileId!==null&&!profiles.some(p=>p.id===d.selectedProfileId)))throw Error();
 if(d.version===3&&profiles.some(p=>p.auth.method==='duo'))throw Error();
 return {version:d.version,profiles,selectedProfileId:d.selectedProfileId};
}
export class SshProfileRepository {
 private version:1|3|4=4;
 private file:JsonFile<ProfilesDocument>;
 private queue:Promise<unknown>=Promise.resolve();
 constructor(private dir:string){
  this.file=new JsonFile(path.join(dir,'profiles.json'),value=>{
   const raw=value as {version:number;profiles:any[];selectedProfileId:string|null};
   if(raw?.version!==1){const result=document(value);this.version=result.version;return result;}
   if(!Array.isArray(raw.profiles)||Object.keys(raw).some(k=>!['version','profiles','selectedProfileId'].includes(k)))throw Error();
   const converted=raw.profiles.map(p=>{
    if(!p||Object.keys(p).some(k=>!['id','name','host','port','username','privateKeyPath','keyId'].includes(k)))throw Error();
    const {privateKeyPath,keyId,...rest}=p;
    return {...rest,auth:{method:'private-key',privateKeyPath,...(keyId?{keyId}: {})}};
   });
   const result=document({...raw,version:3,profiles:converted});this.version=1;return result;
  },()=>({version:4,profiles:[],selectedProfileId:null}),value=>this.serialize(value));
 }
 private serialize(value:ProfilesDocument):unknown {
  if(this.version!==1)return {...value,version:this.version};
  return {version:1,selectedProfileId:value.selectedProfileId,profiles:value.profiles.map(p=>{
   if(p.auth.method!=='private-key')throw Error('Duo profiles require version 4.');
   return {id:p.id,name:p.name,host:p.host,port:p.port,username:p.username,privateKeyPath:p.auth.privateKeyPath,...(p.auth.keyId?{keyId:p.auth.keyId}: {})};
  })};
 }
 load(){return this.file.load()}
 async list(){return (await this.load()).profiles}
 private mutate<T>(fn:(d:ProfilesDocument)=>T):Promise<T>{
  const result=this.queue.then(async()=>{
   const d=await this.load(),previous=structuredClone(this.serialize(d)),value=fn(d);
   if(this.version!==4&&d.profiles.some(p=>p.auth.method==='duo')){
    // Preserve the last readable pre-Duo document for an explicit rollback.
    const backup=path.join(this.dir,`profiles.before-duo-${randomUUID()}.json`);
    const file=await open(backup,'wx',0o600);
    try{await file.writeFile(JSON.stringify(previous,null,2)+'\n');await file.sync()}finally{await file.close()}
    this.version=4;d.version=4;
   }
   await this.file.write(d);return value;
  });this.queue=result.catch(()=>{});return result;
 }
 upsert(profile:Profile){return this.mutate(d=>{const p=profileInput(profile) as Profile;const i=d.profiles.findIndex(v=>v.id===p.id);if(i<0)d.profiles.push(p);else d.profiles[i]=p;d.selectedProfileId=p.id;return p})}
 clearKey(keyId:string,keyPath:string){return this.mutate(d=>{for(const p of d.profiles)if(p.auth.method==='private-key'&&(p.auth.keyId===keyId||p.auth.privateKeyPath===keyPath))p.auth={method:'duo'}})}
 remove(id:string){return this.mutate(d=>{d.profiles=d.profiles.filter(p=>p.id!==id);if(d.selectedProfileId===id)d.selectedProfileId=null})}
 setSelectedProfile(id:string|null){return this.mutate(d=>{if(id!==null&&!d.profiles.some(p=>p.id===id))fail('INVALID_PROFILE','Profile not found.');d.selectedProfileId=id})}
}
export function hostIdentity(host:string,port:number,key:Buffer):HostIdentity {
 if(key.length<5||key.length>16384)throw Error('Invalid host key.');const n=key.readUInt32BE(0);if(n>128||n+4>key.length)throw Error('Invalid host key.');
 const algorithm=key.subarray(4,4+n).toString('ascii');if(utils.parseKey(`${algorithm} ${key.toString('base64')}`) instanceof Error)throw Error('Invalid host key.');
 return {host,port,algorithm,fingerprint:'SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,''),publicKey:key.toString('base64')};
}
export function validIdentity(v:unknown):v is HostIdentity {
 const p=v as HostIdentity;return !!p&&typeof p.host==='string'&&/^[a-z0-9:][a-z0-9.:-]{0,252}$/.test(p.host)&&Number.isInteger(p.port)&&p.port>0&&p.port<65536&&typeof p.algorithm==='string'&&/^[a-zA-Z0-9@._-]{1,128}$/.test(p.algorithm)&&typeof p.fingerprint==='string'&&/^SHA256:[A-Za-z0-9+/]{43}$/.test(p.fingerprint)&&Object.keys(p).every(k=>['host','port','algorithm','fingerprint','publicKey'].includes(k))&&(!('publicKey' in p)||(typeof p.publicKey==='string'&&Buffer.from(p.publicKey,'base64').toString('base64')===p.publicKey&&!(utils.parseKey(`${p.algorithm} ${p.publicKey}`) instanceof Error)&&'SHA256:'+createHash('sha256').update(Buffer.from(p.publicKey,'base64')).digest('base64').replace(/=+$/,'')===p.fingerprint));
}
export class HostKeyTrustStore {
 private file:JsonFile<{version:1;hosts:HostIdentity[]}>;private hosts:HostIdentity[]=[];private loaded=false;
 constructor(private readonly dir:string){this.file=new JsonFile(path.join(dir,'host-trust.json'),v=>{const d=v as {version:1;hosts:HostIdentity[]};if(!d||d.version!==1||!Array.isArray(d.hosts)||d.hosts.length>100||!d.hosts.every(validIdentity)||new Set(d.hosts.map(h=>h.host+':'+h.port)).size!==d.hosts.length)throw Error();return d},()=>({version:1,hosts:[]}))}
 async load(){this.hosts=(await this.file.load()).hosts;this.loaded=true}
 get(host:string,port:number){if(!this.loaded)throw Error('Host trust store unavailable.');const identity=this.hosts.find(item=>item.host===host&&item.port===port);return identity?structuredClone(identity):undefined}
 check(identity:HostIdentity){if(!this.loaded)throw Error('Host trust store unavailable.');const known=this.hosts.find(h=>h.host===identity.host&&h.port===identity.port);return !known?'unknown':known.algorithm===identity.algorithm&&known.fingerprint===identity.fingerprint?'match':'changed'}
 async trust(identity:HostIdentity){if(!validIdentity(identity)||this.check(identity)!=='unknown')fail('HOST_KEY_CHANGED','Existing host trust cannot be replaced here. Contact your administrator.');const hosts=[...this.hosts,identity];await this.file.write({version:1,hosts});this.hosts=hosts}
 async attachPublicKey(identity:HostIdentity){
  if(!validIdentity(identity)||!identity.publicKey||this.check(identity)!=='match')fail('HOST_KEY_CHANGED','Saved host identity no longer matches the server. Connection blocked.');
  const hosts=this.hosts.map(host=>host.host===identity.host&&host.port===identity.port?identity:host);await this.file.write({version:1,hosts});this.hosts=hosts;
 }
 async materializeKnownHosts(){
  if(!this.loaded)throw Error('Host trust store unavailable.');const target=path.join(this.dir,'known_hosts'),temporary=target+'.'+randomUUID()+'.tmp';await this.file.prepare();
  const lines=this.hosts.map(identity=>{if(!identity.publicKey)throw Error('Saved host key cannot be exported.');const host=identity.port===22?identity.host:`[${identity.host}]:${identity.port}`;return `${host} ${identity.algorithm} ${identity.publicKey}`});
  try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(lines.join('\n')+(lines.length?'\n':''));await file.sync()}finally{await file.close()}await rename(temporary,target);if(process.platform!=='win32')await chmod(target,0o600)}finally{await unlink(temporary).catch(()=>{})}return target;
 }
}
