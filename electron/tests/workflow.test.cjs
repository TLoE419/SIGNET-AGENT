'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');const {readFileSync}=require('node:fs');const path=require('node:path');
const config={root:'/pub/u/signet-agent',partition:'standard'};
function fixture(){
 const dom=new JSDOM('<meta name="chat-token" content="fixture"><details id="workflow" open><summary id="workflow-summary"></summary><span id="workflow-environment-status"></span><button id="workflow-check"></button><ul id="workflow-items"></ul><p id="workflow-message"></p></details>',{runScripts:'outside-only'});
 const w=dom.window;let listener;const calls=[],checks=[],installs=[];let reply=async()=>({status:'ok',checks:[]}),confirm=false;
 const settled={phase:'needs-install',message:'Installation required',config};
 w.confirm=()=>confirm;
 w.signetDesktop={environment:{subscribe:fn=>{listener=fn;return()=>{}},getSnapshot:async()=>({ok:true,value:{phase:'disconnected',message:''}}),
  check:async(...args)=>{checks.push(args);listener(settled);return {ok:true,value:settled}},install:async()=>{installs.push(true);return {ok:true}}}};
 w.fetch=async url=>{calls.push(url);return {ok:true,json:()=>reply(url)}};
 w.eval(readFileSync(path.join(__dirname,'../renderer/workflow.js'),'utf8'));
 return {dom,w,calls,checks,installs,snapshot:value=>listener(value),reply:fn=>{reply=fn},allow:()=>{confirm=true},text:id=>w.document.getElementById(id).textContent,click:()=>w.document.getElementById('workflow-check').click()};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('workflow discards an in-flight readiness reply when SSH disconnects',async()=>{
 const f=fixture();let resolve;f.reply(()=>new Promise(r=>{resolve=r}));
 f.click();await settle();
 f.snapshot({phase:'disconnected',message:'SSH disconnected'});
 resolve({status:'ok',ready:true,checks:[{item:'connection',status:'ok',detail:'stale account'}]});await settle();
 assert.doesNotMatch(f.w.document.body.textContent,/stale account/);
 assert.match(f.text('workflow-message'),/SSH disconnected/);
 f.dom.window.close();
});
test('the check button rechecks the environment with its saved location, then shows what is missing',async()=>{
 const f=fixture();f.snapshot({phase:'ready',message:'',config});await settle();
 f.reply(async()=>({status:'ok',checks:[{item:'container',status:'missing',detail:'images/signet-0.0.6.sif is missing.'}]}));
 f.click();await settle();await settle();
 assert.deepEqual(f.checks,[['/pub/u/signet-agent','standard']]);
 assert.match(f.w.document.body.textContent,/images\/signet-0\.0\.6\.sif is missing/);
 assert.doesNotMatch(f.w.document.body.textContent,/not reachable|HPC3 not connected/);f.dom.window.close();
});
test('an unconfigured environment is not described as a lost connection',async()=>{
 const f=fixture();f.reply(async()=>({status:'not_ready',reason:'Checking remote paths.'}));
 f.snapshot({phase:'needs-install',message:'Installation required',config});await settle();await settle();
 assert.equal(f.text('workflow-summary'),'Environment not ready');assert.match(f.text('workflow-message'),/Checking remote paths/);f.dom.window.close();
});
test('SIGNET installs through the shared backend only after confirmation; the container is a Slurm step',async()=>{
 const f=fixture();f.reply(async url=>url==='/hpc/check'?{status:'ok',checks:[{item:'signet_source',status:'missing',detail:'No source'},{item:'container',status:'missing',detail:'No image'}]}:{status:'ok',detail:'Started'});
 f.snapshot({phase:'needs-install',message:'',config});await settle();await settle();
 const buttons=()=>[...f.w.document.querySelectorAll('[data-status=missing] button')];
 assert.deepEqual(buttons().map(b=>b.textContent),['Install','Download']);
 buttons()[0].click();await settle();assert.equal(f.installs.length,0);
 assert.equal(f.calls.includes('/hpc/signet'),false);
 f.allow();buttons()[0].click();await settle();assert.equal(f.installs.length,0);assert.equal(f.calls.filter(url=>url==='/hpc/signet').length,1);
 buttons()[1].click();await settle();assert.ok(f.calls.includes('/hpc/container'));f.dom.window.close();
});
test('a verification failure stays visible beside the per-item results',async()=>{
 const f=fixture();f.reply(async()=>({status:'ok',checks:[{item:'container',status:'ok',detail:'6 GB'}]}));
 f.snapshot({phase:'error',message:'runtime-verification failed',config});await settle();await settle();
 assert.match(f.text('workflow-message'),/runtime-verification failed/);assert.match(f.w.document.body.textContent,/6 GB/);f.dom.window.close();
});
test('environment readiness uses only infrastructure and software checks',async()=>{
 const f=fixture();
 const checks=['connection','workspace','slurm','apptainer','signet_source','container'].map(item=>({item,status:'ok',detail:''}));
 f.reply(async()=>({status:'ok',ready:true,checks}));
 f.snapshot({phase:'ready',message:'',config});await settle();await settle();
 assert.deepEqual(f.calls,['/hpc/check']);
 assert.equal(f.text('workflow-summary'),'Environment: 3/3 ready');
 assert.equal(f.w.document.querySelectorAll('.workflow-item').length,3);
 f.dom.window.close();
});
