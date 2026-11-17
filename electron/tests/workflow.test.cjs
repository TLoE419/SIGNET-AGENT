'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');const {readFileSync}=require('node:fs');const path=require('node:path');
const config={root:'/pub/u/signet-agent',partition:'standard'};
const STAGE2='<details id="workflow-environment" open></details><div id="workflow-next" hidden><button id="workflow-next-button"></button></div>'
 +'<li id="workflow-preprocess-stage" class="locked"><details id="workflow-preprocess"><summary></summary><span id="workflow-preprocess-status"></span><div id="workflow-preprocess-body"></div></details></li>'
 +'<li id="workflow-results-stage" class="locked"><details id="workflow-results"><summary></summary><span id="workflow-results-status"></span><div id="workflow-results-body"></div></details></li><div id="messages"></div>';
function fixture({stage2=false}={}){
 const dom=new JSDOM('<meta name="chat-token" content="fixture"><details id="workflow" open><summary id="workflow-summary"></summary><span id="workflow-environment-status"></span><button id="workflow-check"></button><ul id="workflow-items"></ul><p id="workflow-message"></p></details>'+(stage2?STAGE2:''),{runScripts:'outside-only',url:'http://127.0.0.1/'});
 const w=dom.window;let listener;const calls=[],checks=[];let reply=async()=>({status:'ok',checks:[]}),confirm=false;
 const settled={phase:'needs-install',message:'Installation required',config};
 w.uiText=(el,text)=>{el.textContent=text};w.translateUI=text=>text;w.confirm=()=>confirm;
 w.signetDesktop={environment:{subscribe:fn=>{listener=fn;return()=>{}},getSnapshot:async()=>({ok:true,value:{phase:'disconnected',message:''}}),
  check:async(...args)=>{checks.push(args);listener(settled);return {ok:true,value:settled}}}};
 const bodies=[];w.fetch=async(url,options={})=>{calls.push(url);if(options.body)bodies.push([url,JSON.parse(options.body)]);return {ok:true,json:()=>reply(url)}};
 // The chat page defines the conversation ID (features/chat/chat.js) in the same bundle.
 if(stage2)w.eval('var session="12345678-1234-1234-1234-123456789abc";');
 w.eval(readFileSync(path.join(__dirname,'../renderer/workflow.js'),'utf8'));
 return {dom,w,calls,bodies,checks,snapshot:value=>listener(value),reply:fn=>{reply=fn},allow:()=>{confirm=true},text:id=>w.document.getElementById(id).textContent,click:()=>w.document.getElementById('workflow-check').click()};
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
test('reference download cancellation does not send a write request',async()=>{
 const f=fixture();f.reply(async()=>({status:'ok',checks:[{item:'reference_ref',status:'missing',detail:'Not installed'}]}));
 f.click();await settle();
 const button=f.w.document.querySelector('[data-status=missing] button');assert.ok(button);button.click();await settle();
 assert.equal(f.calls.some(url=>url.includes('/hpc/reference')),false);f.dom.window.close();
});
test('the check button rechecks the environment with its saved location, then shows what is missing',async()=>{
 const f=fixture();f.snapshot({phase:'ready',message:'',config});await settle();
 f.reply(async()=>({status:'ok',checks:[{item:'container',status:'missing',detail:'images/signet-0.0.6.sif is missing.'}]}));
 f.click();await settle();await settle();
 assert.deepEqual(f.checks,[['/pub/u/signet-agent','standard']]);
 assert.match(f.w.document.body.textContent,/images\/signet-0\.0\.6\.sif is missing/);
 assert.doesNotMatch(f.w.document.body.textContent,/not reachable|尚未連線/);f.dom.window.close();
});
test('an unconfigured environment is not described as a lost connection',async()=>{
 const f=fixture();f.reply(async()=>({status:'not_ready',reason:'Checking remote paths.'}));
 f.snapshot({phase:'needs-install',message:'Installation required',config});await settle();await settle();
 assert.equal(f.text('workflow-summary'),'環境尚未就緒');assert.match(f.text('workflow-message'),/Checking remote paths/);f.dom.window.close();
});
test('SIGNET installs through the Python service only after confirmation; the container is a Slurm step',async()=>{
 const f=fixture();f.reply(async url=>url==='/hpc/check'?{status:'ok',checks:[{item:'signet_source',status:'missing',detail:'No source'},{item:'container',status:'missing',detail:'No image'}]}:url==='/hpc/files/selected'?{status:'ok',selected:{}}:{status:'ok',detail:'Started'});
 f.snapshot({phase:'needs-install',message:'',config});await settle();await settle();
 const buttons=()=>[...f.w.document.querySelectorAll('[data-status=missing] button')];
 assert.deepEqual(buttons().map(b=>b.textContent),['安裝','下載']);
 buttons()[0].click();await settle();assert.equal(f.calls.includes('/hpc/signet'),false);
 f.allow();buttons()[0].click();await settle();assert.ok(f.calls.includes('/hpc/signet'));
 assert.equal('install' in f.w.signetDesktop.environment,false,'the desktop bridge has no installer');
 await new Promise(resolve=>setTimeout(resolve,3100));
 buttons()[1].click();await settle();assert.ok(f.calls.includes('/hpc/container'));f.dom.window.close();
});
test('once SIGNET is installed, the desktop re-verifies the environment that still lists it as missing',async()=>{
 const f=fixture();f.reply(async url=>url==='/hpc/check'?{status:'ok',checks:[{item:'signet_source',status:'ok',detail:'Installed'}]}:{status:'ok',selected:{}});
 f.snapshot({phase:'needs-install',message:'',config,missing:['SIGNET source','SIGNET container']});
 for(let i=0;i<5;i++)await settle();
 assert.deepEqual(f.checks,[['/pub/u/signet-agent','standard']],'one automatic recheck');
 for(let i=0;i<5;i++)await settle();
 assert.equal(f.checks.length,1,'the recheck does not repeat while the desktop still disagrees');f.dom.window.close();
});
test('a setup step started by the assistant opens the panel and refreshes it',async()=>{
 const f=fixture();f.reply(async url=>url==='/hpc/check'?{status:'ok',checks:[]}:{status:'ok',selected:{}});
 f.snapshot({phase:'needs-install',message:'',config});await settle();await settle();
 const panel=f.w.document.getElementById('workflow');panel.open=false;const before=f.calls.filter(u=>u==='/hpc/check').length;
 f.w.dispatchEvent(new f.w.CustomEvent('panel-request',{detail:{panel:'workflow',visible:true,refresh:true}}));
 assert.equal(panel.open,true);await new Promise(resolve=>setTimeout(resolve,3100));await settle();
 assert.ok(f.calls.filter(u=>u==='/hpc/check').length>before);f.dom.window.close();
});
test('a verification failure stays visible beside the per-item results',async()=>{
 const f=fixture();f.reply(async()=>({status:'ok',checks:[{item:'container',status:'ok',detail:'6 GB'}]}));
 f.snapshot({phase:'error',message:'runtime-verification failed',config});await settle();await settle();
 assert.match(f.text('workflow-message'),/runtime-verification failed/);assert.match(f.w.document.body.textContent,/6 GB/);f.dom.window.close();
});
test('reference rows offer the file window, and only its own route carries the chosen path',async()=>{
 const f=fixture();const opened=[];f.w.addEventListener('open-remote-files',event=>opened.push(event.detail));
 f.reply(async url=>url==='/hpc/files/selected'?{status:'ok',selected:{gtf:'/dfs7/lab/refs/g.gtf'}}:url==='/hpc/files/clear'?{status:'ok'}:{status:'ok',checks:[{item:'reference_gtf',status:'ok',detail:'Selected file (1.0 GB)'},{item:'reference_ref',status:'missing',detail:'Missing'}]});
 f.snapshot({phase:'needs-install',message:'',config});await settle();await settle();await settle();
 assert.match(f.w.document.body.textContent,/\/dfs7\/lab\/refs\/g\.gtf/);
 const gtf=[...f.w.document.querySelectorAll('[data-status=ok] button')];assert.deepEqual(gtf.map(b=>b.textContent),['選擇 HPC 檔案','改用預設']);
 const ref=[...f.w.document.querySelectorAll('[data-status=missing] button')];assert.deepEqual(ref.map(b=>b.textContent),['下載','選擇 HPC 檔案']);
 gtf[0].click();assert.equal(opened[0].key,'gtf');assert.equal(opened[0].current,'/dfs7/lab/refs/g.gtf');
 gtf[1].click();await settle();assert.equal(f.calls.includes('/hpc/files/clear'),false,'cancelling keeps the selection');
 f.allow();[...f.w.document.querySelectorAll('[data-status=ok] button')][1].click();await settle();assert.ok(f.calls.includes('/hpc/files/clear'));
 f.dom.window.close();
});
test('a chosen file refreshes the panel, and disconnecting forgets its path',async()=>{
 const f=fixture();f.reply(async url=>url==='/hpc/files/selected'?{status:'ok',selected:{gtf:'/dfs7/lab/g.gtf'}}:{status:'ok',checks:[]});
 f.snapshot({phase:'needs-install',message:'',config});await settle();await settle();await settle();
 const before=f.calls.length;f.w.dispatchEvent(new f.w.Event('remote-file-selected'));await settle();assert.ok(f.calls.length>before);await settle();await settle();
 f.snapshot({phase:'disconnected',message:'SSH disconnected'});await settle();
 assert.doesNotMatch(f.w.document.body.textContent,/\/dfs7/);f.dom.window.close();
});

const READY_CHECKS={status:'ok',ready:true,checks:[{item:'signet_source',status:'ok',detail:'Installed'}]};
test('the next step appears only when every item and the desktop check are ready',async()=>{
 const f=fixture({stage2:true});f.reply(async url=>url==='/hpc/check'?{status:'ok',ready:false,checks:[{item:'reference_gtf',status:'missing',detail:'Missing'}]}:url.startsWith('/signet/progress')?{analyses:[]}:{status:'ok',selected:{}});
 const next=f.w.document.getElementById('workflow-next'),stage=f.w.document.getElementById('workflow-preprocess-stage');
 f.snapshot({phase:'ready',message:'',config});for(let i=0;i<4;i++)await settle();
 assert.equal(next.hidden,true,'a missing item keeps the next step hidden');assert.ok(stage.classList.contains('locked'));
 f.reply(async url=>url==='/hpc/check'?READY_CHECKS:url.startsWith('/signet/progress')?{analyses:[]}:{status:'ok',selected:{}});
 f.snapshot({phase:'needs-install',message:'',config});for(let i=0;i<4;i++)await settle();
 assert.equal(next.hidden,true,'the desktop environment must be verified too');
 f.snapshot({phase:'ready',message:'',config});for(let i=0;i<4;i++)await settle();
 assert.equal(next.hidden,false);assert.equal(stage.classList.contains('locked'),false);
 f.w.document.getElementById('workflow-next-button').click();for(let i=0;i<4;i++)await settle();
 assert.equal(f.w.document.getElementById('workflow-environment').open,false);
 assert.equal(f.w.document.getElementById('workflow-preprocess').open,true);
 assert.ok(f.calls.some(url=>url.startsWith('/signet/progress?session=12345678')),'opening stage 2 reads this conversation');
 assert.equal(f.w.document.querySelectorAll('[data-mode]').length,2);
 await new Promise(resolve=>setTimeout(resolve,20));for(let i=0;i<4;i++)await settle();  // let the toggle event's reload finish
 f.dom.window.close();
});
test('stage 2 shows -g, -t and -a, links to the chat card, and starts an analysis only through a card',async()=>{
 const f=fixture({stage2:true});
 const analysis={run_id:'tcga-20261116-101500',session:'12345678-1234-1234-1234-123456789abc',completed_steps:1,total_steps:6,
  steps:[{step:'genotype',flag:'-g',phase:'completed'},{step:'expression',flag:'-t',phase:'running',progress:{expression_outputs:'1 2'}},{step:'adjust',flag:'-a',phase:'not_started'},
   {step:'cis',flag:'-c',phase:'not_started'},{step:'network',flag:'-n',phase:'not_started'},{step:'visualize',flag:'-v',phase:'not_started'}]};
 let analyses=[];
 f.reply(async url=>url==='/hpc/check'?READY_CHECKS:url.startsWith('/signet/progress')?{analyses}:url==='/signet/analyses'?(analyses=[analysis],{run_id:analysis.run_id,proposal:{state:'pending'}}):{status:'ok',selected:{}});
 f.snapshot({phase:'ready',message:'',config});for(let i=0;i<4;i++)await settle();
 f.w.document.getElementById('workflow-preprocess').open=true;f.w.document.getElementById('workflow-preprocess').dispatchEvent(new f.w.Event('toggle'));for(let i=0;i<4;i++)await settle();
 assert.match(f.w.document.getElementById('workflow-preprocess-body').textContent,/尚未開始分析/);
 const started=[];f.w.addEventListener('analysis-started',()=>started.push(true));
 const example=f.w.document.querySelector('[data-mode=example]');
 example.click();for(let i=0;i<4;i++)await settle();
 assert.equal(f.bodies.some(([url])=>url==='/signet/analyses'),false,'cancelling the confirmation starts nothing');
 f.allow();f.w.document.querySelector('[data-mode=example]').click();for(let i=0;i<6;i++)await settle();
 assert.deepEqual(f.bodies.find(([url])=>url==='/signet/analyses')[1],{session:'12345678-1234-1234-1234-123456789abc',mode:'example'});
 assert.equal(started.length,1,'the chat shows the new card at once');
 const rows=[...f.w.document.querySelectorAll('#workflow-preprocess-body .workflow-item')].map(row=>[row.dataset.step,row.dataset.status]);
 assert.deepEqual(rows,[['genotype','ok'],['expression','in_progress'],['adjust','unknown']]);
 assert.match(f.w.document.getElementById('workflow-preprocess-body').textContent,/1\/2/);
 assert.equal(f.w.document.getElementById('workflow-preprocess-status').textContent,'1/3');
 assert.equal(f.w.document.querySelectorAll('#workflow-preprocess-body [data-mode]').length,0,'one conversation, one analysis');
 const newChat=[...f.w.document.querySelectorAll('#workflow-preprocess-body button')].find(b=>b.textContent==='開新對話來跑新分析');
 assert.ok(newChat,'a new analysis is offered in a new conversation');
 let opened=0;const chatButton=f.w.document.createElement('button');chatButton.id='new-chat';chatButton.addEventListener('click',()=>opened++);
 f.w.document.body.append(chatButton);newChat.click();assert.equal(opened,1,'it opens a new conversation');
 // Stage 3 lists the other three steps, so the two stages match the chat's six-step card.
 const results=f.w.document.getElementById('workflow-results');results.open=true;results.dispatchEvent(new f.w.Event('toggle'));for(let i=0;i<4;i++)await settle();
 assert.deepEqual([...f.w.document.querySelectorAll('#workflow-results-body .workflow-item')].map(row=>row.dataset.step),['cis','network','visualize']);
 assert.equal(f.w.document.getElementById('workflow-results-status').textContent,'0/3');
 const card=f.w.document.createElement('details');card.className='analysis-progress-card';card.dataset.runId=analysis.run_id;f.w.document.getElementById('messages').append(card);
 [...f.w.document.querySelectorAll('#workflow-preprocess-body button')].find(b=>b.textContent==='到聊天中的卡片').click();
 assert.equal(card.open,true,'the button opens the analysis card in the chat');
 assert.equal(f.calls.some(url=>/\/steps\//.test(url)),false,'the panel never submits or polls a step itself');
 await new Promise(resolve=>setTimeout(resolve,1600));for(let i=0;i<4;i++)await settle();  // let the delayed jump to the card finish
 f.dom.window.close();
});
