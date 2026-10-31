import type {Profile,KeyMetadata} from '../../../../shared/ssh/types';

/** Labels describe the selected credential and configured endpoint, not a login node. */
export function connectionIdentity(profile:Profile|null,keys:KeyMetadata[]){
 if(!profile)return {name:'Set up SSH connection',endpoint:'No SSH endpoint configured'};
 const host=profile.host.includes(':')&&!profile.host.startsWith('[')?`[${profile.host}]`:profile.host;
 const endpoint=`${profile.username}@${host}:${profile.port}`;
 if(profile.auth.method==='duo')return {name:`${profile.username} · Duo`,endpoint};
 const auth=profile.auth;
 const key=keys.find(key=>auth.keyId?key.keyId===auth.keyId:key.privateKeyPath===auth.privateKeyPath);
 return {name:key?.label||'SSH key',endpoint};
}
