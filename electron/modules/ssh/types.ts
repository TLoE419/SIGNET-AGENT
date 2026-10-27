export type Status = 'disconnected'|'connecting'|'connected'|'disconnecting'|'error';
export type SshErrorCode = 'INVALID_PROFILE'|'KEY_NOT_FOUND'|'KEY_UNREADABLE'|'KEY_UNENCRYPTED'|'KEY_INVALID'|'KEY_UNSUPPORTED'|'PASSPHRASE_REQUIRED'|'INVALID_PASSPHRASE'|'HOST_KEY_UNKNOWN'|'HOST_KEY_CHANGED'|'NETWORK_UNREACHABLE'|'CONNECTION_TIMEOUT'|'AUTH_FAILED'|'ACCOUNT_NOT_READY'|'SESSION_CLOSED'|'UNKNOWN';
export interface SshError {code:SshErrorCode; message:string}
export interface Profile {id:string; name:string; host:string; port:number; username:string; auth:{method:'private-key';privateKeyPath:string;keyId?:string;managed?:boolean}; presetId?:string}
export type FormInput = Omit<Profile,'id'> & {id?:string};
export interface ProfilesDocument {version:3;selectedProfileId:string|null;profiles:Profile[]}
export type Inspection = {status:'encrypted'|'unencrypted';format:string;keyType?:string;publicKey?:string;fingerprint?:string}|{status:'invalid'|'unsupported'|'unreadable';reason:string};
export interface HostIdentity {publicKey?:string;host:string;port:number;algorithm:string;fingerprint:string}
export type PrivateKeySelection={canceled:true}|{canceled:false;path:string;name:string};
export interface Snapshot {selectedProfile:Profile|null;connection:{profileId:string;status:Status;connectedAt?:string;error?:SshError}|null; pendingHost?:HostIdentity}
export interface SshConnectionPort {
 initialize():Promise<Snapshot>; listProfiles():Promise<Profile[]>; saveProfile(input:FormInput):Promise<Profile>;
 selectProfile(id:string):Promise<void>; inspectPrivateKey(path:string):Promise<Inspection>;
 pickPrivateKey():Promise<PrivateKeySelection>;
 connect(id:string,passphrase:string):Promise<void>; disconnect(id:string):Promise<void>;
 getSnapshot():Promise<Snapshot>; subscribe(listener:(snapshot:Snapshot)=>void):()=>void;
 trustHost(identity:HostIdentity):Promise<void>;
}
export type RegistrationSessionId=string;
export interface KeyMetadata {keyId:string;label:string;algorithm:string;publicKey:string;fingerprint:string;createdAt:string;privateKeyPath:string;username?:string;source?:'managed'|'external'}
export interface AuthChallenge {sessionId:string;challengeId:string;name:string;instructions:string;prompts:{prompt:string;echo:boolean}[]}
export interface RegistrationResult {alreadyPresent:boolean;verified:boolean}
export interface SshKeyOnboardingPort {
 listKeys():Promise<KeyMetadata[]>;
 generateKey(input:{label:string;username:string;passphrase:string}):Promise<KeyMetadata>;
 addExternalKey(input:{label:string;username:string;privateKeyPath:string}):Promise<KeyMetadata>;
 registerKey(input:{profile:FormInput;keyId:string;passphrase:string;password:string}):Promise<RegistrationResult>;
 answerAuthChallenge(sessionId:RegistrationSessionId,challengeId:string,answers:string[]):Promise<void>;
 subscribeAuthChallenge(listener:(challenge:AuthChallenge)=>void):()=>void;
}
export const uciHpc3Preset:FormInput = {name:'UCI HPC3',host:'hpc3.rcic.uci.edu',port:22,username:'',auth:{method:'private-key',privateKeyPath:''},presetId:'uci-hpc3'};
