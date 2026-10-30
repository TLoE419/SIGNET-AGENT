import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost'});
for(const key of ['window','document','HTMLElement','HTMLDialogElement','Node','MutationObserver','Event','MouseEvent','KeyboardEvent'])Object.defineProperty(globalThis,key,{value:(dom.window as any)[key],configurable:true});
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false};
const require=createRequire(import.meta.url);
const {render,screen,fireEvent,waitFor,cleanup,act}=require('@testing-library/react') as typeof import('@testing-library/react');
import {AccountLoginPrompt} from '../renderer/features/ssh/auth/AccountLoginPrompt';
import {DuoChallenge} from '../renderer/features/ssh/auth/LoginSteps';
import {UnlockPrompt} from '../renderer/features/ssh/auth/UnlockPrompt';
import {SshStatusBlock} from '../renderer/features/ssh/connection/SshStatusBlock';
import {ConnectionBadge} from '../renderer/features/ssh/connection/ConnectionBadge';
import {connectionIdentity} from '../renderer/features/ssh/connection/connectionIdentity';
import {Modal} from '../renderer/components/Modal';
import {KeyDetailsModal} from '../renderer/features/ssh/keys/KeyDetailsModal';
import {ConnectionModal} from '../renderer/features/ssh/connection/ConnectionModal';
import {KeyRegistrationModal} from '../renderer/features/ssh/keys/KeyRegistrationModal';
import {useSshConnection} from '../renderer/features/ssh/state/useSshConnection';
import {MockSshConnectionPort} from './fixtures/MockSshConnectionPort';
import {uciHpc3Preset} from '../shared/ssh/types';
import {useState} from 'react';
afterEach(cleanup);
const profile={...uciHpc3Preset,id:'test',username:'testuser',auth:{method:'private-key' as const,privateKeyPath:'/test/encrypted'}};
const savedKey={keyId:'key-test',label:'My HPC3 key',username:'testuser',source:'external' as const,algorithm:'ssh-rsa',publicKey:'ssh-rsa AAAATEST test',fingerprint:'SHA256:'+'A'.repeat(43),createdAt:'2026-01-01T00:00:00.000Z',privateKeyPath:'/test/encrypted'};
function fill(){fireEvent.change(screen.getByLabelText('SSH key'),{target:{value:savedKey.keyId}})}
function Harness({port}:{port:MockSshConnectionPort}){const ssh=useSshConnection(port),[open,setOpen]=useState(false);return <><ConnectionBadge status={ssh.snapshot.connection?.status||'unconfigured'} onClick={()=>setOpen(true)}/><button onClick={()=>setOpen(true)}>Edit</button><ConnectionModal open={open} profile={ssh.snapshot.selectedProfile} keys={[savedKey]} status={ssh.snapshot.connection?.status||'unconfigured'} onClose={()=>setOpen(false)} onOpenKeyRegistration={()=>{}} onInspectKey={ssh.inspect} onSave={ssh.save} onConnect={ssh.connect} onDisconnect={ssh.disconnect} error={ssh.error} busy={ssh.busy}/></>}
test('connection offers Duo by default and allows an empty SSH management block; never collects secrets',async()=>{
 render(<ConnectionModal open profile={null} keys={[]} status="unconfigured" onClose={()=>{}} onOpenKeyRegistration={()=>{}} onInspectKey={new MockSshConnectionPort().inspectPrivateKey} onSave={async()=>{}} onConnect={async()=>{}} onDisconnect={async()=>{}}/>);
 assert.equal(screen.queryByLabelText('Connection name'),null);assert.equal(screen.getByRole('radio',{name:'Duo'}).getAttribute('aria-checked'),'true');assert.equal(screen.queryByRole('button',{name:'Add SSH key…'}),null);fireEvent.click(screen.getByRole('radio',{name:'SSH key'}));assert.ok(screen.getByRole('region',{name:'SSH key management'}));assert.ok(screen.getByRole('button',{name:'Add SSH key…'}));assert.equal(screen.queryByLabelText('Private-key passphrase'),null);assert.equal(screen.queryByLabelText('UCInetID password'),null);
});
test('saved SSH keys can be selected without entering a passphrase in settings',async()=>{
 const port=new MockSshConnectionPort();await act(async()=>{render(<Harness port={port}/>)});fireEvent.click(screen.getByRole('button',{name:'Not configured'}));fireEvent.click(screen.getByRole('radio',{name:'SSH key'}));await waitFor(()=>assert.equal((screen.getByRole('button',{name:'Connect'}) as HTMLButtonElement).disabled,false));assert.equal(screen.queryByLabelText('Private-key passphrase'),null);assert.equal((screen.getByLabelText('UCInetID / username') as HTMLInputElement).value,'testuser');fireEvent.click(screen.getByRole('button',{name:'Save'}));await waitFor(()=>assert.equal(port.saveCalls,1));assert.equal(port.connectCalls,0);
});
test('generate key needs no account and hands off to the separate account step',async()=>{
 let generated=0,completed=0;const key={...savedKey,username:undefined,source:'managed' as const};
 render(<KeyRegistrationModal open onClose={()=>{}} onPickKey={async()=>({canceled:true})} onInspectKey={new MockSshConnectionPort().inspectPrivateKey} onAddExternalKey={async()=>key} onImported={()=>{}} onGenerateKey={async input=>{generated++;assert.deepEqual(input,{label:'Laptop key',passphrase:'1234567890'});return key}} onGenerated={(result,secret)=>{completed++;assert.equal(result,key);assert.equal(secret,'1234567890')}}/>);
 assert.equal(screen.queryByLabelText('UCInetID / username'),null);assert.equal(screen.queryByLabelText('UCInetID password'),null);
 fireEvent.change(screen.getByLabelText('Key name'),{target:{value:'Laptop key'}});fireEvent.change(screen.getByLabelText('New key passphrase'),{target:{value:'1234567890'}});fireEvent.change(screen.getByLabelText('Confirm passphrase'),{target:{value:'1234567890'}});fireEvent.click(screen.getByRole('button',{name:'Generate SSH key'}));await waitFor(()=>assert.equal(completed,1));assert.equal(generated,1);assert.equal((screen.getByLabelText('New key passphrase') as HTMLInputElement).value,'');
});
test('unencrypted keys block Save and Connect with visible warning',async()=>{render(<ConnectionModal open profile={{...profile,auth:{method:'private-key',privateKeyPath:'/test/unencrypted'}}} keys={[]} status="disconnected" onClose={()=>{}} onOpenKeyRegistration={()=>{}} onInspectKey={new MockSshConnectionPort().inspectPrivateKey} onSave={async()=>assert.fail()} onConnect={async()=>assert.fail()} onDisconnect={async()=>{}}/>);await screen.findByText('This key has no passphrase');assert.ok((screen.getByRole('button',{name:'Connect'}) as HTMLButtonElement).disabled);assert.ok((screen.getByRole('button',{name:'Save'}) as HTMLButtonElement).disabled)});
test('rapid connection submissions run once and closing ignores stale completion',async()=>{let calls=0,release!:()=>void,closed=0;const props={open:true,profile,keys:[],status:'disconnected' as const,onClose:()=>closed++,onOpenKeyRegistration:()=>{},onInspectKey:new MockSshConnectionPort().inspectPrivateKey,onSave:async()=>{},onConnect:async()=>{calls++;await new Promise<void>(r=>release=r)},onDisconnect:async()=>{}};const result=render(<ConnectionModal {...props}/>);await waitFor(()=>assert.equal((screen.getByRole('button',{name:'Connect'}) as HTMLButtonElement).disabled,false));const button=screen.getByRole('button',{name:'Connect'});fireEvent.click(button);fireEvent.click(button);assert.equal(calls,1);fireEvent.click(screen.getByRole('button',{name:'Close'}));result.rerender(<ConnectionModal {...props} open={false}/>);await act(async()=>release());assert.equal(closed,1)});
test('stale inspection cannot enable a newly selected invalid key; trust enrollment requires explicit verification',async()=>{let resolve!:(v:any)=>void,trust=0;const invalidKey={...savedKey,keyId:'invalid',label:'Invalid key',privateKeyPath:'/test/invalid'};const inspect=async(path:string)=>path.endsWith('encrypted')?new Promise<any>(done=>resolve=done):{status:'invalid' as const,reason:'Not a key'};render(<ConnectionModal open profile={profile} keys={[invalidKey]} status="error" pendingHost={{host:'example.test',port:22,algorithm:'ssh-ed25519',fingerprint:'SHA256:'+'A'.repeat(43)}} onTrustHost={async()=>{trust++;throw Error('Store unavailable')}} onOpenKeyRegistration={()=>{}} onInspectKey={inspect} onSave={async()=>{}} onConnect={async()=>{}} onDisconnect={async()=>{}} onClose={()=>{}}/>);await waitFor(()=>assert.ok(resolve));fireEvent.change(screen.getByLabelText('SSH key'),{target:{value:'invalid'}});await screen.findByText('Not a key');await act(async()=>resolve({status:'encrypted',format:'test'}));assert.ok((screen.getByRole('button',{name:'Connect'}) as HTMLButtonElement).disabled);const button=screen.getByRole('button',{name:'Trust verified host'});assert.ok((button as HTMLButtonElement).disabled);fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(button);await screen.findByText('Store unavailable');assert.equal(trust,1)});

