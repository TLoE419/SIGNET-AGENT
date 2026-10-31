import {Modal,DialogActions} from '../../../components/Modal';
import React,{useEffect,useRef,useState} from 'react';
import {HostTrust} from './LoginSteps';
import type {HostIdentity} from '../../../../shared/ssh/types';
/** Request-scoped unlock only; never edits or saves connection settings. */
export function UnlockPrompt({open,name,onConnect,onClose,pendingHost,onTrust,diagnostics}:{diagnostics?:React.ReactNode;open:boolean;name:string;pendingHost?:HostIdentity;onTrust?:()=>Promise<void>;onConnect:(phrase:string)=>Promise<void>;onClose:()=>void}){
 const locked=useRef(false),generation=useRef(0);
 const [phrase,setPhrase]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{generation.current++;setPhrase('');setError('')},[open]);
 const close=()=>{generation.current++;setPhrase('');onClose()};
 async function submit(){if(locked.current)return;locked.current=true;setBusy(true);setError('');const current=generation.current,secret=phrase;setPhrase('');try{await onConnect(secret);if(current===generation.current)close()}catch(e){if(current===generation.current)setError((e as Error).message)}finally{locked.current=false;setBusy(false)}}
 return <Modal open={open} title={`Connect to ${name}`} ariaLabel="Unlock SSH private key" className="ssh-unlock" onClose={close}><form onSubmit={e=>{e.preventDefault();void submit()}}><p>Enter your private-key passphrase to connect. This is not your account password and will not be saved.</p><label>Private-key passphrase<input autoFocus type="password" autoComplete="off" required value={phrase} disabled={busy} onChange={e=>setPhrase(e.target.value)}/></label><HostTrust identity={pendingHost} onTrust={onTrust}/>{error&&<p role="alert">{error}</p>}{diagnostics}<DialogActions><button type="button" onClick={close}>Cancel</button><button type="submit" className="ssh-primary" disabled={busy||!phrase}>{busy?'Connecting…':'Connect'}</button></DialogActions></form></Modal>;
}
