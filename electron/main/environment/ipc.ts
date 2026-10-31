import type {IpcMain,BrowserWindow} from 'electron';
import {authorized} from '../ssh/ipc/sshIpcHandlers';
import type {EnvironmentService} from './EnvironmentService';
export function installEnvironmentHandlers(ipc:IpcMain,getWindow:()=>BrowserWindow|null,service:EnvironmentService,getOrigin:()=>string){
 for(const name of ['getSnapshot','check','install'] as const)ipc.handle('environment:'+name,async(event,...args)=>{
  if(!authorized(event,getWindow(),getOrigin()))return {ok:false,error:'Unauthorized environment request.'};
  try{
   if(name==='check'){if(args.length!==2||args.some(v=>typeof v!=='string'))throw Error('Invalid environment settings.');return {ok:true,value:await service.check(args[0],args[1])}}
   if(args.length)throw Error('Invalid environment request.');
   return {ok:true,value:await service[name]()};
  }catch(e){return {ok:false,error:(e as Error).message}}
 });
 const listener=(value:unknown)=>{const win=getWindow();if(win&&!win.isDestroyed()&&win.webContents.mainFrame.url.startsWith(getOrigin()+'/'))win.webContents.send('environment:snapshot',value)};
 service.on('snapshot',listener);
 return()=>{service.off('snapshot',listener);for(const name of ['getSnapshot','check','install'])ipc.removeHandler('environment:'+name)};
}
