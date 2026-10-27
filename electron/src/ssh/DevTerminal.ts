import {EventEmitter} from 'node:events';
import type {ClientChannel} from 'ssh2';
import type {SshConnectionService} from './SshConnectionService';
import {fail} from '../../modules/ssh/validation';
import {authorized} from './sshIpcHandlers';
import type {BrowserWindow,IpcMain} from 'electron';

/** One PTY channel on the existing authenticated transport, never a new login. */
export class DevTerminal extends EventEmitter {
 private id?:string;private stream?:ClientChannel;private outstanding=0;private generation=0;
 constructor(private service:SshConnectionService){super();service.on('snapshot',this.snapshot)}
 private snapshot=()=>{if(this.service.getSnapshot().connection?.status!=='connected')this.close()};
 async open(id:string,cols:number,rows:number){
  if(this.id)fail('UNKNOWN','Close the existing terminal first.');this.id=id;const token=++this.generation;
  try{const stream=await this.service.openShell(cols,rows);if(this.generation!==token){stream.destroy();fail('SESSION_CLOSED','Terminal opening cancelled.')}
   this.stream=stream;this.outstanding=0;
   const output=(data:Buffer)=>{if(this.generation!==token)return;for(let i=0;i<data.length;i+=16384){const chunk=data.subarray(i,i+16384);if(this.outstanding+chunk.length>262144){this.close(id);return}this.outstanding+=chunk.length;this.emit('event',{id,type:'data',data:chunk.toString('base64')})}if(this.outstanding>=65536)stream.pause()};
   stream.on('data',output);stream.stderr.on('data',output);const close=()=>{if(this.generation===token)this.close(id)};stream.on('error',close);stream.on('close',close);
   return {id};
  }catch(e){if(this.generation===token)this.close(id);throw e}
 }
 input(id:string,data:string){if(id!==this.id||!this.stream)fail('SESSION_CLOSED','Open a terminal first.');if(this.stream.writableLength>65536)fail('UNKNOWN','Terminal input is busy.');this.stream.write(data)}
 resize(id:string,cols:number,rows:number){if(id!==this.id||!this.stream)fail('SESSION_CLOSED','Terminal is closed.');this.stream.setWindow(rows,cols,0,0)}
 ack(id:string,bytes:number){if(id!==this.id||!this.stream)return;this.outstanding=Math.max(0,this.outstanding-bytes);if(this.outstanding<32768)this.stream.resume()}
 close(id=this.id){if(!this.id||id!==this.id)return;++this.generation;const stream=this.stream,closed=this.id;this.id=undefined;this.stream=undefined;this.outstanding=0;stream?.destroy();this.emit('event',{id:closed,type:'closed'})}
 dispose(){this.close();this.service.off('snapshot',this.snapshot);this.removeAllListeners()}
}
export function installDevTerminal(ipc:IpcMain,getWindow:()=>BrowserWindow|null,service:SshConnectionService,getOrigin:()=>string){
 const terminal=new DevTerminal(service);let sequence=0,rawSequence=0,rawBytes=0;const history:unknown[]=[],rawHistory:Array<object&{text:string;seq:number}>=[];
 const send=(channel:string,value:unknown)=>{const win=getWindow();if(win&&!win.isDestroyed()&&win.webContents.mainFrame.url.startsWith(getOrigin()+'/'))win.webContents.send(channel,value)};
 const output=(value:unknown)=>send('ssh-dev:event',value),activity=(value:unknown)=>send('ssh-dev:activity',value);
 const diagnostic=(value:object)=>{const entry={...value,seq:++sequence};history.push(entry);if(history.length>300)history.shift();send('ssh-dev:diagnostic',entry)};
 const raw=(value:object&{text?:unknown})=>{const text=String(value.text??'').slice(0,65536),entry={...value,text,seq:++rawSequence};rawHistory.push(entry);rawBytes+=Buffer.byteLength(text);while(rawHistory.length>2000||rawBytes>2*1024*1024){const removed=rawHistory.shift();if(removed)rawBytes-=Buffer.byteLength(removed.text)}send('ssh-dev:raw',entry)};
 terminal.on('event',output);service.on('activity',activity);service.on('diagnostic',diagnostic);service.on('raw-ssh',raw);
 const operations:Record<string,(...args:any[])=>unknown>={history:()=>history.slice(),rawHistory:()=>rawHistory.slice(),open:(id,cols,rows)=>terminal.open(id,cols,rows),input:(id,data)=>terminal.input(id,data),resize:(id,cols,rows)=>terminal.resize(id,cols,rows),ack:(id,bytes)=>terminal.ack(id,bytes),close:id=>terminal.close(id)};
 const counts:Record<string,number>={history:0,rawHistory:0,open:3,input:2,resize:3,ack:2,close:1};
 for(const [name,fn] of Object.entries(operations))ipc.handle('ssh-dev:'+name,async(event,...args)=>{
  if(!authorized(event,getWindow(),getOrigin()))return {ok:false,error:'Unauthorized terminal request.'};
  try{
   if(name==='history'||name==='rawHistory'){if(args.length)throw Error();return {ok:true,value:await fn()}}
   if(args.length!==counts[name]||typeof args[0]!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(args[0]))throw Error();
   if(['open','resize'].includes(name)&&(!Number.isInteger(args[1])||args[1]<2||args[1]>500||!Number.isInteger(args[2])||args[2]<2||args[2]>200))throw Error();
   if(name==='input'&&(typeof args[1]!=='string'||Buffer.byteLength(args[1])>16384))throw Error();
   if(name==='ack'&&(!Number.isInteger(args[1])||args[1]<1||args[1]>65536))throw Error();
   return {ok:true,value:await fn(...args)};
  }catch{return {ok:false,error:'Terminal operation failed. Check the SSH connection and reopen the terminal.'}}
 });
 return {close:()=>terminal.close(),dispose:()=>{terminal.dispose();service.off('activity',activity);service.off('diagnostic',diagnostic);service.off('raw-ssh',raw);history.length=0;rawHistory.length=0;rawBytes=0;for(const name of Object.keys(operations))ipc.removeHandler('ssh-dev:'+name)}};
}
