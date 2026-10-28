import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ConnectionModal,KeyRegistrationModal,useSshConnection} from '../../modules/ssh';
import {ElectronSshConnectionPort,ElectronSshKeyOnboardingPort,type SshBridge} from './ElectronSshConnectionPort';
import {uciHpc3Preset,type AuthChallenge,type KeyMetadata,type FormInput} from '../../modules/ssh/types';
import {UnlockPrompt} from './UnlockPrompt';
import {AccountLoginPrompt} from './AccountLoginPrompt';
import {DevTerminalPanel,type DevTerminalBridge} from './DevTerminalPanel';
import {ConnectionDiagnostics,useConnectionDiagnostics} from './ConnectionDiagnostics';
import {SshStatusBlock} from './SshStatusBlock';
const bridge=(window as unknown as {signetDesktop:{ssh:SshBridge}}).signetDesktop.ssh,port=new ElectronSshConnectionPort(bridge),onboarding=new ElectronSshKeyOnboardingPort(bridge);
const devTerminal=(window as unknown as {signetDesktop:{devTerminal?:DevTerminalBridge}}).signetDesktop.devTerminal;
function SshControls(){
 const diagnostics=useConnectionDiagnostics(devTerminal),diagnosticView=devTerminal?<ConnectionDiagnostics entries={diagnostics}/>:undefined;
 const ssh=useSshConnection(port),[open,setOpen]=useState(false),[keyOpen,setKeyOpen]=useState(false),[unlock,setUnlock]=useState(false),[account,setAccount]=useState(false),[draft,setDraft]=useState<FormInput|null>(null),[registration,setRegistration]=useState<{key:KeyMetadata;passphrase:string}|null>(null),[challenge,setChallenge]=useState<AuthChallenge|null>(null),[keys,setKeys]=useState<KeyMetadata[]>([]),p=ssh.snapshot.selectedProfile,liveStatus=ssh.snapshot.connection?.status||'unconfigured',status=ssh.error&&!['connected','connecting','disconnecting'].includes(liveStatus)?'error':liveStatus;
 useEffect(()=>{void onboarding.listKeys().then(setKeys);return onboarding.subscribeAuthChallenge(setChallenge)},[]);
 useEffect(()=>{const check=()=>{if(liveStatus==='connected'&&document.visibilityState!=='hidden')void ssh.healthCheck(false).catch(()=>{})};window.addEventListener('focus',check);document.addEventListener('visibilitychange',check);return()=>{window.removeEventListener('focus',check);document.removeEventListener('visibilitychange',check)}},[liveStatus]);
 async function refreshKeys(){setKeys(await onboarding.listKeys())}
 function credentialRequest(e:unknown){const code=(e as {code?:string}).code;if(code==='PASSPHRASE_REQUIRED'){setUnlock(true);return}if(code==='PASSWORD_REQUIRED'){setAccount(true);return}throw e}
 async function connect(input:FormInput){setDraft(null);if(input.auth.method==='duo'){await ssh.save(input);setOpen(false);setAccount(true);return}try{await ssh.connect(input)}catch(e){credentialRequest(e)}}
 async function toggle(){if(liveStatus==='connected'||liveStatus==='connecting'){await ssh.disconnect();return}if(!p){setOpen(true);return}if(p.auth.method==='duo'){setAccount(true);return}try{await ssh.connectSaved()}catch(e){credentialRequest(e)}}
 const connection=ssh.snapshot.connection,remote=connection?.health?.remote,detail=remote?`${remote.username} @ ${remote.hostname} · Slurm ready`:undefined;
 return <>{devTerminal&&<DevTerminalPanel diagnostics={diagnostics} bridge={devTerminal} connected={liveStatus==='connected'} status={liveStatus}/>}<SshStatusBlock name={p?.name||'UCI HPC3'} host={p?`${p.host}:${p.port}`:'hpc3.rcic.uci.edu:22'} status={status} phase={connection?.phase} detail={detail} error={ssh.error||connection?.error} busy={ssh.busy} onEdit={()=>setOpen(true)} onToggle={()=>void toggle().catch(()=>{})}/>
 <UnlockPrompt diagnostics={diagnosticView} open={unlock} name={p?.name||'SSH'} onClose={()=>{setUnlock(false);if(liveStatus==='connecting')void ssh.disconnect()}} onConnect={ssh.connectSaved} pendingHost={ssh.snapshot.pendingHost} onTrust={ssh.trustHost}/>
 <ConnectionModal diagnostics={diagnosticView} open={open} onClose={()=>setOpen(false)} profile={draft||p} keys={keys} status={status} busy={ssh.busy} health={connection?.health} error={ssh.error||connection?.error} onOpenKeyRegistration={()=>{setOpen(false);setKeyOpen(true)}} onInspectKey={ssh.inspect} onSave={async input=>{await ssh.save(input);setDraft(null)}} onConnect={connect} onDisconnect={ssh.disconnect} onCheck={()=>ssh.healthCheck(true)} pendingHost={ssh.snapshot.pendingHost} onTrustHost={ssh.trustHost}/>
 <KeyRegistrationModal open={keyOpen} onClose={()=>setKeyOpen(false)} onPickKey={ssh.pickKey} onInspectKey={ssh.inspect} onGenerateKey={onboarding.generateKey} onAddExternalKey={onboarding.addExternalKey} onGenerated={(key,passphrase)=>{setRegistration({key,passphrase});setKeyOpen(false);setAccount(true);void refreshKeys()}} onImported={async key=>{await refreshKeys();setDraft({...p,...(!p?uciHpc3Preset:{}),username:p?.username||'',auth:{method:'private-key',privateKeyPath:key.privateKeyPath,keyId:key.keyId,managed:false}} as FormInput);setKeyOpen(false);setOpen(true)}}/>
 <AccountLoginPrompt diagnostics={diagnosticView} onComplete={()=>{setAccount(false);setRegistration(null);setChallenge(null)}} open={account} username={p?.username||''} keyToRegister={registration?.key} challenge={challenge} onAnswer={onboarding.answerAuthChallenge} pendingHost={ssh.snapshot.pendingHost} onTrust={ssh.trustHost} onClose={()=>{setAccount(false);setRegistration(null);setChallenge(null);void bridge.cancelRegistration();if(liveStatus==='connecting')void ssh.disconnect()}} onLogin={async(username,password)=>{if(registration){const key=registration.key;await onboarding.registerKey({profile:{...(p||uciHpc3Preset),username,auth:{method:'private-key',privateKeyPath:key.privateKeyPath,keyId:key.keyId,managed:true}},keyId:key.keyId,passphrase:registration.passphrase,password});setRegistration(null);await refreshKeys()}else await ssh.connect({...p,...(!p?uciHpc3Preset:{}),username,auth:{method:'duo'}} as FormInput,password)}}/>
 </>;
}
const mount=document.getElementById('ssh-root');
if(mount){mount.classList.add('ssh-ui-root');mount.hidden=false;createRoot(mount).render(<SshControls/>)}
