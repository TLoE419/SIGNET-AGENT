'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createRendererHandler}=require('../main/renderer/protocol.cjs');
const origin='http://127.0.0.1:43210';
test('Electron serves its renderer with escaped bootstrap data and strict production CSP',async()=>{
 const calls=[];
 const handler=createRendererHandler({origin,fetch:async(url,options)=>{calls.push({url,options});return Response.json({token:'token"value',model:'<model>',initial:{messages:[{text:'</script><img src=x>'}]}})}});
 const response=await handler(new Request(origin+'/?new=1'));
 assert.equal(response.status,200);
 const html=await response.text();
 assert.match(html,/token&quot;value/);assert.match(html,/&lt;model&gt;/);
 assert.doesNotMatch(html,/<img src=x>/);assert.match(html,/\\u003c\/script>/);
 assert.equal(calls[0].url,origin+'/bootstrap?new=1');
 assert.equal(calls[0].options.bypassCustomProtocolHandlers,true);
 assert.doesNotMatch(response.headers.get('content-security-policy'),/unsafe-inline/);
 assert.match(html,/\/renderer.js/);assert.doesNotMatch(html,/ssh-ui.js/);
 const script=await handler(new Request(origin+'/renderer.js'));
 assert.equal(script.status,200);assert.match(script.headers.get('content-type'),/javascript/);
});
test('renderer forwards streaming API requests without consuming their bodies and rejects foreign origins',async()=>{
 const request=new Request(origin+'/chat',{method:'POST',headers:{Origin:origin,'X-Chat-Token':'test'},body:'{"text":"question"}'});
 let called=0;
 const handler=createRendererHandler({origin,fetch:async(input,options)=>{called++;assert.equal(input,request);assert.ok(options.bypassCustomProtocolHandlers);assert.equal(await input.text(),'{"text":"question"}');return new Response('stream')}});
 assert.equal(await (await handler(request)).text(),'stream');
 assert.equal((await handler(new Request('http://example.com/renderer.js'))).status,403);
 assert.equal(called,1);
});
test('bootstrap conflicts remain visible and unknown files are never read from disk',async()=>{
 const handler=createRendererHandler({origin,fetch:async input=>new Response('not available',{status:typeof input==='string'?409:404})});
 assert.equal((await handler(new Request(origin+'/'))).status,409);
 assert.equal((await handler(new Request(origin+'/.env'))).status,404);
});
