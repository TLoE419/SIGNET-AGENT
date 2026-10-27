import React,{useEffect,useRef,useState} from 'react';
/** Request-scoped unlock only; never edits or saves connection settings. */
export function UnlockPrompt({open,name,onConnect,onClose}:{open:boolean;name:string;onConnect:(phrase:string)=>Promise<void>;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),locked=useRef(false),generation=useRef(0);
 const [phrase,setPhrase]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{generation.current++;setPhrase('');setError('');if(open)dialog.current?.showModal();else dialog.current?.close()},[open]);
 const close=()=>{generation.current++;setPhrase('');onClose()};
 async function submit(){if(locked.current)return;locked.current=true;setBusy(true);setError('');const current=generation.current,secret=phrase;setPhrase('');try{await onConnect(secret);if(current===generation.current)close()}catch(e){if(current===generation.current)setError((e as Error).message)}finally{locked.current=false;setBusy(false)}}
 return <dialog ref={dialog} className="ssh-modal ssh-unlock" aria-label="Unlock SSH private key" onCancel={e=>{e.preventDefault();close()}} onKeyDown={e=>e.stopPropagation()}><form onSubmit={e=>{e.preventDefault();void submit()}}><h2>Connect to {name}</h2><p>Enter your private-key passphrase to connect. This is not your account password and will not be saved.</p><label>Private-key passphrase<input autoFocus type="password" autoComplete="off" required value={phrase} disabled={busy} onChange={e=>setPhrase(e.target.value)}/></label>{error&&<p role="alert">{error}</p>}<footer><button type="submit" className="ssh-primary" disabled={busy||!phrase}>{busy?'Connecting…':'Connect'}</button><button type="button" onClick={close}>Cancel</button></footer></form></dialog>;
}
