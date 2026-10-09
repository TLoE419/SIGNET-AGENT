const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const F=require('./files.cjs'),R=require('./results.cjs'),S=require('./stages.cjs');
const ACTIVE=new Set(['starting','running','verifying','cancelling']);
const LEGACY='macos-vm-smoke-20261006';
const ID=/^a-\d{8}T\d{6}-[a-f0-9]{12}$/;
const stamp=()=>new Date().toISOString();
function id(value){if(typeof value!=='string'||!ID.test(value))throw Error('Invalid analysis ID');return value;}
function stage(value){const s=S.STAGES.find(s=>s.id===value);if(!s)throw Error('Unknown analysis stage');return s;}
function config(file,values){fs.writeFileSync(file,fs.readFileSync(file,'utf8').split(/\r?\n/).map(line=>{
 const key=line.split('=')[0].trim();return line.includes('=')&&Object.hasOwn(values,key)?key+' = '+values[key]:line;
}).join('\n'));}
function sameHashes(a,b){return JSON.stringify(Object.entries(a).sort())===JSON.stringify(Object.entries(b).sort());}
class Store{
 constructor(root){this.root=fs.realpathSync(root);this.instance=crypto.randomUUID();this.registry=path.join(this.root,'analyses');fs.mkdirSync(this.registry,{recursive:true});}
 folder(aid){return path.join(this.registry,id(aid));}
 run(aid){return path.join(this.root,'runs',id(aid));}
 state(aid){return F.read(path.join(this.folder(aid),'state.json'));}
 update(aid,changes){const s={...this.state(aid),...changes,updated_at:stamp()};F.write(path.join(this.folder(aid),'state.json'),s);return s;}
 lockFile(){return path.join(this.registry,'node-execution.lock');}
 lock(){
  const file=this.lockFile();if(fs.existsSync(file)){
   const l=F.read(file);if(F.alive(l.pid))throw Error('A detached analysis is already running');
   // Never recover a lock until its owner has actually exited.
   fs.unlinkSync(file);
  }
  // Preserve live legacy Python work. It cannot safely be taken over by Node.
  for(const entry of this.entries())if(ACTIVE.has(entry.status)){
   if(entry.controller!=='node-v1'||F.alive(entry.worker_pid))throw Error('An analysis is still active; check its original controller');
   this.update(entry.id,{status:'interrupted',error:'Worker exited; create a new analysis instead of reusing partial outputs.'});
  }
  const token=crypto.randomUUID(),fd=fs.openSync(file,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token,created_at:stamp()}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  return token;
 }
 release(token){if(fs.existsSync(this.lockFile())&&F.read(this.lockFile()).token===token)fs.unlinkSync(this.lockFile());}
 entries(){return fs.readdirSync(this.registry).filter(n=>ID.test(n)&&fs.existsSync(path.join(this.registry,n,'state.json'))).map(n=>this.state(n));}
 recover(){for(const s of this.entries()){
  if(s.controller==='node-v1'&&s.status==='preparing'&&(!F.alive(s.creator_pid)||(s.creator_pid===process.pid&&s.creator_instance!==this.instance))){
   this.update(s.id,{status:'interrupted',error:'Input preparation was interrupted; create a new analysis.'});continue;
  }
  if(s.controller==='node-v1'&&ACTIVE.has(s.status)&&!F.alive(s.worker_pid)){
  const lock=fs.existsSync(this.lockFile())?F.read(this.lockFile()):null;
  if(lock&&F.alive(lock.pid))continue;
  this.update(s.id,{status:'interrupted',error:'Worker exited; partial outputs are preserved and cannot be rerun.'});
 }}}
 create(params){
  if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).some(k=>!['label','dataset','cohort','parameters','imports','nboots'].includes(k)))throw Error('Invalid analysis creation parameters');
  const label=params.label??'Official simulation';if(typeof label!=='string'||!label.trim()||label.length>80||/[\x00-\x1f]/.test(label))throw Error('Name must contain 1–80 characters');
  const dataset=params.dataset??'official-simulation',cohort=params.cohort??'TCGA';
  if(!['official-simulation','official-ciseqtl','custom'].includes(dataset)||!['TCGA','GTEx'].includes(cohort))throw Error('Invalid dataset mode or cohort');
  if(dataset!=='custom'&&cohort!=='TCGA')throw Error('Official simulations use prepared paired data, not raw GTEx workflows');
  const p=S.parameters({...params.parameters,...(params.nboots===undefined?{}:{nboots:params.nboots})});
  const imports=params.imports??{};
  if(typeof imports!=='object'||Array.isArray(imports)||Object.keys(imports).some(k=>!S.FILES[cohort].some(f=>f[0]===k)))throw Error('Unknown input field');
  if(dataset==='custom'){
   for(const [key,label] of S.FILES[cohort])if(typeof imports[key]!=='string')throw Error('Choose '+label);
  }else if(Object.keys(imports).length)throw Error('Official simulation inputs cannot be replaced');
  const aid='a-'+stamp().replace(/[-:]/g,'').slice(0,15)+'-'+crypto.randomBytes(6).toString('hex');
  const folder=this.folder(aid),run=this.run(aid);fs.mkdirSync(folder);
  const skipped=dataset==='official-simulation'?4:dataset==='official-ciseqtl'?3:0;
  F.write(path.join(folder,'state.json'),{id:aid,label:label.trim(),controller:'node-v1',status:'preparing',creator_pid:process.pid,creator_instance:this.instance,created_at:stamp(),updated_at:stamp(),
   dataset,cohort,parameters:p,nboots:p.nboots,legacy:false,error:null,environment:'Local Linux VM; university HPC is not connected',
   stages:S.STAGES.map((s,i)=>({id:s.id,name:s.name,status:i<skipped?'skipped':'ready',note:i<skipped?'This mode starts with official prepared inputs; this stage was not executed.':null}))});
  try{
   F.copy(path.join(this.root,'official-signet'),run);
   const values={...p,ncore_local:4,ncores:4,queue:'local',memory:4,walltime:'00:15:00',interactive:'F',forcerm:'F',cohort,
    sif:'/work/evidence/signet-0.0.6.sif',email:'F',computing:'slurm',resn:'res/resn/signet',
    'net.gexp.data':'res/resc/signet_net.gexp.data','net.geno.data':'res/resc/signet_all.eQTL.data',
    'sig.pair':'res/resc/signet_all.sig.pValue_'+p['alpha.cis'],'net.genename':'res/resc/signet_net.genename','net.genepos':'res/resc/signet_net.genepos',
    Afreq:'res/resn/signet_Afreq',coef:'res/resn/signet_CoeffMat0','vis.genepos':'res/resn/signet_net.genepos'};
   const inputFolder=path.join(run,'data/imports');fs.mkdirSync(inputFolder,{recursive:true});
   let index=0;const sources=[];
   for(const [key,,kind] of S.FILES[cohort])if(imports[key]){
    const source=fs.realpathSync(imports[key]),stat=fs.lstatSync(imports[key]);
    if(stat.isSymbolicLink()||(kind==='directory'?!stat.isDirectory():!stat.isFile())||(!stat.isDirectory()&&!stat.size))throw Error('Invalid input file or folder: '+key);
    const name=String(++index),target=path.join(inputFolder,name);F.copy(source,target);
    sources.push({key,original:source,hashes:stat.isDirectory()?F.hashes(target):{file:F.digest(target)}});
    values[key]='data/imports/'+name+(kind==='directory'?'/chr':'');
   }
   if(cohort==='GTEx')values['reads.file']=values['read.file'];
   if(dataset==='custom'&&cohort==='TCGA')for(let chr=1;chr<=p.nchr;chr++)for(const [key,ext] of [['ref','.gen'],['gmap','.map']]){
    const file=path.join(run,values[key]+chr+ext);if(!fs.existsSync(file)||!fs.statSync(file).size)throw Error('Missing reference file chr'+chr+ext);
   }
   if(dataset==='official-simulation'){
    const validation=R.inputs(path.join(run,'example/network')),expected=F.read(path.join(this.root,'evidence/input-validation.json'));
    if(validation.files.some((f,i)=>f.sha256!==expected.files[i]?.sha256))throw Error('Official simulation checksums differ');
    F.write(path.join(folder,'inputs.json'),validation);
    Object.assign(values,{'net.gexp.data':'example/network/signet_net.gexp.data','net.geno.data':'example/network/signet_all.eQTL.data',
     'sig.pair':'example/network/signet_all.sig.pValue_0.05','net.genename':'example/network/signet_net.genename','net.genepos':'example/network/signet_net.genepos'});
   }
   if(dataset==='official-ciseqtl')Object.assign(values,{'snps.map':'example/ciseqtl/signet_new.Geno.map','snps.maf':'example/ciseqtl/signet_new.Geno.maf',
    'matched.gexp':'example/ciseqtl/signet_gexp_rmpc.data','matched.gexp.withpc':'example/ciseqtl/signet_gexp.data',
    'matched.geno':'example/ciseqtl/signet_geno.data','gene.pos':'example/ciseqtl/signet_gene_pos'});
   if(cohort==='GTEx'&&dataset==='custom')Object.assign(values,{'snps.map':'res/resg/signet_snps.map','snps.maf':'res/resg/signet_snps.maf',
    'matched.geno':'res/resg/signet_clean_Genotype_repNA.data','gene.pos':'res/resa/signet_gene_pos'});
   config(path.join(run,'config.ini'),values);
   const template=path.join(run,'script/network/template.sub.ori');fs.writeFileSync(template,fs.readFileSync(template,'utf8').replace('#SBATCH -N 1','#SBATCH -N 1\n#SBATCH --mem=4G'));
   for(const file of ['bts1gensub.sh','bts2gensub.sh']){const f=path.join(run,'script/network',file);fs.writeFileSync(f,fs.readFileSync(f,'utf8').replaceAll('time sh qsub','time bash qsub'));}
   // Official scripts prompt for PCs. Replace only that prompt with the chosen value in the isolated copy.
   for(const file of ['adj.sh','adj_gtex.sh']){const f=path.join(run,'script/adj',file);fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/^read -p .* pc$/m,'pc='+p.npc));}
   // GTEx expression calls tabix on this gzip later; keep both official formats.
   const extract=path.join(run,'script/geno_prep/extract.sh');
   fs.writeFileSync(extract,fs.readFileSync(extract,'utf8').replace('gunzip GTEx_snp.vcf.gz','gunzip -k GTEx_snp.vcf.gz'));
   F.write(path.join(folder,'runtime-changes.json'),{memory:'4G in network template',submission_shell:'bash',
    population_pcs:p.npc,gtex_vcf:'retain compressed and uncompressed VCF; official source remains unchanged'});
   F.write(path.join(folder,'inputs-manifest.json'),sources);F.write(path.join(folder,'source.json'),F.read(path.join(this.root,'evidence/provenance.json')));
   F.write(path.join(folder,'code-hashes.json'),F.hashes(run));fs.copyFileSync(path.join(run,'config.ini'),path.join(folder,'config.created.ini'));
   return this.update(aid,{status:'ready'});
  }catch(e){this.update(aid,{status:'failed',error:'Analysis creation failed: '+e.message});throw e;}
 }
 start(aid,stageId){
  const current=this.state(aid);if(current.controller!=='node-v1')throw Error('Historical analyses are read only; no takeover or rerun');
  const selected=stage(stageId??current.stages.find(s=>s.status==='ready')?.id),entry=current.stages.find(s=>s.id===selected.id);
  const upgrade=selected.id==='visualization'&&entry.status==='succeeded'&&current.status==='succeeded'&&!fs.existsSync(path.join(this.run(aid),'res/resv/official-session.RData'));
  if(!upgrade&&(current.status!=='ready'||entry.status!=='ready'))throw Error('Analysis or stage cannot be started again; create a new analysis after failure');
  const before=current.stages.slice(0,current.stages.indexOf(entry));
  const independent=selected.id==='expression'&&current.cohort==='TCGA';
  if(!independent&&before.some(s=>!['succeeded','skipped'].includes(s.status)))throw Error('Complete prerequisite stages first');
  const run=this.run(aid),snapshot=F.read(path.join(this.folder(aid),'code-hashes.json'));
  if(!sameHashes(F.hashes(run),snapshot))throw Error('Run copy differs from recorded checksums');
  if(selected.id==='visualization'){config(path.join(run,'config.ini'),{freq:current.parameters?.freq??1,ntop:current.parameters?.ntop??1});F.write(path.join(this.folder(aid),'code-hashes.json'),F.hashes(run));}
  const token=this.lock();
  try{
   const stages=current.stages.map(s=>s.id===selected.id?{...s,status:'starting',started_at:stamp()}:s);
   this.update(aid,{status:'starting',active_stage:selected.id,stages,worker_token:token,worker_pid:process.pid,error:null});
   const log=fs.openSync(path.join(this.folder(aid),'worker.log'),'a');let child;
   try{child=spawn(process.execPath,[path.join(__dirname,'analysis-worker.cjs'),this.root,aid,selected.id,token],
    {cwd:this.root,detached:true,stdio:['ignore',log,log],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});}finally{fs.closeSync(log);}
   child.on('error',e=>{this.update(aid,{status:'failed',error:e.message});this.release(token)});
   if(!child.pid)throw Error('Unable to spawn detached analysis worker');
   this.update(aid,{worker_pid:child.pid});F.write(this.lockFile(),{pid:child.pid,token,analysis_id:aid,stage:selected.id});child.unref();
   return this.detail(aid);
  }catch(e){this.update(aid,{status:'failed',error:e.message});this.release(token);throw e;}
 }
 progress(aid){const tmp=path.join(this.run(aid),'tmp/tmpn');
  return {stages:[1,2].map(i=>{const f=path.join(tmp,'stage'+i);if(!fs.existsSync(f))return {stage:i,total:0,completed:0};
   return {stage:i,total:fs.existsSync(path.join(f,'params.txt'))?F.lines(path.join(f,'params.txt')).length:0,
    completed:fs.readdirSync(f).filter(n=>/^params\d+\.txt\.completed$/.test(n)).reduce((s,n)=>s+F.lines(path.join(f,n)).length,0)};}),
   scheduler:fs.existsSync(path.join(this.folder(aid),'scheduler-live.json'))?F.read(path.join(this.folder(aid),'scheduler-live.json')):{jobs:[],checked_at:null}};
 }
 detail(aid){
  if(aid===LEGACY){const run=path.join(this.root,'runs',LEGACY),record=F.read(path.join(run,'logs/verification.json')),v=R.verify(run,record.nboots);
   if(v.outputs.some((f,i)=>f.sha256!==record.outputs[i]?.sha256))throw Error('Historical outputs changed');
   return {id:aid,label:'Historical actual run (2026-10-06)',status:'succeeded',legacy:true,nboots:record.nboots,environment:'Local Linux VM; official simulated data',verification:v,links:this.links(aid)};
  }
  const s=this.state(aid);s.officialVisualization=fs.existsSync(path.join(this.run(aid),'res/resv/official-session.RData'));
  s.stages=s.stages?.map(entry=>entry.id==='visualization'?{...entry,name:'Official network visualization',status:entry.status==='succeeded'&&!s.officialVisualization?'ready':entry.status}:entry);
  if(s.status==='succeeded'&&!s.officialVisualization&&s.controller==='node-v1')s.status='ready';
  s.progress=this.progress(aid);s.artifacts=this.stageArtifacts(aid);
  if(s.status==='succeeded'||s.stages?.find(x=>x.id==='network')?.status==='succeeded'){
   const record=F.read(path.join(this.run(aid),'logs/verification.json')),v=R.verify(this.run(aid),record.nboots);
   if(v.outputs.some((f,i)=>f.sha256!==record.outputs[i]?.sha256))throw Error('Result checksums changed');s.verification=v;s.links=this.links(aid);
  }return s;
 }
 list(){this.recover();const list=this.entries().sort((a,b)=>b.created_at.localeCompare(a.created_at)).map(s=>this.detail(s.id));
  if(fs.existsSync(path.join(this.root,'runs',LEGACY,'logs/verification.json')))list.push(this.detail(LEGACY));return list;}
 links(aid){return Object.fromEntries(['network.html','edges.csv','network.json','Afreq','CoeffMat0','positions','verification.json','scheduler-jobs.json'].map(n=>[n,n]));}
 stageArtifacts(aid){const state=this.state(aid),out={};
  for(const s of state.stages??[])if(s.status==='succeeded'){
   const file=path.join(this.folder(aid),'verified-'+s.id+'.json');if(fs.existsSync(file))F.read(file).files?.forEach((f,i)=>{out['stage-'+s.id+'-'+i]=path.basename(f.file)});
  }return out;}
 artifact(aid,name){
  const detail=this.detail(aid),run=path.join(this.root,'runs',aid),output=path.join(this.root,'results',aid===LEGACY?'actual':aid);
  if(/^stage-/.test(name)){
   if(!Object.hasOwn(detail.artifacts??{},name))throw Error('Unverified or unknown stage artifact');
   const match=name.match(/^stage-([a-z]+)-(\d+)$/),record=F.read(path.join(this.folder(aid),'verified-'+match[1]+'.json')),file=record.files[+match[2]];
   if(!file||!file.file.startsWith(run+path.sep)||F.digest(file.file)!==file.sha256)throw Error('Stage artifact changed');return file.file;
  }
  if(!detail.verification)throw Error('Network has not passed verification');
  const map={'network.html':path.join(output,'network.html'),'network.json':path.join(output,'network.json'),'edges.csv':path.join(output,'edges.csv'),
   Afreq:path.join(run,'res/resn/signet_Afreq'),CoeffMat0:path.join(run,'res/resn/signet_CoeffMat0'),positions:path.join(run,'res/resn/signet_net.genepos'),
   'verification.json':path.join(run,'logs/verification.json'),'scheduler-jobs.json':path.join(run,'logs/scheduler-jobs.json')};
  if(!Object.hasOwn(map,name))throw Error('Unknown result artifact');
  // Generated artifacts are checked against the verified matrices, not trusted solely by filename.
  if(['network.html','network.json','edges.csv'].includes(name)&&detail.controller==='node-v1'){
   const manifest=F.read(path.join(this.folder(aid),'result-artifacts.json'));if(F.digest(map[name])!==manifest[name])throw Error('Rendered artifact changed');
  }
  return map[name];
 }
 saveArtifact(aid,name,destination){
  const source=this.artifact(aid,name),sha256=F.digest(source),temporary=destination+'.signet-'+crypto.randomUUID()+'.tmp';
  try{
   fs.copyFileSync(source,temporary,fs.constants.COPYFILE_EXCL);
   if(F.digest(temporary)!==sha256)throw Error('Result changed during export; file was not saved');
   const bytes=fs.statSync(temporary).size;fs.renameSync(temporary,destination);
   return {path:destination,bytes,sha256};
  }finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
 }
 logs(aid){if(aid===LEGACY)return {};this.state(aid);const out={};
  for(const folder of [this.folder(aid),path.join(this.run(aid),'logs')])if(fs.existsSync(folder))for(const name of fs.readdirSync(folder).filter(n=>/\.log$/.test(n))){
   const file=path.join(folder,name),size=fs.statSync(file).size,fd=fs.openSync(file,'r'),buf=Buffer.alloc(Math.min(size,24000));
   try{fs.readSync(fd,buf,0,buf.length,Math.max(0,size-buf.length));}finally{fs.closeSync(fd);}out[name]=buf.toString('utf8');
  }return out;
 }
 viewer(aid){
  const detail=this.detail(aid);if(!detail.verification)throw Error('Network has not passed verification');
  const run=path.join(this.root,'runs',aid),data=R.network(path.join(run,'res/resn'));
  data.provenance='Verified actual analysis output';data.verification=detail.verification;
  return fs.readFileSync(path.join(__dirname,'viewer.html'),'utf8').replace('__NETWORK_DATA__',JSON.stringify(data).replaceAll('<','\\u003c'));
 }
 async cancel(aid){const state=this.state(aid);if(state.controller!=='node-v1'||!ACTIVE.has(state.status))throw Error('No owned active work to cancel');
  F.write(path.join(this.folder(aid),'cancel.json'),{requested_at:stamp(),token:state.worker_token});
  this.update(aid,{status:'cancelling'});
  const {cancelRemote}=require('./transport.cjs');
  try{await cancelRemote(this.root,aid);return this.state(aid);}catch(e){this.update(aid,{cancel_error:e.message});throw e;}
 }
}
module.exports={Store,LEGACY,ID,ACTIVE,id,stage,config,sameHashes};
