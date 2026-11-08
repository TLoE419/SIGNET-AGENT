import {Modal,DialogActions} from '../../../components/Modal';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import type {AuthChallenge,HostIdentity,KeyMetadata} from '../../../../shared/ssh/types';
import {DuoChallenge,HostTrust} from './LoginSteps';
export function AccountLoginPrompt(p:{resume?:boolean;diagnostics?:ReactNode;open:boolean;username:string;keyToRegister?:KeyMetadata;onLogin:(username:string,password:string)=>Promise<void>;onClose:()=>void;onComplete:()=>void;challenge?:AuthChallenge|null;onAnswer:(session:string,challenge:string,answers:string[])=>Promise<void>;pendingHost?:HostIdentity;onTrust:()=>Promise<void>}){
 const generation=useRef(0),lock=useRef(false);
 const [username,setUsername]=useState(p.username),[password,setPassword]=useState(''),[working,setWorking]=useState(false),[error,setError]=useState('');
 useEffect(()=>{generation.current++;setPassword('');setError('');if(p.open){setUsername(p.username)}},[p.open]);
 const close=()=>{generation.current++;setPassword('');p.onClose()};
 async function submit(){if(lock.current)return;const current=generation.current,secret=p.resume?'':password;setPassword('');setError('');lock.current=true;setWorking(true);try{await p.onLogin(username.trim(),secret);if(current===generation.current)p.onComplete()}catch(e){if(current===generation.current)setError((e as Error).message)}finally{lock.current=false;setWorking(false)}}
 return <Modal open={p.open} title={p.keyToRegister?'Set up SSH key':'Sign in with Duo'} className="ssh-account-login" onClose={close}><form onSubmit={e=>{e.preventDefault();void submit()}}>
  {p.keyToRegister?<><p>Your key is ready. Sign in to install its public key on your account and verify the connection.</p><strong>{p.keyToRegister.label}</strong><code>{p.keyToRegister.fingerprint}</code><details><summary>View public key for manual setup</summary><textarea aria-label="Generated public key" readOnly rows={4} value={p.keyToRegister.publicKey}/></details></>:p.resume?<p>Your login is still active. Retry verification without entering your password or approving Duo again.</p>:<p>Enter your account password, then complete the Duo request.</p>}
  <fieldset disabled={working}><legend>Account sign-in</legend><label>UCInetID / username<input aria-label="UCInetID / username" autoComplete="username" disabled={p.resume} required value={username} onChange={e=>setUsername(e.target.value)}/></label>{!p.resume&&<label>UCInetID password<input aria-label="UCInetID password" type="password" autoComplete="off" required value={password} onChange={e=>setPassword(e.target.value)}/></label>}</fieldset>
  <DuoChallenge challenge={p.challenge} onAnswer={p.onAnswer}/><HostTrust identity={p.pendingHost} onTrust={p.onTrust}/>{error&&<p role="alert">{error}</p>}
  {p.diagnostics}<DialogActions><button type="button" onClick={close}>Cancel</button><button type="submit" className="ssh-primary" disabled={working||!username.trim()||(!p.resume&&!password)}>{working?'Waiting for authentication…':p.resume?'Retry verification':p.keyToRegister?'Sign in and set up key':'Sign in'}</button></DialogActions>
 </form></Modal>;
}
