import {utils} from 'ssh2';
import {createPrivateKey,randomBytes} from 'node:crypto';
import {readKey,inspectBytes} from './PrivateKeyInspector';
import {fail} from '../../../shared/ssh/validation';
export async function unlockPrivateKey(path:string,passphrase:string):Promise<string> {
 if(typeof passphrase!=='string'||!passphrase.length)fail('PASSPHRASE_REQUIRED','Enter the private-key passphrase, not your account password.');
 if(passphrase.length>4096)fail('UNKNOWN','Passphrase is too long.');
 let bytes:Buffer;
 try{bytes=await readKey(path)}catch(e){fail((e as NodeJS.ErrnoException).code==='ENOENT'?'KEY_NOT_FOUND':'KEY_UNREADABLE','Cannot read private key. Check its location and owner-only permissions.');}
 try {
  const inspection=inspectBytes(bytes);
  if(inspection.status!=='encrypted')fail(inspection.status==='unencrypted'?'KEY_UNENCRYPTED':inspection.status==='unsupported'?'KEY_UNSUPPORTED':'KEY_INVALID','Select a supported passphrase-protected OpenSSH private key.');
  const parsed=utils.parseKey(bytes,passphrase);
  if(parsed instanceof Error) {
   // CTR has no authentication tag: bad ciphertext and wrong passphrases can be indistinguishable.
   if(/bad passphrase/i.test(parsed.message))fail('INVALID_PASSPHRASE','Unable to unlock: incorrect passphrase or damaged encrypted key. Check your passphrase or select a known-good key.');
   fail('UNKNOWN','Unable to decrypt the key; it may be damaged or use an unsupported format.');
  }
  const keys=Array.isArray(parsed)?parsed:[parsed];
  if(keys.length!==1||!keys[0].isPrivateKey())fail('KEY_INVALID','Invalid private key.');
  const key=keys[0];
  if(key.type!=='ssh-ed25519')return key.getPrivatePEM();
  // ssh2 cannot re-import Ed25519 PKCS#8. Encode the validated key in its
  // supported OpenSSH container inside the worker; this plaintext never touches disk.
  const jwk=createPrivateKey(key.getPrivatePEM()).export({format:'jwk'});
  if(!jwk.d||!jwk.x)fail('KEY_INVALID','Invalid Ed25519 key.');
  const uint=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b};
  const str=(b:Buffer|string)=>{const bytes=Buffer.isBuffer(b)?b:Buffer.from(b);return Buffer.concat([uint(bytes.length),bytes])};
  const publicBytes=Buffer.from(jwk.x,'base64url'),seed=Buffer.from(jwk.d,'base64url'),check=randomBytes(4);
  let payload=Buffer.concat([check,check,str('ssh-ed25519'),str(publicBytes),str(Buffer.concat([seed,publicBytes])),str('')]);
  const padding=8-payload.length%8;payload=Buffer.concat([payload,Buffer.from(Array.from({length:padding},(_,i)=>i+1))]);
  const envelope=Buffer.concat([Buffer.from('openssh-key-v1\0'),str('none'),str('none'),str(''),uint(1),str(key.getPublicSSH()),str(payload)]);
  const result='-----BEGIN OPENSSH PRIVATE KEY-----\n'+envelope.toString('base64').match(/.{1,70}/g)!.join('\n')+'\n-----END OPENSSH PRIVATE KEY-----';
  seed.fill(0);payload.fill(0);envelope.fill(0);
  return result;
 } finally {bytes.fill(0)}
}
