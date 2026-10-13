const fs=require('node:fs');
const {fields,WORKFLOWS,LIMIT}=require('./drafts.cjs');
const number=/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
function fail(message,code='unsupported-format'){throw Object.assign(Error(message),{code});}
function numeric(v){if(!number.test(v)||!Number.isFinite(Number(v)))fail('Expected a finite decimal number');return Number(v);}
function unique(values){if(!values.length||values.some(x=>!x||/[\s\x00-\x1f]/.test(x)))fail('Invalid identifier');if(new Set(values).size!==values.length)fail('Duplicate identifier','duplicate-id');return values;}
function read(file){const bytes=fs.readFileSync(file);if(bytes.includes(0))fail('Binary/compressed formats are not supported by this text contract');const lines=bytes.toString('utf8').split(/\r?\n/).filter(l=>l.trim());if(!lines.length||lines.length>LIMIT.rows)fail('Input is empty or exceeds the row limit');return lines;}
function rows(file,numbers=false){const out=[];let cells=0,width=null;for(const line of read(file)){const r=line.trim().split(/\s+/,LIMIT.cells-cells+1);if((cells+=r.length)>LIMIT.cells)fail('Input exceeds the bounded cell limit');if(width!==null&&r.length!==width)fail('Rows have different widths');width=r.length;out.push(numbers?r.map(numeric):r);}return out;}
function ids(file){const r=rows(file);if(r[0].length!==1)fail('Use one sample identifier per line');return unique(r.map(r=>r[0]));}
function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function annotation(file,content){
 const lines=read(file),build=lines.find(l=>/^#!?(?:genome-build|assembly)\s/.test(l))?.trim().split(/\s+/).at(-1),species=lines.find(l=>/^#!?species\s/.test(l))?.trim().split(/\s+/).at(-1);
 // An unknown alias/version is not silently treated as the configured build.
 if(build!==content.assembly||species!==content.species)fail('GTF must declare the exact configured assembly and taxonomy ID; unproved aliases require an explicit adapter','annotation-unverified');
 const result=new Map(),geneIds=new Set();for(const l of lines.filter(l=>!l.startsWith('#'))){const r=l.split('\t');if(r.length!==9)fail('Expected nine GTF columns','annotation-unverified');if(r[2]!=='gene')continue;const name=r[8].match(/\bgene_name\s+"([^"]+)"/)?.[1],id=r[8].match(/\bgene_id\s+"([^"]+)"/)?.[1];if(!name||!id||result.has(name)||geneIds.has(id))fail('Missing or duplicate GTF gene identity','annotation-unverified');if(!/^\d+$/.test(r[3])||!/^\d+$/.test(r[4])||+r[3]<1||+r[3]>+r[4])fail('Invalid GTF coordinates','annotation-unverified');result.set(name,{id,chr:r[0],start:+r[3],end:+r[4]});geneIds.add(id);}
 if(!result.size)fail('No verifiable gene annotations','annotation-unverified');return result;
}
function validate(c,caps,checked){
 const issues=[...checked.issues],parsed={};const add=(field,code,message)=>issues.push({field,code,message});
 const attempt=(field,fn)=>{try{return fn();}catch(e){add('inputs.'+field,e.code??'unsupported-format',e.message);return null;}};
 const definition=WORKFLOWS[c.workflow];if(!definition?.supported)add('workflow','workflow-unavailable',definition?.reason??'Unsupported workflow');
 if(!caps.annotation.some(a=>a.species===c.species&&a.assembly===c.assembly))add('assembly','annotation-unverified','Choose a species/build explicitly present in the official configuration');
 const required=fields(c.workflow,c.cohort);for(const [key]of required){if(!c.inputs[key])add('inputs.'+key,'missing-input','Select the required source through the native picker');}
 const valid=field=>c.inputs[field]&&!checked.issues.some(i=>i.field==='inputs.'+field);const file=field=>c.inputs[field].source;
 if(c.workflow==='network'){
 for(const k of ['expression','genotype','pairs'])if(valid(k))parsed[k]=attempt(k,()=>rows(file(k),true));
 for(const k of ['genes','expressionSamples','genotypeSamples'])if(valid(k))parsed[k]=attempt(k,()=>ids(file(k)));
 if(valid('positions'))parsed.positions=attempt('positions',()=>{const r=rows(file('positions'));if(r[0].length!==4||r.some(x=>!/^\d+$/.test(x[2])||!/^\d+$/.test(x[3])||+x[2]<1||+x[2]>+x[3]))fail('Expected gene/chromosome/start/end coordinates');unique(r.map(x=>x[0]));return r;});
 if(valid('annotation'))parsed.annotation=attempt('annotation',()=>annotation(file('annotation'),c));
 const {expression:e,genotype:g,expressionSamples:es,genotypeSamples:gs,genes,positions:pos,pairs,annotation:a}=parsed;
 if(es&&gs&&!same(es,gs))add('inputs.genotypeSamples','sample-order','Expression and genotype sample identities/order differ; automatic reordering is disabled');
 if(e&&es&&e.length!==es.length)add('inputs.expressionSamples','sample-count','Expression row count differs from sample IDs');
 if(g&&gs&&g.length!==gs.length)add('inputs.genotypeSamples','sample-count','Genotype row count differs from sample IDs');
 if(e&&g&&e.length!==g.length)add('inputs.genotype','sample-count','Matrix sample counts differ');
 if(e&&genes&&e[0].length!==genes.length)add('inputs.genes','gene-linkage','Expression columns differ from gene names');
 if(genes&&pos&&!same(genes,pos.map(r=>r[0])))add('inputs.positions','gene-linkage','Gene names and position identities/order differ');
 if(pos&&a&&pos.some(r=>{const p=a.get(r[0]);return !p||p.chr!==r[1]||p.start!==+r[2]||p.end!==+r[3];}))add('inputs.annotation','annotation-unverified','Gene coordinates differ from the supplied GTF');
 if(pairs&&new Set(pairs.map(r=>r[0]+':'+r[1])).size!==pairs.length)add('inputs.pairs','duplicate-pair','Duplicate gene/variant pair');
 if(pairs&&genes&&g&&pairs.some(r=>r.length!==3||!Number.isInteger(r[0])||!Number.isInteger(r[1])||r[0]<1||r[0]>genes.length||r[1]<1||r[1]>g[0].length||r[2]<0||r[2]>c.parameters['alpha.cis']))add('inputs.pairs','pair-bounds','Pair indices or p-values exceed this draft’s bounds');
 }else if(c.workflow==='preprocessing'){
 // Raw contracts are checked independently; no invocation of R, PLINK or imputation.
 if(c.cohort==='TCGA'){
 if(valid('ped.file'))parsed.samples=attempt('ped.file',()=>{const r=rows(file('ped.file'));if(r[0].length<8||(r[0].length-6)%2||r.some(x=>x.slice(6).some(a=>!['0','A','C','G','T','1','2','3','4'].includes(a))))fail('Unsupported PED allele columns');parsed.markerCount=(r[0].length-6)/2;return unique(r.map(x=>x[1]));});
 if(valid('map.file'))attempt('map.file',()=>{const r=rows(file('map.file'));if(r[0].length!==4||r.some(x=>!/^\d+$/.test(x[3])||numeric(x[2])<0))fail('Unsupported PLINK MAP rows');unique(r.map(x=>x[1]));if(parsed.markerCount&&r.length!==parsed.markerCount)fail('PED/MAP marker counts differ','gene-linkage');});
 if(valid('gexp.file'))parsed.expressionSamples=attempt('gexp.file',()=>{const r=rows(file('gexp.file'));if(r.length<7||r[0].length<2)fail('Official TCGA input requires a header and five trailing rows');unique(r.slice(1,-5).map(x=>x[0]));for(const row of r.slice(1))row.slice(1).forEach(numeric);return unique(r[0].slice(1));});
 if(parsed.samples&&parsed.expressionSamples&&!same(parsed.samples,parsed.expressionSamples))add('inputs.gexp.file','sample-order','Raw genotype/expression IDs differ; no implicit TCGA subject remapping is certified');
 for(const [key,ext]of [['ref','.gen'],['gmap','.map']])if(valid(key)){for(let chr=1;chr<=c.parameters.nchr;chr++)if(!c.inputs[key].files['chr'+chr+ext])add('inputs.'+key,'missing-reference','Missing chr'+chr+ext);add('inputs.'+key,'reference-unverified','Selected reference files have hashes, but species/build provenance is not established by these seven raw fields');}
 if(valid('cli.file'))attempt('cli.file',()=>{const r=rows(file('cli.file')),col=r[0].indexOf('submitter_id');if(col<0)fail('Clinical header must include submitter_id');unique(r.slice(1).map(x=>x[col]));});
 if(valid('pmap.file'))attempt('pmap.file',()=>annotation(file('pmap.file'),c));
 }else{
 for(const key of ['vcf0','vcf.file'])if(valid(key))parsed[key]=attempt(key,()=>{const l=read(file(key));if(!l[0].startsWith('##fileformat=VCFv4.'))fail('Only uncompressed VCF v4 text is supported');const h=l.find(x=>x.startsWith('#CHROM\t'))?.split('\t');if(!h||h.length<10)fail('VCF sample header is missing');const samples=unique(h.slice(9));for(const line of l.filter(x=>!x.startsWith('#'))){const r=line.split('\t');if(r.length!==h.length||!/^\d+$/.test(r[1])||+r[1]<1||!r[3]||!r[4]||!r[8].split(':').includes('GT'))fail('Invalid VCF variant or genotype format');const gt=r[8].split(':').indexOf('GT');if(r.slice(9).some(v=>!/^\d+[|/]\d+$/.test(v.split(':')[gt])))fail('Missing/non-diploid VCF genotypes require an explicit policy');}return samples;});
 for(const key of ['read.file','tpm.file'])if(valid(key))parsed[key]=attempt(key,()=>{const l=read(file(key));if(l[0]!=='#1.2')fail('Only uncompressed GCT 1.2 is supported');if(!/^\d+\s+\d+$/.test(l[1].trim()))fail('Invalid GCT dimensions');const dimensions=l[1].trim().split(/\s+/).map(Number);if(dimensions.some(n=>!Number.isSafeInteger(n)||n<1)||dimensions[0]*dimensions[1]>LIMIT.cells)fail('GCT exceeds the bounded cell limit');const header=l[2].split('\t',dimensions[1]+3);if(header[0]!=='Name'||header[1]!=='Description'||dimensions[0]!==l.length-3||dimensions[1]!==header.length-2)fail('GCT dimensions/header differ');const geneIds=[];for(const line of l.slice(3)){const x=line.split('\t',header.length+1);if(x.length!==header.length)fail('GCT row width differs');geneIds.push(x[0]);x.slice(2).forEach(numeric);}unique(geneIds);return unique(header.slice(2));});
 if(parsed.vcf0&&parsed['vcf.file']&&!same(parsed.vcf0,parsed['vcf.file']))add('inputs.vcf.file','sample-order','VCF sample IDs/order differ');
 if(parsed['read.file']&&parsed['tpm.file']&&!same(parsed['read.file'],parsed['tpm.file']))add('inputs.tpm.file','sample-order','Reads and TPM sample IDs/order differ');
 if(valid('anno'))attempt('anno',()=>{const r=rows(file('anno')),id=r[0].indexOf('SAMPID');if(id<0||!r[0].includes('SMTSD'))fail('Sample annotation requires SAMPID and SMTSD');unique(r.slice(1).map(x=>x[id]));});
 if(valid('pheno'))attempt('pheno',()=>{const r=rows(file('pheno'));unique(r.slice(1).map(x=>x[0]));});
 if(valid('gtf.file'))attempt('gtf.file',()=>annotation(file('gtf.file'),c));
 add('inputs.anno','sample-mapping-unverified','GTEx tissue sample-to-subject mapping and phased/reference provenance require a verified checkpoint; raw files alone are not certified');
 }
 }
 return {issues,capabilities:{computeReady:false,reviewReady:issues.length===0,entryStage:c.entryStage,finishAfter:c.finishAfter,availablePCs:null,pcaMaximum:null,samples:parsed.expressionSamples?.length??null,note:'Structural input evidence only; no biological quality, scientific computation, remote connection or submission has been established.'}};
}
module.exports={validate};
