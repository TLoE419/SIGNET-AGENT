#!/usr/bin/env node
// Maintenance commands use the same Node contracts as Electron, without a server.
const path=require('node:path'),fs=require('node:fs');
const {Store}=require('./store.cjs'),R=require('./results.cjs');
const root=path.resolve(__dirname,'../..');
(async()=>{
 const [command,...args]=process.argv.slice(2);let value;
 if(command==='inputs')value=R.inputs(path.resolve(args[0]));
 else if(command==='verify')value=R.verify(path.resolve(args[0]),Number(args[1]??2));
 else if(command==='render')value=R.render(path.resolve(args[0]),path.resolve(args[1]),path.join(__dirname,'viewer.html'));
 else {const store=new Store(root);
  if(command==='list')value=store.list();
  else if(command==='create')value=store.create(args[0]?JSON.parse(fs.readFileSync(args[0],'utf8')):{});
  else if(command==='detail')value=store.detail(args[0]);
  else if(command==='start')value=store.start(args[0],args[1]);
  else if(command==='cancel')value=await store.cancel(args[0]);
  else throw Error('Usage: inputs FOLDER | verify RUN NBOOTS | render RUN OUTPUT | list | create [CONFIG.json] | detail ID | start ID STAGE | cancel ID');
 }
 console.log(JSON.stringify(value,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1});
