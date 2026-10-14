'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Packages}=require('./core/s5-integration.cjs');
const clone=x=>JSON.parse(JSON.stringify(x)),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const BASE=fs.realpathSync(process.env.SIGNET_S5_INTEGRATION_TEST_ROOT||require('node:os').tmpdir());
function root(t){const p=fs.mkdtempSync(path.join(BASE,'s5-i-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
test('without trusted source authority catalog is explicitly blocked, never fabricated or path-authorized',async t=>{
 const p=new Packages(root(t)),list=await p.call('packageList',{});
 assert.equal(list.status,'blocked');assert.equal(list.executeEnabled,false);assert.deepEqual(list.packages,[]);assert.ok(list.missing.includes('trusted_source_authority'));
 await assert.rejects(p.call('packageRegister',{sourceToken:'fake',requestId:'register-one'}),/source_authority_unavailable/);
 await assert.rejects(p.call('packageList',{path:'/tmp'}),/schema_invalid/);
});
function fixture(t){
 const p=root(t),source=path.join(p,'approved-source');fs.mkdirSync(source);
 const ref={sourceId:'source-one',batchId:'batch-one',revision:1};
 const entries=[['frequency','matrix-frequency','0,0.5\n1,0\n'],['coefficient','matrix-coefficient','0 -0.2\n0.7 0\n'],['positions','gene-positions','A chr1 10 20\nB chr1 30 40\n']];
 const artifacts=entries.map(([artifactId,role,bytes])=>{fs.writeFileSync(path.join(source,artifactId),bytes);return {artifactId,role,relativePath:artifactId,bytes:Buffer.byteLength(bytes),sha256:sha(bytes),sourceRef:ref};});
 const grant={rootId:'approved',sourceRef:ref,kind:'synthetic',complete:true,manifest:{schemaVersion:1,sourceRef:ref,direction:'column/source->row/target',axes:null,claims:{status:'verified_actual_run',jobIds:['999']},visualization:null,artifacts}};
 const authority={roots:[{rootId:'approved',path:source}],sources:[{sourceToken:'source-token',label:'Synthetic result',grant}]};
 return {p,source,authority,api:new Packages(p,{authority})};
}
test('approved package registration displays exact directed matrix derivatives and selection survives new adapter',async t=>{
 const f=fixture(t),list=await f.api.call('packageList',{});assert.equal(list.sources[0].sourceToken,'source-token');
 const r=await f.api.call('packageRegister',{sourceToken:'source-token',requestId:'register-one'});
 assert.equal(r.network.direction,'column/source->row/target');assert.deepEqual(r.network.shape,[2,2]);
 assert.equal(r.network.edges[0].source,'B');assert.equal(r.network.edges[0].target,'A');assert.equal(r.verification.level,'synthetic-contract');assert.equal(r.scientificStatus,'unknown');
 const selected=await f.api.call('packageSelect',{packageId:r.packageId,packageHash:r.packageHash,artifactId:'frequency',expectedRevision:0});
 assert.equal(selected.revision,1);assert.equal(selected.artifact.artifactId,'frequency');
 const cold=new Packages(f.p,{authority:f.authority});const restored=await cold.call('packageSelection',{});assert.equal(restored.selection.packageId,r.packageId);assert.equal(restored.selection.artifactId,'frequency');assert.equal(restored.status,'selected');
});
test('saved selection is revalidated after restart; changed byte is blocked and never rewritten',async t=>{
 const f=fixture(t),r=await f.api.call('packageRegister',{sourceToken:'source-token',requestId:'register-one'});
 await f.api.call('packageSelect',{packageId:r.packageId,packageHash:r.packageHash,artifactId:'frequency',expectedRevision:0});
 const file=path.join(f.p,'s5/packages/selected.json'),before=fs.readFileSync(file),time=fs.statSync(file).mtimeMs;
 const text=fs.readFileSync(path.join(f.source,'frequency'),'utf8');fs.writeFileSync(path.join(f.source,'frequency'),text.replace('0.5','0.6'));
 const cold=new Packages(f.p,{authority:f.authority}),s=await cold.call('packageSelection',{});
 assert.equal(s.status,'blocked');assert.equal(s.error,'stale_artifact');assert.equal(s.package,null);assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.statSync(file).mtimeMs,time);
 await assert.rejects(cold.call('packageExportPlan',{packageId:r.packageId,packageHash:r.packageHash,artifactIds:['frequency'],requestId:'export-one'}),/stale_artifact/);
});
test('same request conflicts, stale selection revision and bad hash are rejected; plans report no copies or drafts',async t=>{
 const f=fixture(t),r=await f.api.call('packageRegister',{sourceToken:'source-token',requestId:'register-one'}),target={packageId:r.packageId,packageHash:r.packageHash};
 const a=await f.api.call('packageExportPlan',{...target,artifactIds:['frequency'],requestId:'export-one'});assert.equal(a.status,'blocked');assert.equal(a.actualFilesWritten,false);assert.equal(a.actualDownloadPerformed,false);assert.equal(a.executeEnabled,false);assert.equal(a.overwrite,false);
 assert.equal((await f.api.call('packageExportPlan',{...target,artifactIds:['frequency'],requestId:'export-one'})).duplicate,true);
 await assert.rejects(f.api.call('packageExportPlan',{...target,artifactIds:['positions'],requestId:'export-one'}),/operation_conflict/);
 const i=await f.api.call('packageImportPlan',{...target,requestId:'import-one'});assert.equal(i.actualDraftCreated,false);assert.ok(i.missing.includes('new_draft_authorization'));
 await f.api.call('packageSelect',{...target,artifactId:'frequency',expectedRevision:0});
 await assert.rejects(f.api.call('packageSelect',{...target,artifactId:'positions',expectedRevision:0}),/reference_drift/);
 await assert.rejects(f.api.call('packageSelect',{...target,packageHash:'b'.repeat(64),artifactId:'positions',expectedRevision:1}),/reference_drift/);
 assert.equal(fs.existsSync(path.join(f.p,'runs')),false);assert.equal(fs.existsSync(path.join(f.p,'drafts')),false);
});
test('IPC surface rejects paths, caller provenance and authority while catalog contains no absolute source paths',async t=>{
 const f=fixture(t),r=await f.api.call('packageRegister',{sourceToken:'source-token',requestId:'register-one'});
 for(const [method,arg] of [['packageRegister',{sourceToken:'source-token',requestId:'other',path:'/tmp'}],['packageInspect',{sourceToken:'source-token',grant:f.authority.sources[0].grant}],['packageSelect',{packageId:r.packageId,packageHash:r.packageHash,artifactId:'positions',expectedRevision:0,authority:true}],['packageList',{roots:[]}]] )await assert.rejects(f.api.call(method,arg),/schema_invalid/);
 const catalog=await f.api.call('packageList',{});assert.equal(JSON.stringify(catalog).includes(f.source),false);assert.equal(catalog.packages[0].integrity,'not-rechecked');
 const internal=clone(f.authority);internal.sources[0].grant.kind='internal';const result=await new Packages(root(t),{authority:internal}).call('packageInspect',{sourceToken:'source-token'});
 assert.equal(result.verification.level,'external-structure');assert.equal(result.scientificStatus,'unknown');
});
test('source batch mismatch, forged hashes, incomplete source and capacity overflow stay bounded',async t=>{
 const f=fixture(t),mixed=clone(f.authority);mixed.sources[0].grant.manifest.artifacts[1].sourceRef.batchId='other-batch';
 await assert.rejects(new Packages(root(t),{authority:mixed}).call('packageInspect',{sourceToken:'source-token'}),/source_mismatch/);
 const bad=clone(f.authority);bad.sources[0].grant.manifest.artifacts[0].sha256='0'.repeat(64);await assert.rejects(new Packages(root(t),{authority:bad}).call('packageRegister',{sourceToken:'source-token',requestId:'bad-hash'}),/hash_mismatch/);
 const partial=clone(f.authority);partial.sources[0].grant.complete=false;const api=new Packages(root(t),{authority:partial}),r=await api.call('packageRegister',{sourceToken:'source-token',requestId:'partial-one'});assert.equal(r.completeness,'partial');assert.equal(r.networkState,'ready');await assert.rejects(api.call('packageImportPlan',{packageId:r.packageId,packageHash:r.packageHash,requestId:'partial-import'}),/not_ready/);
 const many=clone(f.authority);many.sources=Array.from({length:129},(_,i)=>({...many.sources[0],sourceToken:'source-'+i}));assert.throws(()=>new Packages(root(t),{authority:many}),/entry_limit/);
});
test('selected-state corruption and symlink refuse; read-only views leave index/selection bytes intact',async t=>{
 const f=fixture(t),r=await f.api.call('packageRegister',{sourceToken:'source-token',requestId:'register-one'});await f.api.call('packageSelect',{packageId:r.packageId,packageHash:r.packageHash,artifactId:'frequency',expectedRevision:0});
 const index=path.join(f.p,'s5/packages/index.json'),selection=path.join(f.p,'s5/packages/selected.json'),b=fs.readFileSync(index),s=fs.readFileSync(selection),time=fs.statSync(selection).mtimeMs;
 await f.api.call('packageList',{});await f.api.call('packageSelection',{});assert.deepEqual(fs.readFileSync(index),b);assert.deepEqual(fs.readFileSync(selection),s);assert.equal(fs.statSync(selection).mtimeMs,time);
 fs.writeFileSync(selection,'{}');await assert.rejects(f.api.call('packageSelection',{}),/state_invalid/);fs.unlinkSync(selection);fs.symlinkSync(path.join(f.source,'frequency'),selection);await assert.rejects(f.api.call('packageSelection',{}),/state_invalid/);
});
test('all eight main/preload methods enforce formal mode and exact trusted frame, no generic package authority API',async()=>{
 const vm=require('node:vm'),main=path.join(__dirname,'main.cjs'),load=require('node:module').createRequire(main),handlers={},frame={url:'signet://app/index.html'},web={mainFrame:frame},calls=[];
 const electron={app:{isPackaged:false,setPath:()=>{},commandLine:{appendSwitch:()=>{}},requestSingleInstanceLock:()=>false,quit:()=>{}},protocol:{registerSchemesAsPrivileged:()=>{}},ipcMain:{handle:(name,fn)=>handlers[name]=fn}};
 const context={require:n=>n==='electron'?electron:load(n),__dirname,path,process:{env:{}},fixtureWin:{webContents:web},fixtureService:{call:async(method,p)=>{calls.push(method);return {method,p};}},console};
 vm.runInNewContext(fs.readFileSync(main,'utf8')+'\nwin=fixtureWin;service=fixtureService;installBridge();globalThis.setMode=m=>desktopMode=m;',context);
 const exposed={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'preload.cjs'),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(_n,v)=>Object.assign(exposed,v)},ipcRenderer:{invoke:(...args)=>args}})});
 const event={sender:web,senderFrame:frame};for(const method of require('./core/s5-api.cjs').METHODS){assert.equal(typeof exposed[method],'function');assert.equal(exposed[method]({})[0],'desktop:'+method);assert.equal((await handlers['desktop:'+method](event,{})).ok,true);}
 const count=calls.length;context.setMode('review');for(const method of require('./core/s5-api.cjs').METHODS)assert.equal((await handlers['desktop:'+method](event,{})).ok,false);assert.equal(calls.length,count);
 await assert.rejects(handlers['desktop:packageRegister']({sender:web,senderFrame:{url:frame.url}},{}),/Untrusted/);assert.equal(exposed.packageAuthorize,undefined);assert.equal(exposed.invoke,undefined);
});
test('real Service worker retains package and selected artifact across controller restart, bounded args deny authority injection',async t=>{
 const f=fixture(t),{Service}=require('./service.cjs'),service=new Service(f.p,{packageAuthority:f.authority});t.after(()=>service.stopOwned());
 await service.connect();const r=await service.call('packageRegister',{sourceToken:'source-token',requestId:'register-worker'});await service.call('packageSelect',{packageId:r.packageId,packageHash:r.packageHash,artifactId:'positions',expectedRevision:0});await service.stopOwned();await service.connect();
 const selected=await service.call('packageSelection',{});assert.equal(selected.selection.artifactId,'positions');assert.equal(selected.package.verification.level,'synthetic-contract');
 await assert.rejects(service.call('packageRegister',{sourceToken:'x'.repeat(17000),requestId:'large'}),/bounded/);await assert.rejects(service.call('packageAuthority',{}),/Unknown/);
 await assert.rejects(service.call('packageRegister',{sourceToken:'source-token',requestId:'bad',roots:[]}),/schema_invalid/);
});
test('large result previews declare truncation and retain full shape and edge count',async t=>{
 const f=fixture(t),n=20,values={frequency:Array.from({length:n},()=>Array(n).fill('1').join(',')).join('\n')+'\n',coefficient:Array.from({length:n},()=>Array(n).fill('0.2').join(' ')).join('\n')+'\n',positions:Array.from({length:n},(_,i)=>'G'+i+' chr1 '+(i*10)+' '+(i*10+2)).join('\n')+'\n'};
 for(const a of f.authority.sources[0].grant.manifest.artifacts){fs.writeFileSync(path.join(f.source,a.artifactId),values[a.artifactId]);a.bytes=Buffer.byteLength(values[a.artifactId]);a.sha256=sha(values[a.artifactId]);}
 const result=await new Packages(root(t),{authority:f.authority}).call('packageInspect',{sourceToken:'source-token'});
 assert.deepEqual(result.network.shape,[20,20]);assert.equal(result.network.edgeCount,400);assert.equal(result.network.edges.length,200);assert.equal(result.network.previewTruncated,true);
});
test('concurrent selection writers serialize without stealing locks or losing revision',async t=>{
 const f=fixture(t),r=await f.api.call('packageRegister',{sourceToken:'source-token',requestId:'register-one'}),other=new Packages(f.p,{authority:f.authority});
 const p={packageId:r.packageId,packageHash:r.packageHash,expectedRevision:0};const result=await Promise.allSettled([f.api.call('packageSelect',{...p,artifactId:'positions'}),other.call('packageSelect',{...p,artifactId:'frequency'})]);
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.filter(r=>r.status==='rejected').length,1);assert.match(result.find(r=>r.status==='rejected').reason.code,/io_conflict|reference_drift/);
 assert.equal((await other.call('packageSelection',{})).revision,1);assert.equal(fs.existsSync(path.join(f.p,'s5/packages/index.lock')),false);
});
test('all package worker requests attempt zero external effects; unknown provenance cannot authorize science',async t=>{
 const {Worker}=require('node:worker_threads'),f=fixture(t),entry=path.join(f.p,'guard-worker.cjs'),task=path.join(__dirname,'core/task-worker.cjs');
 fs.writeFileSync(entry,`const {parentPort}=require('node:worker_threads');const attempts=[];const deny=()=>{attempts.push('external');throw Error('Forbidden external effect')};for(const module of ['node:child_process','node:net','node:tls','node:http','node:https','node:dns','node:dgram'])for(const key of ['exec','execSync','execFile','execFileSync','spawn','spawnSync','fork','connect','createConnection','createServer','request','get','lookup','resolve','createSocket'])if(typeof require(module)[key]==='function')require(module)[key]=deny;require('node:net').Socket.prototype.connect=deny;global.fetch=deny;const post=parentPort.postMessage.bind(parentPort);parentPort.postMessage=m=>post({...m,externalAttempts:attempts});require(${JSON.stringify(task)});`);
 const w=new Worker(entry,{workerData:{root:f.p,packageAuthority:f.authority}});t.after(()=>w.terminate());let id=0;const pending=new Map();w.on('message',m=>{const cb=pending.get(m.id);if(cb){pending.delete(m.id);cb(m);}});const call=(method,arg)=>new Promise(resolve=>{const n=++id;pending.set(n,resolve);w.postMessage({id:n,method,args:[arg]});});
 const reg=await call('packageRegister',{sourceToken:'source-token',requestId:'guard-register'});assert.equal(reg.ok,true);assert.deepEqual(reg.externalAttempts,[]);const r=reg.value,target={packageId:r.packageId,packageHash:r.packageHash};
 const cases=[['packageList',{}],['packageInspect',{sourceToken:'source-token'}],['packageGet',{packageId:r.packageId}],['packageSelect',{...target,artifactId:'frequency',expectedRevision:0}],['packageSelection',{}],['packageImportPlan',{...target,requestId:'guard-import'}],['packageExportPlan',{...target,artifactIds:['frequency'],requestId:'guard-export'}]];
 for(const [method,p] of cases){const result=await call(method,p);assert.equal(result.ok,true,method);assert.deepEqual(result.externalAttempts,[],method);assert.equal(result.value.executeEnabled,false,method);}
 assert.equal(fs.existsSync(path.join(f.p,'runs')),false);
});
test('formal package controller projects real results, blocks plan completion claims and clears stale view',async t=>{
 const vm=require('node:vm'),f=fixture(t),window={},rendered=[];
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'formal-s5.js'),'utf8'),{window,crypto:{randomUUID:()=>crypto.randomUUID()}});
 const c=window.signetPackages({unwrap:(m,p)=>f.api.call(m,clone(p)),run:fn=>fn(),render:id=>rendered.push(id),onBack:async()=>{rendered.push('home');}});
 await c.act('open');await c.act('register');await c.act('artifact','positions');await c.act('select');assert.equal(c.current().selection.artifactId,'positions');await c.act('export');assert.equal(c.current().planStatus,'blocked');
 const tree={tag:'div',attrs:{'data-name':'Page content'},children:[{tag:'p',children:[{text:'FAKE Download complete'}]}]};c.project(tree,'4:13');const serialized=JSON.stringify(tree);assert.equal(serialized.includes('FAKE'),false);assert.match(serialized,/Plan only/);assert.match(serialized,/No artifact files written/);assert.match(serialized,/science unknown/);
 fs.writeFileSync(path.join(f.source,'frequency'),'0,0.6\n1,0\n');await assert.rejects(c.act('export'),/stale_artifact/);assert.equal(c.current().packageId,undefined);assert.equal(c.current().planStatus,undefined);assert.equal(c.current().issue,'stale_artifact');await c.act('back');assert.equal(rendered.at(-1),'home');
});
