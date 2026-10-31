import {useEffect,useRef,useState} from 'react';
export interface Diagnostic {seq:number;id:string;stage:string;message:string;time:string}
export interface DiagnosticBridge {diagnostics:(listener:(event:Diagnostic)=>void)=>()=>void;history:()=>Promise<{ok:boolean;value?:Diagnostic[]}>}
export function useConnectionDiagnostics(bridge?:DiagnosticBridge){
 const [entries,setEntries]=useState<Diagnostic[]>([]);
 useEffect(()=>{if(!bridge)return;let live=true;const merge=(incoming:Diagnostic[])=>{if(live)setEntries(current=>Array.from(new Map([...current,...incoming].map(item=>[item.seq,item])).values()).sort((a,b)=>a.seq-b.seq).slice(-300))};const off=bridge.diagnostics(event=>merge([event]));void bridge.history().then(reply=>{if(reply.ok)merge(reply.value||[])}).catch(()=>{});return()=>{live=false;off()}},[bridge]);
 return entries;
}
export function ConnectionDiagnostics({entries}:{entries:Diagnostic[]}){
 const view=useRef<HTMLPreElement>(null),follow=useRef(true);
 useEffect(()=>{if(follow.current&&view.current)view.current.scrollTop=view.current.scrollHeight},[entries]);
 return <details className="ssh-connection-diagnostics" open><summary><span className="ssh-dev-badge">DEV</span> SSH connection diagnostics</summary><pre ref={view} aria-label="SSH connection diagnostics" onScroll={event=>{const el=event.currentTarget;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<32}}>{entries.length?entries.map(event=>`[${event.time}] ${event.id} · ${event.stage}: ${event.message}`).join('\n'):'Ready to monitor. Press Connect in SSH settings; no login is required to view this log.'}</pre></details>;
}