test('glass status block maps live states to text and switch semantics without simulating connections',()=>{
 const states=['unconfigured','disconnected','connecting','connected','disconnecting','error'] as const;let edits=0,toggles=0;
 const result=render(<SshStatusBlock name="UCI HPC3" host="hpc3.rcic.uci.edu:22" status="unconfigured" onEdit={()=>edits++} onToggle={()=>toggles++}/>);
 for(const status of states){result.rerender(<SshStatusBlock name="UCI HPC3" host="hpc3.rcic.uci.edu:22" status={status} error={status==='error'?{code:'CONNECTION_TIMEOUT',message:'Connection timed out.'}:null} onEdit={()=>edits++} onToggle={()=>toggles++}/>);if(status==='connected')fireEvent.click(screen.getByRole('button',{name:'Expand SSH connection'}));const control=screen.getByRole('switch',{name:'SSH connection enabled'});assert.equal(control.getAttribute('aria-checked'),String(status==='connected'));assert.equal((control as HTMLButtonElement).disabled,status==='disconnecting');assert.equal(result.container.querySelector('.ssh-status-block')?.getAttribute('data-status'),status);assert.equal(!!result.container.querySelector('.ssh-status-outline'),status==='connecting'||status==='disconnecting');if(status==='error')assert.match(screen.getByRole('button',{name:'Edit SSH connection: UCI HPC3'}).title,/Connection timed out/)}
 fireEvent.click(screen.getByRole('button',{name:'Edit SSH connection: UCI HPC3'}));fireEvent.click(screen.getByRole('button',{name:'Error'}));assert.equal(edits,2);fireEvent.click(screen.getByRole('switch'));assert.equal(toggles,1);assert.equal(result.container.querySelector('.ssh-status-block')?.getAttribute('data-status'),'error');
});
test('connected settings show verified HPC health and Check again refreshes it',async()=>{
 let checks=0;const health={checkedAt:'2026-10-27T23:00:00.000Z',remote:{hostname:'login-i15',username:'testuser',slurm:true},steps:[{name:'transport' as const,ok:true,detail:'SSH transport authenticated.'},{name:'session' as const,ok:true,detail:'Persistent login shell open.'},{name:'identity' as const,ok:true,detail:'testuser on login-i15'},{name:'slurm' as const,ok:true,detail:'sbatch available.'}]};
 render(<ConnectionModal open profile={profile} keys={[]} status="connected" health={health} onClose={()=>{}} onOpenKeyRegistration={()=>{}} onInspectKey={new MockSshConnectionPort().inspectPrivateKey} onSave={async()=>{}} onConnect={async()=>{}} onDisconnect={async()=>{}} onCheck={async()=>{checks++}}/>);const region=screen.getByRole('region',{name:'HPC3 connection health'});assert.match(region.textContent||'',/testuser on login-i15/);await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Check again'}))});await waitFor(()=>assert.equal(checks,1));
});

