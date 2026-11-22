import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';

const dom=new JSDOM('<!doctype html><html><head><meta name="chat-token" content="test-token"></head><body></body></html>',{url:'http://localhost'});
for(const key of ['window','document','HTMLElement','HTMLDialogElement','Node','MutationObserver','Event','CustomEvent','MouseEvent','KeyboardEvent'])Object.defineProperty(globalThis,key,{value:(dom.window as any)[key],configurable:true});
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true};
dom.window.HTMLDialogElement.prototype.close=function(){this.open=false};
const require=createRequire(import.meta.url);
const {render,fireEvent,waitFor,cleanup,act}=require('@testing-library/react') as typeof import('@testing-library/react');
import {RemoteFilesModal,RemoteFilesHost} from '../renderer/features/remote-files/RemoteFilesModal';

const originalFetch=globalThis.fetch;
afterEach(()=>{cleanup();globalThis.fetch=originalFetch});
const target={key:'genotype',inputKind:'genotype' as const,label:'Genotype',current:'example.ped',currentPaths:['example.ped','example.map'],datasetId:'dataset-a',multiple:true,language:'en'};
const record=(id='dataset-a',paths=['/canonical/study.ped','/canonical/study.map'])=>({id,name:['A','A'],folder:'',inputs:{genotype:paths,expression:[],clinical:[]},default_inputs:{genotype:[],expression:[],clinical:[]},alternative_inputs:{},selections:{}});
const entry=(name:string,folder='/pub/u',kind='file')=>({name,path:`${folder}/${name}`,kind,size:2048,supported:!name.includes(' ')});
const calls:Array<{url:string;body:any;method:string}>=[];
function serve(overrides:Record<string,(body:any)=>any>={}){
 calls.length=0;
 globalThis.fetch=(async(url:any,init:any)=>{
  const body=JSON.parse(init.body||'{}');calls.push({url:String(url),body,method:init.method});
  assert.equal(init.headers['X-Chat-Token'],'test-token');
  let value;
  if(overrides[url])value=await overrides[url](body);
  else if(url==='/hpc/files/shortcuts')value={status:'ok',shortcuts:[{label:'Home',path:'/home/u'},{label:'Personal (/pub)',path:'/pub/u'}]};
  else if(url==='/hpc/files/list')value={status:'ok',kind:'folder',path:body.path,entries:body.path==='/pub/u'?[entry('study.ped'),entry('bad name.tsv'),entry('other','/pub/u','folder')]:[entry('study.map',body.path)]};
  else if(url==='/hpc/files/inspect')value={status:'ok',read_only:true,files:body.paths.map((path:string)=>({path:path.replace('/pub/u','/canonical'),size:2048}))};
  else if(url==='/signet/datasets/dataset-a')value=record('dataset-a',body.inputs.genotype);
  else throw Error(`Unexpected route: ${url}`);
  return {ok:!value.httpError,json:async()=>value};
 }) as typeof fetch;
}
const query=(selector:string)=>document.querySelector(selector) as HTMLElement;
async function ready(){await waitFor(()=>assert.equal(!!query('[data-remote-entry-path="/pub/u/study.ped"]'),true))}
function click(selector:string){const element=query(selector);assert.ok(element,selector);fireEvent.click(element)}

test('dataset browser combines files across folders and saves only inspected canonical paths',async()=>{
 serve();let saved:any;
 render(<RemoteFilesModal target={target} connected connectionIdentity="account-a" onClose={()=>{}} onSelected={value=>saved=value}/>);
 await ready();assert.equal(document.querySelectorAll('[data-remote-selected-path]').length,0,'relative defaults are not remote selections');
 assert.equal((query('[data-remote-entry-path="/pub/u/bad name.tsv"]') as HTMLButtonElement).disabled,true);
 assert.equal(query('[data-remote-size]')?.textContent,'2.0 KB');
 click('[data-remote-entry-path="/pub/u/study.ped"]');click('[data-remote-entry-path="/pub/u/other"]');
 await waitFor(()=>assert.equal(!!query('[data-remote-entry-path="/pub/u/other/study.map"]'),true));
 click('[data-remote-entry-path="/pub/u/other/study.map"]');assert.equal(document.querySelectorAll('[data-remote-selected-path]').length,2);
 click('[data-remote-apply]');await waitFor(()=>assert.equal(saved?.id,'dataset-a'));
 const inspect=calls.find(call=>call.url==='/hpc/files/inspect')!;
 assert.deepEqual(inspect.body,{paths:['/pub/u/study.ped','/pub/u/other/study.map']});
 const patch=calls.find(call=>call.method==='PATCH')!;
 assert.equal(patch.url,'/signet/datasets/dataset-a');
 assert.deepEqual(patch.body,{inputs:{genotype:['/canonical/study.ped','/canonical/other/study.map']}});
 assert.equal(calls.some(call=>call.url==='/hpc/files/select'),false);
});

