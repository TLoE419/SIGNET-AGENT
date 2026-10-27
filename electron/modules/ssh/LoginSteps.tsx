import {useEffect,useState} from 'react';
import type {AuthChallenge,HostIdentity} from './types';
export function HostTrust({identity,onTrust}:{identity?:HostIdentity;onTrust?:()=>Promise<void>}){
 const [verified,setVerified]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{setVerified(false);setError('')},[identity?.fingerprint,identity?.host,identity?.port]);
 if(!identity)return null;
 return <section aria-label="Verify host identity"><strong>Verify host identity</strong><p>{identity.host}:{identity.port} · {identity.algorithm}</p><code>{identity.fingerprint}</code><p>Confirm this fingerprint with RCIC through a trusted, separate channel.</p><label><input type="checkbox" checked={verified} onChange={e=>setVerified(e.target.checked)}/>I independently verified this exact fingerprint.</label><button type="button" disabled={!verified||busy} onClick={async()=>{setBusy(true);try{await onTrust?.();setVerified(false)}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}>Trust verified host</button>{error&&<p role="alert">{error}</p>}</section>;
}
export function DuoChallenge({challenge,onAnswer}:{challenge?:AuthChallenge|null;onAnswer:(sessionId:string,challengeId:string,answers:string[])=>Promise<void>}){
 const [answers,setAnswers]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{setAnswers(challenge?.prompts.map(()=> '')||[]);setError('');setBusy(false)},[challenge?.challengeId]);
 if(!challenge)return null;
 return <section className="ssh-auth-challenge" aria-label="Duo authentication"><strong>{challenge.name||'Duo authentication'}</strong><p>{challenge.instructions}</p>{challenge.prompts.map((prompt,index)=><label key={index}>{prompt.prompt}<input autoComplete="off" type={prompt.echo?'text':'password'} value={answers[index]||''} onChange={e=>setAnswers(values=>challenge.prompts.map((_,i)=>i===index?e.target.value:values[i]||''))}/></label>)}<button type="button" disabled={busy} onClick={async()=>{setBusy(true);const values=answers;setAnswers(challenge.prompts.map(()=> ''));try{await onAnswer(challenge.sessionId,challenge.challengeId,values)}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}>Submit authentication response</button>{error&&<p role="alert">{error}</p>}</section>;
}
