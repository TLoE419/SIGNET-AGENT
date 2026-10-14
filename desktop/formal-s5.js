'use strict';
// Local bounded package projection; renderer never supplies a path or grant; native export authority stays in main.
window.signetPackages=({unwrap,run,render,onBack})=>{
 const c={catalog:{sources:[],packages:[]},source:'',package:null,selection:null,selectionRevision:0,artifactId:'',plan:null,issue:'',exportResult:null,lastExport:null,visualization:null,importResult:null,lastImport:null,importForm:{label:'Imported result',notes:'',cohort:'',freq:'0.5',ntop:'2'}};
 try{const raw=localStorage.getItem('signet-last-export');if(raw&&raw.length<=16384)c.lastExport=JSON.parse(raw);}catch{}
 try{const raw=localStorage.getItem('signet-last-import');if(raw&&raw.length<=16384)c.lastImport=JSON.parse(raw);}catch{}
 const find=(n,p)=>p(n)?n:(n.children??[]).map(x=>find(x,p)).find(Boolean);
 const text=value=>({tag:'p',children:[{text:String(value)}]});
 const button=(key,label,disabled=false)=>({tag:'Button',attrs:{class:'sds-button','data-node-id':'formal:s5-'+key,label,state:disabled?'Disabled':'Default'}});
 const field=(key,label,value,options)=>({tag:'SelectField',attrs:{class:'sds-field','data-node-id':'formal:s5-'+key,label,value,options,hasLabel:'true',state:'Default'}});
 const clear=()=>{c.package=null;c.selection=null;c.artifactId='';c.plan=null;c.issue='';c.exportResult=null;c.importResult=null;c.visualization=null;};
 function selected(r){c.selection=r.selection??null;c.selectionRevision=r.revision??0;if(r.status==='selected'){c.package=r.package;c.artifactId=r.selection.artifactId;}else if(r.status==='blocked'){c.package=null;c.artifactId='';c.issue=r.error??'trusted_source_authority unavailable';}}
 async function refresh(){
  clear();c.catalog=await unwrap('packageList',{});c.source=c.catalog.sources.some(s=>s.sourceToken===c.source)?c.source:c.catalog.sources[0]?.sourceToken??'';
  selected(c.catalog.selected??{status:c.catalog.status,revision:0,selection:null});if(c.lastExport?.requestId)c.exportResult=await unwrap('packageExportStatus',{requestId:c.lastExport.requestId});if(c.lastImport?.requestId)c.importResult=await unwrap('packageImportStatus',{requestId:c.lastImport.requestId});
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
  if(p){const input=(key,label,value)=>({tag:'InputField',attrs:{class:'sds-field','data-node-id':'formal:s5-import-'+key,label,value,hasLabel:'true',state:'Default'}});children.push(text('Create a new result draft; unknown provenance does not become TCGA or Lung source data.'),input('label','Draft label',c.importForm.label),input('notes','Notes',c.importForm.notes),field('import-cohort','Declared cohort: empty means unknown',c.importForm.cohort,['','TCGA','GTEx']),input('freq','Requested frequency',c.importForm.freq),input('ntop','Requested top networks',c.importForm.ntop),button('execute-import','Confirm and create new imported draft',!registered||p.networkState!=='ready'||!p.sourceTransferComplete));}
  if(c.lastImport)children.push(button('retry-import','Confirm and reconcile last import'),button('refresh-import','Recheck imported draft'));
  if(c.importResult){const r=c.importResult,v=r.importView;children.push(text('Import '+r.status+' · actual draft created: '+(r.actualDraftCreated===null?'unknown':String(r.actualDraftCreated))),text('Current binding '+(r.bindingReady?'verified':'unverified')+' · science unknown · scientific execution and visualization session blocked'));
   if(v){children.push(text('Verified draft '+v.draftRef.draftId+' · revision '+v.draftRef.revision+' · SHA256 '+v.draftRef.contentHash),text('Declared cohort: '+(v.declaredCohort??'unknown')+' · '+v.cohortMeaning+'; schema cohort '+v.schemaCohort+' is '+(v.declaredCohort===null?'compatibility only':'user-selected, not verified source provenance')),text('Tissue '+v.draft.parameters.tissue+' is a schema default, not source tissue · '+v.parameterMeaning),text('Source verification '+(r.sourceLevel??'unknown')+' · '+(r.sourceKind??'unknown')),button('open-import','Open imported draft with fresh verification'),button('open-visualization','Open verified visualization host'));}
   else children.push(text('Imported draft is not currently verified. No legacy TCGA/Lung defaults are displayed as source facts. Reauthorize the source or repair the binding before use.'));
   if(r.error)children.push(text('Import issue: '+r.error));
  }
  if(p){children.push(button('execute-export','Choose private folder and export selected original',!c.artifactId||!registered),button('retry-export','Reauthorize and reconcile last export',!c.lastExport||c.lastExport.packageId!==p.packageId||c.lastExport.packageHash!==p.packageHash));}
  if(c.exportResult){const r=c.exportResult;children.push(text('Export '+r.status+' · request '+(r.requestId??'unknown')),text('Actual files written: '+(r.actualFilesWritten===null?'unknown':String(r.actualFilesWritten))+' · temporary bytes '+(r.temporaryBytesWritten??0)+(r.historicalOnly?' · historical receipt only; destination must be reauthorized':'')));if(r.error)children.push(text('Export issue: '+r.error));for(const f of r.receipts??[])children.push(text('Confirmed '+f.name+' · '+f.bytes+' B · SHA256 '+f.sha256));if(r.publicationUnknown)children.push(text('Publication is uncertain. Inspect the receipt and reauthorize the same destination before reconciling.'));}
  if(c.visualization){const h=c.visualization;children.push(text('Visualization host '+h.state+' · '+(h.error??'no error')+' · evidence '+(h.evidence??'unknown')),text('Control mapping '+(h.mapping?.analysisId??'not assigned')+' / '+(h.mapping?.visualizationRevision??'not assigned')+' · official pages not verified'),button('visualization-status','Recheck visualization host'),button('visualization-close','Close owned visualization host'));if(h.missing?.length)children.push(text('Missing: '+h.missing.join(' · ')));if(h.state==='ready'&&h.url)children.push({tag:'iframe',attrs:{src:h.url,title:'Owned visualization service; official pages require separate verification'}});}
  if(c.plan)children.push(text('Plan only · '+c.plan.kind+' · '+c.plan.status+' · '+c.plan.missing.join(' · ')),text('No artifact files written; no download; no new analysis draft; original data preserved.'),{tag:'pre',children:[{text:JSON.stringify(c.plan.reproducibility,null,2)}]});
  children.push(text('This view validates existing bytes and derives matrix edges. It does not run scientific inference or load an official session.'));
  holder.children.push({tag:'section',attrs:{class:'formal-s2 formal-s5','data-name':'Result package evidence'},children});
 }
 async function act(key,value){
  if(key.startsWith('import-')&&['label','notes','cohort','freq','ntop'].includes(key.slice(7))){c.importForm[key.slice(7)]=value;return;}
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
   else if(key==='open-visualization'){const draftId=c.importResult?.importView?.draftRef.draftId;if(!draftId)throw Error('Import binding not ready');c.visualization=null;c.visualization=await unwrap('visualization',{draftId});}
   else if(key==='visualization-status'){c.visualization=null;c.visualization=await unwrap('visualizationStatus');}
   else if(key==='visualization-close'){c.visualization=await unwrap('closeVisualization');}
   else if(key==='execute-import'||key==='retry-import'){const q=key==='retry-import'?c.lastImport:{...target(),sourceRef:c.package.sourceRef,requestId:'import-'+crypto.randomUUID(),label:c.importForm.label,notes:c.importForm.notes,cohort:c.importForm.cohort||null,parameters:{freq:Number(c.importForm.freq),ntop:Number(c.importForm.ntop)}};c.lastImport=q;try{localStorage.setItem('signet-last-import',JSON.stringify(q));}catch{}c.importResult=await unwrap('packageImport',q);c.plan=null;}
   else if(key==='refresh-import'){const requestId=c.importResult?.requestId??c.lastImport?.requestId;c.importResult=null;c.importResult=await unwrap('packageImportStatus',{requestId});}
   else if(key==='open-import'){const id=c.importResult?.importView?.draftRef.draftId;if(!id)throw Error('Import binding not ready');c.importResult=null;const loaded=await unwrap('draftLoad',id);if(!loaded.importOnly)throw Error('Import route required');c.importResult=loaded.result;}
   else if(key==='execute-export'||key==='retry-export'){const p=key==='retry-export'?c.lastExport:{...target(),artifactIds:[c.artifactId],requestId:'export-'+crypto.randomUUID()};c.lastExport=p;try{localStorage.setItem('signet-last-export',JSON.stringify(p));}catch{}c.exportResult=await unwrap('packageExport',p);c.plan=null;}
   else if(key==='import'||key==='export'){c.plan=null;c.plan=await unwrap(key==='import'?'packageImportPlan':'packageExportPlan',{...target(),...(key==='export'?{artifactIds:[c.artifactId]}:{}),requestId:'package-'+key+'-'+crypto.randomUUID()});}
   render('4:13');
  }catch(e){clear();c.issue=e.message;render('4:13');throw e;}});
 }
 return Object.freeze({project,act,refresh,openImported:result=>{clear();c.importResult=result;render('4:30');},current:()=>({packageId:c.package?.packageId,source:c.source,artifactId:c.artifactId,selectionRevision:c.selectionRevision,selection:c.selection,planStatus:c.plan?.status,visualization:c.visualization,importRequest:c.lastImport,importResult:c.importResult,exportRequest:c.lastExport,exportResult:c.exportResult,issue:c.issue,catalogStatus:c.catalog.status})});
};
