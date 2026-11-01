'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');const {readFileSync}=require('node:fs');const path=require('node:path');
function fixture(){
 const dom=new JSDOM('<meta name="chat-token" content="fixture"><details id="workflow"><summary id="workflow-summary"></summary><span id="workflow-environment-status"></span><button id="workflow-check"></button><ul id="workflow-items"></ul><p id="workflow-message"></p></details>',{runScripts:'outside-only'});
 const w=dom.window;let listener;const calls=[];let reply=async()=>({status:'ok',checks:[]});
 w.uiText=(el,text)=>{el.textContent=text};w.translateUI=text=>text;w.confirm=()=>false;
 w.signetDesktop={environment:{subscribe:fn=>{listener=fn;return()=>{}}}};
 w.fetch=async url=>{calls.push(url);return {ok:true,json:()=>reply(url)}};
 w.eval(readFileSync(path.join(__dirname,'../renderer/workflow.js'),'utf8'));
 return {dom,w,calls,snapshot:value=>listener(value),reply:fn=>{reply=fn}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('workflow discards an in-flight readiness reply when SSH disconnects',async()=>{
 const f=fixture();let resolve;f.reply(()=>new Promise(r=>{resolve=r}));
 f.w.document.getElementById('workflow-check').click();await settle();
 f.snapshot({phase:'disconnected',message:'SSH disconnected'});
 resolve({status:'ok',ready:true,checks:[{item:'connection',status:'ok',detail:'stale account'}]});await settle();
 assert.doesNotMatch(f.w.document.body.textContent,/stale account/);
 assert.match(f.w.document.getElementById('workflow-message').textContent,/SSH disconnected/);
 f.dom.window.close();
});
test('reference download cancellation does not send a write request',async()=>{
 const f=fixture();f.reply(async()=>({status:'ok',checks:[{item:'reference_ref',status:'missing',detail:'Not installed'}]}));
 f.w.document.getElementById('workflow-check').click();await settle();
 const button=f.w.document.querySelector('[data-status=missing] button');assert.ok(button);button.click();await settle();
 assert.deepEqual(f.calls,['/hpc/check']);f.dom.window.close();
});
