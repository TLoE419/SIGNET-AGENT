import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
import type {AuthChallenge,HostIdentity,KeyMetadata} from '../../modules/ssh/types';
import {DuoChallenge,HostTrust} from '../../modules/ssh/LoginSteps';
export function AccountLoginPrompt(p:{diagnostics?:ReactNode;open:boolean;username:string;keyToRegister?:KeyMetadata;onLogin:(username:string,password:string)=>Promise<void>;onClose:()=>void;onComplete:()=>void;challenge?:AuthChallenge|null;onAnswer:(session:string,challenge:string,answers:string[])=>Promise<void>;pendingHost?:HostIdentity;onTrust:()=>Promise<void>}){
 const dialog=useRef<HTMLDialogElement>(null),id=useId(),generation=useRef(0),lock=useRef(false);
 const [username,setUsername]=useState(p.username),[password,setPassword]=useState(''),[working,setWorking]=useState(false),[error,setError]=useState('');
 useEffect(()=>{generation.current++;setPassword('');setError('');if(p.open){setUsername(p.username);dialog.current?.showModal()}else dialog.current?.close()},[p.open]);
 const close=()=>{generation.current++;setPassword('');p.onClose()};
 async function submit(){if(lock.current)return;const current=generation.current,secret=password;setPassword('');setError('');lock.current=true;setWorking(true);try{await p.onLogin(username.trim(),secret);if(current===generation.current)p.onComplete()}catch(e){if(current===generation.current)setError((e as Error).message)}finally{lock.current=false;setWorking(false)}}
 return <dialog ref={dialog} className="ssh-modal ssh-account-login" aria-labelledby={id} onCancel={e=>{e.preventDefault();close()}}><form onSubmit={e=>{e.preventDefault();void submit()}}><h2 id={id}>{p.keyToRegister?'Set up SSH key':'Sign in with Duo'}</h2>
  {p.keyToRegister?<><p>Your key is ready. Sign in to install its public key on your account and verify the connection.</p><strong>{p.keyToRegister.label}</strong><code>{p.keyToRegister.fingerprint}</code><details><summary>View public key for manual setup</summary><textarea aria-label="Generated public key" readOnly rows={4} value={p.keyToRegister.publicKey}/></details></>:<p>Enter your account password, then complete the Duo request.</p>}
  <fieldset disabled={working}><legend>Account sign-in</legend><label>UCInetID / username<input aria-label="UCInetID / username" autoComplete="username" required value={username} onChange={e=>setUsername(e.target.value)}/></label><label>UCInetID password<input aria-label="UCInetID password" type="password" autoComplete="off" required value={password} onChange={e=>setPassword(e.target.value)}/></label></fieldset>
  <DuoChallenge challenge={p.challenge} onAnswer={p.onAnswer}/><HostTrust identity={p.pendingHost} onTrust={p.onTrust}/>{error&&<p role="alert">{error}</p>}
  {p.diagnostics}<footer><button type="submit" className="ssh-primary" disabled={working||!username.trim()||!password}>{working?'Waiting for authentication…':p.keyToRegister?'Sign in and set up key':'Sign in'}</button><button type="button" onClick={close}>Cancel</button></footer>
 </form></dialog>;
}
