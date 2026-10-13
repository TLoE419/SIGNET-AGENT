// Author software integration only: hidden owned Electron, scripted DOM/IPC; no native input claim.
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
const output=process.env.SIGNET_S2_TEST_OUTPUT;if(!output||!path.isAbsolute(output))throw Error('Owned output required');
const result={kind:'Hidden owned Electron, synthetic DOM/limited IPC, not native input or scientific acceptance',events:[],errors:[],pid:process.pid,sourceEntry:path.resolve(__dirname,'../main.cjs'),startedAt:new Date().toISOString()};
app.on('web-contents-created',(_e,w)=>w.on('console-message',(_e,level,message)=>{if(level>=2)result.errors.push(String(message).slice(0,500));}));
const {Service}=require('../service.cjs');let serviceInstance,holdStatus=false;
const oldConnect=Service.prototype.connect,oldCall=Service.prototype.call;
Service.prototype.connect=function(...a){serviceInstance=this;return oldConnect.apply(this,a);};
Service.prototype.call=async function(method,...a){const value=await oldCall.call(this,method,...a);if(method==='operationStatus'&&holdStatus)await new Promise(r=>setTimeout(r,120));return value;};
require('../main.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let done=false,activeWindow;
const deadline=setTimeout(()=>{result.timeout=true;fs.writeFileSync(output,JSON.stringify(result,null,2));app.exit(2);},30000);
(async()=>{
 try{
 let win;for(let i=0;i<100;i++){win=BrowserWindow.getAllWindows()[0];if(win?.webContents.getURL()==='signet://app/index.html')break;await wait(100);}if(!win)throw Error('Missing owned window');
 activeWindow=win;result.window={id:win.id,url:win.webContents.getURL(),visible:win.isVisible(),userData:app.getPath('userData'),appPath:app.getAppPath()};if(win.isVisible())throw Error('Window must be hidden');
 const js=async code=>win.webContents.executeJavaScript(code);
 async function until(predicate){for(let i=0;i<80;i++){if(await js(predicate))return;await wait(50);}throw Error('DOM state timeout: '+predicate);}
 const click=async id=>{await js(`(()=>{const el=document.querySelector('[data-node-id="${id}"]');if(!el)throw Error('Missing control ${id}');if(el.disabled)throw Error('Disabled control ${id}');el.click();})()`);};
 const snapshot=async label=>{result.events.push({label,state:await js('window.signetWorkspace.current()'),text:(await js('document.body.innerText')).slice(-6000)});};
 await until('window.signetWorkspace?.current().records===1 && !window.signetWorkspace.current().busy');await snapshot('formal-list');
 await click('formal:record:a-20261013T210000-0123456789ab');await until("window.signetWorkspace.current().page==='4:65' && !window.signetWorkspace.current().busy");
 await click('formal:s2-start');await until("window.signetWorkspace.current().operationStatus==='monitoring' && !window.signetWorkspace.current().busy");await snapshot('local-monitor-remote-unknown');
 holdStatus=true;await click('formal:s2-status');await js('window.signetReview.openIndex()');await wait(180);result.lateResponseState=await js('window.signetWorkspace.current()');if(result.lateResponseState.mode!=='review')throw Error('Late reply overwrote review mode');holdStatus=false;
 await js('window.signetWorkspace.open()');await until('window.signetWorkspace.current().records===1 && !window.signetWorkspace.current().busy');await click('formal:record:a-20261013T210000-0123456789ab');await until("window.signetWorkspace.current().page==='4:65' && !window.signetWorkspace.current().busy");
 
 await click('formal:s2-log');await until("window.signetWorkspace.current().page==='4:74' && !window.signetWorkspace.current().busy");await snapshot('bounded-redacted-log');
 await click('formal:s2-explain');await until("window.signetWorkspace.current().page==='4:67' && !window.signetWorkspace.current().busy");await snapshot('unavailable-explanation');
 await click('formal:s2-pca-open');await until("window.signetWorkspace.current().page==='4:39'");await snapshot('checkpoint-no-fake-curve');
 await click('6:7162');await until("window.signetWorkspace.current().page==='4:64' && !window.signetWorkspace.current().busy");await snapshot('missing-checkpoint-blocked');
 const liveOp=(await js('window.desktop.operationStatus({operationId:window.signetWorkspace.current().operationId})')).value;
 const checkpoint={schemaVersion:2,owner:liveOp.owner,analysisId:liveOp.analysisId,attemptId:liveOp.attemptId,planHash:'a'.repeat(64),checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),availablePCs:[1,2],batches:[{id:'b1',status:'failed'},{id:'b2',status:'succeeded'}],synthetic:true};
 fs.writeFileSync(path.join(process.env.SIGNET_REVIEW_PROJECT_ROOT,'s2/checkpoints',liveOp.analysisId+'.json'),JSON.stringify(checkpoint));
 await click('formal:s2-pca-open');await until('window.signetWorkspace.current().availablePCs?.length===2 && !window.signetWorkspace.current().busy');
 await js(`(()=>{const el=document.querySelector('[data-node-id="6:7149"] input,[data-node-id="6:7149"] select');el.value='2';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await click('6:7162');await until("window.signetWorkspace.current().planStatus==='confirmation_required' && !window.signetWorkspace.current().busy");await snapshot('PCA-owned-checkpoint-confirmation');
 await click('6:11620');await until("window.signetWorkspace.current().planStatus==='not_ready' && !window.signetWorkspace.current().busy");await snapshot('PCA-no-scientific-continuation');
 await click('formal:s2-retry-open');await until("window.signetWorkspace.current().failedBatches?.length===1 && !window.signetWorkspace.current().busy");
 await click('formal:s2-batch:b1');await click('6:3243');await until("window.signetWorkspace.current().planStatus==='confirmation_required' && !window.signetWorkspace.current().busy");await snapshot('retry-failed-only-confirmation');
 await click('formal:s2-retry');await until("window.signetWorkspace.current().planStatus==='not_ready' && !window.signetWorkspace.current().busy");await snapshot('retry-no-scientific-continuation');
 
 await click('formal:s2-stop-open');await until("window.signetWorkspace.current().page==='4:69'");await click('6:12436');await snapshot('keep-running-no-cancel');
 await click('formal:s2-stop-open');await until("window.signetWorkspace.current().page==='4:69'");await click('6:12442');await until("window.signetWorkspace.current().operationStatus==='cancelled' && !window.signetWorkspace.current().busy");await snapshot('confirmed-local-monitor-released');
 const op=await js('window.signetWorkspace.current().operationId');
 await js('window.signetReview.openIndex()');await wait(100);const blocked=await js(`window.desktop.operationStart({requestId:'review-should-not-write',analysisId:'a-20261013T210000-0123456789ab',kind:'monitor'})`);result.reviewBlocked=blocked;if(blocked.ok)throw Error('Review allowed side effect');
 await js('window.signetWorkspace.open()');await until("window.signetWorkspace.current().mode==='formal' && !window.signetWorkspace.current().busy");await click('5:1178');await until("window.signetWorkspace.current().page==='4:27' && !window.signetWorkspace.current().busy");await snapshot('recovery-owned-only');
 const newOp=(await js("window.desktop.operationStart({requestId:'ui-recovery-second',analysisId:'a-20261013T210000-0123456789ab',kind:'monitor'})")).value;
 await serviceInstance.stopOwned();await js('window.desktop.reconnect()');await js('window.signetWorkspace.open()');await until("window.signetWorkspace.current().page==='4:2' && !window.signetWorkspace.current().busy");await click('5:1178');await until("window.signetWorkspace.current().page==='4:27' && !window.signetWorkspace.current().busy");
 result.recoveryControlInteractive=await js(`(()=>{const el=document.querySelector('[data-node-id="formal:s2-select:${newOp.operationId}"]');return !!el&&!el.closest('[inert]')&&!!el.closest('[role="dialog"]');})()`);if(!result.recoveryControlInteractive)throw Error('Recovery selection is inert/background');
 await click('formal:s2-select:'+newOp.operationId);await click('6:4539');await until("window.signetWorkspace.current().operationStatus==='monitoring' && !window.signetWorkspace.current().busy");await snapshot('recovery-attach-only-after-controller-restart');
 
 result.finalOperation=await js(`window.desktop.operationStatus({operationId:'${op}'})`);
 await serviceInstance.stopOwned();result.controllerStoppedBeforeClose=true;
 result.keepClose=await js("window.desktop.closeConfirm({decision:'keep-running'})");if(result.keepClose.value.shouldClose)throw Error('Keep closes');
 result.passed=true;result.endedAt=new Date().toISOString();fs.writeFileSync(output,JSON.stringify(result,null,2));done=true;clearTimeout(deadline);
 await js("window.desktop.closeConfirm({decision:'close-anyway'})").catch(()=>{});
 }catch(e){if(activeWindow&&!activeWindow.isDestroyed()){try{result.failureState=await activeWindow.webContents.executeJavaScript('({state:window.signetWorkspace?.current(),text:document.body.innerText,record:document.querySelector("[data-record-id]")?.outerHTML})');}catch{}}result.failure={name:e.name,message:e.message};result.endedAt=new Date().toISOString();fs.writeFileSync(output,JSON.stringify(result,null,2));clearTimeout(deadline);app.exit(1);}
})();
