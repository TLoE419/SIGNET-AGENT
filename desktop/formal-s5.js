'use strict';
// Local bounded package projection; no path, grant, destination, downloader or R bridge.
window.signetPackages=({unwrap,run,render,onBack})=>{
 const c={catalog:{sources:[],packages:[]},source:'',package:null,selection:null,selectionRevision:0,artifactId:'',plan:null,issue:''};
 const find=(n,p)=>p(n)?n:(n.children??[]).map(x=>find(x,p)).find(Boolean);
 const text=value=>({tag:'p',children:[{text:String(value)}]});
 const button=(key,label,disabled=false)=>({tag:'Button',attrs:{class:'sds-button','data-node-id':'formal:s5-'+key,label,state:disabled?'Disabled':'Default'}});
 const field=(key,label,value,options)=>({tag:'SelectField',attrs:{class:'sds-field','data-node-id':'formal:s5-'+key,label,value,options,hasLabel:'true',state:'Default'}});
 const clear=()=>{c.package=null;c.selection=null;c.artifactId='';c.plan=null;c.issue='';};
 function selected(r){c.selection=r.selection??null;c.selectionRevision=r.revision??0;if(r.status==='selected'){c.package=r.package;c.artifactId=r.selection.artifactId;}else if(r.status==='blocked'){c.package=null;c.artifactId='';c.issue=r.error??'trusted_source_authority unavailable';}}
 async function refresh(){
  clear();c.catalog=await unwrap('packageList',{});c.source=c.catalog.sources.some(s=>s.sourceToken===c.source)?c.source:c.catalog.sources[0]?.sourceToken??'';
  selected(c.catalog.selected??{status:c.catalog.status,revision:0,selection:null});
 }
 const target=()=>{if(!c.package)throw Error('Choose and recheck a registered result package');return {packageId:c.package.packageId,packageHash:c.package.packageHash};};
 function project(tree,id){
  const home=id==='4:2',pages=['4:13','4:14','4:30','4:31','4:32','4:33','4:57','4:58','4:59','4:60'];if(!home&&!pages.includes(id)&&id!=='4:65')return;
  const holder=find(tree,n=>n.attrs?.['data-name']==='Page content');if(!holder)return;
  if(home||id==='4:65'){holder.children.push({tag:'section',attrs:{class:'formal-s2','data-name':'Result packages entry'},children:[button('open','Open local result packages')]});return;}
  // Design-only completion examples must not survive into the formal result view.
  const header=holder.children.find(n=>n.attrs?.['data-name']==='Page header');holder.children=header?[header]:[];
  const p=c.package,registered=!!p&&c.catalog.packages.some(r=>r.packageId===p.packageId),children=[button('back','Back to analyses'),text('Local result packages · integrity, provenance and science are separate'),button('refresh','Reload approved sources and saved selection'),button('pick','Authorize local result package folder'),button('revoke','Revoke selected source access',!c.source)];
  if(c.catalog.status==='blocked')children.push(text('Blocked: trusted source authorization is unavailable. No files were imported, downloaded or exported.'));
  children.push(field('source','Approved source',c.source,['',...c.catalog.sources.map(s=>s.sourceToken)]),button('inspect','Inspect approved source',!c.source),button('register','Register verified-byte package',!c.source));
  for(const s of c.catalog.sourceAccess??[])if(s.status==='blocked')children.push(text('Source '+s.sourceToken+' · blocked; reauthorize the prepared source or revoke this reference'),button('revoke:'+s.sourceToken,'Revoke unavailable source'));
  for(const s of c.catalog.sources)children.push(text('Approved source '+s.sourceToken+' · '+s.label));
  for(const r of c.catalog.packages)children.push(button('get:'+r.packageId,r.packageId+' · requires current integrity check'));
  if(c.issue)children.push(text('Unavailable: '+c.issue));
  if(p){
   children.push(text('Package '+p.packageId+' · '+p.packageHash),text('Source '+p.sourceRef.sourceId+' / '+p.sourceRef.batchId+' / revision '+p.sourceRef.revision+' · '+p.sourceKind),text('Integrity '+p.completeness+' · matrix '+p.networkState+' · source transfer '+(p.sourceTransferComplete?'complete':'partial')),text('Verification '+p.verification.level+' · science '+p.scientificStatus+' · session '+p.visualization.loadState),text('Missing: '+p.missing.concat(p.verification.missing,p.visualization.missing).join(' · ')));
   const n=p.network;if(n){children.push(text('Matrix shape '+n.shape.join(' × ')+' · column/source → row/target · bootstrap count unknown'),text('Edges '+n.edgeCount+' · bounded preview '+n.edges.length+(n.previewTruncated?' (truncated)':'')),{tag:'pre',attrs:{class:'formal-s2-log'},children:[{text:JSON.stringify(n.edges,null,2)}]});}
   for(const a of p.artifacts)children.push(text(a.artifactId+' · '+a.role+' · '+a.state+' · expected '+a.bytes+' B / '+a.sha256+' · actual '+(a.actualBytes??'missing')+' B / '+(a.actualSha256??'missing')));
   const ready=p.artifacts.filter(a=>a.state==='ready').map(a=>a.artifactId);children.push(field('artifact','Verified-byte artifact',c.artifactId,['',...ready]),button('select','Save this artifact selection',!c.artifactId||!registered),text('Saved selection revision '+c.selectionRevision+(c.selection?' · '+c.selection.artifactId:' · none')),button('import','Review import prerequisites',p.networkState!=='ready'||!p.sourceTransferComplete||!registered),button('export','Review export prerequisites',!c.artifactId||!p.sourceTransferComplete||!registered));
  }
  if(c.plan)children.push(text('Plan only · '+c.plan.kind+' · '+c.plan.status+' · '+c.plan.missing.join(' · ')),text('No artifact files written; no download; no new analysis draft; original data preserved.'),{tag:'pre',children:[{text:JSON.stringify(c.plan.reproducibility,null,2)}]});
  children.push(text('This view validates existing bytes and derives matrix edges. It does not run scientific inference or load an official session.'));
  holder.children.push({tag:'section',attrs:{class:'formal-s2 formal-s5','data-name':'Result package evidence'},children});
 }
 async function act(key,value){
  if(key==='back'){await onBack();return;}
  if(key==='source'){c.source=value;clear();render();return;}
  if(key==='artifact'){c.artifactId=value;c.plan=null;render();return;}
  await run(async()=>{try{
   if(key==='open'||key==='refresh'){await refresh();render('4:13');return;}
   if(key==='pick'){const r=await unwrap('packageSourcePick',{});if(!r.canceled){c.source=r.sourceToken;await refresh();}render('4:13');return;}
   if(key==='revoke'||key.startsWith('revoke:')){await unwrap('packageSourceRevoke',{sourceToken:key==='revoke'?c.source:key.slice(7)});await refresh();render('4:13');return;}
   if(key==='inspect'||key==='register'){
    c.package=null;c.plan=null;c.artifactId='';c.issue='';
    c.package=await unwrap(key==='inspect'?'packageInspect':'packageRegister',{sourceToken:c.source,...(key==='register'?{requestId:'package-register-'+crypto.randomUUID()}:{} )});
    c.artifactId=c.package.artifacts.find(a=>a.state==='ready')?.artifactId??'';
    if(key==='register'){const current=c.package;c.catalog=await unwrap('packageList',{});c.package=current;c.selectionRevision=c.catalog.selected?.revision??0;}
   }else if(key.startsWith('get:')){clear();c.package=await unwrap('packageGet',{packageId:key.slice(4)});c.artifactId=c.package.artifacts.find(a=>a.state==='ready')?.artifactId??'';}
   else if(key==='select'){const r=await unwrap('packageSelect',{...target(),artifactId:c.artifactId,expectedRevision:c.selectionRevision});selected(r);c.plan=null;}
   else if(key==='import'||key==='export'){c.plan=null;c.plan=await unwrap(key==='import'?'packageImportPlan':'packageExportPlan',{...target(),...(key==='export'?{artifactIds:[c.artifactId]}:{}),requestId:'package-'+key+'-'+crypto.randomUUID()});}
   render('4:13');
  }catch(e){clear();c.issue=e.message;render('4:13');throw e;}});
 }
 return Object.freeze({project,act,refresh,current:()=>({packageId:c.package?.packageId,source:c.source,artifactId:c.artifactId,selectionRevision:c.selectionRevision,selection:c.selection,planStatus:c.plan?.status,issue:c.issue,catalogStatus:c.catalog.status})});
};
