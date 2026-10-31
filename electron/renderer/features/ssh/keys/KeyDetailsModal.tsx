import {useRef,useState} from 'react';
import {Modal,DialogActions,ConfirmDialog} from '../../../components/Modal';
import type {KeyMetadata} from '../../../../shared/ssh/types';

export function KeyDetailsModal({keyInfo,onClose,onUpdate,onRemove,onAccountChanged}:{keyInfo:KeyMetadata;onClose:()=>void;onUpdate?:(id:string,input:{label:string;username?:string})=>Promise<void>;onRemove?:(id:string)=>Promise<void>;onAccountChanged:(username:string)=>void}){
 const [action,setAction]=useState<'edit'|'delete'|null>(null),[label,setLabel]=useState(keyInfo.label),[username,setUsername]=useState(keyInfo.username||''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const lock=useRef(false);
 async function run(fn:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await fn()}catch(e){setError((e as Error).message)}finally{lock.current=false;setBusy(false)}}
 const dismiss=()=>{setAction(null);setError('')};
 return <><Modal className="ssh-key-dialog" title="SSH key details" onClose={onClose}>
  <dl className="ssh-key-details"><dt>Key name</dt><dd>{keyInfo.label}</dd><dt>Linked account</dt><dd>{keyInfo.username||'No linked account'}</dd><dt>Key type</dt><dd>{keyInfo.algorithm}</dd><dt>Source</dt><dd>{keyInfo.source==='managed'?'Generated in SIGNET':'Imported key'}</dd><dt>Created</dt><dd>{new Date(keyInfo.createdAt).toLocaleString()}</dd><dt>Fingerprint</dt><dd><code>{keyInfo.fingerprint}</code></dd><dt>Private-key location</dt><dd><code>{keyInfo.privateKeyPath}</code></dd></dl>
  <p className="ssh-key-account-note">The linked account is saved locally; it does not confirm current access on the server.</p>
  <DialogActions><button type="button" className="ssh-danger" disabled={!onRemove} onClick={()=>{setError('');setAction('delete')}}>Delete key</button><button type="button" disabled={!onUpdate} onClick={()=>{setLabel(keyInfo.label);setUsername(keyInfo.username||'');setError('');setAction('edit')}}>Edit key</button></DialogActions>
 </Modal>
 {action==='edit'&&<Modal className="ssh-key-dialog" title="Edit SSH key" onClose={dismiss} dismissDisabled={busy}><form onSubmit={e=>{e.preventDefault();void run(async()=>{await onUpdate!(keyInfo.keyId,{label:label.trim(),username:username.trim()||undefined});onAccountChanged(username.trim());dismiss()})}}><fieldset disabled={busy}><label>Key name<input required maxLength={120} value={label} onChange={e=>setLabel(e.target.value)}/></label><label>Key account (optional)<input maxLength={128} pattern="[a-zA-Z0-9_.@-]+" value={username} onChange={e=>setUsername(e.target.value)}/></label></fieldset>{error&&<p role="alert">{error}</p>}<DialogActions><button type="button" disabled={busy} onClick={dismiss}>Cancel edit</button><button type="submit" disabled={busy||!label.trim()}>{busy?'Saving…':'Save key changes'}</button></DialogActions></form></Modal>}
 {action==='delete'&&<ConfirmDialog title="Delete SSH key?" onCancel={dismiss} busy={busy} error={error} confirmLabel="Confirm delete" cancelLabel="Cancel delete" busyLabel="Deleting…" onConfirm={()=>void run(async()=>{await onRemove!(keyInfo.keyId);onClose()})}><p>Delete “{keyInfo.label}” from the saved list? Profiles using it will switch to Duo. Private-key files and remote authorization will be kept.</p></ConfirmDialog>}
 </>;
}
