import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {WorkspaceModelSettings} from '../features/workspace/WorkspaceModelSettings';
import {App} from './App';
import {WorkspaceSshSettings} from '../features/workspace/WorkspaceSshSettings';

if(!(window as any).signetDesktop?.isDesktop)throw Error('Launch SIGNET through Electron.');
const workspace=document.getElementById('signet-lens-left-preview');
if(workspace){
 const modelSettings=document.getElementById('ml-model-settings');
 if(modelSettings)createRoot(modelSettings).render(<WorkspaceModelSettings bridge={(window as any).signetDesktop.model} model={document.querySelector('meta[name="model-label"]')?.getAttribute('content')||'—'}/>);
 const controls=document.getElementById('ml-remote-controls');
 const readiness=document.getElementById('ml-environment-settings');
 const pane=controls?.closest<HTMLElement>('.ml-nav-pane');
 const sidebar=document.getElementById('ml-chat-panel');
 if(controls&&readiness&&pane&&sidebar)createRoot(controls).render(<WorkspaceSshSettings {...{readiness,pane,sidebar}}/>);
}else{
 const root=document.getElementById('app');
 if(!root)throw Error('Missing SIGNET app root.');
 flushSync(()=>createRoot(root).render(<App model={document.querySelector('meta[name="model-label"]')?.getAttribute('content')||'SIGNET'}/>));
}
