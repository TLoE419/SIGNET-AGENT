import {SshConnectionService} from '../SshConnectionService';
import {profileInput,text,validPath,SshFailure,fail} from '../../../shared/ssh/validation';
import {validIdentity} from '../storage/stores';
import type {IpcMain,BrowserWindow,IpcMainInvokeEvent} from 'electron';
import type {PrivateKeySelection} from '../../../shared/ssh/types';
export function authorized(event:IpcMainInvokeEvent,win:BrowserWindow|null,origin='signet://app'){return !!win&&!win.isDestroyed()&&event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame&&!!event.senderFrame&&(origin==='signet://app'?event.senderFrame.url==='signet://app/index.html':new URL(event.senderFrame.url).origin===origin)}
export function installSshHandlers(ipc:IpcMain,getWindow:()=>BrowserWindow|null,service:SshConnectionService,pickPrivateKey:()=>Promise<PrivateKeySelection>,getOrigin:()=>string=()=> 'signet://app'){
 const operations:Record<string,(...args:any[])=>unknown>={
  cancelRegistration:()=>service.cancelRegistration(),initialize:()=>service.initialSnapshot(),getSnapshot:()=>service.getSnapshot(),listProfiles:()=>service.listProfiles(),
  saveProfile:input=>service.saveProfile(profileInput(input)),
  selectProfile:id=>service.selectProfile(id),inspectPrivateKey:p=>service.inspectPrivateKey(p),pickPrivateKey,
  connect:(id,passphrase)=>service.connect(id,passphrase),disconnect:id=>service.disconnect(id),healthCheck:force=>service.healthCheck(force),trustHost:i=>service.trustHost(i),
  updateKey:(id,input)=>service.updateKey(id,input),removeKey:id=>service.removeKey(id),
  listKeys:()=>service.listKeys(),generateKey:input=>service.generateKey(input),addExternalKey:input=>service.addExternalKey(input),registerGenerated:input=>service.registerGenerated(input),answerAuthChallenge:(sessionId,challengeId,answers)=>service.answerAuthChallenge(sessionId,challengeId,answers),
 };
 const arity:Record<string,number>={updateKey:2,removeKey:1,cancelRegistration:0,initialize:0,getSnapshot:0,listProfiles:0,saveProfile:1,selectProfile:1,inspectPrivateKey:1,pickPrivateKey:0,connect:2,disconnect:1,healthCheck:1,trustHost:1,listKeys:0,generateKey:1,addExternalKey:1,registerGenerated:1,answerAuthChallenge:3};
 for(const [name,fn] of Object.entries(operations))ipc.handle('ssh:'+name,async(event,...args)=>{
  if(!authorized(event,getWindow(),getOrigin()))return {ok:false,error:{code:'UNKNOWN',message:'Unauthorized SSH request.'}};
  try{
   if(args.length!==arity[name])fail('UNKNOWN','Invalid SSH request.');
   if(['connect','disconnect','selectProfile'].includes(name)&&(!text(args[0],80)||!/^[a-zA-Z0-9_-]+$/.test(args[0])))fail('INVALID_PROFILE','Invalid profile ID.');
   if(['updateKey','removeKey'].includes(name)&&!text(args[0],80))fail('KEY_NOT_FOUND','Invalid key ID.');
   if(name==='updateKey'&&(!args[1]||typeof args[1].label!=='string'||(args[1].username!==undefined&&typeof args[1].username!=='string')||Object.keys(args[1]).some(k=>!['label','username'].includes(k))))fail('INVALID_PROFILE','Invalid key update.');
   if(name==='inspectPrivateKey'&&!validPath(args[0]))fail('KEY_UNREADABLE','Use an absolute private-key path.');
   if(name==='connect'&&(typeof args[1]!=='string'||args[1].length>4096))fail('PASSPHRASE_REQUIRED','Enter a private-key passphrase.');
   if(name==='healthCheck'&&typeof args[0]!=='boolean')fail('UNKNOWN','Invalid health-check request.');
   if(name==='generateKey'&&(!args[0]||typeof args[0].label!=='string'||(args[0].username!==undefined&&typeof args[0].username!=='string')||typeof args[0].passphrase!=='string'||Object.keys(args[0]).some(k=>!['label','username','passphrase'].includes(k))))fail('KEY_INVALID','Invalid key-generation request.');
   if(name==='addExternalKey'&&(!args[0]||typeof args[0].label!=='string'||(args[0].username!==undefined&&typeof args[0].username!=='string')||!validPath(args[0].privateKeyPath)||Object.keys(args[0]).some(k=>!['label','username','privateKeyPath'].includes(k))))fail('KEY_INVALID','Invalid saved-key request.');
   if(name==='registerGenerated'&&(!args[0]||typeof args[0].keyId!=='string'||typeof args[0].passphrase!=='string'||typeof args[0].password!=='string'||!args[0].profile||Object.keys(args[0]).some(k=>!['profile','keyId','passphrase','password'].includes(k))))fail('AUTH_FAILED','Invalid registration request.');
   if(name==='answerAuthChallenge'&&(!text(args[0],80)||!text(args[1],80)||!Array.isArray(args[2])||args[2].some((answer:unknown)=>typeof answer!=='string'||answer.length>4096)))fail('AUTH_FAILED','Invalid authentication response.');
   if(name==='trustHost'&&!validIdentity(args[0]))fail('HOST_KEY_UNKNOWN','Invalid host identity.');
   return {ok:true,value:await fn(...args)};
  }catch(e){return {ok:false,error:e instanceof SshFailure?{code:e.code,message:e.message}:{code:'UNKNOWN',message:'SSH storage or operation failed. Existing configuration was preserved. Check configuration format and permissions.'}}}
 });
 const listener=(snapshot:unknown)=>{const win=getWindow();if(win&&!win.isDestroyed()&&(getOrigin()==='signet://app'?win.webContents.mainFrame.url==='signet://app/index.html':new URL(win.webContents.mainFrame.url).origin===getOrigin()))win.webContents.send('ssh:snapshot',snapshot)};
 const challengeListener=(challenge:unknown)=>{const win=getWindow();if(win&&!win.isDestroyed()&&(getOrigin()==='signet://app'?win.webContents.mainFrame.url==='signet://app/index.html':new URL(win.webContents.mainFrame.url).origin===getOrigin()))win.webContents.send('ssh:auth-challenge',challenge)};
 service.on('snapshot',listener);
 service.on('challenge',challengeListener);
 return ()=>{service.off('snapshot',listener);service.off('challenge',challengeListener);for(const name of Object.keys(operations))ipc.removeHandler('ssh:'+name)};
}
