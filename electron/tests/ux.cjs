'use strict';
// Real Chromium layout, keyboard and async focus regressions; isolated local state, no model or HPC calls.
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {app}=require('electron');
const {launch}=require('../main/app/main.cjs');
const temporary=mkdtempSync(path.join(os.tmpdir(),'signet-ux-'));
let running;
const deadline=setTimeout(()=>app.exit(1),45000);
app.on('will-quit',()=>{clearTimeout(deadline);rmSync(temporary,{recursive:true,force:true})});
(async()=>{
 running=await launch({visible:false,userData:path.join(temporary,'app'),stateFile:path.join(temporary,'state.json')});
 const {window}=running,web=window.webContents;
 const js=code=>web.executeJavaScript(code);
 await js(`new Promise((resolve,reject)=>{const deadline=Date.now()+10000;const check=()=>{if(document.querySelector('.model-status-block'))resolve();else if(Date.now()>deadline)reject(Error('UI did not mount'));else setTimeout(check,25)};check()})`);
 const toggleGeometry=await js(`(()=>{const toggle=document.querySelector('.ssh-toggle'),thumb=toggle.firstElementChild,b=toggle.getBoundingClientRect(),t=thumb.getBoundingClientRect();return {height:b.height,centerOffset:Math.abs((b.top+b.bottom-t.top-t.bottom)/2)}})()`);
 assert.equal(toggleGeometry.height,20,'global button sizing must not stretch the SSH switch');
 assert.ok(toggleGeometry.centerOffset<1,'SSH switch thumb must be vertically centered');
 await js(`(()=>{const saved=document.createElement('button');saved.className='chat-link';saved.textContent='Saved conversation';document.getElementById('chat-list').append(saved)})()`);
 for(const [width,height,zoom] of [[1320,900,1],[1000,700,1],[760,540,1],[1320,900,2]]){
  window.setSize(width,height);web.setZoomFactor(zoom);
  await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const result=await js(`(()=>{const visible=id=>{const el=document.getElementById(id),r=el.getBoundingClientRect();return !!el.getClientRects().length&&r.width>0&&r.height>0&&r.right<=innerWidth+1&&r.left>=0};return {overflow:document.documentElement.scrollWidth>innerWidth+1,newChat:visible('new-chat'),language:visible('language-toggle'),hiddenVisualization:!document.querySelector('#s6-open').getClientRects().length,history:getComputedStyle(document.getElementById('chat-list')).display!=='none',composer:visible('composer')}})()`);
  assert.deepEqual(result,{overflow:false,newChat:true,language:true,hiddenVisualization:true,history:true,composer:true},JSON.stringify({width,height,zoom,result}));
  // Expanded setup must not crush the composer or introduce two nested scrollers.
  const spacing=await js(`(()=>{const workflow=document.getElementById('workflow');workflow.open=true;const rect=id=>document.getElementById(id).getBoundingClientRect();const w=rect('workflow'),c=rect('composer'),m=rect('messages');return {aligned:Math.abs(w.left-c.left)<1&&Math.abs(w.right-c.right)<1,ordered:m.top>=w.bottom-1&&c.top>=m.bottom-1,composerIntact:c.height>=100,outerScroll:getComputedStyle(workflow).overflowY};})()`);
  assert.equal(spacing.aligned,true,'workflow and composer must share content insets');
  assert.equal(spacing.ordered,true,'expanded workflow, messages and composer must not overlap');
  assert.equal(spacing.composerIntact,true,'setup must not shrink the composer');
  assert.equal(spacing.outerScroll,'visible','only the stages list should scroll inside workflow');
  await js(`document.getElementById('workflow').open=false`);

 }
 web.setZoomFactor(1);window.setSize(1320,900);
 await js(`document.querySelector('.skip-link').focus()`);
 web.sendInputEvent({type:'keyDown',keyCode:'Return'});web.sendInputEvent({type:'keyUp',keyCode:'Return'});
 await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
 assert.equal(await js(`document.activeElement.id`),'prompt');
 // Real navigation must preserve drafts per conversation without leaking into a new chat.
 const originalURL=web.getURL(),originalSession=new URL(originalURL).searchParams.get('session');
 await js(`document.getElementById('prompt').value='Unsent usability test draft';document.getElementById('prompt').dispatchEvent(new Event('input'))`);
 let loaded=new Promise(resolve=>web.once('did-finish-load',resolve));
 await js(`document.getElementById('new-chat').click()`);await loaded;
 assert.equal(await js(`document.getElementById('prompt').value`),'');
 loaded=new Promise(resolve=>web.once('did-finish-load',resolve));
 await js(`document.querySelector('[data-session="${originalSession}"]').click()`);await loaded;
 assert.equal(await js(`document.getElementById('prompt').value`),'Unsent usability test draft');
 // Shared dialogs unmount on close; restore focus to their actual trigger.
 await js(`document.getElementById('workflow').open=true;const trigger=document.querySelector('#workflow-environment button');trigger.focus();trigger.click()`);
 await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
 assert.equal(await js(`!!document.querySelector('dialog[open]')`),true);
 web.sendInputEvent({type:'keyDown',keyCode:'Escape'});web.sendInputEvent({type:'keyUp',keyCode:'Escape'});
 await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
 assert.equal(await js(`document.activeElement===document.querySelector('#workflow-environment button')`),true);
 await js(`applyLanguage('zh-Hant')`);
 assert.equal(await js(`translateUI('第一行<br>第二行')`),'第一行\n第二行');
 // A response must not steal focus from a dialog the user opened while waiting.
 await js(`(()=>{const original=window.fetch;window.fetch=(url,options)=>url==='/chat'?Promise.resolve({ok:true,body:{getReader:()=>{let read=false;return {read:async()=>{if(read)return {done:true};read=true;await new Promise(resolve=>window.finishUXResponse=resolve);return {done:false,value:new TextEncoder().encode(JSON.stringify({type:'answer',text:'Controlled test answer'})+'\\n'+JSON.stringify({type:'done',text:'Done'})+'\\n')}}}}}}):original(url,options);window.pendingUX=send('Local UX test');})()`);
 await js(`document.querySelector('.model-status-block .ssh-identity').click()`);
 await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
 assert.equal(await js(`!!document.querySelector('dialog[open]')`),true);
 const actions=await js(`(()=>{const d=document.querySelector('dialog[open]'),f=d.querySelector('.ssh-dialog-actions'),last=f.lastElementChild,a=f.getBoundingClientRect(),b=last.getBoundingClientRect();return {aligned:Math.abs(a.right-b.right)<1,contained:d.scrollWidth<=d.clientWidth+1,gap:parseFloat(getComputedStyle(f).gap)}})()`);
 assert.equal(actions.aligned,true,'model actions align to the content edge');assert.equal(actions.contained,true);assert.ok(actions.gap>=8);
 await js(`document.querySelector('dialog[open] input').focus();window.finishUXResponse();window.pendingUX`);
 assert.equal(await js(`document.activeElement===document.querySelector('dialog[open] input')`),true,'chat completion must preserve dialog focus');
 web.sendInputEvent({type:'keyDown',keyCode:'Escape'});web.sendInputEvent({type:'keyUp',keyCode:'Escape'});
 await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
 assert.equal(await js(`!!document.querySelector('dialog[open]')`),false);
 console.log('PASS: real Electron responsive layouts, 200% zoom, skip link, draft navigation, Chinese line breaks, dialog focus restoration and async focus preservation');
 await running.backend.stop();app.exit(0);
})().catch(async error=>{console.error(error);await running?.backend.forceStop();app.exit(1)});
