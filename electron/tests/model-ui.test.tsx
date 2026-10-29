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
import {GeminiKeyModal,ModelStatusBlock,type ModelStatus} from '../src/model/ModelControls';
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
