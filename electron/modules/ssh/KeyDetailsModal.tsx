import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
import type {KeyMetadata} from './types';

function KeyDialog({title,onClose,children,busy=false}:{title:string;onClose:()=>void;children:ReactNode;busy?:boolean}){
 const ref=useRef<HTMLDialogElement>(null),id=useId();
 useEffect(()=>{const dialog=ref.current;dialog?.showModal();return()=>dialog?.close()},[]);
 const close=()=>{if(!busy)onClose()};
 return <dialog ref={ref} className="ssh-modal ssh-key-dialog" aria-labelledby={id} onCancel={e=>{e.preventDefault();close()}} onClick={e=>{if(e.target!==e.currentTarget)return;const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close()}}>
  <button type="button" className="ssh-modal-close" aria-label="Close" title="Close" disabled={busy} onClick={close}><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
  <h2 id={id}>{title}</h2>{children}
 </dialog>;
}
export function KeyDetailsModal({keyInfo,onClose,onUpdate,onRemove,onAccountChanged}:{keyInfo:KeyMetadata;onClose:()=>void;onUpdate?:(id:string,input:{label:string;username?:string})=>Promise<void>;onRemove?:(id:string)=>Promise<void>;onAccountChanged:(username:string)=>void}){
 const [action,setAction]=useState<'edit'|'delete'|null>(null),[label,setLabel]=useState(keyInfo.label),[username,setUsername]=useState(keyInfo.username||''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const lock=useRef(false);
 async function run(fn:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await fn()}catch(e){setError((e as Error).message)}finally{lock.current=false;setBusy(false)}}
 const dismiss=()=>{setAction(null);setError('')};
 return <><KeyDialog title="SSH key details" onClose={onClose}>
  <dl className="ssh-key-details"><dt>Key name</dt><dd>{keyInfo.label}</dd><dt>Linked account</dt><dd>{keyInfo.username||'No linked account'}</dd><dt>Key type</dt><dd>{keyInfo.algorithm}</dd><dt>Source</dt><dd>{keyInfo.source==='managed'?'Generated in SIGNET':'Imported key'}</dd><dt>Created</dt><dd>{new Date(keyInfo.createdAt).toLocaleString()}</dd><dt>Fingerprint</dt><dd><code>{keyInfo.fingerprint}</code></dd><dt>Private-key location</dt><dd><code>{keyInfo.privateKeyPath}</code></dd></dl>
  <p className="ssh-key-account-note">The linked account is saved locally; it does not confirm current access on the server.</p>
  <footer><button type="button" className="ssh-danger" disabled={!onRemove} onClick={()=>{setError('');setAction('delete')}}>Delete key</button><button type="button" disabled={!onUpdate} onClick={()=>{setLabel(keyInfo.label);setUsername(keyInfo.username||'');setError('');setAction('edit')}}>Edit key</button></footer>
 </KeyDialog>
 {action==='edit'&&<KeyDialog title="Edit SSH key" onClose={dismiss} busy={busy}><form onSubmit={e=>{e.preventDefault();void run(async()=>{await onUpdate!(keyInfo.keyId,{label:label.trim(),username:username.trim()||undefined});onAccountChanged(username.trim());dismiss()})}}><fieldset disabled={busy}><label>Key name<input required maxLength={120} value={label} onChange={e=>setLabel(e.target.value)}/></label><label>Key account (optional)<input maxLength={128} pattern="[a-zA-Z0-9_.@-]+" value={username} onChange={e=>setUsername(e.target.value)}/></label></fieldset>{error&&<p role="alert">{error}</p>}<footer><button type="button" disabled={busy} onClick={dismiss}>Cancel edit</button><button type="submit" disabled={busy||!label.trim()}>{busy?'Saving…':'Save key changes'}</button></footer></form></KeyDialog>}
 {action==='delete'&&<KeyDialog title="Delete SSH key?" onClose={dismiss} busy={busy}><p>Delete “{keyInfo.label}” from the saved list? Profiles using it will switch to Duo. Private-key files and remote authorization will be kept.</p>{error&&<p role="alert">{error}</p>}<footer><button type="button" className="ssh-danger" disabled={busy} onClick={()=>void run(async()=>{await onRemove!(keyInfo.keyId);onClose()})}>{busy?'Deleting…':'Confirm delete'}</button><button type="button" autoFocus disabled={busy} onClick={dismiss}>Cancel delete</button></footer></KeyDialog>}
 </>;
}
