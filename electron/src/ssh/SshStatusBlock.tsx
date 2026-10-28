import React from 'react';
import {ConnectionBadge} from '../../modules/ssh/ConnectionBadge';
import type {Status,SshError,ConnectionPhase} from '../../modules/ssh/types';

interface Props {
 name:string;
 host:string;
 status:Status|'unconfigured';
 error?:SshError|null;
 phase?:ConnectionPhase;
 detail?:string;
 busy?:boolean;
 onEdit:()=>void;
 onToggle:()=>void;
}
const labels={unconfigured:'Not configured',disconnected:'Disconnected',connected:'Connected',connecting:'Connecting…',disconnecting:'Disconnecting…',error:'Error'};
/** Host-app composition: only actions are injected; no connection logic or fake state cycling. */
const phases:Partial<Record<ConnectionPhase,string>>={'opening-transport':'Opening SSH transport…',authenticating:'Waiting for authentication…','opening-session':'Opening login session…','verifying-remote':'Verifying HPC3 and Slurm…',ready:'Connected'};
export function SshStatusBlock({name,host,status,error,phase,detail,busy,onEdit,onToggle}:Props){
 const pending=status==='connecting'||status==='disconnecting';
 const subtitle=status==='error'?(error?.message||'Connection failed. Open to review.'):pending?(status==='connecting'?(phase&&phases[phase]||'Establishing SSH connection…'):'Closing SSH connection…'):status==='connected'&&detail?detail:host;
 return <section className="ssh-status-block" data-status={status} aria-label="SSH connection" onClick={e=>{if(!(e.target as HTMLElement).closest('button'))onEdit()}}>
  {pending&&<svg className="ssh-status-outline" aria-hidden="true"><rect x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)" rx="13"/></svg>}
  <button type="button" className="ssh-identity" onClick={onEdit} aria-label={`Edit SSH connection: ${name}`} title={`${name} — ${host}\n${labels[status]}${error?' — '+error.message:''}`}>
   <span className="ssh-status-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {status==='error'?<><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v4m0 3h.01"/></>:pending?<><path d="m5 6 6 6-6 6m8 0h6"/></>:<><path d="m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0" transform="translate(3 0)"/><path d="m13 8 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/></>}
   </svg></span>
   <span className="ssh-status-copy"><span className="ssh-status-heading"><strong>{name}</strong><span className="ssh-protocol">SSH</span><span className="ssh-state-text">{labels[status]}</span></span><span className="ssh-status-subtitle">{subtitle}</span></span>
  </button>
  <span className="ssh-status-divider" aria-hidden="true"/>
  <button type="button" role="switch" aria-checked={status==='connected'} aria-label="SSH connection enabled" aria-description={status==='connecting'?'Cancel connection':status==='connected'?'Disconnect':status==='disconnecting'?'Disconnecting':'Connect saved SSH profile'} title={status==='connecting'?'Cancel connection':status==='connected'?'Disconnect':'Connect'} className="ssh-toggle" disabled={status==='disconnecting'||(busy&&status!=='connecting')} onClick={onToggle}><span aria-hidden="true"/></button>
  <ConnectionBadge status={status} onClick={onEdit} className="ssh-indicator"/>
 </section>;
}
