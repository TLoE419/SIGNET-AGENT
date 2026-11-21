import {useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';

export type Provider='none'|'gemini'|'groq'|'codex';
type SelectableProvider=Exclude<Provider,'groq'>;
export interface ModelStatus {provider:Provider;geminiConfigured:boolean;encryptionAvailable:boolean}
type Result<T>={ok:true;value:T}|{ok:false;error:{code:string;message:string}};
export interface ModelBridge {
 getStatus():Promise<Result<ModelStatus>>;
 saveGeminiKey(key:string):Promise<Result<{restarting:boolean}>>;
 clearGeminiKey():Promise<Result<{restarting:boolean}>>;
 selectProvider(provider:SelectableProvider):Promise<Result<{restarting:boolean}>>;
}
async function unwrap<T>(pending:Promise<Result<T>>){const result=await pending;if(!result.ok)throw Object.assign(Error(result.error.message),{code:result.error.code});return result.value}

const providerNames:Record<Provider,string>={none:'Not configured',gemini:'Gemini',groq:'Groq',codex:'Codex CLI'};
type BlockStatus='unconfigured'|'disconnected'|'connected'|'connecting'|'error';
const labels:Record<BlockStatus,string>={unconfigured:'Not configured',disconnected:'Saved',connected:'Active',connecting:'Restarting…',error:'Error'};

/** Status contains no saved key; only newly entered credentials pass through the form. */
export function ModelStatusBlock({status,error,restarting,onEdit}:{status:ModelStatus|null;error?:string;restarting?:boolean;onEdit:()=>void}){
 const state:BlockStatus=restarting?'connecting':error?'error':!status?'unconfigured':status.provider==='gemini'?'connected':status.geminiConfigured?'disconnected':'unconfigured';
 const subtitle=state==='connecting'?'Restarting the assistant…':state==='error'?error:state==='connected'?(status!.geminiConfigured?'Chat uses Gemini · key in Keychain':'Chat uses Gemini · key from .env'):status?.provider==='none'?'Set up Gemini to use chat.':status?`Chat uses ${providerNames[status.provider]}`:'Checking model settings…';
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

export function GeminiKeyModal({open,status,onSave,onClear,onClose,model}:{model?:string;open:boolean;status:ModelStatus|null;onSave:(key:string)=>Promise<{restarting:boolean}>;onClear:()=>Promise<{restarting:boolean}>;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),id=useId(),lock=useRef(false);
 const [key,setKey]=useState(''),[working,setWorking]=useState<'saving'|'clearing'|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
 useEffect(()=>{setKey('');setError('');setNotice('');if(open)dialog.current?.showModal();else dialog.current?.close()},[open]);
 const close=()=>{if(working)return;setKey('');onClose()};
 async function run(kind:'saving'|'clearing'){
  if(lock.current||!status||(kind==='saving'&&(!status.encryptionAvailable||!key.trim())))return;lock.current=true;setWorking(kind);setError('');setNotice('');const secret=key;setKey('');
  try{const result=kind==='saving'?await onSave(secret.trim()):await onClear();if(result.restarting)setNotice(kind==='saving'?'Key verified and saved. Restarting the assistant with Gemini…':'Key removed. Restarting the assistant without Gemini…');else onClose()}
  catch(e){
   setError((e as Error).message);
  }finally{lock.current=false;setWorking(null)}
 }
 const unavailable=!status||status.encryptionAvailable===false;
 return createPortal(<dialog ref={dialog} className="ssh-modal model-key-modal" aria-labelledby={id} onClose={()=>{setKey('');onClose()}} onCancel={e=>{if(working)e.preventDefault();else close()}}><form onSubmit={e=>{e.preventDefault();void run('saving')}}>
  <button type="button" className="ssh-modal-close" aria-label={"Close"} title={"Close"} disabled={!!working} onClick={close}><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
  <h2 id={id}>{"Gemini API"}</h2>
  {model&&<p>{"Current model: "}<strong>{model}</strong></p>}
  <p>{"Chat uses Google Gemini with your own API key. Create one in "}<a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">Google AI Studio</a>.</p>
  <p className="model-key-note">{"The key is encrypted with your system keychain and is never shown again. Chat messages and tool results are sent to Google; on the free tier Google may use them to improve its products."}</p>
  {status?.geminiConfigured&&<p role="status">{"A key is saved."} {"Active provider: "}{providerNames[status.provider]}</p>}
  <fieldset disabled={!!working||unavailable}><legend>{status?.geminiConfigured?'Replace API key':'API key'}</legend>
   <label>{"Gemini API key"}<input autoFocus aria-label={"Gemini API key"} type="password" autoComplete="off" spellCheck={false} required value={key} onChange={e=>setKey(e.target.value)}/></label>
  </fieldset>
  {status?.encryptionAvailable===false&&<p role="alert">{"System keychain encryption is unavailable, so a key cannot be saved here."}</p>}
  {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
  <footer className="ssh-dialog-actions">{status?.geminiConfigured&&<button type="button" className="ssh-danger" disabled={!!working} onClick={()=>void run('clearing')}>{working==='clearing'?'Removing…':'Remove key'}</button>}
   <button type="button" disabled={!!working} onClick={close}>{"Cancel"}</button>
   <button type="submit" className="ssh-primary" disabled={!!working||unavailable||!key.trim()}>{working==='saving'?'Verifying key…':'Save and use Gemini'}</button></footer>
 </form></dialog>,document.body);
}

export function ModelControls({bridge,model,workspace=false}:{bridge:ModelBridge;model?:string;workspace?:boolean}){
 const [status,setStatus]=useState<ModelStatus|null>(null),[error,setError]=useState(''),[open,setOpen]=useState(false),[restarting,setRestarting]=useState(false);
 const [selecting,setSelecting]=useState(false),selectLock=useRef(false);
 useEffect(()=>{let mounted=true;const refresh=()=>unwrap(bridge.getStatus()).then(value=>{if(mounted){setStatus(value);setError('')}},()=>{if(mounted){setStatus(null);setError('Could not read model settings.')}});void refresh();const show=()=>{setOpen(true);void refresh()};if(workspace)window.addEventListener('workspace-open-model-settings',show);return ()=>{mounted=false;window.removeEventListener('workspace-open-model-settings',show)}},[bridge,workspace]);
 // A restart reloads this page, so restarting state only needs to last until then.
 const track=async(pending:Promise<Result<{restarting:boolean}>>)=>{const value=await unwrap(pending);if(value.restarting)setRestarting(true);else setStatus(await unwrap(bridge.getStatus()));return value};
 async function selectProvider(provider:SelectableProvider){
  if(!status||selectLock.current||restarting)return;
  selectLock.current=true;setSelecting(true);setError('');
  try{await track(bridge.selectProvider(provider))}
  catch(failure){setError(failure instanceof Error?failure.message:'The chat model could not be changed.')}
  finally{selectLock.current=false;setSelecting(false)}
 }
 const codexActive=status?.provider==='codex';
 const nextProvider=codexActive?(status.geminiConfigured?'gemini':'none'):'codex';
 const nextLabel=nextProvider==='codex'?'Use Codex CLI':nextProvider==='gemini'?'Use Gemini':'Stop using Codex CLI';
 return <>{workspace?<>
  <p className="ml-settings-note">Current model: <strong>{model||'—'}</strong></p>
  <p className="ml-settings-note" role="status">{restarting||selecting?'Restarting the assistant…':error||(status?(status.geminiConfigured?'Gemini key saved securely':'No saved Gemini key'):'Checking model settings…')}</p>
  <button type="button" className="ml-settings-action" disabled={selecting||restarting} onClick={()=>setOpen(true)}>Manage Gemini key</button>
  <button type="button" className="ml-settings-action" disabled={!status||selecting||restarting} onClick={()=>void selectProvider(nextProvider)}>{nextLabel}</button>
  <p className="ml-settings-note">Codex CLI uses your existing sign-in for this app session.</p>
 </>:<ModelStatusBlock status={status} error={error} restarting={restarting} onEdit={()=>setOpen(true)}/>}
  <GeminiKeyModal model={model} open={open} status={status} onClose={()=>setOpen(false)} onSave={key=>track(bridge.saveGeminiKey(key))} onClear={()=>track(bridge.clearGeminiKey())}/></>;
}
