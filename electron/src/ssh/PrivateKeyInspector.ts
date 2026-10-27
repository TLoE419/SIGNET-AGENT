import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {utils} from 'ssh2';
import {createHash} from 'node:crypto';
import type {Inspection} from '../../modules/ssh/types';
import {validPath} from '../../modules/ssh/validation';
export async function readKey(path:string):Promise<Buffer> {
 if(!validPath(path)) throw Error('Use an absolute private-key path.');
 // Resolve parent aliases (e.g. macOS /tmp), but reject a symlink as the selected file.
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {
  const st=await file.stat();
  if(!st.isFile()||st.size===0||st.size>128*1024) throw Error('Select a regular private-key file smaller than 128 KiB.');
  if(process.platform!=='win32'&&((st.mode&0o077)!==0||!(st.mode&0o400)||(process.getuid&&st.uid!==process.getuid()))) throw Error('Private key must be owned by you and owner-readable only; set its permissions to 0600.');
  await realpath(path);
  const bytes=Buffer.alloc(st.size+1); const {bytesRead}=await file.read(bytes,0,bytes.length,0);
  if(bytesRead!==st.size) throw Error('Key changed while reading; select it again.');
  return bytes.subarray(0,bytesRead);
 } finally {await file.close()}
}
class Reader {
 offset=0;constructor(readonly b:Buffer){}
 uint(){if(this.offset+4>this.b.length)throw Error();const n=this.b.readUInt32BE(this.offset);this.offset+=4;return n}
 str(){const n=this.uint();if(n>this.b.length-this.offset)throw Error();const b=this.b.subarray(this.offset,this.offset+n);this.offset+=n;return b}
 done(){if(this.offset!==this.b.length)throw Error()}
}
export function inspectBytes(bytes:Buffer):Inspection {
 const s=bytes.toString('utf8').trim();
 if(!s.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')) {
  if(/^-----BEGIN (?:ENCRYPTED |RSA |EC |DSA )?PRIVATE KEY-----/.test(s)||s.startsWith('PuTTY-User-Key-File-')) return {status:'unsupported',reason:'Use an OpenSSH private key; PEM, PKCS#8 and PuTTY formats are not supported in this MVP.'};
  return {status:'invalid',reason:'Select a private key, not a public key or other document.'};
 }
 try {
  const match=s.match(/^-----BEGIN OPENSSH PRIVATE KEY-----\s+([A-Za-z0-9+/=\r\n]+)\s+-----END OPENSSH PRIVATE KEY-----$/);if(!match)throw Error();
  const base=match[1].replace(/\s/g,'');const b=Buffer.from(base,'base64');if(b.toString('base64')!==base)throw Error();
  if(b.subarray(0,15).toString('binary')!=='openssh-key-v1\0')throw Error();
  const r=new Reader(b.subarray(15));const cipher=r.str().toString(),kdf=r.str().toString(),opts=r.str();if(r.uint()!==1)throw Error();
  const pub=r.str(),payload=r.str();r.done();const pr=new Reader(pub);const keyType=pr.str().toString();
  if(!['ssh-ed25519','ssh-rsa','ecdsa-sha2-nistp256','ecdsa-sha2-nistp384','ecdsa-sha2-nistp521'].includes(keyType))return {status:'unsupported',reason:'Unsupported OpenSSH key algorithm.'};
  const publicText=`${keyType} ${pub.toString('base64')}`,publicKey=utils.parseKey(publicText);if(publicKey instanceof Error)throw Error();const fingerprint='SHA256:'+createHash('sha256').update(pub).digest('base64').replace(/=+$/,'');
  if(cipher==='none') {
   if(kdf!=='none'||opts.length)throw Error();
   const parsed=utils.parseKey(bytes);if(parsed instanceof Error)throw Error();const keys=Array.isArray(parsed)?parsed:[parsed];if(keys.length!==1||!keys[0].isPrivateKey())throw Error();
   return {status:'unencrypted',format:'OpenSSH',keyType,publicKey:publicText,fingerprint};
  }
  if(cipher!=='aes256-ctr'||kdf!=='bcrypt') return {status:'unsupported',reason:'Supported encryption is OpenSSH aes256-ctr with bcrypt.'};
  const kr=new Reader(opts),salt=kr.str(),rounds=kr.uint();kr.done();
  if(salt.length!==16||!rounds||payload.length<32||payload.length%16!==0)throw Error();
  if(rounds>100)return {status:'unsupported',reason:'Key derivation cost exceeds the MVP safety limit (100 rounds).'};
  // parseKey validates the public envelope independently. It cannot validate encrypted ciphertext until unlock.
  const result=utils.parseKey(bytes);
  if(!(result instanceof Error)||result.message!=='Encrypted private OpenSSH key detected, but no passphrase given')throw Error();
  return {status:'encrypted',format:'OpenSSH (aes256-ctr / bcrypt)',keyType,publicKey:publicText,fingerprint};
 }catch{return {status:'invalid',reason:'Malformed OpenSSH private-key envelope.'}}
}
export async function inspectPrivateKey(path:string):Promise<Inspection>{
 try{return inspectBytes(await readKey(path))}catch(e){return {status:'unreadable',reason:(e as NodeJS.ErrnoException).code==='ENOENT'?'Key file not found.':(e as Error).message.startsWith('Private key')?(e as Error).message:'Cannot read key. Choose an owner-readable regular file (0600), not a symlink.'}}
}