test('inspection and persistence errors retain the basket and do not report success',async()=>{
 let invalid=true,saves=0,selected=0;
 serve({'/hpc/files/inspect':body=>invalid?{status:'invalid',error:'The file is empty.'}:{status:'ok',files:body.paths.map((path:string)=>({path,size:2048}))},
 '/signet/datasets/dataset-a':()=>{saves++;return {httpError:true,error:'Storage unavailable'}}});
 render(<RemoteFilesModal target={target} onClose={()=>{}} onSelected={()=>selected++}/>);
 await ready();click('[data-remote-entry-path="/pub/u/study.ped"]');click('[data-remote-apply]');
 await waitFor(()=>assert.equal(query('[data-remote-error]')?.textContent?.includes('empty'),true));assert.equal(saves,0);
 invalid=false;click('[data-remote-apply]');
 await waitFor(()=>assert.equal(query('[data-remote-error]')?.textContent?.includes('Storage unavailable'),true));
 assert.equal(saves,1);assert.equal(selected,0);assert.equal(document.querySelectorAll('[data-remote-selected-path]').length,1);
});

test('disconnecting during inspection ignores completion and never saves the selection',async()=>{
 let release!:(value:any)=>void;
 serve({'/hpc/files/inspect':()=>new Promise(resolve=>release=resolve)});
 const props={target,onClose:()=>{},onSelected:()=>assert.fail('stale success')};
 const view=render(<RemoteFilesModal {...props} connected connectionIdentity="account-a"/>);
 await ready();click('[data-remote-entry-path="/pub/u/study.ped"]');click('[data-remote-apply]');
 await waitFor(()=>assert.equal(typeof release,'function'));
 view.rerender(<RemoteFilesModal {...props} connected={false} connectionIdentity="account-a"/>);
 await act(async()=>release({status:'ok',files:[{path:'/canonical/study.ped',size:2048}]}));
 assert.equal(calls.some(call=>call.method==='PATCH'),false);
 assert.equal((query('[data-remote-apply]') as HTMLButtonElement).disabled,true);
});

test('host closes an abandoned dataset target before a delayed inspection can save it',async()=>{
 let release!:(value:any)=>void,event:any;
 serve({'/hpc/files/inspect':()=>new Promise(resolve=>release=resolve)});
 render(<RemoteFilesHost connected connectionIdentity="account-a"/>);
 const listener=(value:Event)=>event=(value as CustomEvent).detail;
 window.addEventListener('dataset-files-selected',listener);
 try{
  await act(async()=>window.dispatchEvent(new CustomEvent('open-remote-files',{detail:target})));
  await ready();click('[data-remote-entry-path="/pub/u/study.ped"]');click('[data-remote-apply]');
  await waitFor(()=>assert.equal(typeof release,'function'));
  await act(async()=>{
   window.dispatchEvent(new Event('close-dataset-remote-files'));
   release({status:'ok',files:[{path:'/canonical/study.ped',size:2048}]});
   await Promise.resolve();
  });
  assert.equal(document.querySelector('dialog'),null);assert.equal(event,undefined);
  assert.equal(calls.some(call=>call.method==='PATCH'),false);
 }finally{window.removeEventListener('dataset-files-selected',listener)}
});