test('direct connection action invokes saved-profile connect without saving or opening settings',async()=>{
 const port=new MockSshConnectionPort();await port.saveProfile(profile);const saves=port.saveCalls;const requests:Array<{id:string;empty:boolean}>=[];const original=port.connect;port.connect=async(id,phrase)=>{requests.push({id,empty:!phrase});return original(id,phrase)};
 function Direct(){const ssh=useSshConnection(port);return <><button onClick={()=>void ssh.connectSaved().catch(()=>{})}>Direct connect</button><button onClick={()=>void ssh.connectSaved('test-only-passphrase').catch(()=>{})}>Unlock</button>{ssh.error&&<p role="alert">{ssh.error.code}</p>}</>}
 await act(async()=>{render(<Direct/>)});fireEvent.click(screen.getByText('Direct connect'));await waitFor(()=>assert.equal(requests.length,1));assert.equal(screen.queryByRole('alert'),null);assert.deepEqual(requests,[{id:profile.id,empty:true}]);assert.equal(port.saveCalls,saves);assert.equal(screen.queryByRole('dialog'),null);fireEvent.click(screen.getByText('Unlock'));await waitFor(()=>assert.equal(port.connectCalls,1));assert.equal(port.saveCalls,saves);assert.equal(requests[1].id,profile.id);
});

