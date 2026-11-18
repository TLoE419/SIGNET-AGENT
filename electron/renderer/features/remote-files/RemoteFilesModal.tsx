import {useCallback,useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Modal,DialogActions} from '../../components/Modal';

interface Entry {name:string;path:string;kind:'file'|'folder';size:number;supported:boolean}
interface Place {label:string;path:string}
type InputKind='genotype'|'expression'|'clinical';
export interface RemoteFilesTarget {
 key:string;label:string;current:string;datasetId?:string;inputKind?:InputKind;
 currentPaths?:string[];multiple?:boolean;language?:string;
}
export interface DatasetRecord {id:string;inputs:Partial<Record<InputKind,string[]>>;[key:string]:unknown}
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

export function RemoteFilesModal({target,onClose,onSelected,connected=true,connectionIdentity='',isCurrent=()=>true}:{
 target:RemoteFilesTarget;onClose:()=>void;onSelected:(record?:DatasetRecord)=>void;connected?:boolean;connectionIdentity?:string;isCurrent?:()=>boolean;
}){
 const dataset=Boolean(target.datasetId&&target.inputKind);
 const multiple=dataset&&Boolean(target.multiple);
 const english=target.language!=='zh-Hant';
 const label=(zh:string,en:string)=>english?en:zh;
 const targetKey=JSON.stringify([target.key,target.datasetId,target.inputKind,target.current,target.currentPaths,multiple]);
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
   if(reply.kind!=='folder'||typeof reply.path!=='string'||!Array.isArray(reply.entries))throw Error(label('無法讀取這個遠端目錄。','Could not read this remote folder.'));
   setFolder(reply.path);setTyped(reply.path);setEntries(reply.entries);setTruncated(Boolean(reply.truncated));
  }catch(e){if(valid(controller))setError((e as Error).message)}
  finally{if(browse.current===controller){browse.current=null;if(valid(controller))setLoading(false)}}
 },[scope,connected,valid,choose]);

 useEffect(()=>{
  closed.current=false;persisting.current=false;setPlaces([]);setFolder('');setTyped('');setEntries([]);setError('');setChecking(false);setSaving(false);setTruncated(false);
  const initial=(dataset?target.currentPaths??[target.current]:[target.current]).filter(path=>typeof path==='string'&&path.startsWith('/'));
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
   if(dataset){
    const checked=await request('/hpc/files/inspect',{paths},controller.signal);
    if(!valid(controller))return;
    if(checked.status!=='ok'){setError(failure(checked));return}
    const files=checked.files;
    if(!Array.isArray(files)||files.length!==paths.length||files.some(file=>!file||typeof file.path!=='string'||!file.path.startsWith('/')||!Number.isFinite(file.size)||file.size<=0)||new Set(files.map(file=>file.path)).size!==files.length){
     throw Error(label('檔案核對結果不完整，請重新選擇。','The file inspection result is incomplete. Choose the files again.'));
    }
    const canonical=files.map(file=>file.path);
    persisting.current=true;setChecking(false);setSaving(true);
    const record=await request<DatasetRecord>(`/signet/datasets/${encodeURIComponent(target.datasetId!)}`,{inputs:{[target.inputKind!]:canonical}},controller.signal,'PATCH');
    if(!valid(controller))return;
    if(record?.id!==target.datasetId||JSON.stringify(record.inputs?.[target.inputKind!])!==JSON.stringify(canonical))throw Error(label('儲存結果與這組資料或檔案不一致。','The saved result does not match this dataset and file selection.'));
    onSelected(record);
   }else{
    const reply=await request('/hpc/files/select',{key:target.key,path:paths[0]},controller.signal);
    if(!valid(controller))return;
    if(reply.status==='ok')onSelected();else setError(failure(reply));
   }
  }catch(e){if(valid(controller))setError((e as Error).message)}
  finally{if(save.current===controller){save.current=null;persisting.current=false;if(valid(controller)){setChecking(false);setSaving(false)}}}
 }
 const busy=loading||checking||saving||!connected;
 return createPortal(<Modal title={label(`選擇${target.label}`,`Choose ${target.label}`)} onClose={close} dismissDisabled={saving} className="remote-files-modal">
  <div className="remote-files" data-mode={dataset?'dataset':'reference'}>
   <nav className="remote-files-places" aria-label={label('位置','Locations')}>
    {places.map(place=><button key={place.path} type="button" disabled={busy} title={place.path} data-remote-shortcut={place.path} onClick={()=>void open(place.path)}>{place.label}</button>)}
   </nav>
   <div>
    <form className="remote-files-path" onSubmit={event=>{event.preventDefault();void open(typed.trim())}}>
     <button type="button" data-remote-up disabled={busy||!folder||folder==='/'} onClick={()=>void open(parent(folder))}>{label('上一層','Up')}</button>
     <input aria-label="HPC3 path" data-remote-path value={typed} disabled={busy} placeholder="/dfs7/your-lab/references" onChange={event=>setTyped(event.target.value)}/>
     <button type="submit" data-remote-go disabled={busy||!typed.trim()}>{label('前往','Go')}</button>
    </form>
    <ul className="remote-files-list" aria-label={label('檔案','Files')}>
     {entries.map(entry=><li key={entry.path}><button type="button" className="remote-files-row" disabled={busy||!entry.supported||multiple&&chosen.length>=128&&!chosen.includes(entry.path)&&entry.kind==='file'} aria-selected={chosen.includes(entry.path)}
       data-remote-entry-path={entry.path} data-entry-kind={entry.kind} title={entry.supported?entry.path:label('檔案路徑僅支援英文字母、數字、底線、連字號、句點及斜線。','Not supported: use only letters, numbers, _, -, . and / in the path.')}
       onClick={()=>entry.kind==='folder'?void open(entry.path):choose(entry.path)}>
      <span className="remote-files-name">{entry.kind==='folder'?`${entry.name}/`:entry.name}</span>
      {entry.kind==='file'&&<span className="remote-files-size" data-remote-size>{size(entry.size)}</span>}
     </button></li>)}
     {!loading&&!entries.length&&connected&&<li className="remote-files-note">{label('這裡沒有可見檔案。','No visible files here.')}</li>}
     {loading&&<li className="remote-files-note">{label('正在載入…','Loading…')}</li>}
     {truncated&&<li className="remote-files-note">{label('目前顯示前 2000 個項目，請輸入更完整的路徑。','Showing the first 2000 items. Type a longer path to narrow it down.')}</li>}
    </ul>
   </div>
  </div>
  <section className="remote-files-selected" aria-label={label('已選檔案','Selected files')}>
   <h3>{label('已選檔案','Selected files')} ({chosen.length}{multiple?'/128':''})</h3>
   <ul>{chosen.map(path=><li key={path} data-remote-selected-path={path}><code>{path}</code><button type="button" data-remote-remove disabled={checking||saving} aria-label={label(`移除 ${path}`,`Remove ${path}`)} onClick={()=>setChosen(previous=>previous.filter(value=>value!==path))}>{label('移除','Remove')}</button></li>)}</ul>
   {dataset&&<p>{label('此步驟僅核對路徑與檔案是否可讀。','This checks paths and file readability only.')}</p>}
  </section>
  {!connected&&<p role="alert" data-remote-error>{label('請先連線到遠端，再選擇檔案。','Connect to the remote server before choosing files.')}</p>}
  {(checking||saving)&&<p role="status" data-remote-state={saving?'saving':'checking'}>{saving?label('正在儲存資料組的檔案選擇…','Saving the dataset file selection…'):dataset?label('正在核對檔案是否可用…','Checking file availability…'):label('正在檢查檔案格式…','Checking the file format…')}</p>}
  {error&&<p role="alert" data-remote-error>{error}</p>}
  <DialogActions><button type="button" data-remote-cancel disabled={saving} onClick={close}>{label('取消','Cancel')}</button><button type="button" data-remote-apply className="ssh-primary" disabled={busy||!chosen.length} onClick={()=>void select()}>{dataset?label('套用檔案選擇','Apply file selection'):label('使用這個檔案','Use this file')}</button></DialogActions>
 </Modal>,document.body);
}

