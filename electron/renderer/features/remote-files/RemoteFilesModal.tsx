import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Modal,DialogActions} from '../../components/Modal';

interface Entry {name:string;path:string;kind:'file'|'folder';size:number;supported:boolean}
interface Place {label:string;path:string}
type InputKind='genotype'|'expression'|'clinical';
type ReferenceKind='ref'|'gmap'|'gtf';
export type RemoteFilesTarget = {
 key:string;label:string;current:string;datasetId:string;
 currentPaths?:string[];multiple?:boolean;
} & ({inputKind:InputKind;referenceKind?:never}|{referenceKind:ReferenceKind;inputKind?:never});
export interface DatasetRecord {
 id:string;inputs:Partial<Record<InputKind,string[]>>;references?:Partial<Record<ReferenceKind,string>>;[key:string]:unknown;
}
type Reply={status?:string;error?:string;reason?:string;path?:string;kind?:string;entries?:Entry[];truncated?:boolean;shortcuts?:Place[];files?:{path:string;size:number}[]};

/** File metadata stays on these local routes and never enters the conversation. */
async function request<T=Reply>(path:string,body:object={},signal?:AbortSignal,method='POST'):Promise<T>{
 const token=document.querySelector<HTMLMetaElement>('meta[name="chat-token"]')?.content||'';
 const response=await fetch(path,{method,body:JSON.stringify(body),signal,headers:{'Content-Type':'application/json','X-Chat-Token':token}});
 const value=await response.json();
 if(!response.ok)throw Error(value?.error||value?.reason||'The local service refused the request.');
 return value;
}
const failure=(reply:Reply)=>reply.error||reply.reason||'The HPC3 command did not complete.';
function size(bytes:number){
 let value=bytes;
 for(const unit of ['B','KB','MB','GB']){if(value<1024||unit==='GB')return unit==='B'?`${value} B`:`${value.toFixed(1)} ${unit}`;value/=1024}
 return '';
}
const parent=(path:string)=>path.slice(0,path.lastIndexOf('/'))||'/';

function FileIcon({folder=false}:{folder?:boolean}){
 return <svg className="remote-files-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
  {folder?<path d="M3 19V5h6l2 2h10v12z"/>:<path d="M6 3h8l4 4v14H6z M14 3v5h4 M9 13h6 M9 17h6"/>}
 </svg>;
}

function SelectedFileLocation({path,filename}:{path:string;filename:string}){
 const panelId=useId();
 const [status,setStatus]=useState('');
 const directory=parent(path);
 const lastFolder=directory.lastIndexOf('/');
 const label=`Full path for ${filename}`;

 async function copyPath(){
  const desktop=(window as Window & {signetDesktop?:{copyFilePath(path:string):Promise<void>}}).signetDesktop;
  try{
   if(!desktop)throw Error('Clipboard unavailable.');
   await desktop.copyFilePath(path);
   setStatus('Path copied.');
  }catch{
   setStatus('Could not copy the path. You can select and copy it above.');
  }
 }

 return <div className="ml-file-location">
  <code className="ml-file-directory" dir="ltr"><span className="ml-file-directory-prefix">{directory.slice(0,lastFolder)}</span><span className="ml-file-directory-tail"><bdi dir="ltr">{directory.slice(lastFolder)}</bdi></span></code>
  <button type="button" className="ml-file-path-trigger" aria-label={label} popoverTarget={panelId}>Full path</button>
  <div id={panelId} className="ml-file-path-panel" popover="auto" role="region" aria-label={label}
   onBeforeToggle={()=>setStatus('')}>
   <header>
    <strong>Full path</strong>
    <button type="button" data-copy-file-path onClick={()=>void copyPath()}>Copy path</button>
   </header>
   <code data-full-file-path dir="ltr">{path}</code>
   <p data-file-path-status role="status">{status}</p>
  </div>
 </div>;
}