test('unlock prompt only collects a temporary passphrase and clears failed input',async()=>{
 render(<UnlockPrompt open name="UCI HPC3" onClose={()=>{}} onConnect={async()=>{throw Error('Wrong passphrase')}}/>);assert.equal(screen.queryByLabelText('Host'),null);fireEvent.change(screen.getByLabelText('Private-key passphrase'),{target:{value:'test-only'}});fireEvent.click(screen.getByRole('button',{name:'Connect'}));await screen.findByRole('alert');assert.equal((screen.getByLabelText('Private-key passphrase') as HTMLInputElement).value,'');
});


test('account setup follows generation and clears the account password on submit and cancellation',async()=>{
 let logins=0,cancels=0,done=0;render(<AccountLoginPrompt open username="" keyToRegister={savedKey} onClose={()=>cancels++} onComplete={()=>done++} onAnswer={async()=>{}} onTrust={async()=>{}} onLogin={async(user,password)=>{logins++;assert.equal(user,'testuser');assert.equal(password,'account-secret');throw Error('Retry authentication')}}/>);
 assert.ok(screen.getByRole('heading',{name:'Set up SSH key'}));assert.equal(screen.queryByLabelText('Private-key passphrase'),null);fireEvent.change(screen.getByLabelText('UCInetID / username'),{target:{value:'testuser'}});fireEvent.change(screen.getByLabelText('UCInetID password'),{target:{value:'account-secret'}});fireEvent.click(screen.getByRole('button',{name:'Sign in and set up key'}));await screen.findByText('Retry authentication');assert.equal(logins,1);assert.equal(done,0);assert.equal((screen.getByLabelText('UCInetID password') as HTMLInputElement).value,'');fireEvent.click(screen.getByRole('button',{name:'Cancel'}));assert.equal(cancels,1);
});

