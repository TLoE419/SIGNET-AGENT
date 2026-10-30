import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {App} from './App';

const root=document.getElementById('app');
if(!root||!(window as any).signetDesktop?.isDesktop)throw Error('Launch SIGNET through Electron.');
flushSync(()=>createRoot(root).render(<App model={document.querySelector('meta[name="model-label"]')?.getAttribute('content')||'SIGNET'}/>));
