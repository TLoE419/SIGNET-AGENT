import {useEffect,useId,useRef,useState} from 'react';

export type Provider='codex'|'gemini'|'groq';
export interface ModelStatus {provider:Provider;geminiConfigured:boolean;encryptionAvailable:boolean}
type Result<T>={ok:true;value:T}|{ok:false;error:{code:string;message:string}};
export interface ModelBridge {
 getStatus():Promise<Result<ModelStatus>>;
 saveGeminiKey(key:string):Promise<Result<{restarting:boolean}>>;
 clearGeminiKey():Promise<Result<{restarting:boolean}>>;
}
async function unwrap<T>(pending:Promise<Result<T>>){const result=await pending;if(!result.ok)throw Object.assign(Error(result.error.message),{code:result.error.code});return result.value}

const providerNames:Record<Provider,string>={codex:'Codex CLI',gemini:'Gemini',groq:'Groq'};
type BlockStatus='unconfigured'|'disconnected'|'connected'|'connecting'|'error';
const labels:Record<BlockStatus,string>={unconfigured:'Not configured',disconnected:'Saved',connected:'Active',connecting:'Restarting…',error:'Error'};

/** Status contains no saved key; only newly entered credentials pass through the form. */
export function ModelStatusBlock({status,error,restarting,onEdit}:{status:ModelStatus|null;error?:string;restarting?:boolean;onEdit:()=>void}){
 const state:BlockStatus=restarting?'connecting':error?'error':!status?'unconfigured':status.provider==='gemini'?'connected':status.geminiConfigured?'disconnected':'unconfigured';
 const subtitle=state==='connecting'?'Restarting the assistant…':state==='error'?error:state==='connected'?(status!.geminiConfigured?'Chat uses Gemini · key in Keychain':'Chat uses Gemini · key from .env'):status?`Chat uses ${providerNames[status.provider]}`:'Checking model settings…';
 return <section className="ssh-status-block model-status-block" data-status={state} aria-label="Model connection" onClick={e=>{if(!(e.target as HTMLElement).closest('button'))onEdit()}}>
  <button type="button" className="ssh-identity" onClick={onEdit} aria-label="Edit Gemini API settings" title={`Gemini API\n${labels[state]}`}>
   <span className="ssh-status-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {state==='error'?<><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v4m0 3h.01"/></>:<><path d="M12 3c.6 4.6 3.4 7.4 8 8-4.6.6-7.4 3.4-8 8-.6-4.6-3.4-7.4-8-8 4.6-.6 7.4-3.4 8-8Z"/></>}
   </svg></span>
   <span className="ssh-status-copy"><span className="ssh-status-heading"><strong>Gemini API</strong><span className="ssh-protocol">LLM</span><span className="ssh-state-text">{labels[state]}</span></span><span className="ssh-status-subtitle">{subtitle}</span></span>
  </button>
  <span className="ssh-status-divider" aria-hidden="true"/>
  <span className="ssh-badge ssh-indicator"><span className="ssh-led" aria-hidden="true"/><span className="ssh-badge-label">{labels[state]}</span></span>
 </section>;
}

