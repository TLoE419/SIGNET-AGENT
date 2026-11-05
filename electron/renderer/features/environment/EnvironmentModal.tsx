import {useEffect,useState,type ReactNode} from 'react';
import {Modal,DialogActions} from '../../components/Modal';
import {environmentLabels,type EnvironmentBridge,type EnvironmentSnapshot} from '../../../shared/environment/types';
export function EnvironmentModal({snapshot,bridge,onClose,diagnostics}:{diagnostics?:ReactNode;snapshot:EnvironmentSnapshot;bridge:EnvironmentBridge;onClose:()=>void}){
 const [root,setRoot]=useState(snapshot.config?.root||''),[partition,setPartition]=useState(snapshot.config?.partition||''),[error,setError]=useState(''),[pending,setPending]=useState(false);
 const busy=pending||['checking','installing-source','verifying'].includes(snapshot.phase);
 useEffect(()=>{if(snapshot.config){setRoot(snapshot.config.root);setPartition(snapshot.config.partition)}},[snapshot.config?.root,snapshot.config?.partition]);
 async function run(action:()=>ReturnType<EnvironmentBridge['check']>){setError('');setPending(true);try{const result=await action();if(!result.ok)throw Error(result.error||'Environment operation failed.')}catch(e){setError((e as Error).message)}finally{setPending(false)}}
 return <Modal title="HPC3 settings" onClose={onClose} className="ssh-environment-modal">
  <p role="status">{environmentLabels[snapshot.phase]}</p><p>{snapshot.message}</p>
  <label>Installation root<input value={root} placeholder="Default: /pub/<you>/signet-agent" disabled={busy} onChange={e=>setRoot(e.target.value)}/></label>
  <label>Slurm partition<input value={partition} placeholder="Use scheduler default" disabled={busy} onChange={e=>setPartition(e.target.value)}/></label>
  {snapshot.config&&<dl className="ssh-key-details"><dt>Source revision</dt><dd><code>{snapshot.config.revision}</code></dd><dt>Container</dt><dd><code>{snapshot.config.image}</code></dd><dt>Runtime</dt><dd><code>{snapshot.config.executor||'Not found'}</code></dd><dt>Runtime module</dt><dd><code>{snapshot.config.runtimeModule||'Not required / not detected'}</code></dd><dt>Run directory</dt><dd><code>{snapshot.config.workRoot}</code></dd></dl>}
  <p>Choose a writable location accessible to your compute jobs. Install SIGNET and download the container from the Workflow panel. Existing installations are never overwritten.</p>
  {error&&<p role="alert">{error}</p>}
  {diagnostics}
  <DialogActions><button type="button" disabled={busy||snapshot.phase==='disconnected'} onClick={()=>void run(()=>bridge.check(root,partition))}>Check environment</button></DialogActions>
 </Modal>;
}
