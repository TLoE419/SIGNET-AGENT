import {useEffect,useId,useRef,useState} from 'react';
import {ModeIcon} from './ModeIcon';
import type {Inspection,KeyMetadata,PrivateKeySelection} from './types';
interface Props {
 keys?:KeyMetadata[];open:boolean;onClose:()=>void;onPickKey:()=>Promise<PrivateKeySelection>;onInspectKey:(path:string)=>Promise<Inspection>;
 onGenerateKey:(input:{label:string;passphrase:string})=>Promise<KeyMetadata>;onAddExternalKey:(input:{label:string;privateKeyPath:string})=>Promise<KeyMetadata>;
 onGenerated:(key:KeyMetadata,passphrase:string)=>void;onImported:(key:KeyMetadata)=>void|Promise<void>;
}
function defaultKeyName(keys:KeyMetadata[]=[]){
 const names=new Set(keys.map(key=>key.label.trim().toLowerCase())),base='My HPC3 key';
 let name=base,index=2;
 while(names.has(name.toLowerCase()))name=`${base} ${index++}`;
 return name;
}
export function KeyRegistrationModal(p:Props){
 const dialog=useRef<HTMLDialogElement>(null),id=useId(),generation=useRef(0),lock=useRef(false);
 const [source,setSource]=useState<'create'|'existing'>('create'),[label,setLabel]=useState(()=>defaultKeyName(p.keys)),[path,setPath]=useState(''),[inspection,setInspection]=useState<Inspection|null>(null),[phrase,setPhrase]=useState(''),[confirm,setConfirm]=useState(''),[working,setWorking]=useState(false),[error,setError]=useState('');
 useEffect(()=>{generation.current++;setPhrase('');setConfirm('');setError('');if(p.open){setSource('create');setLabel(defaultKeyName(p.keys));setPath('');setInspection(null);dialog.current?.showModal()}else dialog.current?.close()},[p.open]);
 const close=()=>{generation.current++;setPhrase('');setConfirm('');p.onClose()};
 async function choose(){const current=generation.current;try{const selected=await p.onPickKey();if(selected.canceled||current!==generation.current)return;setPath(selected.path);setInspection(null);const result=await p.onInspectKey(selected.path);if(current===generation.current)setInspection(result)}catch(e){if(current===generation.current)setError((e as Error).message)}}
 async function save(){
  if(lock.current)return;setError('');if(!label.trim()){setError('Enter a key name.');return}if(source==='create'&&(phrase.length<10||phrase!==confirm)){setError('Use at least 10 characters and matching passphrases.');return}if(source==='existing'&&inspection?.status!=='encrypted'){setError('Choose a supported encrypted SSH key.');return}
  lock.current=true;setWorking(true);const current=generation.current,secret=phrase;setPhrase('');setConfirm('');
  try{if(source==='create'){const key=await p.onGenerateKey({label:label.trim(),passphrase:secret});if(current===generation.current)p.onGenerated(key,secret)}else{const key=await p.onAddExternalKey({label:label.trim(),privateKeyPath:path});if(current===generation.current)await p.onImported(key)}}catch(e){if(current===generation.current)setError((e as Error).message)}finally{lock.current=false;setWorking(false)}
 }
 return <dialog ref={dialog} className="ssh-modal ssh-key-registration" aria-labelledby={id} onCancel={e=>{e.preventDefault();close()}}><form onSubmit={e=>{e.preventDefault();void save()}}><h2 id={id}>{source==='create'?'Generate SSH key':'Add existing SSH key'}</h2><p>Create or import a key first. Account sign-in comes afterwards.</p>
  <fieldset disabled={working}><legend>SSH key</legend><section className="ssh-key-source ssh-mode-tiles" role="radiogroup" aria-label="SSH key source"><button type="button" role="radio" aria-checked={source==='create'} onClick={()=>{if(source==='create')return;setSource('create');setError('')}}><ModeIcon kind="create"/><span>Create New SSH Key</span></button><button type="button" role="radio" aria-checked={source==='existing'} onClick={()=>{if(source==='existing')return;setSource('existing');setPhrase('');setConfirm('');setError('')}}><ModeIcon kind="import"/><span>Use Existing SSH Key</span></button></section>
   <label>Key name<input aria-label="Key name" value={label} maxLength={120} onChange={e=>setLabel(e.target.value)} required/></label>
   {source==='create'?<><label>New key passphrase<input aria-label="New key passphrase" type="password" autoComplete="new-password" value={phrase} onChange={e=>setPhrase(e.target.value)}/><span>At least 10 characters. Never saved.</span></label><label>Confirm passphrase<input aria-label="Confirm passphrase" type="password" autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)}/></label></>:<section className="ssh-onboarding"><label>SSH private key<input aria-label="SSH private key" readOnly value={path} placeholder="No key selected"/></label><button type="button" onClick={()=>void choose()}>Choose private key…</button>{inspection?.status!=='encrypted'&&<p role="status">{inspection?.status==='unencrypted'?'This key has no passphrase. Choose a passphrase-protected key.':inspection&&'reason'in inspection?inspection.reason:'Choose an encrypted OpenSSH private key.'}</p>}</section>}
  </fieldset>{error&&<p role="alert">{error}</p>}<footer><button type="button" onClick={close}>Cancel</button><button type="submit" className="ssh-primary" disabled={working||(source==='existing'&&inspection?.status!=='encrypted')}>{working?'Working…':source==='create'?'Generate SSH key':'Save key'}</button></footer>
 </form></dialog>;
}
