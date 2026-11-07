import {useCallback,useEffect,useState} from 'react';
import {Modal,DialogActions} from '../../components/Modal';

interface Entry {name:string;path:string;kind:'file'|'folder';size:number;supported:boolean}
interface Place {label:string;path:string}
interface Target {key:string;label:string;current:string}
type Reply={status:string;error?:string;reason?:string;path?:string;kind?:string;entries?:Entry[];truncated?:boolean;shortcuts?:Place[]};

/** Same local route protections as the workflow panel; these paths never join the conversation. */
async function post(path:string,body:object={}):Promise<Reply>{
 const token=document.querySelector<HTMLMetaElement>('meta[name="chat-token"]')?.content||'';
 const response=await fetch(path,{method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json','X-Chat-Token':token}});
 const value=await response.json();
 if(!response.ok)throw Error(value.error||'The local service refused the request.');
 return value;
}
const failure=(reply:Reply)=>reply.error||reply.reason||'The HPC3 command did not complete.';
function size(bytes:number){
 let value=bytes;
 for(const unit of ['B','KB','MB','GB']){if(value<1024||unit==='GB')return unit==='B'?`${value} B`:`${value.toFixed(1)} ${unit}`;value/=1024}
 return '';
}
const parent=(path:string)=>path.slice(0,path.lastIndexOf('/'))||'/';

export function RemoteFilesModal({target,onClose,onSelected}:{target:Target;onClose:()=>void;onSelected:()=>void}){
 const [places,setPlaces]=useState<Place[]>([]),[folder,setFolder]=useState(''),[typed,setTyped]=useState(''),[entries,setEntries]=useState<Entry[]>([]),[truncated,setTruncated]=useState(false);
 const [chosen,setChosen]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(true),[checking,setChecking]=useState(false);
 const open=useCallback(async(path:string)=>{
  setLoading(true);setError('');
  try{
   const reply=await post('/hpc/files/list',{path});
   if(reply.status!=='ok'){setError(failure(reply));return}
   if(reply.kind==='file'){setChosen(reply.path!);setTyped(reply.path!);if(!folder)await open(parent(reply.path!));return}
   setFolder(reply.path!);setTyped(reply.path!);setEntries(reply.entries||[]);setTruncated(!!reply.truncated);setChosen('');
  }catch(e){setError((e as Error).message)}
  finally{setLoading(false)}
 },[folder]);
 useEffect(()=>{let live=true;void (async()=>{
  try{
   const reply=await post('/hpc/files/shortcuts');
   if(!live)return;
   if(reply.status!=='ok'){setError(failure(reply));setLoading(false);return}
   setPlaces(reply.shortcuts||[]);
   const start=target.current?parent(target.current):reply.shortcuts?.find(place=>place.label.startsWith('Personal'))?.path||reply.shortcuts?.[0]?.path;
   if(start)await open(start);else setLoading(false);
  }catch(e){if(live){setError((e as Error).message);setLoading(false)}}
 })();return()=>{live=false}// eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);
 async function select(){
  setChecking(true);setError('');
  try{
   const reply=await post('/hpc/files/select',{key:target.key,path:chosen});
   if(reply.status==='ok')onSelected();else setError(failure(reply));
  }catch(e){setError((e as Error).message)}
  finally{setChecking(false)}
 }
 const busy=loading||checking;
 return <Modal title={`Choose ${target.label}`} onClose={onClose} className="remote-files-modal">
  <div className="remote-files">
   <nav className="remote-files-places" aria-label="Locations">
    {places.map(place=><button key={place.path} type="button" disabled={busy} title={place.path} onClick={()=>void open(place.path)}>{place.label}</button>)}
   </nav>
   <div>
    <form className="remote-files-path" onSubmit={event=>{event.preventDefault();void open(typed.trim())}}>
     <button type="button" disabled={busy||!folder||folder==='/'} onClick={()=>void open(parent(folder))}>Up</button>
     <input aria-label="HPC3 path" value={typed} disabled={busy} placeholder="/dfs7/your-lab/references" onChange={event=>setTyped(event.target.value)}/>
     <button type="submit" disabled={busy||!typed.trim()}>Go</button>
    </form>
    <ul className="remote-files-list" aria-label="Files">
     {entries.map(entry=><li key={entry.path}><button type="button" className="remote-files-row" disabled={busy||!entry.supported} aria-selected={chosen===entry.path}
       title={entry.supported?entry.path:'Not supported: use only letters, numbers, _, -, . and / in the path.'}
       onClick={()=>entry.kind==='folder'?void open(entry.path):setChosen(entry.path)}>
      <span className="remote-files-name">{entry.kind==='folder'?`${entry.name}/`:entry.name}</span>
      {entry.kind==='file'&&<span className="remote-files-size">{size(entry.size)}</span>}
     </button></li>)}
     {!loading&&!entries.length&&<li className="remote-files-note">No visible files here.</li>}
     {loading&&<li className="remote-files-note">Loading…</li>}
     {truncated&&<li className="remote-files-note">Showing the first 2000 items. Type a longer path to narrow it down.</li>}
    </ul>
   </div>
  </div>
  {checking&&<p role="status">Checking the file format…</p>}
  {error&&<p role="alert">{error}</p>}
  <DialogActions><button type="button" onClick={onClose}>Cancel</button><button type="button" className="ssh-primary" disabled={busy||!chosen} onClick={()=>void select()}>Use this file</button></DialogActions>
 </Modal>;
}

/** Bridges the plain-script workflow panel to this React dialog. */
export function RemoteFilesHost(){
 const [target,setTarget]=useState<Target|null>(null);
 useEffect(()=>{
  const listen=(event:Event)=>setTarget((event as CustomEvent<Target>).detail);
  window.addEventListener('open-remote-files',listen);
  return()=>window.removeEventListener('open-remote-files',listen);
 },[]);
 if(!target)return null;
 return <RemoteFilesModal key={target.key} target={target} onClose={()=>setTarget(null)} onSelected={()=>{setTarget(null);window.dispatchEvent(new Event('remote-file-selected'))}}/>;
}
