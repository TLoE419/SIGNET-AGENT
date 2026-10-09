// Scientific output validation only. Official inference remains in the container.
const fs = require('node:fs');
const path = require('node:path');
const {read, write, digest, lines} = require('./files.cjs');

function rows(file, numeric=false) {
  const data = lines(file).map(s=>s.replaceAll(',',' ').trim().split(/\s+/));
  if (!data.length || data.some(r=>r.length!==data[0].length)) throw Error('Empty or ragged matrix: '+file);
  if (!numeric) return data;
  return data.map(row=>row.map(s=>{
    // Number('') and hexadecimal literals are not valid scientific matrix cells.
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(s) || !Number.isFinite(Number(s)))
      throw Error('Invalid or non-finite matrix cell: '+file);
    return Number(s);
  }));
}
function info(file) { return {file,sha256:digest(file)}; }
function inputs(folder) {
  const names = {expression:'signet_net.gexp.data',genotype:'signet_all.eQTL.data',
    pairs:'signet_all.sig.pValue_0.05',names:'signet_net.genename',positions:'signet_net.genepos'};
  const files = Object.fromEntries(Object.entries(names).map(([key,name])=>[key,path.join(folder,name)]));
  const d = Object.fromEntries(Object.entries(files).map(([k,f])=>[k,rows(f,['expression','genotype','pairs'].includes(k))]));
  const n=d.expression.length,p=d.expression[0].length,q=d.genotype[0].length;
  if(d.genotype.length!==n || d.names.length!==p || d.positions.length!==p)throw Error('Samples and gene metadata do not align');
  if(d.names.some(r=>r.length!==1)||d.positions.some(r=>r.length!==4))throw Error('Invalid gene metadata columns');
  if(new Set(d.names.map(r=>r[0])).size!==p)throw Error('Duplicate gene names');
  d.positions.forEach((r,i)=>{
    if(r[0]!==d.names[i][0]||!/^\d+$/.test(r[2])||!/^\d+$/.test(r[3])||Number(r[2])>Number(r[3]))throw Error('Invalid gene order or coordinates');
  });
  for(const [g,s,v,...rest] of d.pairs)if(rest.length||!Number.isInteger(g)||!Number.isInteger(s)||g<1||g>p||s<1||s>q||v<0||v>0.05)throw Error('Invalid significant pair');
  return {status:'validated_official_simulated_inputs',samples:n,genes:p,markers:q,significant_pairs:d.pairs.length,
    genes_with_instruments:new Set(d.pairs.map(r=>r[0])).size,genotype_values:[...new Set(d.genotype.flat())].sort((a,b)=>a-b),
    note:'Official simulation special values are retained; not a general real-data acceptance rule.',files:Object.values(files).map(info)};
}
function network(folder) {
  const files=['Afreq','CoeffMat0','net.genepos'].map(s=>path.join(folder,'signet_'+s));
  const freq=rows(files[0],true),coef=rows(files[1],true),positions=rows(files[2]);
  const n=freq.length,p=freq[0].length;
  if(coef.length!==n||coef[0].length!==p||positions.length!==n||p>n)throw Error('Frequency, coefficient, and gene metadata dimensions differ');
  if(positions.some(r=>r.length!==4)||new Set(positions.map(r=>r[0])).size!==n)throw Error('Invalid or duplicate gene metadata');
  const edges=[];
  freq.forEach((r,i)=>r.forEach((v,j)=>{
    if(v<0||v>1)throw Error('Frequency outside [0, 1]');
    if(v>0)edges.push({source:positions[j][0],target:positions[i][0],frequency:v,coefficient:coef[i][j],source_index:j,target_index:i});
  }));
  return {shape:[n,p],genes:positions.map(r=>r[0]),edges,files:files.map(info),
    direction:'column/source regulates row/target; columns map to the first p gene positions',
    counts:Object.fromEntries([0.5,0.8,0.9,1].map(t=>[t===1?'1.0':String(t),edges.filter(e=>e.frequency>=t-1e-15).length]))};
}
function verify(root,nboots) {
  if(!Number.isInteger(nboots)||nboots<1)throw Error('Bootstrap repetitions must be a positive integer');
  const tmp=path.join(root,'tmp/tmpn'),net=network(path.join(root,'res/resn')),[n,p]=net.shape;
  const ny=rows(path.join(tmp,'nety'),true),nx=rows(path.join(tmp,'netx'),true);
  if(n!==ny[0].length||p!==nx[0].length||ny.length!==nx.length)throw Error('Network dimensions differ from prepared inputs');
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  if(!equal(rows(path.join(tmp,'net.genepos')),rows(path.join(root,'res/resn/signet_net.genepos'))))throw Error('Result gene order changed');
  for(const stage of [1,2]){
    const folder=path.join(tmp,'stage'+stage),expected=lines(path.join(folder,'params.txt'));
    const completed=fs.readdirSync(folder).filter(n=>/^params\d+\.txt\.completed$/.test(n)).flatMap(n=>lines(path.join(folder,n)));
    if(!expected.length||!equal(expected.sort(),completed.sort()))throw Error('Phase '+stage+' command completion lists differ');
    for(const file of fs.readdirSync(folder).filter(n=>/^rerun.*\.txt$/.test(n)))if(lines(path.join(folder,file)).length)throw Error('Failed commands remain: '+file);
  }
  const sum=Array.from({length:n},()=>Array(p).fill(0));
  let original;
  for(let b=0;b<=nboots;b++){
    const pre=rows(path.join(tmp,'stage1/output/ypre'+b),true),adj=rows(path.join(tmp,'stage2/output/AdjMat'+b),true),coef=rows(path.join(tmp,'stage2/output/CoeffMat'+b),true);
    if(pre.length!==ny.length||pre[0].length!==p||[adj,coef].some(m=>m.length!==n||m[0].length!==p))throw Error('Phase '+b+' matrix dimensions differ');
    adj.forEach((r,i)=>r.forEach((v,j)=>{if(v!==0&&v!==1)throw Error('Adjacency is not binary');if(b>0)sum[i][j]+=v}));
    if(b===0)original=coef;
  }
  const freq=rows(path.join(root,'res/resn/signet_Afreq'),true);
  if(freq.some((r,i)=>r.some((v,j)=>Math.abs(v-sum[i][j]/nboots)>1e-12)))throw Error('Frequency is not the actual bootstrap mean');
  if(!equal(original,rows(path.join(root,'res/resn/signet_CoeffMat0'),true)))throw Error('Original coefficients differ');
  const accounting=read(path.join(root,'logs/scheduler-jobs.json')),jobs=lines(path.join(root,'logs/job_ids.txt'));
  if(!jobs.length||new Set(jobs).size!==jobs.length||jobs.some(j=>!/^\d+$/.test(j)))throw Error('Missing valid actual scheduler job IDs');
  for(const job of jobs){const matching=accounting.filter(r=>r.JobIDRaw===job);
    if(matching.length!==1||matching[0].State!=='COMPLETED'||matching[0].ExitCode!=='0:0')throw Error('Scheduler job '+job+' is not verified completed');
  }
  return {status:'verified_actual_run',job_ids:jobs,nboots,shape:net.shape,counts:net.counts,outputs:net.files};
}
function render(root,output,template) {
  const record=read(path.join(root,'logs/verification.json')),v=verify(root,record.nboots);
  if(record.status!=='verified_actual_run'||v.outputs.some((f,i)=>f.sha256!==record.outputs[i]?.sha256))throw Error('Results differ from recorded verification');
  const data=network(path.join(root,'res/resn'));
  data.verification=v;data.provenance='Verified actual analysis output';
  fs.mkdirSync(output,{recursive:true});write(path.join(output,'network.json'),data);
  const cols=['source','target','frequency','coefficient','source_index','target_index'];
  const cell=v=>'"'+String(v).replaceAll('"','""')+'"';
  fs.writeFileSync(path.join(output,'edges.csv'),cols.join(',')+'\r\n'+data.edges.map(e=>cols.map(k=>cell(e[k])).join(',')).join('\r\n')+'\r\n');
  fs.writeFileSync(path.join(output,'network.html'),fs.readFileSync(template,'utf8').replace('__NETWORK_DATA__',JSON.stringify(data).replaceAll('<','\\u003c')));
  return v;
}
module.exports={rows,info,inputs,network,verify,render};
