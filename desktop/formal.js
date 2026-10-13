/* Local records/drafts only. Review routing remains in renderer.js and cannot call this controller. */
'use strict';
(()=>{
 const bridge=window.desktop,view=window.signetView;if(!bridge)return;
 const pages=new Map(window.SIGNET_DESIGN.pages.map(p=>[p.nodeId,p])),bindings=window.SIGNET_FORMAL_BINDINGS;
 const routes={network:['4:3','4:5','4:6','4:7'],preprocessing:['4:34','4:35','4:36','4:7'],cis:['4:41','4:42','4:43','4:7'],import:['4:30','4:31','4:31','4:7']};
 const state={mode:'formal',records:[],drafts:[],query:'',filter:'All',page:'4:2',step:0,draft:null,loaded:null,validation:null,issues:[],manifest:[],selectedInput:null,dirty:false,busy:false,error:'',caps:null,record:null,dialogReturn:null};
 let generation=0;
 const active=()=>state.mode==='formal';
 const unwrap=async(name,...args)=>{if(!active())throw Error('Review is isolated');const stamp=generation;const r=await bridge[name](...args);if(stamp!==generation||!active())throw Error('Stale response after mode change');if(!r?.ok)throw Error(r?.error??'Local controller unavailable');return r.value;};
 const clone=x=>JSON.parse(JSON.stringify(x));
 const t=(node,value)=>{node.children=[{text:String(value??'—')}];};
 const find=(node,predicate)=>{if(predicate(node))return node;for(const c of node.children||[]){const found=find(c,predicate);if(found)return found;}return null;};
 const visit=(node,fn)=>{fn(node);for(const c of node.children||[])visit(c,fn);};
 const name=(node)=>node.attrs?.['data-name'];
 function summary(node,label,value){if(!node)return;const ps=[];visit(node,n=>{if(n.tag==='p')ps.push(n);});if(ps.length){t(ps[0],label);for(let i=1;i<ps.length;i++)t(ps[i],i===1?value:'');}}
 function fields(){return state.draft?.workflow==='preprocessing'?state.caps.fields[state.draft.cohort]:state.draft?.workflow==='network'?state.caps.fields.network:[];}
 function invalidate(){state.dirty=true;state.validation=null;state.issues=[];}
 function setWorkflow(workflow){const definition=state.caps.workflows[workflow];const d=state.draft;d.workflow=workflow;d.entryStage=definition.entryStage;d.finishAfter=definition.finishes[0];d.inputs={};state.manifest=[];state.selectedInput=null;state.step=0;invalidate();render(routes[workflow][0]);}
 function descriptor(id){return bindings[state.page]?.[id];}
 function controls(tree){visit(tree,n=>{const a=n.attrs;if(!a)return;const control=bindings[state.page]?.[a['data-node-id']];
  if(['Button','Tab','InputField','SelectField'].includes(n.tag)){
   if(!control){a.state='Disabled';if(n.tag==='InputField'||n.tag==='SelectField'){a.value='Not ready (S2–S7)';a.options=[a.value];}if(a.label==='UCI HPC3 · Connected')a.label='Remote connection · Not ready';}
   else{
    a.state='Default';const [action,key]=control;
    if(action==='edit'){a.value=state.draft?.[key]??'';if(key==='finishAfter')a.options=state.caps.workflows[state.draft.workflow].finishes;if(key==='cohort')a.options=['TCGA','GTEx'];if(key==='species')a.options=['',...new Set(state.caps.annotation.map(c=>c.species))];if(key==='assembly')a.options=['',...state.caps.annotation.filter(c=>c.species===state.draft.species).map(c=>c.assembly)];}
    if(action==='parameter')a.value=String(state.draft.parameters[key]);
    if(action==='search')a.value=state.query;
    if(action==='filter')a.active=key===state.filter?'On':'Off';
    if(['validate-review','continue'].includes(action)&&state.step>0&&!state.validation?.capabilities?.reviewReady)a.state='Disabled';
    if(action==='continue'&&!state.caps.workflows[state.draft.workflow].supported)a.state='Disabled';
    if(action==='pick'&&!state.selectedInput)a.state='Disabled';
    if(action==='validate-review'&&state.step===2)a.state='Default';
   }
   if(n.tag==='InputField'||n.tag==='SelectField'){a.hasError='false';a.hasDescription='false';a.error='';if(a.state==='Disabled')a.value='Not ready (S2–S7)';}
  }
  if(n.tag==='a'&&!control&&!a['data-record-id'])a['data-formal-disabled']='true';
  if(n.tag==='Tag'&&a.label==='Demo data')a.label='Local records';
 });}
 function recordRows(tree){const table=find(tree,n=>name(n)==='Data table'),template=find(table,n=>n.attrs?.['data-node-id']==='5:1222');if(!table||!template)return;
 const all=[...state.records,...state.drafts];const filtered=all.filter(r=>(!state.query||[r.label,r.id,r.workflow,r.status].some(v=>String(v??'').toLowerCase().includes(state.query.toLowerCase())))&&(state.filter==='All'||state.filter==='Drafts'&&r.kind==='draft'||state.filter==='Active'&&['running','starting','verifying','cancelling'].includes(r.status)||state.filter==='Completed'&&r.status==='succeeded'||state.filter==='Needs attention'&&['record-error','failed','interrupted','cancelled','missing-input'].includes(r.status)));
 table.children=table.children.filter(n=>name(n)==='Column headings');for(const r of filtered){const row=clone(template);delete row.attrs['data-formal-disabled'];row.attrs['data-record-id']=r.id;row.attrs['data-record-kind']=r.kind;row.attrs['data-node-id']='formal:record:'+r.id;row.attrs['data-name']='Record '+r.id;
 const values={'Cell / Analysis':r.label,'Cell / Starting point':r.workflow??r.dataset??(r.legacy?'Historical record':'Recorded'),'Cell / Current stage':r.active_stage??'Not recorded','Cell / Status':r.status,'Cell / Last checked':r.checkedAt??r.updated_at??'Not recorded','Cell / Local results':r.error??'Read-only'};
 for(const cell of row.children??[]){const value=values[name(cell)];if(value!==undefined){let first=true;visit(cell,n=>{if(n.tag==='p'){t(n,first?value:'');first=false;}});}}
 visit(row,n=>{if(n!==row&&n.attrs?.['data-node-id'])delete n.attrs['data-node-id'];});table.children.push(row);
 }
 if(!filtered.length){const row=clone(template);row.tag='div';row.attrs['data-name']='No records';delete row.attrs['data-node-id'];row.children=[{tag:'p',attrs:{class:'design-0041'},children:[{text:state.query||state.filter!=='All'?'No matching local records.':'No local analyses or saved drafts.'}]}];table.children.push(row);}
 // Replace the design-only footer; recovery is a later-stage capability.
 summary(find(tree,n=>n.attrs?.['data-node-id']==='5:1261'),'Local records','');
 }
 function inputRows(tree){const table=find(tree,n=>name(n)==='Data table');if(!table)return;const template=table.children.find(n=>n.tag==='div'&&name(n)!=='Column headings');if(!template)return;
 table.children=table.children.filter(n=>name(n)==='Column headings');for(const [key,label]of fields()){
 const row=clone(template),m=state.manifest.find(m=>m.field===key),selected=state.draft.inputs[key],problem=state.issues.find(i=>i.field==='inputs.'+key);
 row.attrs['data-node-id']='formal:input:'+key;row.attrs['data-input-key']=key;row.attrs['data-name']='Input '+key;if(state.selectedInput===key)row.attrs.class+=' formal-selected';
 const values={'Cell / Required input':label,'Cell / Location':'Local','Cell / File':m?.name??(selected?.token?selected.name??'Selected':'Choose source'),'Cell / Size':m?.bytes?m.bytes+' B':'—','Cell / Check':problem?.code??(state.validation?.status==='validated'?'Validated':selected?'Not validated':'Required')};
 for(const cell of row.children??[]){const value=values[name(cell)];if(value!==undefined){const p=find(cell,n=>n.tag==='p');if(p)t(p,value);}}
 visit(row,n=>{if(n!==row&&n.attrs?.['data-node-id'])delete n.attrs['data-node-id'];});table.children.push(row);
 }
 }
 function statusPanel(tree){const holder=find(tree,n=>name(n)==='Page content');if(!holder)return;const issueText=state.error||state.issues.map(i=>i.field+': '+i.message).join('\n');if(issueText)holder.children.push({tag:'div',attrs:{class:'formal-issues','data-name':'Validation issues'},children:[{tag:'p',children:[{text:issueText}]}]});}
 function project(id){const tree=clone(pages.get(id).tree);state.page=id;controls(tree);
 // Data sections retain their design containers while replacing demo claims with real data.
 if(id==='4:2')recordRows(tree);
 if(state.draft){
  summary(find(tree,n=>name(n)==='Analysis plan'),'Analysis plan',state.draft.workflow+' · '+state.draft.entryStage+' → '+state.draft.finishAfter+'\n'+(state.caps.workflows[state.draft.workflow].reason??'Local draft; no computation or remote submission'));

  if(state.step===3){
   const card=find(tree,n=>name(n)==='Review your analysis');
   for(const [section,value]of [['Analysis',state.draft.label],['Workflow',state.draft.workflow],['Inputs',state.manifest.map(m=>m.name).join(' · ')],['Parameters',JSON.stringify(Object.fromEntries(['nboots','ncis','cor','alpha.cis','freq','ntop'].map(k=>[k,state.draft.parameters[k]])))],['Connection','Not ready (S3)'],['Resources','Not configured (S3)'],['Output location','Not created'],['Local results','No scientific work started']])summary(find(tree,n=>name(n)===section),section,value);
  }
  // These original text IDs contain design-only success/file/remote claims.
  const override={
   '6:472':'Choose each input row, then choose its local source. Sample IDs and annotation metadata are required.',
   '6:473':state.validation?state.validation.status+' · revision '+state.validation.revision:'Not validated',
   '6:885':'Local validation only; upload is not ready (S3).','6:886':'Saving this draft does not start an analysis.',
   '6:824':state.draft.label,'6:827':state.draft.workflow+' · '+state.draft.entryStage+' → '+state.draft.finishAfter,
   '6:833':JSON.stringify(Object.fromEntries(['nboots','ncis','cor','alpha.cis','freq','ntop'].map(k=>[k,state.draft.parameters[k]]))),'6:866':'Not ready (S3)','6:872':'Not created','6:875':'No result created',
  };visit(tree,n=>{if(override[n.attrs?.['data-node-id']]!==undefined)t(n,override[n.attrs['data-node-id']]);});
  // Keep original notice/layout, clear hardcoded validation successes on the raw/alternate data pages.
  if(state.step===1)visit(tree,n=>{if(n.tag==='p'&&n.children?.some(c=>c.text&&(/✓|☑|\d+ samples|\.data|\.vcf|\.gct|\.gtf/.test(c.text)))&&!find(n,x=>x.attrs?.['data-input-key']))t(n,'Validation is required for this draft.');});
 }
 if(state.draft&&state.step===1){inputRows(tree);if(id==='4:4'){const form=find(tree,n=>name(n)==='Network construction inputs');if(form)for(const [key,label]of [['species','Species'],['assembly','Genome assembly']]){form.children.push({tag:'SelectField',attrs:{class:'sds-field','data-node-id':'formal:'+key,label,hasLabel:'true',value:state.draft[key],options:['',...state.caps.annotation.map(a=>a[key])],state:'Default'}});}}}
 if(state.record&&['4:65','4:23'].includes(id)){
 const r=state.record;visit(tree,n=>{if(n.tag==='Tag'&&['6:11697','6:3803'].includes(n.attrs?.['data-node-id']))n.attrs.label=r.status;if(['6:11704','6:3810'].includes(n.attrs?.['data-node-id']))t(n,r.id+' · '+(r.checkedAt??r.updated_at??'No remote check recorded'));});summary(find(tree,n=>name(n)==='Analysis header'),r.label,r.id+' · '+r.status);
 summary(find(tree,n=>name(n)==='Workflow'),'Workflow',r.workflow??r.dataset??'Historical actual run');
 summary(find(tree,n=>name(n)==='Input files'),'Input files',(r.inputIssues??[]).map(i=>i.message).join('\n')||'No current source issue recorded');
 summary(find(tree,n=>name(n)==='Scientific parameters'),'Scientific parameters',JSON.stringify(r.parameters??{nboots:r.nboots}));
 summary(find(tree,n=>name(n)==='HPC resources'),'Environment',r.environment??'Not recorded; no current connection proven');
 summary(find(tree,n=>name(n)==='Workspace'),'Source',r.stateSource??'Persisted local record');
 summary(find(tree,n=>name(n)==='Execution history'),'Execution history',JSON.stringify({created_at:r.created_at,updated_at:r.updated_at,active_stage:r.active_stage,stages:r.stages,error:r.error},null,2));
 }
 if(state.draft&&state.step===2&&state.draft.workflow==='network'){const group=find(tree,n=>n.attrs?.['data-node-id']===(id==='4:53'?'6:9333':'6:605')),template=find(group,n=>n.attrs?.['data-node-id']===(id==='4:53'?'6:9334':'6:606'));if(group&&template)for(const key of ['alpha.cis','freq','ntop']){const field=clone(template);field.attrs['data-node-id']='formal:param:'+key;field.attrs.label=state.caps.parameters[key].label;field.attrs.value=String(state.draft.parameters[key]);group.children.push(field);}}
 if(state.draft&&state.step===3){const resource=find(tree,n=>name(n)==='Resources');if(resource)summary(resource,'Resources','Not configured (S3)');}
 visit(tree,n=>{if(n.tag==='p'&&n.children?.some(c=>c.text?.startsWith('Demo values')))t(n,'Remote resources are not configured (S3).');if(id==='4:4'&&n.attrs?.['data-node-id']==='6:229')t(n,'Input validation is blocked.');if(id==='4:4'&&n.attrs?.['data-node-id']==='6:230')t(n,state.issues.map(i=>i.field+': '+i.message).join(' · ')||state.error);if(n.attrs?.['data-formal-disabled']==='true')n.attrs['data-formal-disabled']='true';});if(id!=='4:4'||state.error)statusPanel(tree);return tree;
 }
 function applyBusy(){for(const el of document.querySelectorAll('input,select,button')){if(state.busy&&!Object.hasOwn(el.dataset,'s1Disabled')){el.dataset.s1Disabled=String(el.disabled);el.disabled=true;}else if(!state.busy&&Object.hasOwn(el.dataset,'s1Disabled')){el.disabled=el.dataset.s1Disabled==='true';delete el.dataset.s1Disabled;}}document.querySelector('[data-screen-id]')?.setAttribute('aria-busy',String(state.busy));}
 function render(id=state.page){if(!active())return;view.render(id,project(id));document.getElementById('app').hidden=false;if(state.record)document.title=state.record.label+' — SIGNET history ('+state.record.status+')';else if(state.draft&&state.step===1)document.title='SIGNET — Input validation ('+(state.validation?.status??'not validated')+')';for(const el of document.querySelectorAll('[data-formal-disabled]')){el.setAttribute('aria-disabled','true');el.tabIndex=-1;}for(const el of document.querySelectorAll('input,select')){if(el.closest('label')?.classList.contains('disabled')||el.closest('label')?.dataset.formalDisabled==='true')el.disabled=true;}applyBusy();}
 function route(step){if(!state.draft)return;state.step=step;render(step===1&&state.draft.workflow==='network'&&(state.validation?.status==='blocked'||state.issues.length)?'4:4':routes[state.draft.workflow][step]);}
 async function refresh(){const [records,drafts]=await Promise.all([unwrap('list'),unwrap('draftList')]);if(!active())return;state.records=records;state.drafts=drafts;}
 async function list(){await refresh();state.draft=null;state.loaded=null;state.record=null;state.validation=null;state.dirty=false;state.issues=[];render('4:2');}
 function newDraft(){state.error='';state.draft={revision:0,label:'',notes:'',workflow:'network',cohort:'TCGA',entryStage:'network',finishAfter:'network',species:'',assembly:'',inputs:{},parameters:{nboots:state.caps.parameters.nboots.default,ncis:state.caps.parameters.ncis.default,cor:state.caps.parameters.cor.default,'alpha.cis':state.caps.parameters['alpha.cis'].default,freq:state.caps.parameters.freq.default,ntop:state.caps.parameters.ntop.default}};state.loaded=null;state.validation=null;state.manifest=[];state.issues=[];state.dirty=false;state.selectedInput=null;state.record=null;route(0);}
 async function save(){for(const [key,value]of Object.entries(state.draft.parameters))if(key!=='tissue'&&(typeof value!=='number'||!Number.isFinite(value)))throw Error('Invalid parameter: '+key);const payload=clone(state.draft);for(const input of Object.values(payload.inputs))delete input.name;const r=await unwrap('draftSave',payload);if(!active())return;state.draft=r.draft;state.loaded=clone(r.draft);state.manifest=r.inputManifest;state.issues=r.issues;state.validation=r.validation;state.dirty=false;return r;}
 async function validate(){if(!state.draft.id||state.dirty)await save();const v=await unwrap('inputValidate',state.draft.id,state.draft.revision);if(!active())return;state.validation=v;state.issues=v.issues;state.manifest=v.inputManifest;return v;}
 async function openRecord(id,kind){if(kind==='draft'){const r=await unwrap('draftLoad',id);state.draft=r.draft;state.loaded=clone(r.draft);state.validation=r.validation;state.manifest=r.inputManifest;state.issues=r.issues;state.dirty=false;state.selectedInput=null;state.record=null;route(r.issues.length?1:0);}else{state.record=await unwrap('detail',id);state.draft=null;state.issues=[];render(state.record.inputIssues?.length?'4:23':'4:65');}}
 async function act(page,id,value,el){if(!active()||state.busy)return;
 if(id==='formal:escape'){state.error='';render(state.dialogReturn??routes[state.draft.workflow][state.step]);return;}
 if(id?.startsWith('formal:param:')){const key=id.slice('formal:param:'.length);if(['alpha.cis','freq','ntop'].includes(key)){state.draft.parameters[key]=value===''?NaN:Number(value);invalidate();}return;}
 if(id?.startsWith('formal:input:')){state.selectedInput=value;render();return;}
 if(id?.startsWith('formal:record:')){await run(()=>openRecord(el.dataset.recordId,el.dataset.recordKind));return;}
 const d=bindings[page]?.[id];if(!d)return;const [action,key]=d;
 if(action==='edit'||action==='parameter'){if(action==='parameter')state.draft.parameters[key]=value===''?NaN:Number(value);else {state.draft[key]=value;if(key==='cohort'){state.draft.inputs={};state.manifest=[];state.selectedInput=null;}}invalidate();if(['cohort','species'].includes(key))render();return;}
 if(action==='search'){state.query=value;render('4:2');return;}
 if(action==='filter'){state.filter=key;render('4:2');return;}
 if(action==='workflow'){setWorkflow(key);return;}
 if(action==='review'){window.signetReview.openIndex();return;}
 if(action==='new'){newDraft();return;}
 if(action==='cancel'){state.dialogReturn=state.page;render('4:71');return;}
 if(action==='cancel-dialog'){render(state.dialogReturn??routes[state.draft.workflow][state.step]);return;}
 if(action==='discard'){state.draft=state.loaded?clone(state.loaded):null;state.dirty=false;await run(list);return;}
 await run(async()=>{
 if(action==='list'){if(state.dirty){state.dialogReturn=state.page;render('4:71');}else await list();}
 else if(action==='save-close'){await save();await list();}
 else if(action==='route'){const step={workflow:0,data:1,settings:2}[key];if(step<2||state.validation?.capabilities.reviewReady)route(step);}
 else if(action==='continue'){if(state.step===0){await save();route(1);}else if(state.step===1&&state.validation?.capabilities.reviewReady)route(2);}
 else if(action==='back')route(Math.max(0,state.step-1));
 else if(action==='pick'){const r=await unwrap('pick',state.selectedInput,state.draft.cohort,state.draft.workflow);if(!active()||r.canceled)return;state.draft.inputs[state.selectedInput]={token:r.token,name:r.name};state.manifest=state.manifest.filter(m=>m.field!==state.selectedInput);invalidate();render();}
 else if(action==='validate'){await validate();route(1);}
 else if(action==='validate-review'){const v=await validate();if(v?.capabilities.reviewReady)route(3);else route(1);}
 else if(action==='reload-record')await openRecord(state.record.id,'analysis');
 });
 }
 async function run(fn){const token=++generation;state.busy=true;state.error='';applyBusy();try{await fn();}catch(e){if(active()&&token===generation){state.error=e.message;render(state.step===2&&state.draft?.workflow==='network'?'4:53':state.page);}}finally{if(token===generation){state.busy=false;if(active())applyBusy();}}}
 view.bind(act);
 window.addEventListener('signet:mode',e=>{state.mode=e.detail.mode;if(state.mode==='review'){generation++;state.busy=false;bridge.mode('review');} });
 window.signetWorkspace=Object.freeze({open:async()=>{state.mode='formal';await bridge.mode('formal');await run(async()=>{if(state.draft)render(state.page);else await list();});},current:()=>({mode:state.mode,page:state.page,draftId:state.draft?.id,revision:state.draft?.revision,dirty:state.dirty,busy:state.busy,validation:state.validation?.status,error:state.error,records:state.records.length,drafts:state.drafts.length})});
 document.getElementById('app').hidden=true;
 run(async()=>{await unwrap('mode','formal');state.caps=await unwrap('capabilities');await list();});
})();
