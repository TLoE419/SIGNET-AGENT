'use strict';
const {readFile}=require('node:fs/promises');
const path=require('node:path');
const {localURL}=require('../security/policy.cjs');
const assets=new Map([
 ['/renderer.js',['renderer.js','text/javascript']],
 ['/workspace.js',['workspace.js','text/javascript']],
 ['/chat.css',['chat.css','text/css']],
 ['/ssh.css',['ssh.css','text/css']],
 ['/vendor/vis-network.min.js',['vendor/vis-network.min.js','text/javascript']],
]);
const escapeHtml=value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function headers(type,devMode){return {'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
 'Content-Security-Policy':`default-src 'self'; script-src 'self'; style-src 'self'${devMode?" 'unsafe-inline'":''}; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`};}
/** Serve only the renderer build allowlist. All API requests retain their HTTP origin. */
function createRendererHandler({origin,fetch,devMode=false,directory=path.join(__dirname,'../../build/renderer')}){
 return async request=>{
  if(!localURL(request.url,origin))return new Response('Forbidden',{status:403});
  const url=new URL(request.url);
  if(request.method!=='GET'||(url.pathname!=='/'&&!assets.has(url.pathname)))return fetch(request,{bypassCustomProtocolHandlers:true});
  try{
   if(url.pathname==='/'){
    const reply=await fetch(origin+'/bootstrap'+url.search,{bypassCustomProtocolHandlers:true});
    if(!reply.ok)return reply;
    const {token,model,initial}=await reply.json();
    const template=await readFile(path.join(directory,'index.html'),'utf8');
    const values={__TOKEN__:escapeHtml(token),__MODEL__:escapeHtml(model),__INITIAL_CHAT__:JSON.stringify(initial).replace(/</g,'\\u003c')};
    return new Response(template.replace(/__TOKEN__|__MODEL__|__INITIAL_CHAT__/g,key=>values[key]),{headers:headers('text/html',devMode)});
   }
   const [file,type]=assets.get(url.pathname);
   return new Response(await readFile(path.join(directory,file)),{headers:headers(type,devMode)});
  }catch{return new Response('Renderer unavailable. Rebuild Electron and restart.',{status:503,headers:headers('text/plain',devMode)})}
 };
}
module.exports={createRendererHandler};