/** Bridges dataset and legacy reference controls to the same scoped dialog. */
export function RemoteFilesHost({connected=true,connectionIdentity=''}:{connected?:boolean;connectionIdentity?:string}={}){
 const [selection,setSelection]=useState<{target:RemoteFilesTarget;id:number}|null>(null);
 const sequence=useRef(0);
 const current=useRef<typeof selection>(null);
 useEffect(()=>{
  const listen=(event:Event)=>{const target=(event as CustomEvent<RemoteFilesTarget>).detail;if(target&&typeof target.key==='string'&&typeof target.label==='string'){current.current={target,id:++sequence.current};setSelection(current.current)}};
  const closeDataset=()=>{if(current.current?.target.datasetId){current.current=null;setSelection(null)}};
  window.addEventListener('open-remote-files',listen);window.addEventListener('close-dataset-remote-files',closeDataset);
  return()=>{current.current=null;window.removeEventListener('open-remote-files',listen);window.removeEventListener('close-dataset-remote-files',closeDataset)};
 },[]);
 useEffect(()=>{current.current=null;setSelection(null)},[connectionIdentity]);
 if(!selection)return null;
 const target=selection.target;
 return <RemoteFilesModal key={selection.id} target={target} connected={connected} connectionIdentity={connectionIdentity}
  isCurrent={()=>current.current?.id===selection.id} onClose={()=>{if(current.current?.id===selection.id){current.current=null;setSelection(null)}}} onSelected={record=>{
  if(current.current?.id!==selection.id)return;
  current.current=null;
  setSelection(null);
  if(target.datasetId&&target.inputKind&&record)window.dispatchEvent(new CustomEvent('dataset-files-selected',{detail:{datasetId:target.datasetId,inputKind:target.inputKind,record}}));
  else window.dispatchEvent(new Event('remote-file-selected'));
 }}/>;
}
