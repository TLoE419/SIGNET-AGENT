import {parentPort,workerData} from 'node:worker_threads';
import {inspectPrivateKey} from './PrivateKeyInspector';
import {unlockPrivateKey} from './PrivateKeyUnlocker';
import {utils} from 'ssh2';
(async()=>{
 try{parentPort!.postMessage({ok:true,value:workerData.operation==='inspect'?await inspectPrivateKey(workerData.path):workerData.operation==='generate'?utils.generateKeyPairSync('rsa',{bits:4096,passphrase:workerData.passphrase,cipher:'aes256-ctr',rounds:16,comment:workerData.path}):await unlockPrivateKey(workerData.path,workerData.passphrase)})}
 catch(e){const error=e as {code?:string;message:string};parentPort!.postMessage({ok:false,code:error.code||'UNKNOWN',message:error.message})}
 finally{workerData.passphrase=undefined}
})();
