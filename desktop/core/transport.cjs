const fs=require('node:fs'),path=require('node:path');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const F=require('./files.cjs');
const exec=promisify(execFile);
const quote=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
function ssh(root){return ['-i',path.join(root,'vm/id_ed25519'),'-p','2226','-o','BatchMode=yes','-o','ConnectTimeout=8',
 '-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+path.join(root,'vm/known_hosts'),'root@127.0.0.1'];}
async function remote(root,mode,aid){
 if(!/^(preflight|snapshot|cancel)$/.test(mode)||!/^a-\d{8}T\d{6}-[a-f0-9]{12}$/.test(aid))throw Error('Unknown remote operation');
 const command=['bash','/work/tools/vm-control.sh',mode,aid].map(quote).join(' ');
 try{return (await exec('ssh',[...ssh(root),command],{timeout:30000,maxBuffer:4*1024*1024})).stdout;}
 catch(e){throw Error('Compute connection or operation failed: '+String(e.stderr||e.message).slice(-3000));}
}
async function snapshot(root,aid){
 const text=await remote(root,'snapshot',aid),parts=text.trim().split(/\r?\n/),ids=[],observations=[],errors=[];
 for(const line of parts){
  if(line.startsWith('ID ')){ids.push(line.slice(3));continue;}
  if(line.startsWith('ERROR ')){errors.push(line.slice(6));continue;}
  const record=Object.fromEntries([...line.matchAll(/(\w+)=([^ ]+)/g)].map(m=>[m[1],m[2]]));
  if(!record.JobId)continue;
  const work='/work/runs/'+aid;if(record.WorkDir!==work&&!record.WorkDir?.startsWith(work+'/'))throw Error('Scheduler job does not belong to this analysis');
  observations.push({...record,JobIDRaw:record.JobId,State:record.JobState,observed_at:new Date().toISOString()});
 }
 const folder=path.join(root,'analyses',aid),file=path.join(folder,'scheduler-history.json');
 const previous=fs.existsSync(file)?F.read(file).jobs:[],records=new Map(previous.map(r=>[r.JobIDRaw,r]));
 for(const item of observations)records.set(item.JobIDRaw,item);
 const value={analysis_id:aid,checked_at:new Date().toISOString(),job_ids:ids,jobs:ids.map(id=>records.get(id)).filter(Boolean),errors};
 F.write(file,{analysis_id:aid,jobs:value.jobs});F.write(path.join(folder,'scheduler-live.json'),value);return value;
}
async function preflight(root,aid){return remote(root,'preflight',aid);}
async function cancelRemote(root,aid){const evidence=await remote(root,'cancel',aid);F.write(path.join(root,'analyses',aid,'cancel-remote.json'),{at:new Date().toISOString(),evidence});return evidence;}
function launch(root,aid,stage,checksum,log){
 const args=['env','SIGNET_VERIFIED_SIF_SHA256='+checksum,'setsid','bash','/work/tools/run-stage.sh',aid,stage];
 return spawn('ssh',[...ssh(root),args.map(quote).join(' ')],{stdio:['ignore',log,log]});
}
module.exports={ssh,snapshot,preflight,cancelRemote,launch};