export function RemoteFilesModal({target,onClose,onSelected,connected=true,connectionIdentity='',isCurrent=()=>true}:{
 target:RemoteFilesTarget;onClose:()=>void;onSelected:(record:DatasetRecord)=>void;connected?:boolean;connectionIdentity?:string;isCurrent?:()=>boolean;
}){
 const {datasetId,inputKind,referenceKind}=target;
 const multiple=inputKind==='genotype'&&Boolean(target.multiple);
 const pathId=useId(),selectedTitleId=useId();
 const targetKey=JSON.stringify([target.key,datasetId,inputKind,referenceKind,target.current,target.currentPaths,multiple]);
 const scope=JSON.stringify([targetKey,connected,connectionIdentity]);
 const latest=useRef(scope);latest.current=scope;
 const closed=useRef(false);
 const persisting=useRef(false);
 const browse=useRef<AbortController|null>(null),bootstrap=useRef<AbortController|null>(null),save=useRef<AbortController|null>(null);
 const [places,setPlaces]=useState<Place[]>([]),[folder,setFolder]=useState(''),[typed,setTyped]=useState(''),[entries,setEntries]=useState<Entry[]>([]),[truncated,setTruncated]=useState(false);
 const [chosen,setChosen]=useState<string[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true),[checking,setChecking]=useState(false),[saving,setSaving]=useState(false);
 const valid=useCallback((controller:AbortController)=>!closed.current&&!controller.signal.aborted&&latest.current===scope&&isCurrent(),[scope,isCurrent]);
 const cancelRequests=()=>{browse.current?.abort();bootstrap.current?.abort();save.current?.abort();browse.current=bootstrap.current=save.current=null;};
 const close=()=>{if(closed.current||persisting.current)return;closed.current=true;cancelRequests();onClose();};

 const choose=useCallback((path:string,toggle=true)=>{
  setError('');
  setChosen(previous=>{
   if(!multiple)return [path];
   if(previous.includes(path))return toggle?previous.filter(selected=>selected!==path):previous;
   if(previous.length>=128)return previous;
   return [...previous,path];
  });
 },[multiple]);

 const open=useCallback(async(path:string)=>{
  if(!connected||closed.current||save.current||!isCurrent())return;
  browse.current?.abort();
  const controller=new AbortController();browse.current=controller;
  setLoading(true);setError('');
  try{
   let reply=await request('/hpc/files/list',{path},controller.signal);
   if(!valid(controller))return;
   if(reply.status!=='ok'){setError(failure(reply));return}
   if(reply.kind==='file'&&reply.path){
    choose(reply.path,false);
    reply=await request('/hpc/files/list',{path:parent(reply.path)},controller.signal);
    if(!valid(controller))return;
    if(reply.status!=='ok'){setError(failure(reply));return}
   }
   if(reply.kind!=='folder'||typeof reply.path!=='string'||!Array.isArray(reply.entries))throw Error('Could not read this remote folder.');
   setFolder(reply.path);setTyped(reply.path);setEntries(reply.entries);setTruncated(Boolean(reply.truncated));
  }catch(e){if(valid(controller))setError((e as Error).message)}
  finally{if(browse.current===controller){browse.current=null;if(valid(controller))setLoading(false)}}
 },[scope,connected,valid,choose]);

 useEffect(()=>{
  closed.current=false;persisting.current=false;setPlaces([]);setFolder('');setTyped('');setEntries([]);setError('');setChecking(false);setSaving(false);setTruncated(false);
  const initial=(referenceKind?[target.current]:target.currentPaths??[target.current]).filter(path=>typeof path==='string'&&path.startsWith('/'));
  setChosen(multiple?[...new Set(initial)].slice(0,128):initial.slice(0,1));
  if(!connected){setLoading(false);return()=>{closed.current=true;cancelRequests()}}
  const controller=new AbortController();bootstrap.current=controller;setLoading(true);
  void(async()=>{
   try{
    const reply=await request('/hpc/files/shortcuts',{},controller.signal);
    if(!valid(controller))return;
    if(reply.status!=='ok'||!Array.isArray(reply.shortcuts)){setError(failure(reply));setLoading(false);return}
    setPlaces(reply.shortcuts);
    const current=initial[0];
    const start=current?parent(current):reply.shortcuts.find(place=>place.label.startsWith('Personal'))?.path||reply.shortcuts[0]?.path;
    if(start)await open(start);else setLoading(false);
   }catch(e){if(valid(controller)){setError((e as Error).message);setLoading(false)}}
   finally{if(bootstrap.current===controller)bootstrap.current=null}
  })();
  return()=>{closed.current=true;cancelRequests()};
 },[scope]);

 async function select(){
  if(!connected||closed.current||loading||save.current||!chosen.length||!isCurrent())return;
  const paths=[...chosen],controller=new AbortController();save.current=controller;
  setChecking(true);setSaving(false);setError('');
  try{
   const checked=await request('/hpc/files/inspect',{paths},controller.signal);
   if(!valid(controller))return;
   if(checked.status!=='ok'){setError(failure(checked));return}
   const files=checked.files;
   if(!Array.isArray(files)||files.length!==paths.length||files.some(file=>!file||typeof file.path!=='string'||!file.path.startsWith('/')||!Number.isFinite(file.size)||file.size<=0)||new Set(files.map(file=>file.path)).size!==files.length){
    throw Error('The file inspection result is incomplete. Choose the files again.');
   }
   const canonical=files.map(file=>file.path);
   persisting.current=true;setChecking(false);setSaving(true);
   const selection=referenceKind
    ?{references:{[referenceKind]:canonical[0]}}
    :{inputs:{[inputKind!]:canonical}};
   const record=await request<DatasetRecord>(`/signet/datasets/${encodeURIComponent(datasetId)}`,selection,controller.signal,'PATCH');
   if(!valid(controller))return;
   const matchesSelection=referenceKind?record?.references?.[referenceKind]===canonical[0]
    :JSON.stringify(record?.inputs?.[inputKind!])===JSON.stringify(canonical);
   if(record?.id!==datasetId||!matchesSelection)throw Error('The saved result does not match this dataset and file selection.');
   onSelected(record);
  }catch(e){if(valid(controller))setError((e as Error).message)}
  finally{if(save.current===controller){save.current=null;persisting.current=false;if(valid(controller)){setChecking(false);setSaving(false)}}}
 }
 const busy=loading||checking||saving||!connected;
 const targetName=target.label.charAt(0).toLowerCase()+target.label.slice(1);
 const selectionHint=multiple?'Choose one matching PED and MAP file pair.':'Choose one file.';
 return createPortal(<Modal title={`Choose ${targetName}`} onClose={close} dismissDisabled={saving} className="remote-files-modal">
  <div className="remote-files" data-mode="dataset">
   {places.length>0&&<nav className="remote-files-places" aria-label="Quick locations">
    <span aria-hidden="true">Quick locations</span>
    {places.map(place=><button key={place.path} type="button" disabled={busy} title={place.path}
     aria-current={folder===place.path?'location':undefined} data-remote-shortcut={place.path}
     onClick={()=>void open(place.path)}>{place.label}</button>)}
   </nav>}
   <form className="remote-files-path" onSubmit={event=>{event.preventDefault();void open(typed.trim())}}>
    <label htmlFor={pathId}>Remote path</label>
    <div>
     <button type="button" data-remote-up disabled={busy||!folder||folder==='/'} onClick={()=>void open(parent(folder))}>
      <svg className="remote-files-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>
      Up
     </button>
     <input id={pathId} data-remote-path value={typed} disabled={busy} placeholder="/pub/username" spellCheck={false} onChange={event=>setTyped(event.target.value)}/>
     <button type="submit" data-remote-go disabled={busy||!typed.trim()}>Go</button>
    </div>
   </form>
   <div className="remote-files-grid">
    <div className="remote-files-browser">
     <div className="remote-files-list-header" aria-hidden="true">
      <span>Name</span><span>Size</span>
     </div>
     <ul className="remote-files-list" aria-label="Folder contents" aria-busy={loading}>
      {entries.map(entry=>{
       const isFolder=entry.kind==='folder';
       const selected=chosen.includes(entry.path);
       return <li key={entry.path}><button type="button" className="remote-files-row"
        disabled={busy||!entry.supported||multiple&&chosen.length>=128&&!selected&&!isFolder}
        aria-pressed={isFolder?undefined:selected} data-remote-entry-path={entry.path} data-entry-kind={entry.kind}
        title={entry.supported?entry.path:'Not supported: use only letters, numbers, _, -, . and / in the path.'}
        onClick={()=>isFolder?void open(entry.path):choose(entry.path)}>
        <FileIcon folder={isFolder}/>
        <span className="remote-files-name">{entry.name}{isFolder?"/":""}</span>
        {!isFolder&&<span className="remote-files-size" data-remote-size>{size(entry.size)}</span>}
        <span className="remote-files-marker" aria-hidden="true"/>
       </button></li>;
      })}
      {!loading&&!entries.length&&connected&&<li className="remote-files-note">No visible files here.</li>}
      {loading&&<li className="remote-files-note" role="status">Loading…</li>}
      {truncated&&<li className="remote-files-note">Showing the first 2000 items. Type a longer path to narrow it down.</li>}
     </ul>
    </div>
    <section className="remote-files-selected" aria-labelledby={selectedTitleId}>
     <div className="remote-files-selected-heading">
      <h3 id={selectedTitleId}>Selected files</h3>
      <span aria-live="polite">{`${chosen.length} selected`}</span>
     </div>
     <p className="remote-files-hint">{selectionHint}</p>
     {chosen.length>0?<ul>{chosen.map(path=>{
      const filename=path.slice(path.lastIndexOf('/')+1);
      return <li key={path} data-remote-selected-path={path}>
       <FileIcon/>
       <strong>{filename}</strong>
       <button type="button" data-remote-remove disabled={checking||saving} aria-label={`Remove ${path}`}
        onClick={()=>{setChosen(previous=>previous.filter(value=>value!==path));setError('')}}>Remove</button>
       <SelectedFileLocation path={path} filename={filename}/>
      </li>;
     })}</ul>:<div className="remote-files-empty">
      <FileIcon/><span>No files selected</span>
     </div>}
    </section>
   </div>
   {!connected&&<p role="alert" data-remote-error>Connect to the remote server before choosing files.</p>}
   {(checking||saving)&&<p role="status" data-remote-state={saving?'saving':'checking'}>{saving?'Saving the dataset file selection…':'Checking file availability…'}</p>}
   {error&&<p role="alert" data-remote-error>{error}</p>}
  </div>
  <DialogActions>
   <p className="remote-files-apply-note">Files are checked for readability before saving.</p>
   <button type="button" data-remote-cancel disabled={saving} onClick={close}>Cancel</button>
   <button type="button" data-remote-apply className="ssh-primary" disabled={busy||!chosen.length} onClick={()=>void select()}>Apply file selection</button>
  </DialogActions>
 </Modal>,document.body);
}

