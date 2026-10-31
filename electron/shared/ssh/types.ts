export type Status = 'disconnected'|'connecting'|'connected'|'disconnecting'|'error';
export type ConnectionPhase = 'opening-transport'|'authenticating'|'opening-session'|'verifying-remote'|'ready';
export type SshErrorCode = 'INVALID_PROFILE'|'KEY_NOT_FOUND'|'KEY_UNREADABLE'|'KEY_UNENCRYPTED'|'KEY_INVALID'|'KEY_UNSUPPORTED'|'PASSWORD_REQUIRED'|'PASSPHRASE_REQUIRED'|'INVALID_PASSPHRASE'|'HOST_KEY_UNKNOWN'|'HOST_KEY_CHANGED'|'DNS_FAILED'|'NETWORK_UNREACHABLE'|'CONNECTION_TIMEOUT'|'AUTH_FAILED'|'ACCOUNT_NOT_READY'|'SESSION_OPEN_FAILED'|'REMOTE_IDENTITY_MISMATCH'|'SLURM_UNAVAILABLE'|'STALE_CONNECTION'|'SESSION_CLOSED'|'UNKNOWN';
export interface SshError {code:SshErrorCode; message:string}
export interface HealthStep {name:'transport'|'session'|'identity'|'slurm';ok:boolean;detail:string}
export interface RemoteIdentity {hostname:string;username:string;slurm:boolean}
export interface ConnectionHealth {checkedAt:string;steps:HealthStep[];remote:RemoteIdentity}
export interface Profile {id:string; name:string; host:string; port:number; username:string; auth:({method:'private-key';privateKeyPath:string;keyId?:string;managed?:boolean}|{method:'duo';privateKeyPath?:never;keyId?:never;managed?:never}); presetId?:string}
export type FormInput = Omit<Profile,'id'> & {id?:string};
export interface ProfilesDocument {version:3|4;selectedProfileId:string|null;profiles:Profile[]}
export type Inspection = {status:'encrypted'|'unencrypted';format:string;keyType?:string;publicKey?:string;fingerprint?:string}|{status:'invalid'|'unsupported'|'unreadable';reason:string};
export interface HostIdentity {publicKey?:string;host:string;port:number;algorithm:string;fingerprint:string}
export type PrivateKeySelection={canceled:true}|{canceled:false;path:string;name:string};
export interface Snapshot {selectedProfile:Profile|null;connection:{profileId:string;status:Status;phase?:ConnectionPhase;connectedAt?:string;health?:ConnectionHealth;error?:SshError}|null; pendingHost?:HostIdentity}
export interface SshConnectionPort {
 initialize():Promise<Snapshot>; listProfiles():Promise<Profile[]>; saveProfile(input:FormInput):Promise<Profile>;
 selectProfile(id:string):Promise<void>; inspectPrivateKey(path:string):Promise<Inspection>;
 pickPrivateKey():Promise<PrivateKeySelection>;
 connect(id:string,passphrase:string):Promise<void>; disconnect(id:string):Promise<void>;
 healthCheck(force?:boolean):Promise<ConnectionHealth>;
 getSnapshot():Promise<Snapshot>; subscribe(listener:(snapshot:Snapshot)=>void):()=>void;
 trustHost(identity:HostIdentity):Promise<void>;
}
export type RegistrationSessionId=string;
export interface KeyMetadata {keyId:string;label:string;algorithm:string;publicKey:string;fingerprint:string;createdAt:string;privateKeyPath:string;username?:string;source?:'managed'|'external'}
export interface AuthChallenge {sessionId:string;challengeId:string;name:string;instructions:string;prompts:{prompt:string;echo:boolean}[]}
export interface RegistrationResult {alreadyPresent:boolean;verified:boolean}
export interface SshKeyOnboardingPort {
 updateKey(id:string,input:{label:string;username?:string}):Promise<KeyMetadata>;removeKey(id:string):Promise<void>;
 listKeys():Promise<KeyMetadata[]>;
 generateKey(input:{label:string;username?:string;passphrase:string}):Promise<KeyMetadata>;
 addExternalKey(input:{label:string;username?:string;privateKeyPath:string}):Promise<KeyMetadata>;
 registerKey(input:{profile:FormInput;keyId:string;passphrase:string;password:string}):Promise<RegistrationResult>;
 answerAuthChallenge(sessionId:RegistrationSessionId,challengeId:string,answers:string[]):Promise<void>;
 subscribeAuthChallenge(listener:(challenge:AuthChallenge|null)=>void):()=>void;
}
export const uciHpc3Preset:FormInput = {name:'UCI HPC3',host:'hpc3.rcic.uci.edu',port:22,username:'',auth:{method:'duo'},presetId:'uci-hpc3'};
