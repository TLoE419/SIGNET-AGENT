'use strict';
// Configuration controls retain the approved page containers; no remote executor.
window.signetConfiguration=({unwrap,run,render,getDraft,getDirty})=>{
 const c={catalog:{profiles:[],resources:[],operations:[]},profile:null,profileRef:null,selectedProfile:null,resource:null,resourceRef:null,binding:null,resourceDirty:false,operation:null,profileDirty:false};
 const roles=['inputs','workspace','outputs','tools','container'],copy=x=>JSON.parse(JSON.stringify(x)),same=(a,b)=>a===b||!!a&&!!b&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>a[k]===b[k]);
 const ref=(r,k)=>({[k]:r[k],revision:r.revision,contentHash:r.contentHash});
 const profileLabel=p=>p.content.name+' · connection '+(c.catalog.profiles.indexOf(p)+1)+' · revision '+p.revision;
 const profileOptions=()=>['',...c.catalog.profiles.map(profileLabel)];
 const resources=()=>c.catalog.resources.filter(r=>same(r.content.profileRef,c.selectedProfile));
 const resourceLabel=r=>'Resource configuration '+(resources().indexOf(r)+1)+' · revision '+r.revision;
 const resourceOptions=()=>['',...resources().map(resourceLabel)];
 const selected=()=>c.catalog.profiles.find(p=>same(ref(p,'profileId'),c.selectedProfile));
 function fresh(){c.profileDirty=true;c.profileRef=null;c.profile={schemaVersion:1,kind:'hpc3',name:'',endpoints:['login','transfer'].map(role=>({endpointId:role,role,host:null,user:null,port:null,sshAlias:null,authRef:null,hostKeyRef:null})),roots:roles.map(role=>({rootId:role,role,endpointPaths:{login:null,transfer:null},access:['inputs','tools','container'].includes(role)?'read':'read-write',canonicalEvidenceRef:null,permissionPolicy:'unknown'})),storageMappings:[]};}
 function resource(p){c.resourceRef=p?ref(p,'resourcePlanId'):null;c.resource=p?copy(p.content):{schemaVersion:1,profileRef:c.selectedProfile,account:null,partition:null,qos:null,cores:null,memoryMiB:null,walltimeSeconds:null,capabilityRef:null};c.resourceDirty=false;}
 function chooseProfile(r){c.selectedProfile=r;resource(null);}
 function editProfile(p){c.operation=c.catalog.operations.find(r=>r.profileRef?.profileId===p.profileId)??null;c.profileDirty=false;c.profileRef=ref(p,'profileId');c.profile={...copy(p.content),profileId:p.profileId};}
 async function refresh(){c.catalog=await unwrap('configurationList',{});}
 async function loadDraft(id){await refresh();c.binding=id?await unwrap('bindingLoad',{draftId:id}):null;c.operation=id?c.catalog.operations.find(r=>r.subject.kind==='draft'&&r.subject.ref.draftId===id)??null:null;if(c.binding?.binding){const b=c.binding.binding.content;c.selectedProfile=b.profileRef;resource(c.catalog.resources.find(r=>same(ref(r,'resourcePlanId'),b.resourceRef))??null);} }
 function visit(n,fn){fn(n);for(const x of n.children??[])visit(x,fn);}
 function find(n,fn){if(fn(n))return n;for(const x of n.children??[]){const r=find(x,fn);if(r)return r;}return null;}
 const button=(key,label,disabled=false)=>({tag:'Button',attrs:{class:'sds-button','data-node-id':'formal:s3-'+key,label,state:disabled?'Disabled':'Default'}});
 const field=(key,label,value,options)=>({tag:options?'SelectField':'InputField',attrs:{class:'sds-field','data-node-id':'formal:s3-'+key,label,value:value??'',hasLabel:'true',state:'Default',...(options?{options}:{})}});
 function displayTime(seconds){if(seconds===null)return '';return String(Math.floor(seconds/3600)).padStart(2,'0')+':'+String(Math.floor(seconds%3600/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');}
 function project(tree,id,bindings){
  visit(tree,n=>{if(n.tag==='Button'&&/UCI HPC3 · (Connected|Offline)/.test(n.attrs?.label??''))n.attrs.label='Connection · Unverified';});
  if(id==='4:7'&&getDraft()){for(const [section,value] of [['Connection',(c.binding?.status??'unconfigured')+' · authentication unknown'],['Resources',c.resourceRef?'Saved configuration · station capability unverified':'Unconfigured']]){const node=find(tree,n=>n.attrs?.['data-name']===section),ps=[];if(node){visit(node,n=>{if(n.tag==='p')ps.push(n)});ps.forEach((n,i)=>n.children=[{text:i===0?section:i===1?value:''}]);}}}
  const connection=['4:45','4:47'].includes(id),settings=['4:6','4:36','4:43','4:53'].includes(id);if(!connection&&!settings)return;
  if(!c.profile)fresh();const holder=find(tree,n=>n.attrs?.['data-name']==='Page content');if(!holder)return;
  visit(tree,n=>{const d=bindings[id]?.[n.attrs?.['data-node-id']];if(!d)return;const [action,key]=d,a=n.attrs;
   if(action==='s3-profile-field'){const ep=c.profile.endpoints.find(e=>e.role==='login');if(key!=='name'&&(!ep||key==='workspace'&&!c.profile.roots.some(r=>r.role==='workspace'))){a.value='Not configured';a.state='Disabled';return;}a.value=key==='name'?c.profile.name:key==='workspace'?c.profile.roots.find(r=>r.role==='workspace')?.endpointPaths[ep.endpointId]??'':ep[key]??'';}
   if(action==='s3-auth'){a.value='Unknown; core authorization required';a.options=[a.value];a.state='Disabled';}
   if(action==='s3-first-profile'){a.label=c.catalog.profiles[0]?.content.name??'No saved connection';a.state=c.catalog.profiles.length?'Default':'Disabled';}
   if(action==='s3-check'){a.label='Review connection prerequisites';a.state=c.profileRef&&!c.profileDirty&&c.profile.endpoints.some(e=>e.role==='login')?'Default':'Disabled';}
   if(action==='s3-select-profile'){const p=selected();a.value=p?profileLabel(p):'';a.options=profileOptions();}
   if(action==='s3-resource-field'){n.tag='InputField';a.value=key==='memoryGiB'?c.resource?.memoryMiB===null?'':String((c.resource?.memoryMiB??0)/1024):key==='walltime'?displayTime(c.resource?.walltimeSeconds??null):c.resource?.[key]??'';if(key==='memoryGiB')a.label='Memory per job (GiB)';a.state=c.selectedProfile?'Default':'Disabled';}
  });
  visit(tree,n=>{if(n.tag==='p'&&n.children?.some(x=>x.text?.startsWith('Remote resources are not configured')))n.children=[{text:c.resourceRef?'Resource configuration saved; station limits and access unverified':'Resource configuration is not saved.'}];});
  const children=[];
  if(connection){
   visit(tree,n=>{if(n.tag!=='p')return;const text=n.children?.map(x=>x.text??'').join('')??'';if(text==='UCI HPC3')n.children=[{text:c.profile.name||'New connection'}];else if(text.startsWith('Transfer host:'))n.children=[{text:'Transfer endpoint configuration; no current connection evidence'}];else if(text.includes('✓'))n.children=[{text:text.includes('Authentication')?'Authentication unknown · Scheduler capability unverified':'Transfer disabled · Runtime capability unverified'}];});
   for(const p of c.catalog.profiles)children.push(button('profile:'+p.profileId,p.content.name+' · revision '+p.revision));
   children.push(field('kind','Connection type',c.profile.kind,['hpc3','local-vm']));
   const login=c.profile.endpoints.find(e=>e.role==='login'),transfer=c.profile.endpoints.find(e=>e.role==='transfer');
   if(login)children.push(field('login-port','Login port (blank = unknown)',login.port));
   if(transfer)for(const key of ['host','user','port'])children.push(field('transfer-'+key,'Transfer '+key+' (configuration only)',transfer[key]));
   for(const r of c.profile.roots)for(const e of c.profile.endpoints)children.push(field('root:'+r.rootId+':'+e.endpointId,r.role+' root on '+e.role+' (remote configuration)',r.endpointPaths[e.endpointId]));
   children.push(button('archive','Archive unreferenced connection',!c.profileRef));
  }else if(getDraft()){
   const p=selected(),savedResource=resources().find(r=>same(ref(r,'resourcePlanId'),c.resourceRef));
   children.push(field('resource-select','Saved resource configuration',savedResource?resourceLabel(savedResource):'',resourceOptions()));
   children.push(field('qos','QoS (blank = unknown)',c.resource?.qos));
   children.push(button('resource-save','Save resource configuration',!p));
   children.push(button('bind','Bind saved configuration to this saved draft',!p||!['inputs','workspace','outputs'].every(role=>p.content.roots.some(r=>r.role===role))||!c.resourceRef||c.resourceDirty||getDirty()||!getDraft().id));
   children.push({tag:'p',children:[{text:'Draft binding: '+(getDirty()?'unsaved draft changes':c.binding?.status??'unconfigured')+' · authentication unknown · transfer and submission disabled'}]});
   children.push(button('transfer-review','Review upload prerequisites',!c.binding?.binding||c.binding.status!=='configured'||getDirty()||!Object.keys(getDraft().inputs).length));
  }
  if(c.operation)children.push({tag:'p',children:[{text:'Saved local plan request: '+c.operation.status+' · '+c.operation.error.code+' · remote execution unknown'}]});
  children.push({tag:'p',children:[{text:'No trusted current authority or accepted effect executor is installed. Saving configuration does not authenticate, transfer files or submit jobs.'}]});
  holder.children.push({tag:'section',attrs:{class:'formal-s2','data-name':'Connection configuration'},children});
 }
 const nullable=v=>v===''?null:v;
 async function act(action,key,value){
  if(action==='s3-profile-field'){c.profileDirty=true;if(key==='name')c.profile.name=value;else{const ep=c.profile.endpoints.find(e=>e.role==='login');if(key==='workspace')c.profile.roots.find(r=>r.role==='workspace').endpointPaths[ep.endpointId]=nullable(value);else ep[key]=nullable(value);}render();return;}
  if(action==='s3-resource-field'){if(!c.resource)resource(null);if(key==='memoryGiB'){c.resource.memoryMiB=value===''?null:Number(value)*1024;}else if(key==='walltime'){if(value==='')c.resource.walltimeSeconds=null;else if(/^\d{2,5}:[0-5]\d:[0-5]\d$/.test(value)){const [h,m,s]=value.split(':').map(Number);c.resource.walltimeSeconds=h*3600+m*60+s;}else c.resource.walltimeSeconds=NaN;}else c.resource[key]=['cores'].includes(key)?value===''?null:Number(value):nullable(value);c.resourceDirty=true;render();return;}
  if(action==='s3-select-profile'){const i=profileOptions().indexOf(value)-1;chooseProfile(i>=0?ref(c.catalog.profiles[i],'profileId'):null);render();return;}
  if(action==='s3-dynamic'){
   if(key==='kind'){c.profileDirty=true;c.profile.kind=value;render();return;}
   if(key==='login-port'){c.profileDirty=true;c.profile.endpoints.find(e=>e.role==='login').port=value===''?null:Number(value);render();return;}
   if(['transfer-host','transfer-user','transfer-port'].includes(key)){c.profileDirty=true;const k=key.slice(9);c.profile.endpoints.find(e=>e.role==='transfer')[k]=k==='port'?value===''?null:Number(value):nullable(value);render();return;}
   if(key.startsWith('root:')){c.profileDirty=true;const [,r,e]=key.split(':');c.profile.roots.find(x=>x.rootId===r).endpointPaths[e]=nullable(value);render();return;}
   if(key==='qos'){if(!c.resource)resource(null);c.resource.qos=nullable(value);c.resourceDirty=true;render();return;}
   if(key==='resource-select'){resource(resources()[resourceOptions().indexOf(value)-1]??null);render();return;}
   if(key.startsWith('profile:')){editProfile(c.catalog.profiles.find(p=>p.profileId===key.slice(8)));render('4:45');return;}
  }
  await run(async()=>{
   if(action==='s3-open'){await refresh();render('4:45');}
   else if(action==='s3-new'){fresh();c.operation=null;render('4:45');}
   else if(action==='s3-first-profile'){editProfile(c.catalog.profiles[0]);render('4:45');}
   else if(action==='s3-save'){const r=await unwrap('profileSave',{manifest:c.profile,expectedRevision:c.profileRef?.revision??0});await refresh();editProfile(c.catalog.profiles.find(p=>same(ref(p,'profileId'),r.profileRef)));if(getDraft()?.id)await loadDraft(getDraft().id);render('4:45');}
   else if(action==='s3-check'){if(c.profileDirty)throw Error('Save connection changes before reviewing prerequisites');const result=await unwrap('profileCheckPlan',{profileRef:c.profileRef,endpointId:c.profile.endpoints.find(e=>e.role==='login').endpointId,requestId:'profile-review-'+crypto.randomUUID()});c.operation=result.operation;render('4:45');}
   else if(key==='archive'){await unwrap('profileDelete',{profileRef:c.profileRef,expectedRevision:c.profileRef.revision});await refresh();fresh();render('4:45');}
   else if(key==='resource-save'){if(!c.selectedProfile)throw Error('Choose an exact saved connection');const plan={...c.resource,profileRef:c.selectedProfile,...(c.resourceRef?{resourcePlanId:c.resourceRef.resourcePlanId}:{})};const r=await unwrap('resourcePlanSave',{plan,expectedRevision:c.resourceRef?.revision??0});await refresh();resource(c.catalog.resources.find(p=>same(ref(p,'resourcePlanId'),r.resourceRef)));render();}
   else if(key==='bind'){if(getDirty()||!c.resourceRef||c.resourceDirty)throw Error('Save the draft and resource configuration first');const d=getDraft(),chosenProfile=c.selectedProfile,chosenResource=c.resourceRef;await loadDraft(d.id);c.selectedProfile=chosenProfile;c.resourceRef=chosenResource;const view=c.binding;if(!view.draft)throw Error('Current draft source is unavailable');const p=selected();if(!p)throw Error('Choose the intended current connection version');const binding={schemaVersion:1,...(view.binding?{bindingId:view.binding.bindingId}:{}),draftRef:{draftId:view.draft.draftId,revision:view.draft.revision,contentHash:view.draft.contentHash},inputValidationRef:view.draft.validationRef??null,profileRef:c.selectedProfile,resourceRef:c.resourceRef,rootSelection:Object.fromEntries([['inputRootId','inputs'],['workspaceRootId','workspace'],['outputRootId','outputs']].map(([k,role])=>[k,p.content.roots.find(r=>r.role===role)?.rootId]))};await unwrap('bindingSave',{binding,expectedRevision:view.binding?.revision??0});await loadDraft(d.id);render();}
   else if(key==='transfer-review'){const b=c.binding.binding;const bindingRef=ref(b,'bindingId');const result=await unwrap('transferPlan',{bindingRef,direction:'upload',sourceTokens:Object.values(getDraft().inputs).map(v=>v.ref),destinationRootId:b.content.rootSelection.workspaceRootId,relativePaths:Object.keys(getDraft().inputs),requestId:'transfer-review-'+crypto.randomUUID()});c.operation=result.operation;render();}
  });
 }
 fresh();return Object.freeze({project,act,refresh,loadDraft,clearDraft:()=>{c.binding=null;c.operation=null},current:()=>({bindingStatus:c.binding?.status,profileRef:c.profileRef,selectedProfile:c.selectedProfile,resourceRef:c.resourceRef,operationId:c.operation?.operationId,operationStatus:c.operation?.status,blocked:c.operation?.error.code})});
};
