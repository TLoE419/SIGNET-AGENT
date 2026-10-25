// Adapted from the SIGNET desktop result validator; see docs/THIRD_PARTY.md.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const lines = file => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(s => s.trim());
function digest(file) {
  const hash = crypto.createHash('sha256'), fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

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
module.exports = {verify};