test('Duo challenge forwards the server instructions and selected push option',async()=>{
 const replies:Array<{session:string;challenge:string;answers:string[]}>=[];
 render(<DuoChallenge challenge={{sessionId:'connection-3',challengeId:'challenge-1',name:'Duo two-factor login for testuser',instructions:'Enter a passcode or select one of the following options:\n\n 1. Duo Push to XXX-XXX-1234',prompts:[{prompt:'Passcode or option (1-1):',echo:false}]}} onAnswer={async(session,challenge,answers)=>{replies.push({session,challenge,answers})}}/>);
 assert.ok(screen.getByText('Duo two-factor login for testuser'));
 assert.ok(screen.getByText(/Enter a passcode or select one/));
 assert.equal((screen.getByLabelText('Passcode or option (1-1):') as HTMLInputElement).type,'password');
 fireEvent.click(screen.getByRole('button',{name:'1 Duo Push to XXX-XXX-1234'}));
 await waitFor(()=>assert.deepEqual(replies,[{session:'connection-3',challenge:'challenge-1',answers:['1']}]));
 assert.ok(screen.getByText('Waiting for Duo authentication…'));
});

test('Duo challenge discovers numbered options embedded in the server prompt',async()=>{
 let answers:string[]=[];
 render(<DuoChallenge challenge={{sessionId:'connection-5',challengeId:'challenge-3',name:'Duo',instructions:'',prompts:[{prompt:'Choose an authentication method:\n 1. Send a Push to XXX-XXX-1234\nPasscode or option:',echo:false}]}} onAnswer={async(_session,_challenge,value)=>{answers=value}}/>);
 fireEvent.click(screen.getByRole('button',{name:'1 Send a Push to XXX-XXX-1234'}));
 await waitFor(()=>assert.deepEqual(answers,['1']));
});

test('Duo challenge keeps manual passcodes available when no numbered option is returned',async()=>{
 let answers:string[]=[];
 render(<DuoChallenge challenge={{sessionId:'connection-4',challengeId:'challenge-2',name:'Duo',instructions:'Enter your generated passcode.',prompts:[{prompt:'Passcode:',echo:false}]}} onAnswer={async(_session,_challenge,value)=>{answers=value}}/>);
 assert.equal(screen.queryByRole('group',{name:'Available Duo options'}),null);
 const input=screen.getByLabelText('Passcode:');fireEvent.change(input,{target:{value:'654321'}});fireEvent.click(screen.getByRole('button',{name:'Submit authentication response'}));
 await waitFor(()=>assert.deepEqual(answers,['654321']));
 assert.equal((input as HTMLInputElement).value,'');
});

test('connection modal closes with X, backdrop or Escape but not content or padding',()=>{
 let closed=0;
 render(<ConnectionModal open profile={null} keys={[]} status="unconfigured" onClose={()=>closed++} onOpenKeyRegistration={()=>{}} onInspectKey={new MockSshConnectionPort().inspectPrivateKey} onSave={async()=>{}} onConnect={async()=>{}} onDisconnect={async()=>{}}/>);
 const dialog=screen.getByRole('dialog');
 dialog.getBoundingClientRect=()=>({left:100,top:100,right:680,bottom:700,width:580,height:600,x:100,y:100,toJSON:()=>({})});
 assert.equal(dialog.querySelector('footer')?.textContent,'SaveConnect');
 fireEvent.click(screen.getByRole('heading',{name:'SSH connection'}));
 fireEvent.click(dialog,{clientX:110,clientY:110});
 assert.equal(closed,0);
 fireEvent.click(dialog,{clientX:90,clientY:110});
 assert.equal(closed,1);
 fireEvent.click(screen.getByRole('button',{name:'Close'}));
 assert.equal(closed,2);
 fireEvent(dialog,new dom.window.Event('cancel',{bubbles:false,cancelable:true}));
 assert.equal(closed,3);
});

