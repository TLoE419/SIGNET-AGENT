import {useEffect,useMemo,useRef,useState} from 'react';
import type {AuthChallenge,HostIdentity} from './types';
export function HostTrust({identity,onTrust}:{identity?:HostIdentity;onTrust?:()=>Promise<void>}){
 const [verified,setVerified]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{setVerified(false);setError('')},[identity?.fingerprint,identity?.host,identity?.port]);
 if(!identity)return null;
 return <section aria-label="Verify host identity"><strong>Verify host identity</strong><p>{identity.host}:{identity.port} · {identity.algorithm}</p><code>{identity.fingerprint}</code><p>Confirm this fingerprint with RCIC through a trusted, separate channel.</p><label><input type="checkbox" checked={verified} onChange={e=>setVerified(e.target.checked)}/>I independently verified this exact fingerprint.</label><button type="button" disabled={!verified||busy} onClick={async()=>{setBusy(true);try{await onTrust?.();setVerified(false)}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}>Trust verified host</button>{error&&<p role="alert">{error}</p>}</section>;
}
export function DuoChallenge({challenge,onAnswer}:{challenge?:AuthChallenge|null;onAnswer:(sessionId:string,challengeId:string,answers:string[])=>Promise<void>}){
 const section=useRef<HTMLElement>(null),[answers,setAnswers]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const options=useMemo(()=>{
  if(!challenge||challenge.prompts.length!==1)return [];
  const values:{value:string;label:string}[]=[];
  const serverText=[challenge.name,challenge.instructions,...challenge.prompts.map(prompt=>prompt.prompt)].join('\n');
  for(const line of serverText.split(/\r?\n/)){
   const match=line.match(/^\s*(\d+)\.\s+(.+?)\s*$/);
   if(match&&!values.some(option=>option.value===match[1]))values.push({value:match[1],label:match[2]});
  }
  return values.slice(0,10);
 },[challenge?.challengeId,challenge?.instructions,challenge?.prompts.length]);
 useEffect(()=>{setAnswers(challenge?.prompts.map(()=> '')||[]);setError('');setBusy(false);if(challenge&&typeof requestAnimationFrame==='function')requestAnimationFrame(()=>section.current?.scrollIntoView({block:'nearest'}))},[challenge?.challengeId]);
 if(!challenge)return null;
 async function submit(values:string[]){
  if(busy||values.length!==challenge!.prompts.length||values.some(value=>!value))return;
  setBusy(true);setError('');setAnswers(challenge!.prompts.map(()=> ''));
  try{await onAnswer(challenge!.sessionId,challenge!.challengeId,values)}catch(e){setError((e as Error).message);setBusy(false)}
 }
 return <section ref={section} className="ssh-auth-challenge" aria-label="Duo authentication" aria-live="polite"><strong>{challenge.name||'Duo authentication'}</strong><p className="ssh-duo-instructions">{challenge.instructions}</p>
  {options.length>0&&<div className="ssh-duo-options" role="group" aria-label="Available Duo options">{options.map(option=><button key={option.value} type="button" disabled={busy} onClick={()=>void submit([option.value])}><b>{option.value}</b> {option.label}</button>)}</div>}
  {challenge.prompts.map((prompt,index)=><label key={index}>{prompt.prompt}<input autoFocus={index===0&&options.length===0} autoComplete="one-time-code" type={prompt.echo?'text':'password'} value={answers[index]||''} disabled={busy} onChange={e=>setAnswers(values=>challenge.prompts.map((_,i)=>i===index?e.target.value:values[i]||''))}/></label>)}
  <button type="button" disabled={busy||answers.length!==challenge.prompts.length||answers.some(value=>!value)} onClick={()=>void submit(answers)}>Submit authentication response</button>{busy&&<p role="status">Waiting for Duo authentication…</p>}{error&&<p role="alert">{error}</p>}</section>;
}
