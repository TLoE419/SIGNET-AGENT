const fs=require('node:fs'),path=require('node:path'),{gunzipSync}=require('node:zlib');
const {rows,inputs,info}=require('./results.cjs');
const {read}=require('./files.cjs');
const STAGES=[
  {id:'genotype',name:'Genotype preprocessing',flag:'-g',folder:'resg',tmp:'tmpg'},
  {id:'expression',name:'Expression preprocessing',flag:'-t',folder:'rest',tmp:'tmpt'},
  {id:'adjustment',name:'Covariate adjustment',flag:'-a',folder:'resa',tmp:'tmpa'},
  {id:'ciseqtl',name:'cis-eQTL analysis',flag:'-c',folder:'resc',tmp:'tmpc'},
  {id:'network',name:'Network construction',flag:'-n',folder:'resn',tmp:'tmpn'},
  {id:'visualization',name:'Official network visualization',flag:'-v',folder:'resv'}
];
// Keys map directly to the official config.ini. Renderer never supplies commands.
const FILES={
 TCGA:[['ped.file','Genotype PED'],['map.file','Genotype MAP'],['ref','Imputation reference folder (chrN.gen)','directory'],['gmap','Genetic map folder (chrN.map)','directory'],['gexp.file','Expression matrix'],['pmap.file','Gene annotation GTF'],['cli.file','Clinical covariates']],
 GTEx:[['vcf0','VCF before phasing'],['vcf.file','VCF after phasing'],['read.file','Read counts GCT'],['anno','Sample annotation'],['tpm.file','TPM expression matrix'],['gtf.file','Gene annotation GTF'],['pheno','Phenotype and covariates']]
};
const PARAMETERS={freq:{label:'Visualization bootstrap frequency',default:1,min:0,max:1},ntop:{label:'Largest subnetworks to visualize',default:1,min:1,max:100,integer:true},nchr:{label:'Chromosome count',default:22,min:1,max:22,integer:true},npc:{label:'Population principal components',default:3,min:1,max:10,integer:true},
 nboots:{label:'Bootstrap repetitions',default:2,min:1,max:100,integer:true},mind:{label:'Individual missingness threshold',default:.1,min:0,max:1},geno:{label:'Marker missingness threshold',default:.1,min:0,max:1},hwe:{label:'Hardy-Weinberg threshold',default:.0001,min:0,max:1},
 int:{label:'Imputation interval',default:5000000,min:1,max:100000000,integer:true},'alpha.cis':{label:'cis-eQTL significance threshold',default:.05,min:.000001,max:.05},nperms:{label:'Permutation count',default:100,min:1,max:10000,integer:true},
 upstream:{label:'Upstream distance',default:1000,min:0,max:10000000,integer:true},downstream:{label:'Downstream distance',default:1000,min:0,max:10000000,integer:true},
 cor:{label:'Instrument correlation threshold',default:.3,min:0,max:1},ncis:{label:'Maximum instruments per gene',default:3,min:1,max:20,integer:true}};