test('SSH key details open separate edit and confirmation dialogs',async()=>{
 let updated:any,removed='';
 render(<ConnectionModal open profile={{...profile,auth:{method:'private-key',privateKeyPath:savedKey.privateKeyPath,keyId:savedKey.keyId}}} keys={[savedKey]} status="disconnected" onClose={()=>{}} onOpenKeyRegistration={()=>{}} onUpdateKey={async(id,input)=>{updated={id,...input}}} onRemoveKey={async id=>{removed=id}} onInspectKey={new MockSshConnectionPort().inspectPrivateKey} onSave={async()=>{}} onConnect={async()=>{}} onDisconnect={async()=>{}}/>);
 await waitFor(()=>assert.equal((screen.getByRole('button',{name:'Connect'}) as HTMLButtonElement).disabled,false));
 assert.equal(screen.queryByRole('button',{name:'Edit key'}),null);
 fireEvent.click(screen.getByRole('button',{name:'SSH key details'}));
 assert.ok(screen.getByRole('dialog',{name:'SSH key details'}));
 assert.ok(screen.getByText('Linked account'));
 assert.ok(screen.getByText('testuser'));
 fireEvent.click(screen.getByRole('button',{name:'Edit key'}));
 assert.ok(screen.getByRole('dialog',{name:'Edit SSH key'}));
 fireEvent.change(screen.getByLabelText('Key name'),{target:{value:'Renamed key'}});
 fireEvent.click(screen.getByRole('button',{name:'Save key changes'}));
 await waitFor(()=>assert.equal(updated?.label,'Renamed key'));
 await waitFor(()=>assert.equal(screen.queryByRole('dialog',{name:'Edit SSH key'}),null));
 fireEvent.click(screen.getByRole('button',{name:'Delete key'}));
 assert.equal(removed,'');
 assert.ok(screen.getByRole('dialog',{name:'Delete SSH key?'}));
 fireEvent.click(screen.getByRole('button',{name:'Cancel delete'}));
 assert.equal(removed,'');
 assert.equal(screen.queryByRole('dialog',{name:'Delete SSH key?'}),null);
 assert.ok(screen.getByRole('dialog',{name:'SSH key details'}));
 fireEvent.click(screen.getByRole('button',{name:'Delete key'}));
 fireEvent.click(screen.getByRole('button',{name:'Confirm delete'}));
 await waitFor(()=>assert.equal(removed,savedKey.keyId));
 await waitFor(()=>assert.ok((screen.getByRole('button',{name:'Connect'}) as HTMLButtonElement).disabled));
 fireEvent.click(screen.getByRole('radio',{name:'Duo'}));
 assert.equal(screen.queryByRole('region',{name:'SSH key management'}),null);
});

test('key details show an unlinked account and keep deletion errors in the confirmation dialog',async()=>{
 let calls=0;
 render(<KeyDetailsModal keyInfo={{...savedKey,username:undefined}} onClose={()=>{}} onAccountChanged={()=>{}} onRemove={async()=>{calls++;throw Error('Storage unavailable')}}/>);
 assert.ok(screen.getByText('No linked account'));
 fireEvent.click(screen.getByRole('button',{name:'Delete key'}));
 fireEvent.click(screen.getByRole('button',{name:'Confirm delete'}));
 const error=await screen.findByRole('alert');
 assert.equal(error.textContent,'Storage unavailable');
 assert.equal(error.closest('dialog'),screen.getByRole('dialog',{name:'Delete SSH key?'}));
 assert.equal(calls,1);
 fireEvent.click(screen.getByRole('button',{name:'Cancel delete'}));
 assert.equal(screen.queryByRole('alert'),null);
 assert.ok(screen.getByRole('dialog',{name:'SSH key details'}));
});

