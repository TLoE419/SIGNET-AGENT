import {useEffect,useRef,useState} from 'react';
import {ConnectionDiagnostics,type Diagnostic,type DiagnosticBridge} from './ConnectionDiagnostics';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import xtermStyles from '@xterm/xterm/css/xterm.css';
type Reply={ok:boolean;error?:string};
type TerminalEvent={id:string;type:'data'|'closed';data?:string};
type Activity={id:string;type:'start'|'output'|'end';time:string;command?:string;channel?:string;data?:string;code?:number;error?:string};
export interface DevTerminalBridge extends DiagnosticBridge {
 open:(id:string,cols:number,rows:number)=>Promise<Reply>;input:(id:string,data:string)=>Promise<Reply>;resize:(id:string,cols:number,rows:number)=>Promise<Reply>;ack:(id:string,bytes:number)=>Promise<Reply>;close:(id:string)=>Promise<Reply>;
 subscribe:(fn:(event:TerminalEvent)=>void)=>()=>void;activity:(fn:(event:Activity)=>void)=>()=>void;
}
export function DevTerminalPanel({bridge,connected,status,diagnostics}:{bridge:DevTerminalBridge;connected:boolean;status:string;diagnostics:Diagnostic[]}){
 const [open,setOpen]=useState(false),[tab,setTab]=useState<'connection'|'activity'|'shell'>('connection'),[state,setState]=useState('Closed'),[error,setError]=useState(''),[log,setLog]=useState(''),[running,setRunning]=useState(0);
 const logView=useRef<HTMLPreElement>(null),follow=useRef(true),mount=useRef<HTMLDivElement>(null),terminal=useRef<Terminal|null>(null),fit=useRef<FitAddon|null>(null),session=useRef<string|null>(null),active=useRef(new Set<string>());
 useEffect(()=>{if(follow.current&&logView.current)logView.current.scrollTop=logView.current.scrollHeight},[log,open,tab]);
 useEffect(()=>bridge.activity(event=>{if(event.type==='start')active.current.add(event.id);if(event.type==='end')active.current.delete(event.id);setRunning(active.current.size);
  const line=event.type==='start'?`\n[${event.time}] ${event.id.slice(0,8)} START $ ${(event.command||'').slice(0,4096)}\n`:event.type==='end'?`\n[${event.time}] ${event.id.slice(0,8)} END ${event.error||'exit '+event.code}\n`:`[${event.id.slice(0,8)} ${event.channel}] ${event.data||''}`;
  setLog(previous=>(previous+line).slice(-200000));
 }),[bridge]);
 useEffect(()=>{if(!connected){active.current.clear();setRunning(0);setState('Closed')}},[connected]);
 useEffect(()=>{
  if(!open||!mount.current)return;
  const term=new Terminal({cursorBlink:true,fontSize:13,scrollback:3000,theme:{background:'#111827',foreground:'#e5e7eb'}}),addon=new FitAddon();terminal.current=term;fit.current=addon;term.loadAddon(addon);term.open(mount.current);addon.fit();
  // Do not load link/clipboard addons; remote output remains terminal content.
  let live=true,queued=0,queue=Promise.resolve();
  const off=bridge.subscribe(event=>{if(event.id!==session.current)return;if(event.type==='closed'){session.current=null;setState('Closed');term.writeln('\r\n[Shell closed]');return}
   const bytes=Uint8Array.from(atob(event.data||''),character=>character.charCodeAt(0));term.write(bytes,()=>{if(live)void bridge.ack(event.id,bytes.length)})});
  const input=term.onData(data=>{const id=session.current;if(!id)return;if(queued+data.length>32768){setError('Input queue is full. Paste a smaller block.');return}queued+=data.length;
   queue=queue.then(async()=>{try{for(let offset=0;offset<data.length;){let end=Math.min(offset+2048,data.length);if(end<data.length&&/[\uD800-\uDBFF]/.test(data[end-1]))end--;const chunk=data.slice(offset,end);offset=end;if(!live||session.current!==id)return;const result=await bridge.input(id,chunk);if(!result.ok)throw Error(result.error)}}catch(e){if(live)setError((e as Error).message)}finally{queued-=data.length}});
  });
  const resize=term.onResize(({cols,rows})=>{const id=session.current;if(id)void bridge.resize(id,Math.min(500,cols),Math.min(200,rows))});
  const observer=new ResizeObserver(()=>{if(mount.current?.offsetWidth)addon.fit()});observer.observe(mount.current);
  return()=>{live=false;const id=session.current;session.current=null;if(id)void bridge.close(id);off();input.dispose();resize.dispose();observer.disconnect();term.dispose();terminal.current=null;fit.current=null};
 },[open,bridge]);
 useEffect(()=>{if(open&&tab==='shell'){fit.current?.fit();terminal.current?.focus()}},[open,tab]);
 async function start(){if(session.current||!terminal.current)return;const id=crypto.randomUUID();session.current=id;setState('Opening');setError('');terminal.current.clear();fit.current?.fit();try{const result=await bridge.open(id,Math.min(500,terminal.current.cols),Math.min(200,terminal.current.rows));if(session.current!==id)return;if(!result.ok)throw Error(result.error);setState('Open');terminal.current?.focus()}catch(e){if(session.current===id){session.current=null;setState('Closed');setError((e as Error).message)}}}
 return <><button className="ssh-dev-launch" onClick={()=>setOpen(true)}>Dev terminal{running?` · ${running} running`:''}</button>{open&&<section className="ssh-dev-panel" aria-label="SSH developer terminal" onKeyDown={event=>event.stopPropagation()}>
 <style>{xtermStyles}</style><header><strong>SSH developer terminal</strong><span>{status} · {running} commands running</span><button onClick={()=>{setOpen(false);setState('Closed')}}>Close panel</button></header>
 <nav aria-label="Terminal views"><button aria-pressed={tab==='connection'} onClick={()=>setTab('connection')}>Connection diagnostics</button><button aria-pressed={tab==='activity'} onClick={()=>setTab('activity')}>Execution activity</button><button aria-pressed={tab==='shell'} onClick={()=>setTab('shell')}>Interactive shell</button></nav>
 <div hidden={tab!=='connection'}><ConnectionDiagnostics entries={diagnostics}/><p>Last 300 events retained in Electron memory until app exit, including failed attempts and page reloads. Credentials and server prompt contents are omitted.</p></div>
 <div hidden={tab!=='activity'}><p>Live Python SSH command output from this app session. Recent preview only; shell input is separate.</p><button onClick={()=>setLog('')}>Clear preview</button><pre ref={logView} onScroll={event=>{const el=event.currentTarget;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<32}} aria-label="SSH execution activity">{log||'No remote commands observed yet.'}</pre></div>
 <div hidden={tab!=='shell'}><div className="ssh-dev-actions"><span>{state} · same SSH connection, separate shell channel</span><button disabled={!connected||state!=='Closed'} onClick={()=>void start()}>Open shell</button><button disabled={state==='Closed'} onClick={()=>{const id=session.current;if(id)void bridge.close(id)}}>Close shell</button></div><div className="ssh-dev-terminal" ref={mount}/></div>
 {error&&<p role="alert">{error}</p>}</section>}</>;
}
