'use strict';
// Main-private, fixed public snapshot admission. No renderer paths or network fallback.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const pins=require('./core/s6/official/public-resource-pins.json');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
function readFixed(file,limit){const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const a=fs.fstatSync(fd,{bigint:true});if(!a.isFile()||a.size>BigInt(limit))fail('PUBLIC_RESOURCE_INVALID');const b=fs.readFileSync(fd);if(b.length!==Number(a.size)||identity(a)!==identity(fs.fstatSync(fd,{bigint:true})))fail('PUBLIC_RESOURCE_CHANGED');return b;}finally{fs.closeSync(fd);}}
function identity(s){return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');}
function admitBinding(parameters,networkHashes){if(parameters.freq!==1||parameters.ntop!==1)fail('PUBLIC_RESOURCE_PARAMETERS_MISMATCH');for(const [role,name] of Object.entries({frequency:'signet_Afreq',coefficient:'signet_CoeffMat0',positions:'signet_net.genepos'}))if(networkHashes[role]!==pins.binding.inputs[name].sha256)fail('PUBLIC_RESOURCE_INPUT_MISMATCH');}
class PublicResources{
 constructor(root,parameters,networkHashes){admitBinding(parameters,networkHashes);if(typeof root!=='string'||!path.isAbsolute(root)||fs.realpathSync(root)!==root||fs.realpathSync(path.join(root,'snapshots'))!==path.join(root,'snapshots'))fail('PUBLIC_RESOURCE_UNCONFIGURED');this.root=root;
 for(const [name,pin] of [['acquisition.json',pins.acquisitionSHA256],['enrichment.json',pins.enrichmentSHA256]])if(sha(readFixed(path.join(root,name),65536))!==pin)fail('PUBLIC_RESOURCE_PROVENANCE_CHANGED');
 }
 async upload(channel,valid){const started=await channel.call('resources-begin',{},10000);channel.guestRoot=started?.guestRoot??null;for(const [name,pin] of Object.entries(pins.files)){if(!valid())fail('AUTHORIZATION_REVOKED');const derived=name==='identifiers.txt';let fd=null;try{const bytes=derived?Buffer.from(pins.binding.identifiers.join('\n')+'\n'):null;
 if(!derived)fd=fs.openSync(path.join(this.root,'snapshots',name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 const before=fd===null?null:fs.fstatSync(fd,{bigint:true});if(before&&(!before.isFile()||before.size!==BigInt(pin.bytes)))fail('PUBLIC_RESOURCE_INVALID');
 const digest=crypto.createHash('sha256');await channel.call('resource-begin',{name});let offset=0;
 while(offset<pin.bytes){if(!valid())fail('AUTHORIZATION_REVOKED');const b=Buffer.alloc(Math.min(1024*1024,pin.bytes-offset));const n=derived?bytes.copy(b,0,offset,offset+b.length):fs.readSync(fd,b,0,b.length,offset);if(n!==b.length)fail('PUBLIC_RESOURCE_CHANGED');digest.update(b);await channel.call('resource-chunk',{offset,bytes:b.toString('base64')},5000);offset+=n;}
 if(digest.digest('hex')!==pin.sha256||before&&identity(before)!==identity(fs.fstatSync(fd,{bigint:true})))fail('PUBLIC_RESOURCE_HASH_MISMATCH');await channel.call('resource-end',{},5000);
 }finally{if(fd!==null)fs.closeSync(fd);}}return {binding:pins.binding,files:pins.files};}
}
module.exports={PublicResources,admitBinding,pins};
