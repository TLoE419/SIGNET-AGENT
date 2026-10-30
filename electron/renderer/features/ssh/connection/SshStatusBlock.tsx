import {environmentLabels,type EnvironmentSnapshot} from '../../../../shared/environment/types';
import React,{useEffect,useId,useState} from 'react';
import {ConnectionBadge} from './ConnectionBadge';
import type {Status,SshError,ConnectionPhase} from '../../../../shared/ssh/types';

interface Props {
 environment?:EnvironmentSnapshot;
 onEnvironment?:()=>void;
 name:string;
 host:string;
 status:Status|'unconfigured';
 error?:SshError|null;
 phase?:ConnectionPhase;
 busy?:boolean;
 onEdit:()=>void;
 onToggle:()=>void;
}
const labels={unconfigured:'Not configured',disconnected:'Disconnected',connected:'Connected',connecting:'Connecting…',disconnecting:'Disconnecting…',error:'Error'};
/** Host-app composition: only actions are injected; no connection logic or fake state cycling. */
const phases:Partial<Record<ConnectionPhase,string>>={'opening-transport':'Opening SSH transport…',authenticating:'Waiting for authentication…','opening-session':'Opening login session…','verifying-remote':'Verifying HPC3 and Slurm…',ready:'Connected'};
export function SshStatusBlock({name,host,status,error,phase,busy,onEdit,onToggle,environment,onEnvironment}:Props){
 const environmentLoading=!!environment&&['checking','installing-source','installing-image','verifying'].includes(environment.phase);
 const stateKey=`${status}:${phase||''}:${environment?.phase||''}`;
 const [manual,setManual]=useState<{key:string;expanded:boolean}|null>(null),detailsId=useId();
 useEffect(()=>setManual(null),[stateKey]);
 const expanded=manual?.key===stateKey?manual.expanded:status!=='connected'||environmentLoading;
 const pending=status==='connecting'||status==='disconnecting';
 const progress=phase&&phases[phase];
 const description=error?.message||(pending?(status==='connecting'?(progress||'Establishing SSH connection…'):'Closing SSH connection…'):labels[status]);
 return <section className="ssh-status-block" data-status={status} aria-label="SSH connection" data-expanded={expanded}>
  {pending&&<svg className="ssh-status-outline" aria-hidden="true"><rect x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)" rx="13"/></svg>}
  <button type="button" className="ssh-collapse" onClick={()=>setManual({key:stateKey,expanded:!expanded})} aria-expanded={expanded} aria-controls={detailsId} aria-label={expanded?'Collapse SSH connection':'Expand SSH connection'} title={`${name} — ${host}\n${description}${environment?' · '+environmentLabels[environment.phase]:''}`}>
   <svg className="ssh-disclosure-arrow" aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m9 5 7 7-7 7"/></svg>
  </button>
  <div className="ssh-status-details" id={detailsId} inert={!expanded} aria-hidden={!expanded}>
  <button type="button" className="ssh-identity" onClick={onEdit} aria-label={`Edit SSH connection: ${name}`} title={`${name} — ${host}\n${description}`}>
   <span className="ssh-status-copy"><span className="ssh-status-heading"><strong>{name}</strong><span className="ssh-protocol">SSH</span>{!(status==='connected'&&environment)&&<span className="ssh-state-text">{labels[status]}</span>}</span><span className="ssh-status-subtitle" title={host}>{host}</span></span>
  </button>
  {status==='connected'&&environment&&<button type="button" className="ssh-environment-status" data-phase={environment.phase} onClick={onEnvironment} title={environment.message} aria-label={`SIGNET environment: ${environmentLabels[environment.phase]}`}><span aria-hidden="true" className="ssh-environment-dot"/><span role="status">{environmentLabels[environment.phase]}</span><span aria-hidden="true">›</span></button>}
  </div>
  <span className="ssh-status-divider" aria-hidden="true"/>
  <button type="button" role="switch" aria-checked={status==='connected'} aria-label="SSH connection enabled" aria-description={status==='connecting'?'Cancel connection':status==='connected'?'Disconnect':status==='disconnecting'?'Disconnecting':'Connect saved SSH profile'} title={status==='connecting'?'Cancel connection':status==='connected'?'Disconnect':'Connect'} className="ssh-toggle" disabled={status==='disconnecting'||(busy&&status!=='connecting')} onClick={onToggle}><span aria-hidden="true"/></button>
  <ConnectionBadge status={status} onClick={onEdit} className="ssh-indicator"/>
 </section>;
}
