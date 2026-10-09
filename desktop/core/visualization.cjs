const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,execFile}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {promisify}=require('node:util');
const exec=promisify(execFile);
const {ssh}=require('./transport.cjs');
const F=require('./files.cjs');
const quote=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
class Visualization{
 constructor(root){this.root=root;this.child=null;this.url=null;this.id=null;}
 async stop(){const child=this.child,id=this.id,token=this.token;this.child=null;this.url=null;this.id=null;this.token=null;if(child){try{await exec('ssh',[...ssh(this.root),['bash','/work/tools/run-visualization.sh','stop',id,token].map(quote).join(' ')],{timeout:15000});}finally{child.kill('SIGTERM');}}}
 async open(id){if(this.opening)throw Error('Official visualization is starting; wait for it to finish.');this.opening=true;try{return await this.start(id);}finally{this.opening=false;}}
 async start(id){
  if(!/^(a-\d{8}T\d{6}-[a-f0-9]{12}|macos-vm-smoke-20261006)$/.test(id))throw Error('Invalid analysis ID');
  const run=path.join(this.root,'runs',id),session=path.join(run,'res/resv/official-session.RData');
  if(!fs.existsSync(session))throw Error('Run official stage six first; historical custom results must be prepared before opening.');
  const record=F.read(path.join(this.root,'analyses',id,'verified-visualization.json'));
  for(const f of record.files)if(!f.file.startsWith(run+path.sep)||F.digest(f.file)!==f.sha256)throw Error('Official visualization outputs changed');
  if(this.id===id&&this.child&&this.url)return {url:this.url};
  await this.stop();
  const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
  const logfile=path.join(run,'logs/visualization-server.log'),offset=fs.existsSync(logfile)?fs.statSync(logfile).size:0;
  const log=fs.openSync(logfile,'a');
  this.token=randomUUID();
  const child=spawn('ssh',[...ssh(this.root),'-o','ExitOnForwardFailure=yes','-L',`127.0.0.1:${port}:127.0.0.1:${port}`,
   ['setsid','--wait','bash','/work/tools/run-visualization.sh','serve',id,this.token,String(port)].map(quote).join(' ')],{stdio:['ignore',log,log]});
  fs.closeSync(log);this.child=child;this.id=id;let failure=null;
  child.on('error',e=>{failure=e.message;});child.on('exit',code=>{failure='Official visualization server exited ('+code+'); inspect visualization-server.log';if(this.child===child)this.url=null;});
  const url=`http://127.0.0.1:${port}/`;
  for(let i=0;i<600;i++){
   if(failure)throw Error(failure);
   if(this.child!==child)throw Error('Visualization startup cancelled.');
   try{if(!fs.readFileSync(logfile).subarray(offset).toString().includes('Listening on http://127.0.0.1:'+port)){await new Promise(resolve=>setTimeout(resolve,500));continue;}const r=await fetch(url,{signal:AbortSignal.timeout(1000)});if(r.ok&&(await r.text()).includes(this.token)){this.url=url;return {url};}}catch{}
   await new Promise(resolve=>setTimeout(resolve,500));
  }
  await this.stop();throw Error('Official visualization did not become ready; inspect visualization-server.log');
 }
}
module.exports={Visualization};
