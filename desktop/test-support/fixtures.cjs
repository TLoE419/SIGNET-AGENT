// Synthetic fixtures: these files are never scientific inference evidence.
const fs=require('node:fs'),path=require('node:path');
const F=require('../core/files.cjs'),R=require('../core/results.cjs');
function text(root,name,value){const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);}
function source(root){
 const code=path.join(root,'official-signet');
 text(code,'signet','#!/bin/sh\nexit 1 # Synthetic source must never execute science\n');
 text(code,'config.ini',['cohort','matched.geno','gene.pos','net.gexp.data','net.geno.data'].map(k=>k+' = placeholder').join('\n')+'\n');
 for(const file of ['bts1gensub.sh','bts2gensub.sh'])text(code,'script/network/'+file,'time sh qsub\n');
 text(code,'script/network/template.sub.ori','#SBATCH -N 1\n');
 for(const file of ['adj.sh','adj_gtex.sh'])text(code,'script/adj/'+file,'read -p "PC count" pc\n');
 text(code,'script/geno_prep/extract.sh','gunzip GTEx_snp.vcf.gz\n');
 const inputs={'signet_net.gexp.data':'1 2\n3 4\n','signet_all.eQTL.data':'0\n1\n',
  'signet_all.sig.pValue_0.05':'1 1 0.01\n','signet_net.genename':'g1\ng2\n','signet_net.genepos':'g1 1 0 2\ng2 1 3 5\n'};
 for(const [file,value] of Object.entries(inputs))text(code,'example/network/'+file,value);
 F.write(path.join(root,'evidence/input-validation.json'),R.inputs(path.join(code,'example/network')));
 F.write(path.join(root,'evidence/provenance.json'),{synthetic:true,container_actual:{sha256:'0'.repeat(64)}});
}
function network(root,id){
 const run=path.join(root,'runs',id),tmp='tmp/tmpn/';
 text(run,'res/resn/signet_Afreq','0\n0.5\n');text(run,'res/resn/signet_CoeffMat0','0\n-2\n');
 text(run,'res/resn/signet_net.genepos','g1 1 0 2\ng2 1 3 5\n');
 text(run,tmp+'net.genepos','g1 1 0 2\ng2 1 3 5\n');text(run,tmp+'nety','1 2\n3 4\n');text(run,tmp+'netx','0\n1\n');
 for(const stage of [1,2]){text(run,tmp+'stage'+stage+'/params.txt','synthetic-command\n');text(run,tmp+'stage'+stage+'/params1.txt.completed','synthetic-command\n');}
 for(let b=0;b<=2;b++){
  text(run,tmp+'stage1/output/ypre'+b,'1\n2\n');
  text(run,tmp+'stage2/output/AdjMat'+b,'0\n'+(b===2?'0':'1')+'\n');
  text(run,tmp+'stage2/output/CoeffMat'+b,'0\n-2\n');
 }
 text(run,'logs/job_ids.txt','1\n');F.write(path.join(run,'logs/scheduler-jobs.json'),[{JobIDRaw:'1',State:'COMPLETED',ExitCode:'0:0',synthetic:true}]);
 F.write(path.join(run,'logs/verification.json'),{...R.verify(run,2),synthetic:true});return run;
}
module.exports={source,network};
