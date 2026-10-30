import {Worker} from 'node:worker_threads';
import path from 'node:path';
import {SshFailure} from '../../../shared/ssh/validation';
import type {Inspection} from '../../../shared/ssh/types';
let running=0;
export function keyTask<T>(operation:'inspect'|'unlock'|'generate',keyPath:string,passphrase?:string):Promise<T>{
 if(running>=2)return Promise.reject(new SshFailure('UNKNOWN','Key validation is busy. Try again shortly.'));
 running++;
 return new Promise<T>((resolve,reject)=>{
  const worker=new Worker(path.join(__dirname,'key-worker.cjs'),{workerData:{operation,path:keyPath,passphrase}});
  const timer=setTimeout(()=>{void worker.terminate();reject(new SshFailure('UNKNOWN','Local key validation timed out.'))},15000);
  worker.once('message',r=>{clearTimeout(timer);void worker.terminate();r.ok?resolve(r.value):reject(new SshFailure(r.code,r.message))});
  worker.once('error',()=>{clearTimeout(timer);reject(new SshFailure('UNKNOWN','Local key validation failed.'))});
  worker.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(new SshFailure('UNKNOWN','Local key worker stopped.'))});
 }).finally(()=>{running--});
}
export const keyOperations={inspect:(p:string)=>keyTask<Inspection>('inspect',p),unlock:(p:string,s:string)=>keyTask<string>('unlock',p,s),generate:(passphrase:string,label:string)=>keyTask<{private:string;public:string}>('generate',label,passphrase)};
