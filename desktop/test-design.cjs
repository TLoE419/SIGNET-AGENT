const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createHash}=require('node:crypto');
const routes=require('./design-routes.js'),{lookup}=require('./design-static.cjs');
const context={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'design-pages.js'),'utf8'),context);const pages=context.window.SIGNET_DESIGN.pages;
function walk(n,fn){fn(n);(n.children||[]).forEach(c=>walk(c,fn));}
test('review index reaches every distinct product screen and keeps two guides separate',()=>{
 assert.equal(pages.length,75);assert.equal(new Set(pages.map(p=>p.nodeId)).size,75);assert.equal(pages.filter(p=>p.review).length,2);
 const buttons=[];walk(pages.find(p=>p.nodeId==='9:3218').tree,n=>{if(n.tag==='Button')buttons.push(n.attrs.label);});
 for(const p of pages.filter(p=>!p.review))assert.equal(buttons.filter(b=>b===p.name.split(' · ')[0]+' · '+p.name.split(' / ').at(-1)).length,1,p.nodeId);
});
test('all supplied vectors have actual callsites, unchanged bytes, and closed protocol paths',()=>{
 const slots=require('./design-assets.json');const used=new Map();const treeSlots=[];for(const p of pages)walk(p.tree,n=>{if(n.tag==='img')treeSlots.push(n.attrs['data-asset-slot']);});
 assert.equal(slots.length,868);assert.equal(new Set(treeSlots).size,slots.length);assert.deepEqual(new Set(treeSlots),new Set(slots.map(s=>s.slot)));
 for(const s of slots){used.set(s.file,s);assert.equal(createHash('sha256').update(fs.readFileSync(path.join(__dirname,s.file))).digest('hex'),s.sha256);assert.equal(lookup('app','GET','/'+s.file)[0],s.file);}
 assert.equal(used.size,69);
 for(const bad of ['/../../main.cjs','/main.cjs','/preload.cjs','/.runtime/project.json','/__proto__','/assets/design/4-16/../x.svg','/assets/fonts/OFL.txt'])assert.equal(lookup('app','GET',bad),null,bad);
 assert.equal(lookup('other','GET','/index.html'),null);assert.equal(lookup('app','POST','/index.html'),null);
});
test('wizard families keep their own data/review routes and modal actions respect boundaries',()=>{
 for(const [workflow,steps] of Object.entries(routes.workflows)){
  const state={workflow};assert.equal(routes.target(steps[0],'Continue',state),steps[1]);assert.equal(routes.target(steps[1],'Continue',state),steps[2]||steps[3]);assert.equal(routes.target(steps[3],'Back',state),steps[2]||steps[1]);
  assert.equal(routes.target('4:72','Cancel',state,true),steps[1]);
 }
 assert.equal(routes.target('4:27','Recover analysis',{},true),'4:26');assert.equal(routes.target('4:27','Recover analysis',{},false),'4:27');
 assert.equal(routes.target('4:11','Stop analysis',{},false),'4:69');assert.equal(routes.target('4:69','Stop analysis',{},true),'4:70');
 assert.equal(routes.target('4:37','Start analysis',{workflow:'preprocessing'}),'4:38');assert.equal(routes.target('4:19','Retry failed / missing batches'),'4:20');assert.equal(routes.target('4:20','Retry 4 batches'),'4:21');assert.equal(routes.target('4:39','Confirm & continue'),'4:40');
});
test('disabled design actions remain disabled and the renderer has no operational bridge or network calls',()=>{
 for(const [id,label] of [['4:4','Continue'],['4:53','Review analysis'],['4:64','Confirm & continue']]){let found;walk(pages.find(p=>p.nodeId===id).tree,n=>{if(n.tag==='Button'&&n.attrs.label===label)found=n;});assert.equal(found?.attrs.state,'Disabled',id);}
 const renderer=fs.readFileSync(path.join(__dirname,'renderer.js'),'utf8');assert.doesNotMatch(renderer,/window\.(desktop|signet)\s*[.(]/);assert.doesNotMatch(renderer,/\b(fetch|XMLHttpRequest|WebSocket|require|ipcRenderer)\s*\(/);
});
