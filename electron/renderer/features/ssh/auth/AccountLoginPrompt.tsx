import {Modal, DialogActions} from '../../../components/Modal';
import {useEffect, useRef, useState, type ReactNode} from 'react';
import type {AuthChallenge, HostIdentity, KeyMetadata} from '../../../../shared/ssh/types';
import {DuoChallenge, HostTrust} from './LoginSteps';

interface AccountLoginProps {
 resume?: boolean;
 diagnostics?: ReactNode;
 open: boolean;
 username: string;
 keyToRegister?: KeyMetadata;
 onLogin: (username: string, password: string) => Promise<void>;
 onClose: () => void;
 onComplete: () => void;
 challenge?: AuthChallenge | null;
 onAnswer: (session: string, challenge: string, answers: string[]) => Promise<void>;
 pendingHost?: HostIdentity;
 onTrust: () => Promise<void>;
}

export function AccountLoginPrompt(p: AccountLoginProps) {
 const generation = useRef(0), lock = useRef(false);
 const [username, setUsername] = useState(p.username);
 const [password, setPassword] = useState('');
 const [working, setWorking] = useState(false);
 const [error, setError] = useState('');
 const [duoStarted, setDuoStarted] = useState(false);
 const verifying = working && Boolean(p.challenge || duoStarted);
 const cancelVerification = useRef<HTMLButtonElement>(null);

 useEffect(() => {
  generation.current++;
  setPassword('');
  setError('');
  setDuoStarted(false);
  if (p.open) setUsername(p.username);
 }, [p.open]);

 useEffect(() => {
  if (p.open && working && p.challenge) setDuoStarted(true);
 }, [p.open, working, p.challenge]);

 useEffect(() => {
  if (p.open && verifying && !p.challenge) cancelVerification.current?.focus();
 }, [p.open, verifying, p.challenge]);

 function close() {
  generation.current++;
  setPassword('');
  p.onClose();
 }

 async function submit() {
  if (lock.current || !username.trim() || (!p.resume && !password)) return;
  const current = generation.current, secret = p.resume ? '' : password;
  setPassword('');
  setError('');
  setDuoStarted(false);
  lock.current = true;
  setWorking(true);
  try {
   await p.onLogin(username.trim(), secret);
   if (current === generation.current) p.onComplete();
  } catch (e) {
   if (current === generation.current) setError((e as Error).message);
  } finally {
   lock.current = false;
   setWorking(false);
  }
 }

 const title = verifying ? 'Verify with Duo' : p.keyToRegister ? 'Set up SSH key' : 'Sign in with Duo';
 return <Modal open={p.open} title={title} className="ssh-account-login" onClose={close}>
  {verifying ? <>
   {p.challenge ? <DuoChallenge key={p.challenge.challengeId} challenge={p.challenge} onAnswer={p.onAnswer}/>
    : <p role="status">Finishing sign-in<span className="ssh-sign-in-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></p>}
   <HostTrust identity={p.pendingHost} onTrust={p.onTrust}/>
   {p.diagnostics}
   <DialogActions><button ref={cancelVerification} type="button" onClick={close}>Cancel</button></DialogActions>
  </> : <form onSubmit={event => {event.preventDefault(); void submit()}}>
   {p.keyToRegister ? <>
    <p>Your key is ready. Sign in to install its public key on your account and verify the connection.</p>
    <strong>{p.keyToRegister.label}</strong><code>{p.keyToRegister.fingerprint}</code>
    <details><summary>View public key for manual setup</summary>
     <textarea aria-label="Generated public key" readOnly rows={4} value={p.keyToRegister.publicKey}/>
    </details>
   </> : p.resume ? <p>Your login is still active. Retry verification without entering your password or approving Duo again.</p>
    : <p>Enter your account password to continue to Duo.</p>}
   <fieldset disabled={working}>
    <legend>Account sign-in</legend>
    <label>UCInetID / username
     <input aria-label="UCInetID / username" autoFocus={!p.username&&!p.resume} autoComplete="username" disabled={p.resume} required
      value={username} onChange={event => setUsername(event.target.value)}/>
    </label>
    {!p.resume && <label>UCInetID password
     <input aria-label="UCInetID password" autoFocus={Boolean(p.username)} type="password" autoComplete="off" required
      value={password} onChange={event => setPassword(event.target.value)}/>
    </label>}
   </fieldset>
   <HostTrust identity={p.pendingHost} onTrust={p.onTrust}/>
   {error && <p role="alert">{error}</p>}
   {p.diagnostics}
   <DialogActions>
    <button type="button" onClick={close}>Cancel</button>
    <button type="submit" className="ssh-primary" disabled={working || !username.trim() || (!p.resume && !password)}>
     {working ? 'Signing in…' : p.resume ? 'Retry verification' : p.keyToRegister ? 'Sign in and set up key' : 'Sign in'}
    </button>
   </DialogActions>
  </form>}
 </Modal>;
}