test('new key defaults avoid existing names and refresh on reopening without replacing user edits',()=>{
 const props={open:true,keys:[savedKey,{...savedKey,keyId:'second',label:' my HPC3 KEY 2 '}],onClose:()=>{},onPickKey:async()=>({canceled:true as const}),onInspectKey:new MockSshConnectionPort().inspectPrivateKey,onAddExternalKey:async()=>savedKey,onImported:()=>{},onGenerateKey:async()=>savedKey,onGenerated:()=>{}};
 const view=render(<KeyRegistrationModal {...props}/>);
 const input=screen.getByLabelText('Key name') as HTMLInputElement;
 assert.equal(input.value,'My HPC3 key 3');
 fireEvent.change(input,{target:{value:'My laptop'}});
 const keys=[...props.keys,{...savedKey,keyId:'third',label:'My HPC3 key 3'}];
 view.rerender(<KeyRegistrationModal {...props} keys={keys}/>);
 assert.equal(input.value,'My laptop');
 view.rerender(<KeyRegistrationModal {...props} keys={keys} open={false}/>);
 view.rerender(<KeyRegistrationModal {...props} keys={keys}/>);
 assert.equal(input.value,'My HPC3 key 4');
 view.rerender(<KeyRegistrationModal {...props} keys={[]} open={false}/>);
 view.rerender(<KeyRegistrationModal {...props} keys={[]}/>);
 assert.equal(input.value,'My HPC3 key');
});

test('importing a key rejects unencrypted keys and hides redundant success text',async()=>{
 let encrypted=false,imports=0;
 render(<KeyRegistrationModal open onClose={()=>{}} onPickKey={async()=>({canceled:false,path:'/test/key',name:'key'})} onInspectKey={async()=>({status:encrypted?'encrypted':'unencrypted',format:'OpenSSH'})} onAddExternalKey={async()=>{imports++;return savedKey}} onImported={()=>{}} onGenerateKey={async()=>savedKey} onGenerated={()=>{}}/>);
 fireEvent.click(screen.getByRole('radio',{name:'Use Existing SSH Key'}));
 fireEvent.click(screen.getByRole('button',{name:'Choose private key…'}));
 await screen.findByText('This key has no passphrase. Choose a passphrase-protected key.');
 const save=screen.getByRole('button',{name:'Save key'}) as HTMLButtonElement;
 assert.ok(save.disabled);
 fireEvent.submit(save.closest('form')!);
 assert.equal(imports,0);
 encrypted=true;
 fireEvent.click(screen.getByRole('button',{name:'Choose private key…'}));
 await waitFor(()=>assert.equal(save.disabled,false));
 assert.equal(screen.queryByText('Passphrase protected'),null);
 fireEvent.click(save);
 await waitFor(()=>assert.equal(imports,1));
});

test('shared modal blocks dismissal while busy and closes its native dialog on unmount',()=>{
 let closed=0;
 const view=render(<Modal title="Shared modal" dismissDisabled onClose={()=>closed++}>Content</Modal>);
 const dialog=screen.getByRole('dialog',{name:'Shared modal'}) as HTMLDialogElement;
 dialog.getBoundingClientRect=()=>({left:100,top:100,right:400,bottom:400,width:300,height:300,x:100,y:100,toJSON:()=>({})});
 fireEvent.click(dialog,{clientX:10,clientY:10});
 fireEvent(dialog,new dom.window.Event('cancel',{cancelable:true}));
 assert.equal(closed,0);
 assert.ok((screen.getByRole('button',{name:'Close'}) as HTMLButtonElement).disabled);
 view.rerender(<Modal title="Shared modal" onClose={()=>closed++}>Content</Modal>);
 fireEvent.click(dialog,{clientX:10,clientY:10});
 assert.equal(closed,1);
 view.unmount();
 assert.equal(dialog.open,false);
});

test('status identity uses key labels or Duo accounts and the configured SSH endpoint',()=>{
 assert.deepEqual(connectionIdentity({...profile,auth:{...profile.auth,keyId:savedKey.keyId}},[savedKey]),{name:savedKey.label,endpoint:'testuser@hpc3.rcic.uci.edu:22'});
 assert.equal(connectionIdentity(profile,[savedKey]).name,savedKey.label);
 assert.equal(connectionIdentity(profile,[]).name,'SSH key');
 assert.deepEqual(connectionIdentity({...profile,auth:{method:'duo'}},[]),{name:'testuser · Duo',endpoint:'testuser@hpc3.rcic.uci.edu:22'});
 assert.equal(connectionIdentity({...profile,host:'::1',port:2222},[]).endpoint,'testuser@[::1]:2222');
});

