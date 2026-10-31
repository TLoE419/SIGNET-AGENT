'use strict';

const {chmodSync,existsSync,readdirSync}=require('node:fs');
const path=require('node:path');

if(process.platform!=='win32'){
 const packageRoot=path.dirname(require.resolve('node-pty/package.json'));
 const prebuilds=path.join(packageRoot,'prebuilds');
 const candidates=[path.join(packageRoot,'build','Release','spawn-helper')];
 if(existsSync(prebuilds))for(const directory of readdirSync(prebuilds)){
  if(directory.startsWith(`${process.platform}-`))candidates.push(path.join(prebuilds,directory,'spawn-helper'));
 }
 for(const helper of candidates)if(existsSync(helper))chmodSync(helper,0o755);
}
