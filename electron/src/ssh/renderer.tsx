import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ConnectionModal,KeyRegistrationModal,useSshConnection} from '../../modules/ssh';
import {ElectronSshConnectionPort,ElectronSshKeyOnboardingPort,type SshBridge} from './ElectronSshConnectionPort';
import type {AuthChallenge,KeyMetadata} from '../../modules/ssh/types';
import {UnlockPrompt} from './UnlockPrompt';
import {SshStatusBlock} from './SshStatusBlock';
const bridge=(window as unknown as {signetDesktop:{ssh:SshBridge}}).signetDesktop.ssh,port=new ElectronSshConnectionPort(bridge),onboarding=new ElectronSshKeyOnboardingPort(bridge);
function SshControls(){
 const ssh=useSshConnection(port),[open,setOpen]=useState(false),[keyOpen,setKeyOpen]=useState(false),[unlock,setUnlock]=useState(false),[challenge,setChallenge]=useState<AuthChallenge|null>(null),[keys,setKeys]=useState<KeyMetadata[]>([]),p=ssh.snapshot.selectedProfile,liveStatus=ssh.snapshot.connection?.status||'unconfigured',status=ssh.error&&!['connected','connecting','disconnecting'].includes(liveStatus)?'error':liveStatus;
 useEffect(()=>{void onboarding.listKeys().then(setKeys);return onboarding.subscribeAuthChallenge(setChallenge)},[]);
 async function refreshKeys(){setKeys(await onboarding.listKeys())}
 async function toggle(){if(liveStatus==='connected'||liveStatus==='connecting'){await ssh.disconnect();return}try{await ssh.connectSaved()}catch(e){if((e as {code?:string}).code==='PASSPHRASE_REQUIRED')setUnlock(true)}}
 return <><SshStatusBlock name={p?.name||'UCI HPC3'} host={p?`${p.host}:${p.port}`:'hpc3.rcic.uci.edu:22'} status={status} error={ssh.error||ssh.snapshot.connection?.error} busy={ssh.busy} onEdit={()=>setOpen(true)} onToggle={()=>void toggle().catch(()=>{})}/>

 <UnlockPrompt open={unlock} name={p?.name||'SSH'} onClose={()=>{setUnlock(false);if(liveStatus==='connecting')void ssh.disconnect()}} onConnect={ssh.connectSaved}/>
 <ConnectionModal open={open} onClose={()=>setOpen(false)} profile={p} keys={keys} status={status} busy={ssh.busy} error={ssh.error||ssh.snapshot.connection?.error} onOpenKeyRegistration={()=>{setOpen(false);setKeyOpen(true)}} onInspectKey={ssh.inspect} onSave={ssh.save} onConnect={ssh.connect} onDisconnect={ssh.disconnect} pendingHost={ssh.snapshot.pendingHost} onTrustHost={ssh.trustHost}/>
 <KeyRegistrationModal open={keyOpen} profile={p} onClose={()=>{void bridge.cancelRegistration();setChallenge(null);setKeyOpen(false)}} onComplete={()=>{void refreshKeys();setKeyOpen(false);setOpen(true)}} onPickKey={ssh.pickKey} onInspectKey={ssh.inspect} onGenerateKey={onboarding.generateKey} onAddExternalKey={onboarding.addExternalKey} onRegisterKey={onboarding.registerKey} onSaveExternalProfile={async key=>{await ssh.save({...p,name:p?.name||'UCI HPC3',host:p?.host||'hpc3.rcic.uci.edu',port:p?.port||22,username:key.username||'',auth:{method:'private-key',privateKeyPath:key.privateKeyPath,keyId:key.keyId,managed:key.source==='managed'},presetId:p?.presetId||'uci-hpc3'})}} authChallenge={challenge} onAnswerAuthChallenge={async(sessionId,challengeId,answers)=>{await onboarding.answerAuthChallenge(sessionId,challengeId,answers);setChallenge(null)}} pendingHost={ssh.snapshot.pendingHost} onTrustHost={ssh.trustHost}/></>;
}
const mount=document.getElementById('ssh-root');
if(mount){mount.classList.add('ssh-ui-root');mount.hidden=false;createRoot(mount).render(<SshControls/>)}
