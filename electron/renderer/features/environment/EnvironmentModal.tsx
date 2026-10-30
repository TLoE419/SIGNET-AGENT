import {useEffect,useState,type ReactNode} from 'react';
import {Modal,DialogActions} from '../../components/Modal';
import {environmentLabels,type EnvironmentBridge,type EnvironmentSnapshot} from '../../../shared/environment/types';
export function EnvironmentModal({snapshot,bridge,onClose,diagnostics}:{diagnostics?:ReactNode;snapshot:EnvironmentSnapshot;bridge:EnvironmentBridge;onClose:()=>void}){
 const [root,setRoot]=useState(snapshot.config?.root||''),[partition,setPartition]=useState(snapshot.config?.partition||''),[confirm,setConfirm]=useState(false),[error,setError]=useState(''),[pending,setPending]=useState(false);
 const settingsChanged=root!==(snapshot.config?.root||'')||partition!==(snapshot.config?.partition||'');
 const busy=pending||['checking','installing-source','installing-image','verifying'].includes(snapshot.phase);
 useEffect(()=>{if(snapshot.config){setRoot(snapshot.config.root);setPartition(snapshot.config.partition)}},[snapshot.config?.root,snapshot.config?.partition]);
 async function run(action:()=>ReturnType<EnvironmentBridge['check']>){setError('');setPending(true);try{const result=await action();if(!result.ok)throw Error(result.error||'Environment operation failed.')}catch(e){setError((e as Error).message)}finally{setPending(false)}}
 return <><Modal title="Remote SIGNET environment" onClose={onClose} className="ssh-environment-modal">
  <p role="status">{environmentLabels[snapshot.phase]}</p><p>{snapshot.message}</p>
  <label>Installation root<input value={root} placeholder="Default: ~/.local/share/signet-agent" disabled={busy} onChange={e=>setRoot(e.target.value)}/></label>
  <label>Slurm partition<input value={partition} placeholder="Use scheduler default" disabled={busy} onChange={e=>setPartition(e.target.value)}/></label>
  {snapshot.config&&<dl className="ssh-key-details"><dt>Source revision</dt><dd><code>{snapshot.config.revision}</code></dd><dt>Container</dt><dd><code>{snapshot.config.image}</code></dd><dt>Runtime</dt><dd><code>{snapshot.config.executor||'Not found'}</code></dd><dt>Run directory</dt><dd><code>{snapshot.config.workRoot}</code></dd></dl>}
  <p>Choose a writable location accessible to your compute jobs. Environment checks do not submit jobs or validate study inputs. Existing installations are never overwritten.</p>
  {error&&<p role="alert">{error}</p>}
  {diagnostics}
  <DialogActions><button type="button" disabled={busy||snapshot.phase==='disconnected'} onClick={()=>void run(()=>bridge.check(root,partition))}>Check environment</button>{snapshot.phase==='needs-install'&&<button type="button" className="ssh-primary" disabled={busy||settingsChanged} onClick={()=>setConfirm(true)}>Install missing components…</button>}</DialogActions>
 </Modal>
 {confirm&&<Modal title="Install SIGNET environment?" className="ssh-key-dialog" onClose={()=>setConfirm(false)}>
  <p>Download the pinned SIGNET source and container 0.0.6 into <code>{snapshot.config?.root}</code>?</p><p>The download may take several minutes. Study data is not included and shell startup files are not changed.</p>
  <DialogActions><button type="button" onClick={()=>setConfirm(false)}>Cancel</button><button type="button" className="ssh-primary" onClick={()=>{setConfirm(false);void run(()=>bridge.install())}}>Install environment</button></DialogActions>
 </Modal>}
 </>;
}
