import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
import type {FormInput,HostIdentity,Inspection,KeyMetadata,SshError,Status,ConnectionHealth} from './types';
import {uciHpc3Preset} from './types';
import {profileInput} from './validation';
import {HostTrust} from './LoginSteps';
export interface ConnectionModalProps {
 diagnostics?:ReactNode;open:boolean;profile:FormInput|null;keys:KeyMetadata[];status:Status|'unconfigured';busy?:boolean;error?:SshError|null;
 onInspectKey:(path:string)=>Promise<Inspection>;onSave:(input:FormInput)=>Promise<void>;onConnect:(input:FormInput)=>Promise<void>;
 onDisconnect:()=>Promise<void>;onCheck?:()=>Promise<void>;onClose:()=>void;onOpenKeyRegistration:()=>void;pendingHost?:HostIdentity;onTrustHost?:()=>Promise<void>;health?:ConnectionHealth;
}
export function ConnectionModal(p:ConnectionModalProps){
 const [form,setForm]=useState<FormInput>(p.profile||uciHpc3Preset),[inspection,setInspection]=useState<Inspection|null>(null),[error,setError]=useState(''),[working,setWorking]=useState(false);
 const dialog=useRef<HTMLDialogElement>(null),lock=useRef(false),generation=useRef(0),id=useId();
 const active=['connected','connecting','disconnecting'].includes(p.status),disabled=working||p.busy||active;
 const legacy=p.profile?.auth.method==='private-key'&&!p.profile.auth.keyId?p.profile:null;
 const hasKeys=p.keys.length>0||!!legacy;
 useEffect(()=>{generation.current++;if(p.open){setForm(p.profile||structuredClone(uciHpc3Preset));setError('');setInspection(null);dialog.current?.showModal()}else dialog.current?.close()},[p.open]);
 const keyPath=form.auth.privateKeyPath;
 useEffect(()=>{let cancelled=false;setInspection(null);if(p.open&&keyPath)void p.onInspectKey(keyPath).then(result=>{if(!cancelled)setInspection(result)}).catch(()=>{if(!cancelled)setInspection({status:'unreadable',reason:'Cannot inspect this key.'})});return()=>{cancelled=true}},[p.open,keyPath]);
 const close=()=>{generation.current++;p.onClose()};
 function selectKey(keyId:string){const key=p.keys.find(k=>k.keyId===keyId);if(key)setForm(current=>({...current,username:key.username||current.username,auth:{method:'private-key',privateKeyPath:key.privateKeyPath,keyId:key.keyId,managed:key.source==='managed'}}))}
 function chooseMethod(method:'duo'|'private-key'){setError('');if(method==='duo')setForm(current=>({...current,auth:{method:'duo'}}));else if(legacy)setForm(current=>({...current,auth:legacy.auth,username:current.username||legacy.username}));else if(p.keys[0])selectKey(p.keys[0].keyId)}
 async function submit(connect:boolean){if(lock.current||disabled)return;lock.current=true;setWorking(true);setError('');const current=generation.current;try{profileInput(form);if(form.auth.method==='private-key'&&inspection?.status!=='encrypted')throw Error('Choose a supported encrypted SSH key.');await(connect?p.onConnect(form):p.onSave(form));if(current===generation.current)close()}catch(e){if(current===generation.current)setError((e as Error).message)}finally{lock.current=false;setWorking(false)}}
 return <dialog ref={dialog} className="ssh-modal" aria-labelledby={id} onCancel={e=>{e.preventDefault();close()}}><form onSubmit={e=>{e.preventDefault();void submit(true)}}>
  <h2 id={id}>SSH connection</h2><p>Choose how to sign in to UCI HPC3.</p><fieldset disabled={!!disabled}><legend>Connection profile</legend>
   <label>Connection name<input required value={form.name} maxLength={120} onChange={e=>setForm({...form,name:e.target.value})}/></label>
   <section className="ssh-key-source" role="radiogroup" aria-label="Login method"><button type="button" role="radio" aria-checked={form.auth.method==='duo'} onClick={()=>chooseMethod('duo')}>Duo</button><button type="button" role="radio" aria-checked={form.auth.method==='private-key'} disabled={!hasKeys} onClick={()=>chooseMethod('private-key')}>SSH key</button></section>
   {!hasKeys&&<p>No SSH key saved. Sign in with Duo, or add a key.</p>}
   {form.auth.method==='private-key'&&<><label>SSH key<select aria-label="SSH key" required value={form.auth.keyId||(legacy?'__current':'')} onChange={e=>e.target.value==='__current'&&legacy?setForm({...form,auth:legacy.auth}):selectKey(e.target.value)}><option value="" disabled>Select a saved key</option>{legacy&&<option value="__current">Current key</option>}{p.keys.map(key=><option key={key.keyId} value={key.keyId}>{key.label}</option>)}</select></label><p role="status">{inspection?.status==='encrypted'?'Passphrase protected':inspection?.status==='unencrypted'?'This key has no passphrase':inspection&&'reason'in inspection?inspection.reason:'Checking selected key…'}</p></>}
   <label>UCInetID / username<input aria-label="UCInetID / username" required autoComplete="username" value={form.username} maxLength={128} onChange={e=>setForm({...form,username:e.target.value})}/></label>
   <div className="ssh-key-actions"><button type="button" onClick={p.onOpenKeyRegistration}>Add SSH key…</button></div>
   <details className="ssh-advanced"><summary>Advanced connection settings</summary><label>Host<input required value={form.host} onChange={e=>setForm({...form,host:e.target.value})}/></label><label>Port<input required type="number" min="1" max="65535" value={form.port} onChange={e=>setForm({...form,port:Number(e.target.value)})}/></label></details>
  </fieldset>{p.health&&<section aria-label="HPC3 connection health"><strong>Last verified {new Date(p.health.checkedAt).toLocaleTimeString()}</strong><ul>{p.health.steps.map(step=><li key={step.name}>{step.ok?'✓':'×'} {step.detail}</li>)}</ul></section>}{(error||p.error)&&<p role="alert">{error||p.error?.message}</p>}<HostTrust identity={p.pendingHost} onTrust={p.onTrustHost}/>
  {p.diagnostics}<footer>{active?<><button type="button" disabled={p.status==='disconnecting'} onClick={()=>void p.onDisconnect().catch(e=>setError(e.message))}>{p.status==='connecting'?'Cancel connection':'Disconnect'}</button>{p.status==='connected'&&p.onCheck&&<button type="button" disabled={working||p.busy} onClick={()=>{setWorking(true);setError('');void p.onCheck!().catch(e=>setError(e.message)).finally(()=>setWorking(false))}}>{working?'Checking…':'Check again'}</button>}</>:<><button type="submit" className="ssh-primary" disabled={!!disabled||(form.auth.method==='private-key'&&inspection?.status!=='encrypted')}>Connect</button><button type="button" disabled={!!disabled||(form.auth.method==='private-key'&&inspection?.status!=='encrypted')} onClick={()=>void submit(false)}>Save</button></>}<button type="button" onClick={close}>Close</button></footer>
 </form></dialog>;
}