export function GeminiKeyModal({open,status,onSave,onClear,onClose,english=true,model}:{english?:boolean;model?:string;open:boolean;status:ModelStatus|null;onSave:(key:string)=>Promise<{restarting:boolean}>;onClear:()=>Promise<{restarting:boolean}>;onClose:()=>void}){
 const t=(zh:string,en:string)=>english?en:zh;
 const dialog=useRef<HTMLDialogElement>(null),id=useId(),lock=useRef(false);
 const [key,setKey]=useState(''),[working,setWorking]=useState<'saving'|'clearing'|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
 useEffect(()=>{setKey('');setError('');setNotice('');if(open)dialog.current?.showModal();else dialog.current?.close()},[open]);
 const close=()=>{if(working)return;setKey('');onClose()};
 async function run(kind:'saving'|'clearing'){
  if(lock.current||!status||(kind==='saving'&&(!status.encryptionAvailable||!key.trim())))return;lock.current=true;setWorking(kind);setError('');setNotice('');const secret=key;setKey('');
  try{const result=kind==='saving'?await onSave(secret.trim()):await onClear();if(result.restarting)setNotice(kind==='saving'?t('金鑰已驗證並儲存，正在以 Gemini 重新啟動助理…','Key verified and saved. Restarting the assistant with Gemini…'):t('金鑰已移除，正在重新啟動助理…','Key removed. Restarting the assistant without Gemini…'));else onClose()}
  catch(e){
   const messages:Record<string,string>={KEY_INVALID:'金鑰格式不正確。',KEY_REJECTED:'Google 拒絕此金鑰，請確認後重試。',NETWORK:'無法連線至 Google，請檢查網路後重試。',UNAVAILABLE:'Google 服務暫時無法使用，請稍後重試。',ENCRYPTION_UNAVAILABLE:'系統安全儲存無法使用，金鑰未儲存。',BUSY:'模型正在變更中，請稍候。'};
   setError(english?(e as Error).message:messages[(e as {code?:string}).code||'']||'設定未完成，請檢查系統安全儲存後重試。');
  }finally{lock.current=false;setWorking(null)}
 }
 const unavailable=!status||status.encryptionAvailable===false;
 return <dialog ref={dialog} className="ssh-modal model-key-modal" aria-labelledby={id} onClose={()=>{setKey('');onClose()}} onCancel={e=>{if(working)e.preventDefault();else close()}}><form onSubmit={e=>{e.preventDefault();void run('saving')}}>
  <button type="button" className="ssh-modal-close" aria-label={t("關閉","Close")} title={t("關閉","Close")} disabled={!!working} onClick={close}><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
  <h2 id={id}>{t("聊天模型設定","Gemini API")}</h2>
  {model&&<p>{t("目前模型：","Current model: ")}<strong>{model}</strong></p>}
  <p>{t("使用自己的金鑰連接 Gemini，可至以下服務建立金鑰：", "Chat uses Google Gemini with your own API key. Create one in ")}<a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">Google AI Studio</a>.</p>
  <p className="model-key-note">{t("金鑰使用系統安全儲存加密，不會再次顯示。聊天訊息與工具結果會傳送至 Google；免費方案可能將其用於改善產品。", "The key is encrypted with your system keychain and is never shown again. Chat messages and tool results are sent to Google; on the free tier Google may use them to improve its products.")}</p>
  {status?.geminiConfigured&&<p role="status">{t("已儲存金鑰。", "A key is saved.")} {t("目前服務：", "Active provider: ")}{providerNames[status.provider]}</p>}
  <fieldset disabled={!!working||unavailable}><legend>{status?.geminiConfigured?t('更換金鑰','Replace API key'):t('金鑰','API key')}</legend>
   <label>{t("Gemini 金鑰","Gemini API key")}<input autoFocus aria-label={t("Gemini 金鑰","Gemini API key")} type="password" autoComplete="off" spellCheck={false} required value={key} onChange={e=>setKey(e.target.value)}/></label>
  </fieldset>
  {status?.encryptionAvailable===false&&<p role="alert">{t("系統安全儲存無法使用，無法儲存金鑰。", "System keychain encryption is unavailable, so a key cannot be saved here.")}</p>}
  {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
  <footer>{status?.geminiConfigured&&<button type="button" className="ssh-danger" disabled={!!working} onClick={()=>void run('clearing')}>{working==='clearing'?t('移除中…','Removing…'):t('移除金鑰','Remove key')}</button>}
   <button type="button" disabled={!!working} onClick={close}>{t("取消","Cancel")}</button>
   <button type="submit" className="ssh-primary" disabled={!!working||unavailable||!key.trim()}>{working==='saving'?t('驗證金鑰中…','Verifying key…'):t('儲存並使用 Gemini','Save and use Gemini')}</button></footer>
 </form></dialog>;
}

export function ModelControls({bridge,english=true,model,workspace=false}:{bridge:ModelBridge;english?:boolean;model?:string;workspace?:boolean}){
 const [status,setStatus]=useState<ModelStatus|null>(null),[error,setError]=useState(''),[open,setOpen]=useState(false),[restarting,setRestarting]=useState(false);
 useEffect(()=>{let mounted=true;const refresh=()=>unwrap(bridge.getStatus()).then(value=>{if(mounted){setStatus(value);setError('')}},()=>{if(mounted){setStatus(null);setError(english?'Could not read model settings.':'無法讀取模型設定。')}});void refresh();const show=()=>{setOpen(true);void refresh()};if(workspace)window.addEventListener('workspace-open-model-settings',show);return ()=>{mounted=false;window.removeEventListener('workspace-open-model-settings',show)}},[bridge,workspace,english]);
 // A restart reloads this page, so restarting state only needs to last until then.
 const track=async(pending:Promise<Result<{restarting:boolean}>>)=>{const value=await unwrap(pending);if(value.restarting)setRestarting(true);else setStatus(await unwrap(bridge.getStatus()));return value};
 return <>{workspace?<>
  <p className="ml-settings-note">{english?'Current model: ':'目前模型：'}<strong>{model||'—'}</strong></p>
  <p className="ml-settings-note" role="status">{restarting?(english?'Restarting the assistant…':'正在重新啟動助理…'):error||(status?(status.geminiConfigured?(english?'Gemini key saved securely':'Gemini 金鑰已安全儲存'):(english?'No saved Gemini key':'尚未儲存 Gemini 金鑰')):(english?'Checking model settings…':'正在讀取模型設定…'))}</p>
  <button type="button" className="ml-settings-action" onClick={()=>setOpen(true)}>{english?'Manage Gemini key':'管理 Gemini 金鑰'}</button>
 </>:<ModelStatusBlock status={status} error={error} restarting={restarting} onEdit={()=>setOpen(true)}/>}
  <GeminiKeyModal english={english} model={model} open={open} status={status} onClose={()=>setOpen(false)} onSave={key=>track(bridge.saveGeminiKey(key))} onClear={()=>track(bridge.clearGeminiKey())}/></>;
}
