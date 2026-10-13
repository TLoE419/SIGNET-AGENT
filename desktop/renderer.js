/* Native design renderer. All controls are local design demonstrations. */
'use strict';
const pages = new Map(window.SIGNET_DESIGN.pages.map(p => [p.nodeId,p]));
const app = document.getElementById('app');
const feedback = document.getElementById('demo-feedback');
const demo = {workflow:'network',current:'4:2',values:{},timer:null,history:[],selected:false};
let feedbackTimer;
let viewMode='review', formalHandler=null;
function notice(){feedback.textContent='Design demo only — no files, services or analyses were changed.';feedback.hidden=false;clearTimeout(feedbackTimer);feedbackTimer=setTimeout(()=>feedback.hidden=true,3500);}
function later(id,delay,next){clearTimeout(demo.timer);demo.timer=setTimeout(()=>{showScreen(id);if(next)later(next,1100);},delay);}
function action(label,node,el){
 if(el.disabled)return;
 if(viewMode==='formal'){formalHandler?.(demo.current,node.attrs?.['data-node-id'],undefined,el);return;}
 if(demo.current==='9:3218'){
  const page=[...pages.values()].find(p=>p.name.split(' · ')[0]+' · '+p.name.split(' / ').at(-1)===label);if(page){showScreen(page.nodeId,{reset:true});return;}
 }
 if(label==='Start scenario'){const buttons=[...document.querySelectorAll('button')].filter(b=>b.textContent==='Start scenario');showScreen(window.SIGNET_ROUTES.scenarios[buttons.indexOf(el)],{reset:true});return;}
 if(label==='Close anyway'){window.close();return;}
 if(['All','Active','Needs attention','Completed','Drafts'].includes(label)){showScreen(({All:'4:2',Active:'4:2','Needs attention':'4:18',Completed:'4:12',Drafts:'4:48'})[label]);return;}
 const inDialog=Boolean(el.closest('[role="dialog"]'));
 const target=window.SIGNET_ROUTES.target(demo.current,label,demo,inDialog);
 if(!target){notice();return;}
 showScreen(target);
 if(label==='Upload & check'||label==='Retry transfer')later('4:54',1100,'4:9');
 if(label==='Start analysis'&&target==='4:10')later('4:11',1500);
 if(['Download & explore','Download selected files','Retry download'].includes(label))later(demo.workflow==='import'?'4:33':'4:14',1500);
 if(label==='Open visualization'||label==='Retry')later('4:15',1500);
 if(label==='Reconnect')later('4:26',1500);
 if(label==='Scan workspace')later('4:27',1500);
}
function copyAttrs(el,attrs){for(const [key,value] of Object.entries(attrs||{}))if(key==='class'||key.startsWith('data-')||['alt','src','draggable'].includes(key))el.setAttribute(key,value);}
function component(node){
 const a=node.attrs||{},label=a.label||'',el=document.createElement(node.tag==='InputField'||node.tag==='SelectField'?'label':node.tag==='Tag'?'span':'button');copyAttrs(el,a);
 if(node.tag==='Button'||node.tag==='Tab'){
  el.type='button';el.textContent=label;el.dataset.label=label;el.setAttribute('aria-label',label);
  el.classList.add(node.tag==='Tab'?'sds-tab':'sds-button');
  if(node.tag==='Tab'){if(a.active==='On'){el.classList.add('active');el.setAttribute('aria-current','page');}}else el.classList.add((a.variant||'neutral').toLowerCase());
  el.disabled=a.state==='Disabled';el.addEventListener('click',()=>action(label,node,el));
 }else if(node.tag==='Tag'){el.textContent=label;el.classList.add('sds-tag',(a.scheme||'Neutral').toLowerCase());}
 else{
  el.classList.add('sds-field');if(a.state==='Error')el.classList.add('error');
  if(a.hasLabel==='true'){const l=document.createElement('span');l.className='sds-field-label';l.textContent=label;el.append(l);}
  const field=document.createElement(node.tag==='SelectField'?'select':'input');field.className=node.tag==='SelectField'?'sds-select':'sds-input';field.setAttribute('aria-label',label||a.placeholder||'Design field');
  const value=viewMode==='formal'?(a.value??''):(demo.values[label]??a.value??'');
  if(node.tag==='SelectField'){
   const choices=viewMode==='formal'?(a.options||[value]):[value];const collect=n=>{if(n.tag==='SelectField'&&n.attrs.label===label)choices.push(n.attrs.value||'');for(const child of n.children||[])collect(child);};if(viewMode!=='formal')for(const page of pages.values())collect(page.tree);
   for(const choice of new Set(choices)){const o=document.createElement('option');o.textContent=choice;o.value=choice;field.append(o);}
  }else field.placeholder=a.placeholder||'';
  field.value=value;field.disabled=viewMode==='formal'&&a.state==='Disabled';field.addEventListener('change',()=>{if(viewMode==='formal'){formalHandler?.(demo.current,a['data-node-id'],field.value,field);return;}demo.values[label]=field.value;if(/search/i.test(label)&&field.value&&!/demo|network|expression/i.test(field.value))showScreen('4:50');if(/PC/i.test(label)&&(!/^\d+$/.test(field.value)||Number(field.value)<1||Number(field.value)>5))showScreen('4:64');});el.append(field);
  if(a.hasDescription==='true'){const d=document.createElement('span');d.className='sds-field-description';d.textContent=a.description||'';el.append(d);}
  if(a.hasError==='true'){const d=document.createElement('span');d.className='sds-field-error';d.textContent=a.error||'';el.append(d);}
 }
 return el;
}
function create(node){
 if(Object.hasOwn(node,'text'))return document.createTextNode(node.text);
 if(['Button','Tab','Tag','InputField','SelectField'].includes(node.tag))return component(node);
 if(node.tag==='ChevronDown')return document.createTextNode('');
 if(!['div','p','a','span','img','section','pre'].includes(node.tag))throw Error('Unsupported design element: '+node.tag);
 const el=document.createElement(node.tag);copyAttrs(el,node.attrs);
 for(const child of node.children||[])el.append(create(child));
 const name=node.attrs?.['data-name']||'';
 if(node.tag==='a'){
  el.setAttribute('role','link');el.tabIndex=0;
  const go=()=>{if(viewMode==='formal'){if(el.getAttribute('aria-disabled')!=='true')formalHandler?.(demo.current,node.attrs?.['data-node-id'],undefined,el);return;}const text=el.textContent;if(demo.current==='4:27'&&el.closest('[role="dialog"]')){demo.selected=true;el.setAttribute('aria-selected','true');el.style.background='#f1f6fd';const b=[...el.closest('[role="dialog"]').querySelectorAll('button')].find(b=>b.textContent==='Recover analysis');if(b)b.disabled=false;return;}if(/Prepare|preprocess|align expression/i.test(text)){demo.workflow='preprocessing';showScreen('4:34');}else if(/cis-eQTL|cis-eqtl/i.test(text)){demo.workflow='cis';showScreen('4:41');}else if(/existing|Import/i.test(text)){demo.workflow='import';showScreen('4:30');}else if(/Build.*network|gene network/i.test(text)){demo.workflow='network';showScreen('4:3');}else if(/Row 1/.test(name))showScreen('4:11');else if(/Row 2/.test(name))showScreen('4:14');else if(/Row 3/.test(name))showScreen('4:34');else notice();};
  el.addEventListener('click',go);el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();go();}});
 }
 if(node.tag==='div'&&node.attrs?.['data-input-key']){el.setAttribute('role','button');el.tabIndex=0;const select=()=>formalHandler?.(demo.current,node.attrs['data-node-id'],node.attrs['data-input-key'],el);el.addEventListener('click',select);el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select();}});}
 return el;
}
// Configure the detached dialog before installing the screen in the document.
// Keep background controls inert and preserve the recovery row's demo selection.
function configureDialog(tree,id){
 const backdrop=[...tree.children].find(el=>el.dataset.name==='Modal backdrop');
 if(!backdrop?.nextElementSibling)return;
 const modal=backdrop.nextElementSibling;
 modal.setAttribute('role','dialog');
 modal.setAttribute('aria-modal','true');
 modal.setAttribute('aria-label',modal.dataset.name);
 if(id==='4:27'){
  for(const row of modal.querySelectorAll('[data-name="Row 1"]')){
   row.setAttribute('role','button');
   row.tabIndex=0;
   const select=()=>{
    demo.selected=true;
    row.setAttribute('aria-selected','true');
    row.style.background='#f1f6fd';
   };
   row.addEventListener('click',select);
   row.addEventListener('keydown',e=>{
    if(e.key==='Enter'||e.key===' '){e.preventDefault();select();}
   });
  }
 }
 for(const el of tree.children){
  if(el!==modal&&el!==backdrop){
   el.inert=true;
   el.setAttribute('aria-hidden','true');
  }
 }
}
function showScreen(id,{reset=false,formal=false,tree:projected=null}={}){
 viewMode=formal?'formal':'review';
 window.dispatchEvent(new CustomEvent('signet:mode',{detail:{mode:viewMode}}));
 const page=pages.get(id);if(!page)throw Error('Unknown design screen: '+id);
 clearTimeout(demo.timer);clearTimeout(feedbackTimer);feedback.hidden=true;if(reset)demo.values={};
 if(/preprocessing|Review PCA/i.test(page.name))demo.workflow='preprocessing';else if(/cis-eqtl/i.test(page.name))demo.workflow='cis';else if(/\/ import/.test(page.name))demo.workflow='import';else if(/\/ network/.test(page.name))demo.workflow='network';
 demo.current=id;
 demo.history.push(id);
 const tree=create(projected||page.tree);
 tree.classList.add('screen');
 if(page.review)tree.classList.add('review');
 tree.dataset.screenId=id;
 configureDialog(tree,id);
 app.replaceChildren(tree);document.title=page.name+(formal?' — SIGNET':' — SIGNET design demo');window.scrollTo(0,0);
 window.dispatchEvent(new CustomEvent('signet:screen',{detail:{nodeId:id,name:page.name,demo:!formal}}));
}
window.signetView=Object.freeze({render:(id,tree)=>showScreen(id,{formal:true,tree}),bind:handler=>{formalHandler=handler;},mode:()=>viewMode});
window.signetReview=Object.freeze({open:showScreen,openIndex:()=>showScreen('3:797'),current:()=>({nodeId:demo.current,workflow:demo.workflow,demo:true,history:[...demo.history]})});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.shiftKey&&e.key.toLowerCase()==='r'){e.preventDefault();showScreen('3:797');}if(e.key==='Escape'&&viewMode==='formal'){if(document.querySelector('[role="dialog"]'))formalHandler?.(demo.current,'formal:escape');return;}if(e.key==='Escape'&&document.querySelector('[role="dialog"]'))showScreen(demo.current==='4:72'?window.SIGNET_ROUTES.workflows[demo.workflow][1]:'4:2');});
showScreen(new URLSearchParams(location.search).has('review')?'3:797':'4:2');
