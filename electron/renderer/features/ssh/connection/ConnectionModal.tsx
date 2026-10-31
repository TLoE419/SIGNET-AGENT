import {Modal,DialogActions} from '../../../components/Modal';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import type {FormInput,HostIdentity,Inspection,KeyMetadata,SshError,Status,ConnectionHealth} from '../../../../shared/ssh/types';
import {uciHpc3Preset} from '../../../../shared/ssh/types';
import {profileInput} from '../../../../shared/ssh/validation';
import {ModeIcon} from '../../../components/ModeIcon';
import {HostTrust} from '../auth/LoginSteps';
import {KeyDetailsModal} from '../keys/KeyDetailsModal';
export interface ConnectionModalProps {
 diagnostics?:ReactNode;open:boolean;profile:FormInput|null;keys:KeyMetadata[];status:Status|'unconfigured';busy?:boolean;error?:SshError|null;
 onInspectKey:(path:string)=>Promise<Inspection>;onSave:(input:FormInput)=>Promise<void>;onConnect:(input:FormInput)=>Promise<void>;
 onDisconnect:()=>Promise<void>;onCheck?:()=>Promise<void>;onClose:()=>void;onOpenKeyRegistration:(draft:FormInput)=>void;onUpdateKey?:(id:string,input:{label:string;username?:string})=>Promise<void>;onRemoveKey?:(id:string)=>Promise<void>;pendingHost?:HostIdentity;onTrustHost?:()=>Promise<void>;health?:ConnectionHealth;
}
export function ConnectionModal(p:ConnectionModalProps){
 const [form,setForm]=useState<FormInput>(p.profile||uciHpc3Preset),[inspection,setInspection]=useState<Inspection|null>(null),[error,setError]=useState(''),[working,setWorking]=useState(false);
 const lock=useRef(false),generation=useRef(0);
 const active=['connected','connecting','disconnecting'].includes(p.status),disabled=working||p.busy||active;
 const legacy=p.profile?.auth.method==='private-key'&&!p.profile.auth.keyId?p.profile:null;
 const [keyDetails,setKeyDetails]=useState(false);
 const selectedKey=p.keys.find(k=>k.keyId===form.auth.keyId);
 useEffect(()=>{setKeyDetails(false)},[p.open,form.auth.method,form.auth.keyId]);
 useEffect(()=>{generation.current++;if(p.open){setForm(p.profile||structuredClone(uciHpc3Preset));setError('');setInspection(null)}},[p.open]);
 const keyPath=form.auth.privateKeyPath;
 useEffect(()=>{let cancelled=false;setInspection(null);if(p.open&&keyPath)void p.onInspectKey(keyPath).then(result=>{if(!cancelled)setInspection(result)}).catch(()=>{if(!cancelled)setInspection({status:'unreadable',reason:'Cannot inspect this key.'})});return()=>{cancelled=true}},[p.open,keyPath]);
 const close=()=>{generation.current++;p.onClose()};
 function selectKey(keyId:string){const key=p.keys.find(k=>k.keyId===keyId);if(key)setForm(current=>({...current,username:key.username||current.username,auth:{method:'private-key',privateKeyPath:key.privateKeyPath,keyId:key.keyId,managed:key.source==='managed'}}))}
 function chooseMethod(method:'duo'|'private-key'){if(method===form.auth.method)return;setError('');if(method==='duo')setForm(current=>({...current,auth:{method:'duo'}}));else if(legacy)setForm(current=>({...current,auth:legacy.auth,username:current.username||legacy.username}));else if(p.keys[0])selectKey(p.keys[0].keyId);else setForm(current=>({...current,auth:{method:'private-key',privateKeyPath:''}}))}
 async function submit(connect:boolean){if(lock.current||disabled)return;lock.current=true;setWorking(true);setError('');const current=generation.current;try{profileInput(form);if(form.auth.method==='private-key'&&inspection?.status!=='encrypted')throw Error('Choose a supported encrypted SSH key.');await(connect?p.onConnect(form):p.onSave(form));if(current===generation.current)close()}catch(e){if(current===generation.current)setError((e as Error).message)}finally{lock.current=false;setWorking(false)}}
 return <><Modal open={p.open} title="SSH connection" className="ssh-connection-modal" onClose={close}><form onSubmit={e=>{e.preventDefault();void submit(true)}}>
  <p>Choose how to sign in to UCI HPC3. Connect to the UCI VPN or campus network before signing in.</p><fieldset disabled={!!disabled}><legend>Connection profile</legend>
   <section className="ssh-key-source ssh-mode-tiles" role="radiogroup" aria-label="Login method"><button type="button" role="radio" aria-checked={form.auth.method==='duo'} onClick={()=>chooseMethod('duo')}><ModeIcon kind="duo"/><span>Duo</span></button><button type="button" role="radio" aria-checked={form.auth.method==='private-key'} onClick={()=>chooseMethod('private-key')}><ModeIcon kind="key"/><span>SSH key</span></button></section>
   {form.auth.method==='private-key'&&<section className="ssh-key-block" aria-label="SSH key management"><h3>SSH keys</h3>{!p.keys.length&&!legacy?<p>No SSH keys saved. Add a key to get started.</p>:<><div className="ssh-key-selection"><label>SSH key<select aria-label="SSH key" required value={form.auth.keyId||(legacy?'__current':'')} onChange={e=>e.target.value==='__current'&&legacy?setForm({...form,auth:legacy.auth}):selectKey(e.target.value)}><option value="" disabled>Select a saved key</option>{legacy&&<option value="__current">Current key</option>}{p.keys.map(key=><option key={key.keyId} value={key.keyId}>{key.label}</option>)}</select></label>{selectedKey&&<button className="ssh-key-detail-button" type="button" aria-label="SSH key details" title="SSH key details" onClick={()=>setKeyDetails(true)}><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></svg></button>}</div>{inspection?.status!=='encrypted'&&<p role="status">{inspection?.status==='unencrypted'?'This key has no passphrase':inspection&&'reason'in inspection?inspection.reason:keyPath?'Checking selected key…':'Select a saved key to continue.'}</p>}</>}
    <div className="ssh-key-actions"><button type="button" onClick={()=>p.onOpenKeyRegistration(form)}>Add SSH key…</button></div>
   </section>}
   <label>UCInetID / username<input aria-label="UCInetID / username" required autoComplete="username" value={form.username} maxLength={128} onChange={e=>setForm({...form,username:e.target.value})}/></label>
   <details className="ssh-advanced"><summary>Advanced connection settings</summary><label>Host<input required value={form.host} onChange={e=>setForm({...form,host:e.target.value})}/></label><label>Port<input required type="number" min="1" max="65535" value={form.port} onChange={e=>setForm({...form,port:Number(e.target.value)})}/></label></details>
  </fieldset>{p.health&&<section aria-label="HPC3 connection health"><strong>Last verified {new Date(p.health.checkedAt).toLocaleTimeString()}</strong><ul>{p.health.steps.map(step=><li key={step.name}>{step.ok?'✓':'×'} {step.detail}</li>)}</ul></section>}{(error||p.error)&&<p role="alert">{error||p.error?.message}</p>}<HostTrust identity={p.pendingHost} onTrust={p.onTrustHost}/>
  {p.diagnostics}<DialogActions>{active?<><button type="button" className="ssh-danger" disabled={p.status==='disconnecting'} onClick={()=>void p.onDisconnect().catch(e=>setError(e.message))}>{p.status==='connecting'?'Cancel connection':'Disconnect'}</button>{p.status==='connected'&&p.onCheck&&<button type="button" disabled={working||p.busy} onClick={()=>{setWorking(true);setError('');void p.onCheck!().catch(e=>setError(e.message)).finally(()=>setWorking(false))}}>{working?'Checking…':'Check again'}</button>}</>:<><button type="button" disabled={!!disabled||(form.auth.method==='private-key'&&inspection?.status!=='encrypted')} onClick={()=>void submit(false)}>Save</button><button type="submit" className="ssh-primary" disabled={!!disabled||(form.auth.method==='private-key'&&inspection?.status!=='encrypted')}>Connect</button></>}</DialogActions>
 </form></Modal>
 {p.open&&keyDetails&&selectedKey&&<KeyDetailsModal key={selectedKey.keyId} keyInfo={selectedKey} onClose={()=>setKeyDetails(false)} onUpdate={p.onUpdateKey} onRemove={p.onRemoveKey?async id=>{await p.onRemoveKey!(id);setForm(current=>({...current,auth:{method:'private-key',privateKeyPath:''}}))}:undefined} onAccountChanged={username=>{if(username)setForm(current=>({...current,username}))}}/>}
 </>;
}
