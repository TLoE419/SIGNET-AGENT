'use strict';
// Opt-in main-process diagnostics. Only rejected reads of the fixed public input or owned derived files.
const fs=require('node:fs'),path=require('node:path');
const fields=['dev','ino','size','mtimeMs','ctimeMs'];
function snapshot(s){if(!s)return {acquired:false};const values={};for(const k of fields)values[k]={value:s[k],numberRepresentation:typeof s[k]==='number'?s[k].toPrecision(21):String(s[k])};for(const k of ['mtimeNs','ctimeNs'])values[k]=typeof s[k]==='bigint'?String(s[k]):{acquired:false,reason:'original numeric fs.Stats does not expose nanoseconds; no extra stat performed'};return {acquired:true,values};}
function recordReadFailure(p,details){
 try{
  const env=process.env,out=env.SIGNET_READ_DIAGNOSTIC_ROOT,owned=env.SIGNET_REVIEW_PROJECT_ROOT,official=env.SIGNET_OFFICIAL_PROJECT_ROOT;if(!out||!owned||!official)return;
  const names={'signet_Afreq':'matrix-frequency','signet_CoeffMat0':'matrix-coefficient','signet_net.genepos':'gene-positions','signet-package.json':'derived-declaration'},name=path.basename(p);let role=null;
  if(name!=='signet-package.json'&&names[name]&&p===path.join(official,'official-signet/example/netvis',name))role='approved-public/'+names[name];
  const relative=path.relative(path.join(owned,'network-imports'),p);if(new RegExp('^[a-f0-9]{64}/(signet_Afreq|signet_CoeffMat0|signet_net\\.genepos|signet-package\\.json)$').test(relative))role='owned-derived/'+names[name];
  if(!role||!path.isAbsolute(out)||path.resolve(out)!==out||fs.realpathSync(out)!==out)return;
  const dir=fs.lstatSync(out);if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid())return;
  const {stage,st,before,after,now,bytesRead,expectedBytes}=details;
  const differences=stage==='initial'?fields.filter(k=>before[k]!==st[k]):fields.filter(k=>before[k]!==after[k]||before[k]!==now[k]);
  const payload={schema:1,error:'source_changed',pid:process.pid,at:new Date().toISOString(),role,file:name,stage,differences,bytesRead:bytesRead??null,expectedBytes:expectedBytes??null,namedBefore:snapshot(st),heldBefore:snapshot(before),heldAfter:snapshot(after),namedAfter:snapshot(now),nanoseconds:'unavailable unless present in the original stat object; never reconstructed by another call'};
  const bytes=Buffer.from(JSON.stringify(payload,null,2)+'\n');if(bytes.length>16384)return;let fd;
  try{fd=fs.openSync(path.join(out,'source-read-failure.json'),fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);fs.writeFileSync(fd,bytes);}finally{if(fd!==undefined)fs.closeSync(fd);}
 }catch{/* Diagnostics must never alter the original rejection or retry it. */}
}
module.exports={recordReadFailure};
