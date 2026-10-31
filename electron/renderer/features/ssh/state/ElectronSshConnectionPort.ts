import type {SshConnectionPort,SshKeyOnboardingPort,Snapshot,FormInput,Profile,Inspection,HostIdentity,PrivateKeySelection,KeyMetadata,RegistrationResult,AuthChallenge,ConnectionHealth} from '../../../../shared/ssh/types';
type Reply<T>={ok:true;value:T}|{ok:false;error:{code:string;message:string}};
export interface SshBridge {
 cancelRegistration():Promise<Reply<void>>;
 initialize():Promise<Reply<Snapshot>>;getSnapshot():Promise<Reply<Snapshot>>;listProfiles():Promise<Reply<Profile[]>>;
 saveProfile(p:FormInput):Promise<Reply<Profile>>;selectProfile(id:string):Promise<Reply<void>>;inspectPrivateKey(p:string):Promise<Reply<Inspection>>;
 pickPrivateKey():Promise<Reply<PrivateKeySelection>>;
 connect(id:string,p:string):Promise<Reply<void>>;disconnect(id:string):Promise<Reply<void>>;healthCheck(force:boolean):Promise<Reply<ConnectionHealth>>;trustHost(i:HostIdentity):Promise<Reply<void>>;
 updateKey(id:string,input:{label:string;username?:string}):Promise<Reply<KeyMetadata>>;removeKey(id:string):Promise<Reply<void>>;
 listKeys():Promise<Reply<KeyMetadata[]>>;generateKey(input:{label:string;username?:string;passphrase:string}):Promise<Reply<KeyMetadata>>;addExternalKey(input:{label:string;username?:string;privateKeyPath:string}):Promise<Reply<KeyMetadata>>;registerGenerated(input:{profile:FormInput;keyId:string;passphrase:string;password:string}):Promise<Reply<RegistrationResult>>;
 answerAuthChallenge(sessionId:string,challengeId:string,answers:string[]):Promise<Reply<void>>;subscribeAuthChallenge(fn:(challenge:AuthChallenge|null)=>void):()=>void;
 subscribe(fn:(s:Snapshot)=>void):()=>void;
}
async function unwrap<T>(p:Promise<Reply<T>>):Promise<T>{const r=await p;if(!r.ok)throw Object.assign(new Error(r.error.message),{code:r.error.code});return r.value}
export class ElectronSshConnectionPort implements SshConnectionPort {
 constructor(private bridge:SshBridge){}
 initialize=()=>unwrap(this.bridge.initialize());getSnapshot=()=>unwrap(this.bridge.getSnapshot());listProfiles=()=>unwrap(this.bridge.listProfiles());
 saveProfile=(p:FormInput)=>unwrap(this.bridge.saveProfile(p));selectProfile=(id:string)=>unwrap(this.bridge.selectProfile(id));inspectPrivateKey=(p:string)=>unwrap(this.bridge.inspectPrivateKey(p));
 pickPrivateKey=()=>unwrap(this.bridge.pickPrivateKey());
 connect=(id:string,p:string)=>unwrap(this.bridge.connect(id,p));disconnect=(id:string)=>unwrap(this.bridge.disconnect(id));healthCheck=(force=false)=>unwrap(this.bridge.healthCheck(force));trustHost=(i:HostIdentity)=>unwrap(this.bridge.trustHost(i));
 subscribe=(fn:(s:Snapshot)=>void)=>this.bridge.subscribe(fn);
}
export class ElectronSshKeyOnboardingPort implements SshKeyOnboardingPort {
 constructor(private bridge:SshBridge){}
 updateKey=(id:string,input:{label:string;username?:string})=>unwrap(this.bridge.updateKey(id,input));
 removeKey=(id:string)=>unwrap(this.bridge.removeKey(id));
 listKeys=()=>unwrap(this.bridge.listKeys());
 generateKey=(input:{label:string;username?:string;passphrase:string})=>unwrap(this.bridge.generateKey(input));
 addExternalKey=(input:{label:string;username?:string;privateKeyPath:string})=>unwrap(this.bridge.addExternalKey(input));
 registerKey=(input:{profile:FormInput;keyId:string;passphrase:string;password:string})=>unwrap(this.bridge.registerGenerated(input));
 answerAuthChallenge=(sessionId:string,challengeId:string,answers:string[])=>unwrap(this.bridge.answerAuthChallenge(sessionId,challengeId,answers));
 subscribeAuthChallenge=(listener:(challenge:AuthChallenge|null)=>void)=>this.bridge.subscribeAuthChallenge(listener);
}