test('status block displays environment initialization while retaining the SSH endpoint',async()=>{
 const {environmentLabels}=await import('../shared/environment/types');let opened=0;
 const view=render(<SshStatusBlock name="Key" host="user@host:22" status="connected" environment={{phase:'checking',message:'Probing remote tools'}} onEnvironment={()=>opened++} onEdit={()=>{}} onToggle={()=>{}}/>);
 assert.ok(screen.getByText('user@host:22'));assert.ok(screen.getByText(environmentLabels.checking));
 fireEvent.click(screen.getByRole('button',{name:'SIGNET environment: '+environmentLabels.checking}));assert.equal(opened,1);
 view.rerender(<SshStatusBlock name="Key" host="user@host:22" status="connected" environment={{phase:'installing-image',message:'Downloading container'}} onEdit={()=>{}} onToggle={()=>{}}/>);
 assert.ok(screen.getByText('Downloading container…'));assert.ok(screen.getByText('user@host:22'));
});

test('environment installation opens a separate confirmation and never starts on the first click',async()=>{
 const {EnvironmentModal}=await import('../renderer/features/environment/EnvironmentModal');let installs=0;
 const bridge={getSnapshot:async()=>({ok:true}),check:async()=>({ok:true}),install:async()=>{installs++;return {ok:true}},subscribe:()=>()=>{}};
 render(<EnvironmentModal snapshot={{phase:'needs-install',message:'Source missing'}} bridge={bridge} onClose={()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'Install missing components…'}));assert.equal(installs,0);
 assert.ok(screen.getByRole('dialog',{name:'Install SIGNET environment?'}));
 fireEvent.click(screen.getByRole('button',{name:'Install environment'}));await waitFor(()=>assert.equal(installs,1));
});

test('SSH icon collapses manually and reapplies defaults on status changes',()=>{
 const props={name:'Key',host:'user@host:22',onEdit:()=>{},onToggle:()=>{}};
 const view=render(<SshStatusBlock {...props} status="disconnected"/>);
 assert.ok(screen.getByRole('switch'));
 fireEvent.click(screen.getByRole('button',{name:'Collapse SSH connection'}));
 assert.ok(screen.getByRole('switch'));assert.equal(screen.queryByRole('button',{name:'Edit SSH connection: Key'}),null);
 view.rerender(<SshStatusBlock {...props} status="connecting"/>);
 assert.ok(screen.getByRole('switch'));
 view.rerender(<SshStatusBlock {...props} status="disconnected"/>);
 assert.ok(screen.getByRole('switch'));
 view.rerender(<SshStatusBlock {...props} status="connected"/>);
 assert.ok(screen.getByRole('switch'));assert.equal(screen.queryByRole('button',{name:'Edit SSH connection: Key'}),null);
 fireEvent.click(screen.getByRole('button',{name:'Expand SSH connection'}));
 assert.ok(screen.getByRole('switch'));
 view.rerender(<SshStatusBlock {...props} status="connected"/>);
 assert.ok(screen.getByRole('switch'));
 view.rerender(<SshStatusBlock {...props} status="connected" environment={{phase:'checking',message:'Checking'}}/>);
 assert.ok(screen.getByRole('switch'));
 view.rerender(<SshStatusBlock {...props} status="connected" environment={{phase:'ready',message:'Ready'}}/>);
 assert.ok(screen.getByRole('switch'));assert.equal(screen.queryByRole('button',{name:'Edit SSH connection: Key'}),null);
 view.rerender(<SshStatusBlock {...props} status="error"/>);
 assert.ok(screen.getByRole('switch'));
});
