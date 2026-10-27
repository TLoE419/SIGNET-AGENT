import type {Status} from './types';
const labels={unconfigured:'Not configured',disconnected:'Disconnected',connecting:'Connecting…',connected:'Connected',disconnecting:'Disconnecting…',error:'Error'};
export function ConnectionBadge({status,onClick,disabled,className=''}:{status:Status|'unconfigured';onClick?:()=>void;disabled?:boolean;className?:string}){
 const content=<><span className="ssh-led" aria-hidden="true"/><span className="ssh-badge-label">{labels[status]}</span></>;
 return onClick?<button type="button" className={'ssh-badge '+className} disabled={disabled} onClick={onClick} title={labels[status]}>{content}</button>:<span className={'ssh-badge '+className}>{content}</span>;
}
