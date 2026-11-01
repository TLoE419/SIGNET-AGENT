'use strict';
// Native lifecycle test; only Google's key verification is replaced with a local fixture.
const assert=require('node:assert/strict');
const {mkdtempSync,writeFileSync,readFileSync,rmSync}=require('node:fs');
const os=require('node:os');const path=require('node:path');const {app}=require('electron');
const {launch}=require('../main/app/main.cjs');
const temporary=mkdtempSync(path.join(os.tmpdir(),'signet-model-switch-'));
const stateFile=path.join(temporary,'chat.json'),id='12345678-0000-0000-0000-000000000000';
writeFileSync(stateFile,JSON.stringify({token:require('node:crypto').randomBytes(32).toString('hex'),histories:{[id]:[{role:'user',parts:[{text:'Retained model-switch conversation'}]}]},events:{[id]:[['Retained event']]}}));
const networkFetch=global.fetch;let verifications=0;
global.fetch=(url,options)=>{if(String(url).startsWith('https://generativelanguage.googleapis.com/')){verifications++;return Promise.resolve(new Response('{}',{status:200}))}return networkFetch(url,options)};
let running;const deadline=setTimeout(()=>{console.error('Model switch deadline exceeded');app.exit(1)},45000);
async function until(predicate){for(let i=0;i<200;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,100))}throw Error('Model switch did not settle')}
app.on('will-quit',()=>{clearTimeout(deadline);rmSync(temporary,{recursive:true,force:true})});
launch({provider:'codex',visible:true,userData:temporary,stateFile}).then(async value=>{
 running=value;const w=value.window;
 async function workflowCheck(){
  const result=await w.webContents.executeJavaScript(`fetch('/hpc/check',{method:'POST',body:'{}',headers:{'Content-Type':'application/json','X-Chat-Token':document.querySelector('meta[name="chat-token"]').content}}).then(async r=>({status:r.status,body:await r.json()}))`);
  assert.equal(result.status,200);assert.equal(result.body.status,'unavailable');assert.match(result.body.reason,/Prepare.*environment/);
 }
 const modelFits=await w.webContents.executeJavaScript(`(()=>{const card=document.querySelector('.model-status-block').getBoundingClientRect();const led=document.querySelector('.model-status-block .ssh-indicator').getBoundingClientRect();return led.right<=card.right&&led.left>=card.left})()`);
 assert.equal(modelFits,true,'model indicator remains inside its card');
 await workflowCheck();
 const initial=w.webContents.getURL();
 const save=await w.webContents.executeJavaScript(`window.signetDesktop.model.saveGeminiKey('AIza'+'x'.repeat(35))`);
 assert.equal(save.ok,true);
 await until(async()=>w.webContents.getURL()!==initial&&await w.webContents.executeJavaScript(`!!document.querySelector('#workflow') && document.querySelector('meta[name="model-label"]').content.toLowerCase().includes('gemini')`).catch(()=>false));
 await workflowCheck();
 const gemini=w.webContents.getURL();
 assert.equal(await w.webContents.executeJavaScript(`document.querySelectorAll('#chat-list .chat-link').length`),1);
 assert.equal((await w.webContents.executeJavaScript(`window.signetDesktop.environment.getSnapshot()`)).value.phase,'disconnected');
 assert.equal(verifications,1);
 const invalidChat=await w.webContents.executeJavaScript(`fetch('/chat',{method:'POST',body:'{}',headers:{'Content-Type':'application/json','X-Chat-Token':document.querySelector('meta[name="chat-token"]').content}}).then(r=>r.status)`);assert.equal(invalidChat,400);
 const clear=await w.webContents.executeJavaScript(`window.signetDesktop.model.clearGeminiKey()`);assert.equal(clear.ok,true);
 await until(async()=>w.webContents.getURL()!==gemini&&await w.webContents.executeJavaScript(`!!document.querySelector('#workflow') && document.querySelector('meta[name="model-label"]').content.toLowerCase().includes('codex')`).catch(()=>false));
 assert.equal(await w.webContents.executeJavaScript(`document.querySelectorAll('#chat-list .chat-link').length`),1);
 assert.ok(JSON.parse(readFileSync(stateFile,'utf8')).histories[id]);
 console.log('PASS: native renderer reloads across Codex → Gemini → Codex; history, workflow and environment bridge survive. Google verification used a local fixture; no model requests were sent.');
 await running.quit();
}).catch(async error=>{console.error(error);if(running)await running.quit();app.exit(1)});
