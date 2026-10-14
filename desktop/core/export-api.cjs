'use strict';
const fail=()=>{throw Object.assign(Error('schema_invalid'),{code:'schema_invalid'});};
const token=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(x);
function request(p,status=false){const keys=status?['requestId']:['packageId','packageHash','artifactIds','requestId'];if(!p||Object.getPrototypeOf(p)!==Object.prototype||Object.keys(p).length!==keys.length||Object.keys(p).some(k=>!keys.includes(k))||Buffer.byteLength(JSON.stringify(p))>16384||!token(p.requestId))fail();if(!status&&(!token(p.packageId)||typeof p.packageHash!=='string'||!/^[a-f0-9]{64}$/.test(p.packageHash)||!Array.isArray(p.artifactIds)||!p.artifactIds.length||p.artifactIds.length>32||p.artifactIds.some(x=>!token(x))||new Set(p.artifactIds).size!==p.artifactIds.length))fail();return status?{requestId:p.requestId}:{packageId:p.packageId,packageHash:p.packageHash,artifactIds:[...p.artifactIds],requestId:p.requestId};}
module.exports={request};
