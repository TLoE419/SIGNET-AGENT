import {useResizeTransition} from './useResizeTransition';
import {useEffect,useId,useRef,type ReactNode} from 'react';

interface ModalProps {
 open?:boolean;
 title:string;
 ariaLabel?:string;
 className?:string;
 onClose:()=>void;
 dismissDisabled?:boolean;
 children:ReactNode;
}

/** Native top-layer dialog; callers retain ownership of drafts and async work. */
export function Modal({open=true,title,ariaLabel,className='',onClose,dismissDisabled=false,children}:ModalProps){
 const ref=useRef<HTMLDialogElement>(null),content=useRef<HTMLDivElement>(null),titleId=useId();
 useEffect(()=>{
  const dialog=ref.current;
  if(open&&!dialog?.open)dialog?.showModal();
  else if(!open&&dialog?.open)dialog.close();
  return()=>{if(dialog?.open)dialog.close()};
 },[open]);
 useResizeTransition(ref,content,open);
 const close=()=>{if(!dismissDisabled)onClose()};
 return <dialog ref={ref} className={`ssh-modal ${className}`} aria-label={ariaLabel} aria-labelledby={ariaLabel?undefined:titleId}
  onCancel={event=>{event.preventDefault();close()}}
  onKeyDown={event=>event.stopPropagation()}
  onClick={event=>{
   if(event.target!==event.currentTarget)return;
   const bounds=event.currentTarget.getBoundingClientRect();
   if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)close();
  }}>
  <button type="button" className="ssh-modal-close" aria-label="Close" title="Close" disabled={dismissDisabled} onClick={close}>
   <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
  </button>
  <div ref={content} className="ssh-modal-content">
  <h2 id={titleId}>{title}</h2>
  {children}
  </div>
 </dialog>;
}

/** Danger actions belong first; the last safe action sits at the right edge. */
export function DialogActions({children}:{children:ReactNode}){
 return <footer className="ssh-dialog-actions">{children}</footer>;
}

interface ConfirmDialogProps {
 title:string;
 children:ReactNode;
 confirmLabel:string;
 cancelLabel:string;
 busyLabel:string;
 busy:boolean;
 error?:string;
 onConfirm:()=>void;
 onCancel:()=>void;
}

export function ConfirmDialog({title,children,confirmLabel,cancelLabel,busyLabel,busy,error,onConfirm,onCancel}:ConfirmDialogProps){
 return <Modal title={title} className="ssh-key-dialog" onClose={onCancel} dismissDisabled={busy}>
  {children}
  {error&&<p role="alert">{error}</p>}
  <DialogActions>
   <button type="button" className="ssh-danger" disabled={busy} onClick={onConfirm}>{busy?busyLabel:confirmLabel}</button>
   <button type="button" autoFocus disabled={busy} onClick={onCancel}>{cancelLabel}</button>
  </DialogActions>
 </Modal>;
}