function schema(){return {stages:STAGES,files:FILES,parameters:PARAMETERS};}
function parameters(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(PARAMETERS,k)&&k!=='tissue'))throw Error('Unknown analysis parameter');
 const result={};for(const [k,s] of Object.entries(PARAMETERS)){const v=value[k]??s.default;
  if(typeof v!=='number'||!Number.isFinite(v)||v<s.min||v>s.max||(s.integer&&!Number.isInteger(v)))throw Error(s.label+' is outside the allowed range');result[k]=v;}
 result.tissue=value.tissue??'Lung';if(typeof result.tissue!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(result.tissue))throw Error('Use the official tissue identifier (letters, digits, underscores, hyphens)');
 return result;
}
function outputs(run,stage,cohort,params){
 const prefix=path.join(run,'res',stage.folder,'signet');
 let files;
 if(stage.id==='genotype')files=cohort==='TCGA'?[prefix+'_Geno',prefix+'_Genotype.sampleID']:[prefix+'_snps.map',prefix+'_snps.maf',prefix+'_clean_Genotype_repNA.data',path.join(run,'tmp/tmpg/subjid_wb_common.txt')];
 if(stage.id==='expression')files=cohort==='TCGA'?[prefix+'_gexpID',prefix+'_gene_pos',prefix+'_gene_name',prefix+'_gexp']:[prefix+'_expression_normalized_igt2log_GTEx_'+params.tissue+'.expression.bed.gz'];
 if(stage.id==='adjustment')files=cohort==='TCGA'?['_gexp.data','_gexp_rmpc.data','_geno.data','_new.Geno.map','_new.Geno.maf'].map(s=>prefix+s):['_gexp.data','_gexp_rmpc.data','_gene_pos'].map(s=>prefix+s);
 if(stage.id==='ciseqtl')files=['_all.sig.pValue_'+params['alpha.cis'],'_net.gexp.data','_all.eQTL.data','_net.genepos','_net.genename'].map(s=>prefix+s);
 if(stage.id==='network')files=['_Afreq','_CoeffMat0','_net.genepos'].map(s=>prefix+s);
 if(stage.id==='visualization')files=[path.join(run,'res/resv/official-session.RData'),prefix+'_edgelist_'+(params.freq??1)+'.txt'];
 if(stage.id==='visualization'&&fs.existsSync(path.dirname(prefix)))files.push(...fs.readdirSync(path.dirname(prefix)).filter(n=>/^signet_[\s\S]*\.(html|pdf|txt|eps)$/.test(n)&&n!==path.basename(files[1])).map(n=>path.join(path.dirname(prefix),n)));
 return files||[];
}
function verifyStage(run,stage,cohort,params,started){
 const files=outputs(run,stage,cohort,params);
 for(const file of files){const s=fs.statSync(file);if(!s.isFile()||s.size===0||s.mtimeMs<started-2000)throw Error('Missing, empty, or stale stage output: '+path.basename(file));}
 if(stage.id==='genotype'){
  const matrix=rows(files[cohort==='TCGA'?0:2],true);
  const ids=cohort==='TCGA'?rows(files[1]):rows(path.join(run,'tmp/tmpg/subjid_wb_common.txt'));
  if(matrix.length!==ids.length)throw Error('Genotype samples and IDs do not align');
  const tmp=path.join(run,'tmp/tmpg');
  if(cohort==='TCGA'){
   const expected=fs.readFileSync(path.join(tmp,'impute_params.txt'),'utf8').trim().split(/\r?\n/).sort();
   const completed=fs.readFileSync(path.join(tmp,'impute_params.txt.completed'),'utf8').trim().split(/\r?\n/).sort();
   if(JSON.stringify(expected)!==JSON.stringify(completed)||!expected[0])throw Error('Imputation commands are incomplete');
  }
 }
 if(stage.id==='expression'&&cohort==='TCGA'){
  const m=rows(files[3],true),pos=rows(files[1]),names=rows(files[2]);
  if(rows(files[0]).length!==m.length)throw Error('Expression samples and IDs do not align');
  if(m[0].length!==pos.length||pos.length!==names.length||pos.some((r,i)=>r.length!==4||r[0]!==names[i][0]))throw Error('Expression and gene metadata differ');
 }
 if(stage.id==='expression'&&cohort==='GTEx'){
  const bed=gunzipSync(fs.readFileSync(files[0])).toString('utf8').trim().split(/\r?\n/).map(line=>line.split('\t'));
  const header=bed.shift(),samples=header.slice(4);
  if(header.slice(0,4).join('\t')!=='#chr\tstart\tend\tgene_id'||!samples.length||new Set(samples).size!==samples.length||!bed.length)throw Error('Invalid GTEx expression BED header or samples');
  for(const r of bed)if(r.length!==header.length||!r[0]||!r[3]||!/^\d+$/.test(r[1])||!/^\d+$/.test(r[2])||Number(r[1])>Number(r[2])||r.slice(4).some(v=>!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(v)||!Number.isFinite(Number(v))))throw Error('Invalid GTEx expression BED row');
  // The official cis-eQTL scripts assume row-aligned genotype/expression matrices.
  const genotypeIds=rows(path.join(run,'tmp/tmpg/GTEx_'+params.tissue+'.raw')).slice(1).map(r=>r[1]);
  if(JSON.stringify(samples)!==JSON.stringify(genotypeIds))throw Error('GTEx expression and genotype sample order differs; correct the source data before analysis');
 }
 if(stage.id==='adjustment'){
  const g=rows(files[0],true),pc=rows(files[1],true);
  if(g.length!==pc.length||g[0].length!==pc[0].length)throw Error('Adjusted matrices differ in shape');
  if(cohort==='TCGA'&&rows(files[2],true).length!==g.length)throw Error('Adjusted genotype and expression samples differ');
  if(cohort==='GTEx'&&(rows(files[2]).length!==g[0].length||rows(path.join(run,'res/resg/signet_clean_Genotype_repNA.data'),true).length!==g.length))throw Error('Adjusted GTEx genes or genotype samples differ');
 }
 if(stage.id==='ciseqtl'){
  // Validate the same contract used by the official network stage.
  const d=Object.fromEntries(['expression','genotype','pairs','positions','names'].map((k,i)=>[k,rows(files[[1,2,0,3,4][i]],!['positions','names'].includes(k))]));
  if(d.expression.length!==d.genotype.length||d.expression[0].length!==d.positions.length||d.names.length!==d.positions.length)throw Error('cis-eQTL output samples or genes differ');
  if(d.positions.some((r,i)=>r.length!==4||r[0]!==d.names[i][0]))throw Error('cis-eQTL gene order differs');
  for(const r of d.pairs)if(r.length!==3||!Number.isInteger(r[0])||!Number.isInteger(r[1])||r[0]<1||r[0]>d.names.length||r[1]<1||r[1]>d.genotype[0].length||r[2]<0||r[2]>params['alpha.cis'])throw Error('cis-eQTL pairs are outside the allowed range');
 }
 return {status:'verified_stage_outputs',stage:stage.id,verified_at:new Date().toISOString(),files:files.map(info),
   note:'Stage outputs, dimensions, and completion evidence checked; biological quality and statistical robustness are not established.'};
}
module.exports={STAGES,FILES,PARAMETERS,schema,parameters,outputs,verifyStage};
