import type {FormInput,SshErrorCode} from './types';
export class SshFailure extends Error {constructor(public code:SshErrorCode,message:string){super(message)}}
export function fail(code:SshErrorCode,message:string):never {throw new SshFailure(code,message)}
export function text(value:unknown,max=256):value is string {return typeof value==='string' && value.length>0 && value.length<=max && !/[\x00-\x1f\x7f]/.test(value)}
export function validPath(value:unknown):value is string {return text(value,4096) && (/^\//.test(value)||/^[A-Za-z]:[\\/]/.test(value))}
export function profileInput(value:unknown):FormInput {
 const p=value as FormInput;
 if(!p||typeof p!=='object'||Object.keys(p).some(k=>!['id','name','host','port','username','auth','presetId'].includes(k))||
 (p.id!==undefined&&(!text(p.id,80)||!/^[a-zA-Z0-9_-]+$/.test(p.id)))||!text(p.name,120)||!text(p.host,253)||
 !/^[a-zA-Z0-9:][a-zA-Z0-9.:-]*$/.test(p.host)||!Number.isInteger(p.port)||p.port<1||p.port>65535||
 !text(p.username,128)||!/^[a-zA-Z0-9_.@-]+$/.test(p.username)||!p.auth||p.auth.method!=='private-key'||
 Object.keys(p.auth).some(k=>!['method','privateKeyPath','keyId','managed'].includes(k))||!validPath(p.auth.privateKeyPath)||
 (p.auth.keyId!==undefined&&(!text(p.auth.keyId,80)||!/^[a-zA-Z0-9_-]+$/.test(p.auth.keyId)))||(p.auth.managed!==undefined&&typeof p.auth.managed!=='boolean')||
 (p.presetId!==undefined&&!text(p.presetId,80))) fail('INVALID_PROFILE','Enter a name, host, port (1–65535), username and absolute private-key path.');
 return {...p,host:p.host.toLowerCase(),auth:{...p.auth}};
}
