const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const R=require('./core/results.cjs'),F=require('./core/files.cjs'),S=require('./core/stages.cjs');
const {Store,LEGACY}=require('./core/store.cjs'),{Service}=require('./service.cjs');
const aid='a-20261007T000000-123456abcdef';
function temporary(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'signet-node-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root}
const fixtures=require('./test-support/fixtures.cjs');
const source=fixtures.source;
function syntheticRun(root){fixtures.network(root,aid);}
test('synthetic network validates edge direction, coefficients and bootstrap frequencies',t=>{
 const root=temporary(t),run=fixtures.network(root,aid),network=R.network(path.join(run,'res/resn'));
 assert.deepEqual(network.edges,[{source:'g1',target:'g2',frequency:0.5,coefficient:-2,source_index:0,target_index:1}]);
 assert.deepEqual(network.shape,[2,1]);assert.equal(network.counts['0.5'],1);assert.equal(network.counts['0.8'],0);
 assert.deepEqual(R.verify(run,2).job_ids,['1']);
});
test('partial jobs, changed frequencies, duplicate accounting and non-finite matrices are rejected',t=>{
 const root=temporary(t);syntheticRun(root);const run=path.join(root,'runs',aid),jobs=path.join(run,'logs/scheduler-jobs.json'),original=F.read(jobs);
 F.write(jobs,[...original,original[0]]);assert.throws(()=>R.verify(run,2),/not verified/);F.write(jobs,original);
 const freq=path.join(run,'res/resn/signet_Afreq'),text=fs.readFileSync(freq,'utf8');fs.writeFileSync(freq,text.replace(/\b0\b/,'0.1'));assert.throws(()=>R.verify(run,2),/bootstrap mean/);fs.writeFileSync(freq,text);
 const folder=path.join(run,'tmp/tmpn/stage1');const completed=path.join(folder,fs.readdirSync(folder).find(n=>/^params\d+\.txt\.completed$/.test(n))); fs.writeFileSync(completed,'');assert.throws(()=>R.verify(run,2),/completion lists/);
 const matrix=path.join(root,'bad.txt');for(const value of ['NaN','Infinity','0x10','1,2\n3']){fs.writeFileSync(matrix,value);assert.throws(()=>R.rows(matrix,true));}
});
test('all six stage definitions, both cohort schemas, controlled parameter bounds',()=>{
 assert.equal(S.schema().stages.length,6);assert.equal(S.FILES.TCGA.length,7);assert.equal(S.FILES.GTEx.length,7);
 for(const p of [{nboots:true},{nboots:0},{npc:11},{cor:Infinity},{command:'anything'},{tissue:"Lung'; touch /tmp/x"}])assert.throws(()=>S.parameters(p));
});
test('creation isolates copies, keeps source unchanged and rejects uncontrolled requests',t=>{
 const root=temporary(t);source(root);const store=new Store(root),before=F.hashes(path.join(root,'official-signet'));
 for(const p of [{command:'x'},{nboots:true},{label:''},{dataset:'unknown'},{dataset:'custom',cohort:'GTEx'},{imports:{evil:'x'}},{parameters:{nboots:101}}])assert.throws(()=>store.create(p));
 assert.equal(store.entries().length,0);const first=store.create({nboots:1}),second=store.create({dataset:'official-ciseqtl'});assert.notEqual(first.id,second.id);
 assert.equal(first.stages.filter(s=>s.status==='skipped').length,4);assert.equal(second.stages.filter(s=>s.status==='skipped').length,3);
 assert.match(fs.readFileSync(path.join(store.run(second.id),'config.ini'),'utf8'),/matched.geno = example\/ciseqtl/);
 assert.deepEqual(F.hashes(path.join(root,'official-signet')),before);assert.throws(()=>store.start(first.id,'genotype'),/cannot be started/);assert.throws(()=>store.artifact(first.id,'edges.csv'),/not passed/);
});
test('both raw cohort imports produce isolated official configuration and stage prerequisites',t=>{
 const root=temporary(t);source(root);const store=new Store(root);
 for(const cohort of ['TCGA','GTEx']){
  const imports={};for(const [key,,kind] of S.FILES[cohort]){
   const input=path.join(root,'input-'+cohort+'-'+key);imports[key]=input;
   if(kind==='directory'){fs.mkdirSync(input);fs.writeFileSync(path.join(input,key==='ref'?'chr1.gen':'chr1.map'),'fixture\n');}
   else fs.writeFileSync(input,'fixture\n');
  }
  const analysis=store.create({dataset:'custom',cohort,imports,parameters:{nchr:1}}),run=store.run(analysis.id),config=fs.readFileSync(path.join(run,'config.ini'),'utf8');
  assert.equal(analysis.stages.filter(s=>s.status==='ready').length,6);assert.equal(F.read(path.join(store.folder(analysis.id),'inputs-manifest.json')).length,7);
  assert.match(config,new RegExp('cohort = '+cohort));assert.doesNotMatch(config,/fixture/);
  if(cohort==='GTEx'){assert.match(config,/matched.geno = res\/resg\/signet_clean_Genotype_repNA.data/);assert.match(config,/gene.pos = res\/resa\/signet_gene_pos/);}
  assert.throws(()=>store.start(analysis.id,'ciseqtl'),/prerequisite/);assert.throws(()=>store.start(analysis.id,'network'),/prerequisite/);
 }
});
test('live locks exclude other controllers; dead Node work becomes interrupted',t=>{
 const root=temporary(t),store=new Store(root);fs.mkdirSync(store.folder(aid));F.write(path.join(store.folder(aid),'state.json'),{id:aid,controller:'node-v1',status:'running',worker_pid:process.pid});
 assert.throws(()=>store.lock(),/active/);store.update(aid,{worker_pid:999999});store.recover();assert.equal(store.state(aid).status,'interrupted');
 const token=store.lock();assert.throws(()=>new Store(root).lock(),/already running/);store.release(token);
});
test('stage contracts reject stale and mismatched preprocessing outputs',t=>{
 const root=temporary(t),run=path.join(root,'run');fs.mkdirSync(path.join(run,'res/rest'),{recursive:true});
 for(const [s,text] of [['_gexpID','sample1\nsample2\n'],['_gene_pos','g1 1 0 2\n'],['_gene_name','g1\n'],['_gexp','1\n2\n']])fs.writeFileSync(path.join(run,'res/rest/signet'+s),text);
 const stage=S.STAGES.find(s=>s.id==='expression');assert.equal(S.verifyStage(run,stage,'TCGA',S.parameters(),Date.now()-100).files.length,4);
 assert.throws(()=>S.verifyStage(run,stage,'TCGA',S.parameters(),Date.now()+10000),/stale/);
 fs.writeFileSync(path.join(run,'res/rest/signet_gene_name'),'wrong\n');assert.throws(()=>S.verifyStage(run,stage,'TCGA',S.parameters(),Date.now()),/metadata/);
});
test('GTEx compressed expression requires finite values and identical genotype sample order',t=>{
 const root=temporary(t),run=path.join(root,'run'),stage=S.STAGES.find(s=>s.id==='expression'),p=S.parameters();
 for(const dir of ['res/rest','tmp/tmpg'])fs.mkdirSync(path.join(run,dir),{recursive:true});
 const file=S.outputs(run,stage,'GTEx',p)[0],{gzipSync}=require('node:zlib');
 const bed='#chr\tstart\tend\tgene_id\tGTEX-A\tGTEX-B\nchr1\t1\t2\tg1\t1\t2\n';
 fs.writeFileSync(file,gzipSync(bed));fs.writeFileSync(path.join(run,'tmp/tmpg/GTEx_Lung.raw'),'FID IID PAT MAT SEX PHENOTYPE SNP\nGTEX-A GTEX-A 0 0 1 -9 1\nGTEX-B GTEX-B 0 0 1 -9 2\n');
 assert.equal(S.verifyStage(run,stage,'GTEx',p,Date.now()).status,'verified_stage_outputs');
 fs.writeFileSync(file,gzipSync(bed.replace('g1\t1','g1\tNaN')));assert.throws(()=>S.verifyStage(run,stage,'GTEx',p,Date.now()),/BED row/);
 fs.writeFileSync(file,gzipSync(bed.replace('GTEX-A\tGTEX-B','GTEX-B\tGTEX-A')));assert.throws(()=>S.verifyStage(run,stage,'GTEx',p,Date.now()),/sample order/);
});
test('interrupted preparation is preserved and cancellation before launch performs no computation',async t=>{
 const root=temporary(t),store=new Store(root),folder=store.folder(aid);fs.mkdirSync(folder);
 F.write(path.join(folder,'state.json'),{id:aid,controller:'node-v1',status:'preparing',creator_pid:999999});store.recover();assert.equal(store.state(aid).status,'interrupted');
 const token=store.lock();store.update(aid,{status:'starting',worker_token:token,stages:[{id:'network',status:'starting'}]});
 F.write(path.join(folder,'cancel.json'),{token});
 const {execute}=require('./core/analysis-worker.cjs'),logged=t.mock.method(console,'error',()=>{});
 await execute(root,aid,'network',token);assert.match(String(logged.mock.calls[0]?.arguments[0]),/Analysis cancelled by user/);logged.mock.restore();
 assert.equal(store.state(aid).status,'cancelled');assert.equal(fs.existsSync(store.lockFile()),false);assert.equal(fs.existsSync(store.run(aid)),false);
});
test('background controller reads synthetic evidence and reconnects without Python or HTTP',async t=>{
 const root=temporary(t);fixtures.network(root,LEGACY);
 const service=new Service(root);t.after(()=>service.stopOwned());await service.connect();assert.equal(service.status().transport,'restricted IPC');
 assert.equal((await service.call('schema')).stages.length,6);assert.equal((await service.call('list'))[0].status,'succeeded');
 const html=await service.call('viewer',LEGACY);assert.match(html,/Gene Regulatory Network/);assert.doesNotMatch(html,/[\p{Script=Han}]/u);
 await assert.rejects(service.call('arbitraryShell','echo nope'),/Unknown controlled/);await service.stopOwned();await service.connect();assert.equal((await service.call('detail',LEGACY)).verification.counts['0.5'],1);
});
test('official visualization requires its session and edge list, exports verified files only',t=>{
 const root=temporary(t),run=path.join(root,'runs',aid),store=new Store(root),folder=store.folder(aid),p=S.parameters();
 fs.mkdirSync(folder,{recursive:true});fs.mkdirSync(path.join(run,'res/resv'),{recursive:true});
 const stage=S.STAGES.find(s=>s.id==='visualization');assert.equal(stage.flag,'-v');assert.equal(stage.local,undefined);
 assert.throws(()=>S.verifyStage(run,stage,'TCGA',p,Date.now()));
 for(const file of S.outputs(run,stage,'TCGA',p))fs.writeFileSync(file,'fixture');
 const record=S.verifyStage(run,stage,'TCGA',p,Date.now());assert.equal(record.files.length,2);
 F.write(path.join(folder,'verified-visualization.json'),record);
 F.write(path.join(folder,'state.json'),{id:aid,controller:'node-v1',status:'ready',stages:[{id:'visualization',status:'succeeded'}]});
 assert.equal(store.stageArtifacts(aid)['stage-visualization-0'],'official-session.RData');
 const file=store.artifact(aid,'stage-visualization-1');assert.ok(file.endsWith('_edgelist_1.txt'));
 fs.appendFileSync(file,'changed');assert.throws(()=>store.artifact(aid,'stage-visualization-1'),/changed/);
});
test('official viewer rejects missing session and uncontrolled IDs before launching',async t=>{
 const root=temporary(t),{Visualization}=require('./core/visualization.cjs'),viewer=new Visualization(root);
 await assert.rejects(viewer.open('../escape'),/Invalid/);
 await assert.rejects(viewer.open(aid),/Run official stage six/);
 viewer.stop();
});

test('completed custom visualization is presented as stage six ready without rerunning network',t=>{
 const root=temporary(t);syntheticRun(root);const store=new Store(root),folder=store.folder(aid);fs.mkdirSync(folder);
 F.write(path.join(folder,'state.json'),{id:aid,controller:'node-v1',status:'succeeded',stages:S.STAGES.map(s=>({id:s.id,status:'succeeded'}))});
 const detail=store.detail(aid);assert.equal(detail.status,'ready');assert.equal(detail.officialVisualization,false);
 assert.equal(detail.stages.find(s=>s.id==='network').status,'succeeded');assert.equal(detail.stages.find(s=>s.id==='visualization').status,'ready');
});