test('offline browser makes no remote request; cancelling a single-file selection does not save',async()=>{
 serve();let closed=0;
 const single={...target,key:'clinical',inputKind:'clinical' as const,label:'Clinical',multiple:false};
 const props={target:single,onClose:()=>closed++,onSelected:()=>assert.fail('cancelled selection')};
 const view=render(<RemoteFilesModal {...props} connected={false} connectionIdentity="account-a"/>);
 assert.equal(calls.length,0);assert.equal((query('[data-remote-apply]') as HTMLButtonElement).disabled,true);
 view.rerender(<RemoteFilesModal {...props} connected connectionIdentity="account-a"/>);
 await ready();click('[data-remote-entry-path="/pub/u/study.ped"]');
 click('[data-remote-entry-path="/pub/u/other"]');await waitFor(()=>assert.equal(!!query('[data-remote-entry-path="/pub/u/other/study.map"]'),true));
 click('[data-remote-entry-path="/pub/u/other/study.map"]');assert.equal(document.querySelectorAll('[data-remote-selected-path]').length,1);
 click('[data-remote-cancel]');assert.equal(closed,1);
 assert.equal(calls.some(call=>call.url==='/hpc/files/inspect'||call.method==='PATCH'),false);
});

test('switching remote accounts rejects an old listing even when its request ignores cancellation',async()=>{
 let release!:(value:any)=>void;
 serve({'/hpc/files/list':body=>body.path==='/pub/u'?new Promise(resolve=>release=resolve):{status:'ok',kind:'folder',path:body.path,entries:[entry('fresh.tsv',body.path)]}});
 const props={target,onClose:()=>{},onSelected:()=>assert.fail('no selection submitted')};
 const view=render(<RemoteFilesModal {...props} connected connectionIdentity="account-a"/>);
 await waitFor(()=>assert.equal(typeof release,'function'));
 const old=release;
 serve({'/hpc/files/list':body=>({status:'ok',kind:'folder',path:body.path,entries:[entry('fresh.tsv',body.path)]})});
 view.rerender(<RemoteFilesModal {...props} connected connectionIdentity="account-b"/>);
 await waitFor(()=>assert.equal(!!query('[data-remote-entry-path="/pub/u/fresh.tsv"]'),true));
 await act(async()=>old({status:'ok',kind:'folder',path:'/old-account',entries:[entry('private.tsv','/old-account')]}));
 assert.equal(query('[data-remote-entry-path="/old-account/private.tsv"]'),null);
 assert.equal(!!query('[data-remote-entry-path="/pub/u/fresh.tsv"]'),true);
 assert.equal(calls.some(call=>call.method==='PATCH'),false);
});

test('once persistence starts, dismissal waits for its outcome instead of pretending to undo it',async()=>{
 let release!:(value:any)=>void,closed=0,saved:any;
 serve({'/signet/datasets/dataset-a':()=>new Promise(resolve=>release=resolve)});
 render(<RemoteFilesModal target={target} onClose={()=>closed++} onSelected={value=>saved=value}/>);
 await ready();click('[data-remote-entry-path="/pub/u/study.ped"]');click('[data-remote-apply]');
 await waitFor(()=>assert.equal(typeof release,'function'));
 assert.equal((query('[data-remote-cancel]') as HTMLButtonElement).disabled,true);
 assert.equal((query('.ssh-modal-close') as HTMLButtonElement).disabled,true);
 click('[data-remote-cancel]');fireEvent(query('dialog'),new dom.window.Event('cancel',{bubbles:false,cancelable:true}));
 assert.equal(closed,0);
 await act(async()=>release(record('dataset-a',['/canonical/study.ped'])));
 assert.equal(saved?.id,'dataset-a');assert.equal(closed,0);
});

test('the file dialog and inspection errors escape a hidden Settings host',async()=>{
 serve({'/hpc/files/inspect':()=>({status:'invalid',error:'The selected file is empty.'})});
 render(<div hidden data-hidden-settings><RemoteFilesHost connected connectionIdentity="account-a"/></div>);
 act(()=>window.dispatchEvent(new CustomEvent('open-remote-files',{detail:target})));
 await ready();
 const dialog=query('dialog.remote-files-modal');
 assert.equal(dialog.parentElement,document.body);
 assert.equal(dialog.closest('[hidden]'),null);
 assert.equal(query('[data-hidden-settings]').contains(dialog),false);
 click('[data-remote-entry-path="/pub/u/study.ped"]');click('[data-remote-apply]');
 await waitFor(()=>assert.equal(query('[data-remote-error]')?.textContent,'The selected file is empty.'));
 assert.equal(query('[data-remote-error]').closest('[hidden]'),null);
 assert.equal(dialog.contains(query('[data-remote-error]')),true);
});
