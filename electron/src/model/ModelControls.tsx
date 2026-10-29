import {useEffect,useId,useRef,useState} from 'react';

export type Provider='codex'|'gemini'|'groq';
export interface ModelStatus {provider:Provider;geminiConfigured:boolean;encryptionAvailable:boolean}
type Result<T>={ok:true;value:T}|{ok:false;error:{code:string;message:string}};
export interface ModelBridge {
 getStatus():Promise<Result<ModelStatus>>;
 saveGeminiKey(key:string):Promise<Result<{restarting:boolean}>>;
 clearGeminiKey():Promise<Result<{restarting:boolean}>>;
}
async function unwrap<T>(pending:Promise<Result<T>>){const result=await pending;if(!result.ok)throw Object.assign(Error(result.error.message),{code:result.error.code});return result.value}

const providerNames:Record<Provider,string>={codex:'Codex CLI',gemini:'Gemini',groq:'Groq'};
type BlockStatus='unconfigured'|'disconnected'|'connected'|'connecting'|'error';
const labels:Record<BlockStatus,string>={unconfigured:'Not configured',disconnected:'Saved',connected:'Active',connecting:'Restarting…',error:'Error'};

/** Mirrors the SSH status block; the key itself never reaches the renderer. */
export function ModelStatusBlock({status,error,restarting,onEdit}:{status:ModelStatus|null;error?:string;restarting?:boolean;onEdit:()=>void}){
 const state:BlockStatus=restarting?'connecting':error?'error':!status?'unconfigured':status.provider==='gemini'?'connected':status.geminiConfigured?'disconnected':'unconfigured';
 const subtitle=state==='connecting'?'Restarting the assistant…':state==='error'?error:state==='connected'?(status!.geminiConfigured?'Chat uses Gemini · key in Keychain':'Chat uses Gemini · key from .env'):status?`Chat uses ${providerNames[status.provider]}`:'Checking model settings…';
 return <section className="ssh-status-block model-status-block" data-status={state} aria-label="Model connection" onClick={e=>{if(!(e.target as HTMLElement).closest('button'))onEdit()}}>
  <button type="button" className="ssh-identity" onClick={onEdit} aria-label="Edit Gemini API settings" title={`Gemini API\n${labels[state]}`}>
   <span className="ssh-status-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {state==='error'?<><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v4m0 3h.01"/></>:<><path d="M12 3c.6 4.6 3.4 7.4 8 8-4.6.6-7.4 3.4-8 8-.6-4.6-3.4-7.4-8-8 4.6-.6 7.4-3.4 8-8Z"/></>}
   </svg></span>
   <span className="ssh-status-copy"><span className="ssh-status-heading"><strong>Gemini API</strong><span className="ssh-protocol">LLM</span><span className="ssh-state-text">{labels[state]}</span></span><span className="ssh-status-subtitle">{subtitle}</span></span>
  </button>
  <span className="ssh-status-divider" aria-hidden="true"/>
  <span className="ssh-badge ssh-indicator"><span className="ssh-led" aria-hidden="true"/><span className="ssh-badge-label">{labels[state]}</span></span>
 </section>;
}

export function GeminiKeyModal({open,status,onSave,onClear,onClose}:{open:boolean;status:ModelStatus|null;onSave:(key:string)=>Promise<{restarting:boolean}>;onClear:()=>Promise<{restarting:boolean}>;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),id=useId(),lock=useRef(false);
 const [key,setKey]=useState(''),[working,setWorking]=useState<'saving'|'clearing'|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
 useEffect(()=>{setKey('');setError('');setNotice('');if(open)dialog.current?.showModal();else dialog.current?.close()},[open]);
 const close=()=>{if(working)return;setKey('');onClose()};
 async function run(kind:'saving'|'clearing'){
  if(lock.current)return;lock.current=true;setWorking(kind);setError('');setNotice('');const secret=key;setKey('');
  try{const result=kind==='saving'?await onSave(secret.trim()):await onClear();if(result.restarting)setNotice(kind==='saving'?'Key verified and saved. Restarting the assistant with Gemini…':'Key removed. Restarting the assistant without Gemini…');else onClose()}
  catch(e){setError((e as Error).message)}finally{lock.current=false;setWorking(null)}
 }
 const unavailable=status?.encryptionAvailable===false;
 return <dialog ref={dialog} className="ssh-modal model-key-modal" aria-labelledby={id} onCancel={e=>{e.preventDefault();close()}}><form onSubmit={e=>{e.preventDefault();void run('saving')}}>
  <button type="button" className="ssh-modal-close" aria-label="Close" title="Close" onClick={close}><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
  <h2 id={id}>Gemini API</h2>
  <p>Chat uses Google Gemini with your own API key. Create one in <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">Google AI Studio</a>.</p>
  <p className="model-key-note">The key is encrypted with your system keychain and is never shown again. Chat messages and tool results are sent to Google; on the free tier Google may use them to improve its products.</p>
  {status?.geminiConfigured&&<p role="status">A key is saved{status.provider==='gemini'?' and chat is using Gemini.':` but chat is using ${providerNames[status.provider]}.`}</p>}
  <fieldset disabled={!!working||unavailable}><legend>{status?.geminiConfigured?'Replace API key':'API key'}</legend>
   <label>Gemini API key<input aria-label="Gemini API key" type="password" autoComplete="off" spellCheck={false} required value={key} onChange={e=>setKey(e.target.value)}/></label>
  </fieldset>
  {unavailable&&<p role="alert">System keychain encryption is unavailable, so a key cannot be saved here.</p>}
  {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
  <footer>{status?.geminiConfigured&&<button type="button" className="ssh-danger" disabled={!!working} onClick={()=>void run('clearing')}>{working==='clearing'?'Removing…':'Remove key'}</button>}
   <button type="button" disabled={!!working} onClick={close}>Cancel</button>
   <button type="submit" className="ssh-primary" disabled={!!working||unavailable||!key.trim()}>{working==='saving'?'Verifying key…':'Save and use Gemini'}</button></footer>
 </form></dialog>;
}

export function ModelControls({bridge}:{bridge:ModelBridge}){
 const [status,setStatus]=useState<ModelStatus|null>(null),[error,setError]=useState(''),[open,setOpen]=useState(false),[restarting,setRestarting]=useState(false);
 useEffect(()=>{unwrap(bridge.getStatus()).then(value=>{setStatus(value);setError('')},e=>setError((e as Error).message))},[]);
 // A restart reloads this page, so restarting state only needs to last until then.
 const track=async(pending:Promise<Result<{restarting:boolean}>>)=>{const value=await unwrap(pending);if(value.restarting)setRestarting(true);else setStatus(await unwrap(bridge.getStatus()));return value};
 return <><ModelStatusBlock status={status} error={error} restarting={restarting} onEdit={()=>setOpen(true)}/>
  <GeminiKeyModal open={open} status={status} onClose={()=>setOpen(false)} onSave={key=>track(bridge.saveGeminiKey(key))} onClear={()=>track(bridge.clearGeminiKey())}/></>;
}