/** Opens a file picker scoped to the active dataset. */
export function RemoteFilesHost({connected=true,connectionIdentity=''}:{connected?:boolean;connectionIdentity?:string}={}){
 const [selection,setSelection]=useState<{target:RemoteFilesTarget;id:number;trigger:HTMLElement|null}|null>(null);
 const sequence=useRef(0);
 const current=useRef<typeof selection>(null);
 const returnFocus=useRef<HTMLElement|null>(null);
 useEffect(()=>{
  const listen=(event:Event)=>{
   const target=(event as CustomEvent<RemoteFilesTarget>).detail;
   if(!target||typeof target.key!=='string'||typeof target.label!=='string'||!target.datasetId||
     !(target.inputKind||target.referenceKind))return;
   const active=document.activeElement;
   returnFocus.current=null;
   current.current={target,id:++sequence.current,trigger:active instanceof HTMLElement?active:null};
   setSelection(current.current);
  };
  const closeDataset=()=>{current.current=null;setSelection(null)};
  window.addEventListener('open-remote-files',listen);window.addEventListener('close-dataset-remote-files',closeDataset);
  return()=>{current.current=null;window.removeEventListener('open-remote-files',listen);window.removeEventListener('close-dataset-remote-files',closeDataset)};
 },[]);
 useEffect(()=>{returnFocus.current=null;current.current=null;setSelection(null)},[connectionIdentity]);
 useEffect(()=>{
  if(selection)return;
  const trigger=returnFocus.current;
  returnFocus.current=null;
  if(document.activeElement===document.body&&trigger?.isConnected&&trigger.getClientRects().length){
   trigger.focus({preventScroll:true});
  }
 },[selection]);
 if(!selection)return null;
 const target=selection.target;
 const dismiss=()=>{
  if(current.current?.id!==selection.id)return false;
  returnFocus.current=selection.trigger;
  current.current=null;
  setSelection(null);
  return true;
 };
 return <RemoteFilesModal key={selection.id} target={target} connected={connected} connectionIdentity={connectionIdentity}
  isCurrent={()=>current.current?.id===selection.id} onClose={dismiss} onSelected={record=>{
  if(!dismiss())return;
  if(target.referenceKind)window.dispatchEvent(new CustomEvent('dataset-reference-selected',{detail:{datasetId:target.datasetId,referenceKind:target.referenceKind,record}}));
  else window.dispatchEvent(new CustomEvent('dataset-files-selected',{detail:{datasetId:target.datasetId,inputKind:target.inputKind,record}}));
 }}/>;
}
