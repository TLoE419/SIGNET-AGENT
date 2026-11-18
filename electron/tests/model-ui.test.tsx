import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost'});
for(const key of ['window','document','HTMLElement','HTMLDialogElement','Node','MutationObserver','Event','MouseEvent','KeyboardEvent'])Object.defineProperty(globalThis,key,{value:(dom.window as any)[key],configurable:true});
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false};
const require=createRequire(import.meta.url);
const {render,screen,fireEvent,waitFor,cleanup}=require('@testing-library/react') as typeof import('@testing-library/react');
import {WorkspaceModelSettings} from '../renderer/features/workspace/WorkspaceModelSettings';
import {GeminiKeyModal,ModelStatusBlock,ModelControls,type ModelStatus,type ModelBridge} from '../renderer/features/model/ModelControls';
afterEach(cleanup);
const codex:ModelStatus={provider:'codex',geminiConfigured:false,encryptionAvailable:true};

test('status block reports which model chat uses without exposing a key',()=>{
 const {rerender}=render(<ModelStatusBlock status={codex} onEdit={()=>{}}/>);
 assert.equal(screen.getByRole('region',{name:'Model connection'}).getAttribute('data-status'),'unconfigured');
 assert.ok(screen.getByText('Chat uses Codex CLI'));
 rerender(<ModelStatusBlock status={{...codex,provider:'gemini',geminiConfigured:true}} onEdit={()=>{}}/>);
 assert.equal(screen.getByRole('region',{name:'Model connection'}).getAttribute('data-status'),'connected');
 rerender(<ModelStatusBlock status={codex} restarting onEdit={()=>{}}/>);
 assert.ok(screen.getByText('Restarting the assistant…'));
});

test('saving clears the field, reports restart, and keeps errors in the dialog',async()=>{
 const saved:string[]=[];let reject=true;
 render(<GeminiKeyModal open status={codex} onClose={()=>{}} onClear={async()=>({restarting:false})} onSave={async key=>{saved.push(key);if(reject)throw Error('Google rejected this API key.');return {restarting:true}}}/>);
 const input=()=>screen.getByLabelText('Gemini API key') as HTMLInputElement;
 assert.equal(input().type,'password');assert.equal(screen.queryByRole('button',{name:'Remove key'}),null);
 fireEvent.change(input(),{target:{value:' AIza-test-key-123456789 '}});fireEvent.click(screen.getByRole('button',{name:'Save and use Gemini'}));
 await waitFor(()=>assert.ok(screen.getByRole('alert')));assert.equal(input().value,'');assert.deepEqual(saved,['AIza-test-key-123456789']);
 reject=false;fireEvent.change(input(),{target:{value:'AIza-test-key-123456789'}});fireEvent.click(screen.getByRole('button',{name:'Save and use Gemini'}));
 await waitFor(()=>assert.ok(screen.getByText(/Restarting the assistant with Gemini/)));
});

test('saved keys can be removed; unavailable encryption blocks saving',async()=>{
 let cleared=0;
 const {rerender}=render(<GeminiKeyModal open status={{...codex,geminiConfigured:true}} onClose={()=>{}} onSave={async()=>({restarting:true})} onClear={async()=>{cleared++;return {restarting:true}}}/>);
 fireEvent.click(screen.getByRole('button',{name:'Remove key'}));await waitFor(()=>assert.equal(cleared,1));
 rerender(<GeminiKeyModal open status={{...codex,encryptionAvailable:false}} onClose={()=>{}} onSave={async()=>({restarting:true})} onClear={async()=>({restarting:false})}/>);
 assert.ok(screen.getByText(/keychain encryption is unavailable/));
});

test('workspace Settings and toolbar event share secure key lifecycle and selected model',async()=>{
 let configured=false;
 const saved:string[]=[];
 const bridge:ModelBridge={
  getStatus:async()=>({ok:true,value:{...codex,geminiConfigured:configured}}),
  saveGeminiKey:async key=>{saved.push(key);configured=true;return {ok:true,value:{restarting:false}}},
  clearGeminiKey:async()=>{configured=false;return {ok:true,value:{restarting:false}}},
 };
 const workspace=document.createElement('section');workspace.lang='zh-Hant';
 const {unmount}=render(<WorkspaceModelSettings workspace={workspace} bridge={bridge} model="gemini-fixture-selected"/>);
 await waitFor(()=>assert.ok(screen.getByText('尚未儲存 Gemini 金鑰')));
 assert.ok(screen.getAllByText('gemini-fixture-selected').length);
 fireEvent.click(screen.getByRole('button',{name:'管理 Gemini 金鑰'}));
 assert.ok(screen.getByRole('dialog',{name:'聊天模型設定'}));
 fireEvent.change(screen.getByLabelText('Gemini 金鑰'),{target:{value:' fixture-secret-123456789 '}});
 fireEvent.click(screen.getByRole('button',{name:'儲存並使用 Gemini'}));
 await waitFor(()=>assert.ok(screen.getByText('Gemini 金鑰已安全儲存')));
 assert.deepEqual(saved,['fixture-secret-123456789']);
 assert.equal((screen.getByLabelText('Gemini 金鑰') as HTMLInputElement).value,'');
 assert.ok(!document.body.textContent?.includes(saved[0]));
 fireEvent(window,new Event('workspace-open-model-settings'));
 await waitFor(()=>assert.ok(screen.getByRole('dialog',{name:'聊天模型設定'})));
 assert.ok(screen.getByText('更換金鑰'));
 fireEvent.change(screen.getByLabelText('Gemini 金鑰'),{target:{value:'fixture-replacement-123456789'}});
 fireEvent.click(screen.getByRole('button',{name:'儲存並使用 Gemini'}));
 await waitFor(()=>assert.equal(saved.length,2));
 await waitFor(()=>assert.equal(document.querySelector('dialog')?.open,false));
 fireEvent(window,new Event('workspace-open-model-settings'));
 await waitFor(()=>assert.ok(screen.getByRole('button',{name:'移除金鑰'})));
 fireEvent.click(screen.getByRole('button',{name:'移除金鑰'}));
 await waitFor(()=>assert.ok(screen.getByText('尚未儲存 Gemini 金鑰')));
 workspace.lang='en';
 await waitFor(()=>assert.ok(screen.getByRole('button',{name:'Manage Gemini key'})));
 fireEvent(window,new Event('workspace-open-model-settings'));
 await waitFor(()=>assert.ok(screen.getByRole('dialog',{name:'Gemini API'})));
 fireEvent.change(screen.getByLabelText('Gemini API key'),{target:{value:'discarded-fixture-secret'}});
 fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
 await waitFor(()=>assert.equal((screen.getByLabelText('Gemini API key') as HTMLInputElement).value,''));
 unmount();
 fireEvent(window,new Event('workspace-open-model-settings'));
 assert.equal(document.querySelector('dialog'),null);
});

test('workspace reports IPC failure without claiming saved or leaking error payload',async()=>{
 const bridge:ModelBridge={getStatus:async()=>({ok:false,error:{code:'UNKNOWN',message:'private fixture'}}),saveGeminiKey:async()=>{throw Error('must not save')},clearGeminiKey:async()=>{throw Error('must not clear')}};
 render(<ModelControls bridge={bridge} workspace model="actual fixture"/>);
 await waitFor(()=>assert.ok(screen.getByText('Could not read model settings.')));
 fireEvent.click(screen.getByRole('button',{name:'Manage Gemini key'}));
 assert.equal((screen.getByRole('button',{name:'Save and use Gemini'}) as HTMLButtonElement).disabled,true);
 assert.ok(!document.body.textContent?.includes('private fixture'));
});
