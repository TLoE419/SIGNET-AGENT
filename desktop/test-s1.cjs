const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('./core/store.cjs');
function setup(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'signet-s1-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,store:new Store(root)}}
const draft=()=>({revision:0,label:'My research',notes:'Not submitted',workflow:'network',cohort:'TCGA',entryStage:'network',finishAfter:'network',species:'9606',assembly:'hg38',inputs:{},parameters:{nboots:2,ncis:3,cor:0.3,'alpha.cis':0.05,freq:1,ntop:1}});
test('draft persists across Store instances without creating a run; stale revision cannot overwrite',t=>{
 const {root,store}=setup(t),saved=store.draftSave(draft()).draft;assert.equal(saved.revision,1);assert.equal(store.entries().length,0);assert.equal(fs.existsSync(path.join(root,'runs')),false);
 const reopened=new Store(root).draftLoad(saved.id).draft;assert.equal(reopened.notes,'Not submitted');const next=store.draftSave({...reopened,label:'New name'}).draft;assert.equal(next.revision,2);assert.throws(()=>store.draftSave({...reopened,label:'Stale'}),/revision/i);assert.equal(store.draftLoad(saved.id).draft.label,'New name');
});
function validInputs(root){const p={expression:'1 2\n3 4\n',genotype:'0 1\n1 0\n',pairs:'1 1 0.01\n2 2 0.02\n',genes:'G1\nG2\n',positions:'G1 chr1 1 3\nG2 chr1 4 6\n',expressionSamples:'S1\nS2\n',genotypeSamples:'S1\nS2\n',annotation:'#!genome-build hg38\n#!species 9606\nchr1\tsource\tgene\t1\t3\t.\t+\t.\tgene_id "g1"; gene_name "G1";\nchr1\tsource\tgene\t4\t6\t.\t+\t.\tgene_id "g2"; gene_name "G2";\n'};const sources={};for(const [k,v]of Object.entries(p)){sources[k]=path.join(root,k);fs.writeFileSync(sources[k],v);}const official=path.join(root,'official-signet');fs.mkdirSync(official);fs.writeFileSync(path.join(official,'config.ini'),'[netvis]\nid = 9606\nassembly = hg38\n');return sources;}
function saveInputs(store,sources){return store.draftSave({...draft(),inputs:Object.fromEntries(Object.keys(sources).map(k=>[k,{token:'opaque-native-selection'}]))},sources).draft;}
test('validation binds saved revision/hash and finite matrices, exact sample identity and gene annotation',t=>{
 const {root,store}=setup(t),sources=validInputs(root),d=saveInputs(store,sources),v=store.inputValidate(d.id,d.revision);assert.equal(v.status,'validated');assert.equal(v.contentHash,store.draftLoad(d.id).contentHash);assert.equal(v.formatVersion,'signet-input-v1');assert.equal(v.capabilities.computeReady,false);
 fs.writeFileSync(sources.genotypeSamples,'S2\nS1\n');assert.equal(store.draftLoad(d.id).validation,null);assert.equal(store.draftLoad(d.id).issues[0].code,'missing-input');const replaced=store.draftSave({...d,inputs:{...d.inputs,genotypeSamples:{token:'replacement'}}},{genotypeSamples:sources.genotypeSamples}).draft;const mismatch=store.inputValidate(replaced.id,replaced.revision);assert.equal(mismatch.status,'blocked');assert.ok(mismatch.issues.some(i=>i.code==='sample-order'));assert.throws(()=>store.inputValidate(d.id,d.revision),/revision/);
});
test('unproved identities, unsupported formats, nonfinite values, gene mismatch and missing source are blocked',t=>{
 const {root,store}=setup(t),sources=validInputs(root);for(const [field,text,code] of [['expressionSamples','S1\nS1\n','duplicate-id'],['expression','NaN 2\n3 4\n','unsupported-format'],['positions','WRONG chr1 1 3\nG2 chr1 4 6\n','gene-linkage'],['annotation','no verifiable GTF metadata\n','annotation-unverified']]){
 const original=fs.readFileSync(sources[field]);fs.writeFileSync(sources[field],text);const d=saveInputs(store,sources),v=store.inputValidate(d.id,d.revision);assert.equal(v.status,'blocked');assert.ok(v.issues.some(i=>i.code===code),JSON.stringify(v.issues));fs.writeFileSync(sources[field],original);
 }
 const d=saveInputs(store,sources);fs.unlinkSync(sources.expression);assert.ok(store.inputValidate(d.id,d.revision).issues.some(i=>i.code==='missing-input'));
});
test('restricted drafts reject paths, unknown settings, out-of-range numbers and invalid stage plans',t=>{
 const {store}=setup(t);for(const patch of [{parameters:{nboots:101}},{parameters:{npc:6}},{parameters:{cor:Infinity}},{parameters:{'alpha.cis':0.1}},{parameters:{ncis:0}},{parameters:{freq:-1}},{parameters:{ntop:0}},{parameters:{command:'anything'}},{inputs:{expression:{path:'/etc/passwd'}}},{finishAfter:'visualization'},{entryStage:'genotype'}])assert.throws(()=>store.draftSave({...draft(),...patch}));
 const d=store.draftSave({...draft(),workflow:'cis',entryStage:'ciseqtl',finishAfter:'ciseqtl'}).draft;assert.ok(store.inputValidate(d.id,d.revision).issues.some(i=>i.code==='workflow-unavailable'));
});
test('readonly record listing isolates one corrupt record and never recovers/writes original states',t=>{
 const {root,store}=setup(t);for(const [id,text]of [['a-20261012T000000-123456abcdef',JSON.stringify({id:'a-20261012T000000-123456abcdef',label:'Real interrupted history',controller:'node-v1',status:'running',worker_pid:999999,created_at:'2026-10-12',stages:[]})],['a-20261012T000001-123456abcdef','broken JSON']]){const folder=path.join(root,'analyses',id);fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'state.json'),text);}
 const file=path.join(root,'analyses/a-20261012T000000-123456abcdef/state.json'),before=fs.readFileSync(file);const rows=store.recordList();assert.equal(rows.length,2);assert.equal(rows.find(r=>r.label==='Real interrupted history').status,'running');assert.equal(rows.filter(r=>r.status==='record-error').length,1);assert.deepEqual(fs.readFileSync(file),before);
});
test('native picker capabilities expire, bind exact field/workflow and never accept a frontend path',()=>{
 const {NativeInputs}=require('./native-inputs.cjs');let now=0;const picks=new NativeInputs(()=>now),token=picks.add('expression','TCGA','network','/owned/file');assert.deepEqual(picks.resolve({...draft(),inputs:{expression:{token}}}),{expression:'/owned/file'});
 assert.throws(()=>picks.resolve({...draft(),inputs:{genotype:{token}}}),/picker/i);assert.throws(()=>picks.resolve({...draft(),inputs:{expression:{path:'/etc/passwd'}}}),/defined/);now=15*60*1000+1;assert.throws(()=>picks.resolve({...draft(),inputs:{expression:{token}}}),/Expired/);
});
test('Service public seams preserve drafts and separate real records from simulation, rejecting arbitrary methods',async t=>{
 const {root}=setup(t),{Service}=require('./service.cjs'),service=new Service(root);t.after(()=>service.stopOwned());await service.connect();const loaded=await service.call('draftSave',draft());assert.equal((await service.call('draftLoad',loaded.draft.id)).draft.id,loaded.draft.id);assert.equal((await service.call('draftList')).length,1);assert.deepEqual(await service.call('recordList'),[]);assert.equal((await service.call('capabilities')).computeReady,false);await assert.rejects(service.call('readFile','/etc/passwd'),/Unknown controlled/);assert.equal(fs.existsSync(path.join(root,'runs')),false);
});
test('duplicate pairs, configured significance threshold and unsupported annotation aliases cannot pass',t=>{
 const {root,store}=setup(t),sources=validInputs(root);fs.writeFileSync(sources.pairs,'1 1 0.01\n1 1 0.02\n');let d=saveInputs(store,sources);assert.ok(store.inputValidate(d.id,d.revision).issues.some(i=>i.code==='duplicate-pair'));
 fs.writeFileSync(sources.pairs,'1 1 0.04\n2 2 0.04\n');d=store.draftSave({...draft(),parameters:{...draft().parameters,'alpha.cis':0.03},inputs:Object.fromEntries(Object.keys(sources).map(k=>[k,{token:'native'}]))},sources).draft;assert.ok(store.inputValidate(d.id,d.revision).issues.some(i=>i.code==='pair-bounds'));
 fs.writeFileSync(sources.annotation,fs.readFileSync(sources.annotation,'utf8').replace('hg38','unknown-build'));d=saveInputs(store,sources);assert.ok(store.inputValidate(d.id,d.revision).issues.some(i=>i.code==='annotation-unverified'));
});
test('null/boolean numeric values, symlinks and oversized sources are rejected before persistence',t=>{
 const {root,store}=setup(t);for(const parameters of [{cor:null},{nboots:true}])assert.throws(()=>store.draftSave({...draft(),parameters}));
 const target=path.join(root,'target'),link=path.join(root,'link');fs.writeFileSync(target,'1 2\n');fs.symlinkSync(target,link);assert.throws(()=>store.draftSave({...draft(),inputs:{expression:{token:'native'}}},{expression:link}),/symlink/);
 const fd=fs.openSync(target,'w');fs.ftruncateSync(fd,65*1024*1024);fs.closeSync(fd);assert.throws(()=>store.draftSave({...draft(),inputs:{expression:{token:'native'}}},{expression:target}),/limits/);assert.equal(store.entries().length,0);
});
test('many historical records require metadata reads only, preserving unknown status and all originals',t=>{
 const {root,store}=setup(t);for(let i=0;i<200;i++){const id='a-20261012T000000-'+i.toString(16).padStart(12,'0'),folder=path.join(root,'analyses',id);fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'state.json'),JSON.stringify({id,label:'History '+i,status:'unknown',created_at:'2026-10-12',stages:[]}));}
 const started=performance.now(),rows=store.recordList();assert.equal(rows.length,200);assert.ok(rows.every(r=>r.status==='unknown'));assert.ok(performance.now()-started<3000,'bounded metadata list should not verify every historical scientific result');assert.equal(fs.existsSync(path.join(root,'runs')),false);
});
test('raw TCGA/GTEx contracts expose seven fields, enforce parsing and block unproved reference/mapping',t=>{
 const {root,store}=setup(t),official=path.join(root,'official-signet');fs.mkdirSync(official);fs.writeFileSync(path.join(official,'config.ini'),'[netvis]\nid = 9606\nassembly = hg38\n');
 for(const cohort of ['TCGA','GTEx']){
 const d=store.draftSave({...draft(),workflow:'preprocessing',cohort,entryStage:'genotype',finishAfter:'expression'}).draft,v=store.inputValidate(d.id,d.revision);assert.equal(v.status,'blocked');assert.equal(v.inputManifest.length,0);assert.equal(store.capabilities().fields[cohort].length,7);assert.equal(v.capabilities.availablePCs,null);
 }
});
test('raw text parsing catches duplicated PED identity and reordered GCT samples before review',t=>{
 const {root,store}=setup(t);validInputs(root);
 function raw(cohort,values){const sources={},inputs={};for(const [key,,kind]of store.capabilities().fields[cohort]){const f=path.join(root,cohort+'-'+key);sources[key]=f;inputs[key]={token:'fixture'};if(kind==='directory'){fs.mkdirSync(f,{recursive:true});fs.writeFileSync(path.join(f,key==='ref'?'chr1.gen':'chr1.map'),'reference fixture; provenance not established');}else fs.writeFileSync(f,values[key]);}
 return store.draftSave({...draft(),workflow:'preprocessing',cohort,entryStage:'genotype',finishAfter:'expression',parameters:{...draft().parameters,nchr:1},inputs},sources).draft;}
 const tcga=raw('TCGA',{'ped.file':'F S1 0 0 1 -9 A A\nF S1 0 0 1 -9 C C\n','map.file':'1 rs1 0 1\n','gexp.file':'gene S1 S2\ng1 1 2\ng2 3 4\nf1 0 0\nf2 0 0\nf3 0 0\nf4 0 0\nf5 0 0\n','pmap.file':fs.readFileSync(path.join(root,'annotation'),'utf8'),'cli.file':'submitter_id\tgroup\nS1\t1\nS2\t0\n'});
 const a=store.inputValidate(tcga.id,tcga.revision);assert.ok(a.issues.some(i=>i.field==='inputs.ped.file'&&i.code==='duplicate-id'));assert.ok(a.issues.some(i=>i.code==='reference-unverified'));assert.equal(a.status,'blocked');
 const vcf='##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tS1\tS2\n1\t1\trs1\tA\tC\t.\tPASS\t.\tGT\t0|0\t0|1\n';
 const gtex=raw('GTEx',{vcf0:vcf,'vcf.file':vcf,'read.file':'#1.2\n2\t2\nName\tDescription\tS1\tS2\ng1\tG1\t1\t2\ng2\tG2\t3\t4\n',anno:'SAMPID\tSMTSD\nS1\tLung\nS2\tLung\n','tpm.file':'#1.2\n2\t2\nName\tDescription\tS2\tS1\ng1\tG1\t2\t1\ng2\tG2\t4\t3\n','gtf.file':fs.readFileSync(path.join(root,'annotation'),'utf8'),pheno:'IID\tgroup\nS1\t1\nS2\t0\n'});
 const b=store.inputValidate(gtex.id,gtex.revision);assert.ok(b.issues.some(i=>i.field==='inputs.tpm.file'&&i.code==='sample-order'));assert.ok(b.issues.some(i=>i.code==='sample-mapping-unverified'));assert.equal(b.status,'blocked');
});
test('bounded text parser rejects an oversized row before allocating an unbounded matrix',t=>{
 const {root,store}=setup(t),sources=validInputs(root);fs.writeFileSync(sources.expression,'1 '.repeat(2000001)+'\n');const d=saveInputs(store,sources),v=store.inputValidate(d.id,d.revision);assert.equal(v.status,'blocked');assert.ok(v.issues.some(i=>i.field==='inputs.expression'&&i.message.includes('cell limit')));
});

test('nested empty source directories count toward the bounded picker entry budget',t=>{
 const {root}=setup(t),{fingerprint}=require('./core/drafts.cjs'),source=path.join(root,'nested');let folder=source;fs.mkdirSync(folder);for(let i=0;i<129;i++){folder=path.join(folder,'d');fs.mkdirSync(folder);}fs.writeFileSync(path.join(folder,'source'),'1\n');assert.throws(()=>fingerprint(source,'directory'),/too many entries/);
});
