export type EnvironmentPhase='disconnected'|'checking'|'needs-install'|'blocked'|'installing-source'|'installing-image'|'verifying'|'ready'|'error';
export interface EnvironmentConfig {root:string;source:string;image:string;executor:string;workRoot:string;revision:string;partition:string}
export interface EnvironmentSnapshot {phase:EnvironmentPhase;message:string;config?:EnvironmentConfig;missing?:string[];checkedAt?:string}
export interface EnvironmentBridge {
 getSnapshot():Promise<{ok:boolean;value?:EnvironmentSnapshot;error?:string}>;
 check(root?:string,partition?:string):Promise<{ok:boolean;value?:EnvironmentSnapshot;error?:string}>;
 install():Promise<{ok:boolean;value?:EnvironmentSnapshot;error?:string}>;
 subscribe(listener:(snapshot:EnvironmentSnapshot)=>void):()=>void;
}
export const environmentLabels:Record<EnvironmentPhase,string>={disconnected:'Disconnected',checking:'Checking environment…','needs-install':'Setup required',blocked:'Setup blocked','installing-source':'Installing SIGNET…','installing-image':'Downloading container…',verifying:'Verifying environment…',ready:'Environment ready',error:'Setup failed'};
