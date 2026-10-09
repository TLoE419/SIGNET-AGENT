// Detached OS process: no IPC link or parent lifetime dependency on Electron.
const fs=require('node:fs'),path=require('node:path');
const {Store,stage}=require('./store.cjs'),F=require('./files.cjs'),R=require('./results.cjs'),S=require('./stages.cjs'),T=require('./transport.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function execute(root,aid,stageId,token){
 const store=new Store(root),folder=store.folder(aid),run=store.run(aid),selected=stage(stageId);
 const cancelled=()=>fs.existsSync(path.join(folder,'cancel.json'))&&F.read(path.join(folder,'cancel.json')).token===token;
 let child;
 const updateStage=(status,extra={})=>{const current=store.state(aid);return store.update(aid,{...extra,stages:current.stages.map(s=>s.id===stageId?{...s,status}:s)});};
 try{
  for(let i=0;i<100;i++){if(F.read(store.lockFile()).pid===process.pid)break;await sleep(25);}
  if(F.read(store.lockFile()).token!==token||F.read(store.lockFile()).pid!==process.pid)throw Error('Worker lock handoff failed');
  if(cancelled())throw Error('Analysis cancelled by user');
  const started=Date.now(),state=store.state(aid);
  {
   const expected=F.read(path.join(folder,'source.json')).container_actual.sha256;
   if(F.digest(path.join(root,'evidence/signet-0.0.6.sif'))!==expected)throw Error('Official container checksum differs');
   await T.preflight(root,aid);if(cancelled())throw Error('Analysis cancelled by user');
   updateStage('running',{status:'running',worker_pid:process.pid});
   const log=fs.openSync(path.join(folder,'launch.log'),'a');
   try{child=T.launch(root,aid,stageId,expected,log);}finally{fs.closeSync(log);}
   let ended=false,code=null,error=null;child.once('error',e=>{error=e;ended=true});child.once('exit',c=>{code=c;ended=true});
   while(!ended){
    if(cancelled()){await T.cancelRemote(root,aid);child.kill('SIGTERM');throw Error('Analysis cancelled by user');}
    if(stageId==='network')try{await T.snapshot(root,aid);}catch(e){F.write(path.join(folder,'scheduler-live.json'),{jobs:[],checked_at:new Date().toISOString(),error:e.message});}
    store.update(aid,{heartbeat_at:new Date().toISOString()});for(let i=0;i<30&&!ended&&!cancelled();i++)await sleep(500);
   }
   if(cancelled())throw Error('Analysis cancelled by user');if(error)throw error;
   updateStage('verifying',{status:'verifying',launcher_exit_code:code});
   if(stageId==='network'){
    const snapshot=await T.snapshot(root,aid);
    F.write(path.join(run,'logs/scheduler-jobs.json'),snapshot.jobs);fs.writeFileSync(path.join(run,'logs/job_ids.txt'),snapshot.job_ids.join('\n')+'\n');
    const verification=R.verify(run,state.nboots);verification.analysis_id=aid;F.write(path.join(run,'logs/verification.json'),verification);

    F.write(path.join(folder,'verified-network.json'),{files:verification.outputs,status:verification.status});
   }else{
    if(code!==0)throw Error('Stage launcher exit code '+code+'; see logs');
    const logFile=path.join(run,'logs',stageId+'.log');
    if(/(^|\n)(Error|Traceback|Execution halted|FATAL)|command not found|No such file or directory|Segmentation fault/i.test(fs.readFileSync(logFile,'utf8')))throw Error('Official program reported an error; see stage log');
    F.write(path.join(folder,'verified-'+stageId+'.json'),S.verifyStage(run,selected,state.cohort,S.parameters(state.parameters),started));
   }
  }
  if(cancelled())throw Error('Analysis cancelled by user');
  const stages=store.state(aid).stages.map(s=>s.id===stageId?{...s,status:'succeeded',ended_at:new Date().toISOString()}:s);
  F.write(path.join(folder,'code-hashes.json'),F.hashes(run));
  if(cancelled())throw Error('Analysis cancelled by user');
  store.update(aid,{stages,status:stages.every(s=>['succeeded','skipped'].includes(s.status))?'succeeded':'ready',active_stage:null,ended_at:new Date().toISOString(),error:null});
 }catch(e){
  const isCancelled=cancelled();
  let cancelError=null;
  if(child&&!selected.local)try{await T.cancelRemote(root,aid);child.kill('SIGTERM');}catch(error){cancelError=error.message;}
  updateStage(isCancelled?'cancelled':'failed',{status:isCancelled&&!cancelError?'cancelled':'failed',error:e.message,cancel_error:cancelError,ended_at:new Date().toISOString()});
  console.error(e.stack);
 }finally{store.release(token);}
}
if(require.main===module)execute(...process.argv.slice(2)).catch(e=>{console.error(e);process.exitCode=1});
module.exports={execute};
