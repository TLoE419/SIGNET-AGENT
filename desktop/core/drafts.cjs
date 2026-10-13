const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const F=require('./files.cjs'),S=require('./stages.cjs');
const ID=/^d-[a-f0-9-]{36}$/;
const LIMIT={fileBytes:64*1024*1024,totalBytes:256*1024*1024,files:128,rows:250000,cells:2000000};
const PREPARED=[['expression','Expression matrix','file'],['genotype','Instrument genotype matrix','file'],['pairs','Significant pairs','file'],['genes','Gene names','file'],['positions','Gene positions','file'],['expressionSamples','Expression sample IDs','file'],['genotypeSamples','Genotype sample IDs','file'],['annotation','Gene annotation (GTF)','file']];
const WORKFLOWS={network:{entryStage:'network',finishes:['network'],supported:true},preprocessing:{entryStage:'genotype',finishes:['expression'],supported:true},cis:{entryStage:'ciseqtl',finishes:['ciseqtl'],supported:false,reason:'Verified adjusted-data checkpoint is not available yet (S4).'},import:{entryStage:'visualization',finishes:['visualization'],supported:false,reason:'Verified official-session import is not available yet (S5).'}};
function fields(workflow,cohort){if(!Object.hasOwn(WORKFLOWS,workflow)||!['TCGA','GTEx'].includes(cohort))throw Error('Unsupported workflow or cohort');return workflow==='preprocessing'?S.FILES[cohort].map(([k,l,kind])=>[k,l,kind??'file']):workflow==='network'?PREPARED:[];}
function hash(value){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function plain(x){return x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;}
function exact(x,keys){if(!plain(x)||Object.keys(x).some(k=>!keys.includes(k)))throw Error('Only defined fields are accepted');}
function text(x,max,required=false){if(typeof x!=='string'||x.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(x)||(required&&!x.trim()))throw Error('Invalid text field');return x.trim();}
function capabilities(root){
 // Only expose the species/build explicitly configured in the pinned official source.
 let annotation=[];try{const config=fs.readFileSync(path.join(root,'official-signet/config.ini'),'utf8').split('[netvis]')[1];const id=config?.match(/^id\s*=\s*(\d+)\s*$/m)?.[1],assembly=config?.match(/^assembly\s*=\s*([\w.-]+)\s*$/m)?.[1];if(id&&assembly)annotation=[{species:id,assembly,source:'official-signet/config.ini [netvis]'}];}catch{}
 return {schemaVersion:1,formatVersion:'signet-input-v1',workflows:WORKFLOWS,annotation,parameters:S.schema().parameters,fields:{network:PREPARED,TCGA:S.FILES.TCGA,GTEx:S.FILES.GTEx},limits:LIMIT,pca:{designMaximum:5,availablePCs:null},computeReady:false};
}
function fingerprint(source,kind){
 if(typeof source!=='string'||!path.isAbsolute(source))throw Error('Source must come from the native picker');
 const top=fs.lstatSync(source);if(top.isSymbolicLink()||(kind==='directory'?!top.isDirectory():!top.isFile()))throw Error('Source type or symlink is not supported');
 const result={},queue=[source];let count=0,entries=0,bytes=0;
 while(queue.length){if(++entries>LIMIT.files)throw Error('Source has too many entries');const file=queue.pop(),stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw Error('Source contains a symlink');if(stat.isDirectory()){
  const children=fs.readdirSync(file);if(entries+queue.length+children.length>LIMIT.files)throw Error('Source has too many entries');queue.push(...children.map(n=>path.join(file,n)));continue;
 }
 if(!stat.isFile()||!stat.size||stat.size>LIMIT.fileBytes||(bytes+=stat.size)>LIMIT.totalBytes||++count>LIMIT.files)throw Error('Source exceeds bounded input limits or is empty');
 const sha256=F.digest(file),after=fs.lstatSync(file);if(['dev','ino','size','mtimeMs','ctimeMs'].some(k=>after[k]!==stat[k]))throw Error('Source changed while being read');result[kind==='directory'?path.relative(source,file):'file']={sha256,bytes:stat.size};
 }
 if(!count)throw Error('Empty input folder');return {source:fs.realpathSync(source),name:path.basename(source),kind,files:Object.fromEntries(Object.entries(result).sort()),bytes};
}
class Drafts{
 constructor(root){this.root=root;this.folder=path.join(root,'analyses/drafts');for(const folder of [path.join(root,'analyses'),this.folder])if(fs.existsSync(folder)&&fs.lstatSync(folder).isSymbolicLink())throw Error('Draft registry cannot be a symlink');}
 file(id){if(typeof id!=='string'||!ID.test(id))throw Error('Invalid draft ID');return path.join(this.folder,id+'.json');}
 read(id){const file=this.file(id);if(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>1024*1024)throw Error('Invalid draft record');const d=F.read(file);if(d.schemaVersion!==1||d.id!==id||!Number.isSafeInteger(d.revision)||d.revision<1||d.contentHash!==hash(d.content))throw Error('Corrupt draft record');return d;}
 public(d){return {id:d.id,revision:d.revision,...d.content,inputs:Object.fromEntries(Object.entries(d.content.inputs).map(([k,v])=>[k,{ref:v.ref}]))};}
 check(d){const issues=[],inputManifest=[];for(const [field,input]of Object.entries(d.content.inputs)){
  try{const now=fingerprint(input.source,input.kind);if(hash(now.files)!==hash(input.files))throw Error('Source contents changed; select and validate again');inputManifest.push({field,ref:input.ref,name:input.name,bytes:input.bytes,files:input.files,status:'available'});}
  catch(e){issues.push({field:'inputs.'+field,code:'missing-input',message:e.message.replaceAll(input.source,input.name)});inputManifest.push({field,ref:input.ref,name:input.name,status:'missing-input'});}
 }return {issues,inputManifest};}
 load(id){const d=this.read(id),checked=this.check(d);let validation=null;try{const v=F.read(this.file(id)+'.validation');if(v.revision===d.revision&&v.contentHash===d.contentHash&&!checked.issues.length)validation=v;}catch{}return {draft:this.public(d),contentHash:d.contentHash,...checked,validation};}
 save(p,sources={}){
 exact(p,['id','revision','label','notes','workflow','cohort','entryStage','finishAfter','species','assembly','inputs','parameters']);exact(sources,fields(p.workflow,p.cohort).map(f=>f[0]));
 if(!Number.isSafeInteger(p.revision)||p.revision<0||(!p.id&&p.revision!==0))throw Error('Invalid draft revision');
 exact(p.inputs,fields(p.workflow,p.cohort).map(f=>f[0]));exact(p.parameters,Object.keys(S.PARAMETERS).concat('tissue'));
 const definition=WORKFLOWS[p.workflow];if(p.entryStage!==definition.entryStage||!definition.finishes.includes(p.finishAfter))throw Error('Invalid entryStage or finishAfter for workflow');
 for(const [key,value]of Object.entries(p.parameters))if(key!=='tissue'&&(typeof value!=='number'||!Number.isFinite(value)))throw Error('Invalid numeric parameter: '+key);
 const parameters=S.parameters(p.parameters);if(parameters.npc>5)throw Error('PCA selection is limited to 1–5; actual availability must also be verified');
 const id=p.id??'d-'+crypto.randomUUID();fs.mkdirSync(this.folder,{recursive:true,mode:0o700});const file=this.file(id),lock=file+'.lock';const fd=fs.openSync(lock,'wx',0o600);
 try{
 const old=p.id?this.read(id):null;if((old?.revision??0)!==p.revision)throw Error('Draft revision conflict: reopen the latest revision');
 const inputs={};for(const [key,value]of Object.entries(p.inputs)){
  exact(value,['ref','token']);if(Object.keys(value).length!==1)throw Error('Select exactly one input reference');
  if(value.ref){const previous=old?.content.inputs[key];if(!previous||value.ref!==previous.ref||old.content.workflow!==p.workflow||old.content.cohort!==p.cohort)throw Error('Unknown persisted input reference');inputs[key]=previous;}
  else {if(typeof value.token!=='string'||!sources[key])throw Error('Expired picker reference; select the file again');inputs[key]={...fingerprint(sources[key],fields(p.workflow,p.cohort).find(f=>f[0]===key)[2]),ref:crypto.randomUUID()};}
 }
 if(Object.keys(sources).some(k=>!p.inputs[k]?.token))throw Error('Unexpected source reference');
 if(Object.values(inputs).reduce((sum,i)=>sum+i.bytes,0)>LIMIT.totalBytes)throw Error('Total source bytes exceed the bounded draft limit');
 const content={label:text(p.label,80,true),notes:text(p.notes??'',2000),workflow:p.workflow,cohort:p.cohort,entryStage:p.entryStage,finishAfter:p.finishAfter,species:text(p.species??'',20),assembly:text(p.assembly??'',30),inputs,parameters};
 const d={schemaVersion:1,id,revision:p.revision+1,createdAt:old?.createdAt??new Date().toISOString(),updatedAt:new Date().toISOString(),content,contentHash:hash(content)};F.write(file,d);return this.load(id);
 }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
 }
 list(){if(!fs.existsSync(this.folder))return [];return fs.readdirSync(this.folder).filter(n=>ID.test(n.slice(0,-5))&&n.endsWith('.json')).map(n=>{
 const id=n.slice(0,-5);try{const d=this.read(id);return {id,label:d.content.label,workflow:d.content.workflow,status:'draft',revision:d.revision,created_at:d.createdAt,updated_at:d.updatedAt,kind:'draft'};}catch(e){return {id,label:id,status:'record-error',kind:'draft',error:e.message};}
 }).sort((a,b)=>(b.updated_at??'').localeCompare(a.updated_at??''));}
 validate(id,revision){const d=this.read(id);if(d.revision!==revision)throw Error('Draft revision changed; save current changes first');const checked=this.check(d),{validate}=require('./input-validation.cjs');const parsed=validate(d.content,capabilities(this.root),checked);
 // Check the sources again after parsing; a concurrent replacement cannot certify old/new mixtures.
 const after=this.check(d);const issues=[...parsed.issues,...after.issues];const v={validationId:crypto.randomUUID(),revision,contentHash:d.contentHash,workflow:d.content.workflow,formatVersion:'signet-input-v1',checkedAt:new Date().toISOString(),status:issues.length?'blocked':'validated',issues,inputManifest:checked.inputManifest,capabilities:parsed.capabilities};F.write(this.file(id)+'.validation',v);return v;}
}
module.exports={Drafts,fields,capabilities,fingerprint,WORKFLOWS,LIMIT,plain,exact};
