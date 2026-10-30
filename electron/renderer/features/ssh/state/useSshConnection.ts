import {useEffect,useRef,useState} from 'react';
import type {Snapshot,SshConnectionPort,FormInput,SshError} from '../../../../shared/ssh/types';
export function useSshConnection(port:SshConnectionPort){
 const [snapshot,setSnapshot]=useState<Snapshot>({selectedProfile:null,connection:null});const [error,setError]=useState<SshError|null>(null);const [busy,setBusy]=useState(false);const locked=useRef(false);const savedId=useRef<string|undefined>(undefined);
 useEffect(()=>{let active=true,received=false;const off=port.subscribe(s=>{received=true;if(active){savedId.current=s.selectedProfile?.id;setSnapshot(s)}});void port.initialize().then(s=>{if(active&&!received){savedId.current=s.selectedProfile?.id;setSnapshot(s)}}).catch(e=>{if(active)setError({code:e.code||'UNKNOWN',message:e.message})});return ()=>{active=false;off()}},[port]);
 async function run(fn:()=>Promise<void>){if(locked.current)return;locked.current=true;setBusy(true);setError(null);try{await fn()}catch(e){const v=e as SshError;if(!['PASSPHRASE_REQUIRED','PASSWORD_REQUIRED'].includes(v.code))setError({code:v.code||'UNKNOWN',message:v.message||'SSH operation failed.'});throw e}finally{locked.current=false;setBusy(false)}}
 return {snapshot,error,busy,save:(input:FormInput)=>run(async()=>{const p=await port.saveProfile({...input,id:input.id||savedId.current});savedId.current=p.id;setSnapshot({selectedProfile:p,connection:{profileId:p.id,status:'disconnected'}})}),
  connect:(input:FormInput,passphrase='')=>run(async()=>{const p=await port.saveProfile({...input,id:input.id||savedId.current});savedId.current=p.id;await port.connect(p.id,passphrase)}),
  connectSaved:(passphrase='')=>run(async()=>{const id=savedId.current;if(!id)throw Object.assign(new Error('Configure an SSH profile first. Click the connection details to open settings.'),{code:'INVALID_PROFILE'});await port.connect(id,passphrase)}),
  disconnect:async()=>{const p=snapshot.selectedProfile;if(p)await port.disconnect(p.id)},
  healthCheck:(force=false)=>run(async()=>{await port.healthCheck(force)}),
  trustHost:()=>run(async()=>{if(snapshot.pendingHost)await port.trustHost(snapshot.pendingHost)}),inspect:(path:string)=>port.inspectPrivateKey(path),pickKey:()=>port.pickPrivateKey()};
}
