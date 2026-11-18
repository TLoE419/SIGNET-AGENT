'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const folder=path.join(__dirname,'../renderer/features/workspace');
const html=readFileSync(path.join(folder,'index.html'),'utf8').replace('__INITIAL_CHAT__','{}');
const code=readFileSync(path.join(folder,'workspace.js'),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
const catalog=[{id:'example-chr1',name:['甲資料組','Dataset A'],inputs:{genotype:['study.ped','study.map'],expression:['example_gexp'],clinical:['clinical.tsv']}},
 {id:'dataset-b',name:['乙資料組','Dataset B'],inputs:{genotype:[],expression:[],clinical:[]}}];
const base=(key,overrides={})=>({history_id:key,run_id:key.split('--').slice(1).join('--'),revision:'revision-'+key,name:[key,key],dataset_id:'example-chr1',source:'recorded',origin:'slurm',
 association:{status:'recorded',method:'manifest'},capabilities:{continue_analysis:false,stage_results:[],stage6_graph:false,assign_dataset:false},jobs:{},operations:[],inputs:{genotype:[],expression:[],clinical:[]},status:'completed',graph:null,issues:[],...overrides});
const workspace=(key='workspace--shared')=>base(key,{source:'live',origin:'workspace',capabilities:{continue_analysis:true,stage_results:['1','6'],stage6_graph:true,assign_dataset:false},jobs:{genotype:{state:'completed'},visualize:{state:'completed'}},graph:{genes:3,connections:2}});
const archive=(key='archive--shared')=>base(key,{source:'archive',origin:'archive',capabilities:{continue_analysis:false,stage_results:['1','6'],stage6_graph:true,assign_dataset:false},jobs:{genotype:{state:'completed'},visualize:{state:'completed'}},graph:{genes:2,connections:1}});
const reply=(value,status=200)=>({ok:status<400,status,json:async()=>clone(value)});
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
async function until(check){for(let i=0;i<80;i++){if(check())return;await settle()}assert.fail('Workspace did not settle')}
function harness(t,rows,handler){
 const dom=new JSDOM(html,{url:'http://localhost',runScripts:'outside-only',pretendToBeVisual:true});t.after(async()=>{await settle();await settle();dom.window.close()});
 const {window}=dom,calls=[],contexts={};window.ResizeObserver=class{observe(){}};window.CSS={escape:value=>String(value).replace(/[^\w-]/g,'\\$&')};
 window.HTMLElement.prototype.scrollIntoView=function(){};
 window.SignetInputValidation={create:()=>({sync(){}})};
 for(const [name,key]of [['Genotype','genotype'],['Expression','expression'],['Adjustment','adjust'],['Cis','cis'],['Network','network'],['Visualization','visualize']]){
  window['mount'+name+'Run']=()=>({setContext(context){contexts[key]=clone(context)}});
 }
 window.fetch=async(url,options={})=>{
  const call={url,options,body:options.body?JSON.parse(options.body):undefined};calls.push(call);
  const custom=handler?.(call);if(custom!==undefined)return custom;
  if(url==='/stage6/history')return reply({runs:rows,datasets:catalog});
  if(url==='/signet/datasets')return reply({datasets:catalog});
  if(url.startsWith('/stage6/results?')){const source=new URL('http://localhost'+url).searchParams.get('source');return reply({run_id:'shared',source,frequency:.45,top_networks:1,graph:{nodes:source==='live'?['MEGF6','A','B']:['MEGF6','X'],edges:source==='live'?[{source:'MEGF6',target:'A',frequency:1,coefficient:.3},{source:'A',target:'B',frequency:1,coefficient:.2}]:[{source:'X',target:'MEGF6',frequency:.9,coefficient:.8}],counts:{genes:source==='live'?3:2,connections:source==='live'?2:1}}});}
  throw Error('Unexpected request '+url);
 };
 window.eval(code);const q=selector=>window.document.querySelector(selector);
 const click=selector=>{assert.ok(q(selector),'Missing '+selector);q(selector).dispatchEvent(new window.MouseEvent('click',{bubbles:true}))};
 const choose=(selector,value)=>{const select=q(selector);select.value=value;select.dispatchEvent(new window.Event('change',{bubbles:true}))};
 return {window,q,click,choose,calls,contexts,ready:()=>until(()=>q('[data-run-target]')),rows};
}

test('history scopes preserve generic evidence and do not fabricate stage actions',async t=>{
 const generic=base('recorded--old',{dataset_id:null,status:'prepared',association:{status:'unclassified',method:null},capabilities:{continue_analysis:false,stage_results:[],stage6_graph:false,assign_dataset:true},
 operations:[{operation:'signet_prepare',status:'prepared',executed:false,inputs:{'gexp.file':'/old/expression'},settings:{npc:7},resources:{cpus:4},settings_evidence:'prepared_snapshot',record_file:'prepare.json'}]});
 const retired=base('recorded--retired',{dataset_id:'retired-dataset'});const h=harness(t,[workspace(),archive(),generic,retired]);await h.ready();h.click('[data-nav-target="history"]');
 assert.equal([...h.window.document.querySelectorAll('[data-run-target]')].filter(row=>!row.hidden).length,2);
 h.choose('#ml-history-scope','unclassified');h.click('[data-run-target="recorded--old"]');const detail=h.q('#ml-run-recorded--old');
 assert.equal(detail.hidden,false);assert.equal(detail.querySelectorAll('[data-run-stage]').length,0);assert.match(detail.querySelector('[data-history-state]').textContent,/未記錄實際執行/);
 assert.match(detail.querySelector('[data-settings-evidence]').textContent,/不代表已執行/);assert.match(detail.querySelector('[data-history-saved="settings"]').textContent,/npc7/);
 assert.match(detail.querySelector('[data-history-saved="inputs"]').textContent,/old\/expression/);assert.equal(h.contexts.expression.runs.length,0);
 h.choose('#ml-history-scope','all');assert.equal([...h.window.document.querySelectorAll('[data-run-target]')].filter(row=>!row.hidden).length,4);
 h.click('[data-run-target="recorded--retired"]');assert.match(h.q('#ml-run-recorded--retired [data-history-association]').textContent,/retired-dataset/);
 assert.equal([...h.q('#ml-dataset-select').options].some(option=>option.value==='retired-dataset'),false);
});

test('same canonical run IDs retain independent graph sources and selections',async t=>{
 const h=harness(t,[workspace(),archive()]);await h.ready();h.click('[data-nav-target="history"]');
 h.click('[data-run-target="workspace--shared"]');h.click('#ml-run-workspace--shared [data-run-stage="6"]');await until(()=>h.q('#lens-stage6').dataset.runState==='ready');
 assert.equal(h.q('#lens-stage6').dataset.historyId,'workspace--shared');h.click('#lens-stage6 [data-gene="A"]');
 h.click('#ml-stage6-back');h.click('[data-run-target="archive--shared"]');h.click('#ml-run-archive--shared [data-run-stage="6"]');await until(()=>h.q('#lens-stage6').dataset.historyId==='archive--shared');
 assert.equal(h.q('#lens-stage6 [data-gene="A"]'),null);h.click('#lens-stage6 [data-gene="X"]');
 h.click('#ml-stage6-back');h.click('[data-run-target="workspace--shared"]');h.click('#ml-run-workspace--shared [data-run-stage="6"]');await until(()=>h.q('#lens-stage6').dataset.historyId==='workspace--shared');
 assert.equal(h.q('#lens-stage6 [data-gene="A"]').getAttribute('aria-pressed'),'true');
 assert.deepEqual(h.calls.filter(call=>call.url.startsWith('/stage6/results?')).map(call=>new URL('http://localhost'+call.url).searchParams.get('source')),['live','archive','live']);
 assert.equal(new Set([...h.q('#ml-stage6-run').options].map(option=>option.value)).size,3);
});

test('All scope opens the selected workspace run even while another dataset is active',async t=>{
 const run=workspace();run.jobs={genotype:{state:'completed'},expression:{state:'running',inputs:{'gexp.file':'/frozen/a'}}};run.capabilities.stage_results=['1'];run.capabilities.stage6_graph=false;
 const h=harness(t,[run]);await h.ready();h.choose('#ml-dataset-select','dataset-b');h.click('[data-nav-target="history"]');h.choose('#ml-history-scope','all');
 h.click('[data-run-target="workspace--shared"]');h.click('#ml-run-workspace--shared [data-run-stage="2"]');
 assert.equal(h.contexts.expression.datasetId,'example-chr1');assert.equal(h.contexts.expression.runId,'shared');assert.deepEqual(h.contexts.expression.runs.map(row=>row.history_id),['workspace--shared']);assert.equal(h.q('#lens-stage2').hidden,false);
});

test('Stage 1 progress opens the exact historical run without changing the selected dataset',async t=>{
 const first=workspace('workspace--first'),second=workspace('workspace--second');
 for(const row of [first,second]){row.jobs={genotype:{state:'pending',job_id:row.run_id==='first'?'123':'456'}};row.capabilities.stage_results=[];row.capabilities.stage6_graph=false;}
 const unavailable=workspace('workspace--unavailable');unavailable.jobs={genotype:{state:'completed'}};unavailable.capabilities.stage_results=[];unavailable.capabilities.stage6_graph=false;
 const h=harness(t,[first,second,unavailable]);await h.ready();h.choose('#ml-dataset-select','dataset-b');h.click('[data-nav-target="history"]');h.choose('#ml-history-scope','all');
 assert.equal(h.q('#ml-run-workspace--unavailable [data-run-stage="1"]'),null);
 h.click('[data-run-target="workspace--second"]');h.click('#ml-run-workspace--second [data-run-stage="1"]');
 assert.equal(h.contexts.genotype.datasetId,'example-chr1');assert.equal(h.contexts.genotype.runId,'second');
 assert.deepEqual(h.contexts.genotype.runs.map(row=>row.history_id),['workspace--second']);
 assert.equal(h.contexts.genotype.runs[0].jobs.genotype.job_id,'456');assert.equal(h.q('#lens-stage1').hidden,false);
 assert.equal(h.q('#lens-history-stage').hidden,true);assert.equal(h.q('#ml-dataset-select').value,'dataset-b');
 h.click('[data-nav-target="analysis"]');assert.equal(h.contexts.genotype.datasetId,'dataset-b');assert.equal(h.contexts.genotype.runId,null);
 assert.equal(h.calls.some(call=>call.url.startsWith('/stage/results')),false);
});

test('manual assignment uses source-scoped revision and remains honest after switching scope',async t=>{
 const row=base('recorded--loose',{dataset_id:null,association:{status:'unclassified',method:null},capabilities:{continue_analysis:false,stage_results:[],stage6_graph:false,assign_dataset:true}});let release;
 const h=harness(t,[row],call=>call.options.method==='PATCH'?new Promise(resolve=>release=resolve):undefined);await h.ready();h.click('[data-nav-target="history"]');h.choose('#ml-history-scope','unclassified');
 h.choose('[data-history-assignment="recorded--loose"] [data-history-dataset]','dataset-b');h.click('[data-history-assignment="recorded--loose"] [data-history-assign]');
 assert.equal(h.q('[data-history-assignment="recorded--loose"]').dataset.saveState,'saving');h.click('[data-history-assignment="recorded--loose"] [data-history-assign]');
 const saves=h.calls.filter(call=>call.options.method==='PATCH');assert.equal(saves.length,1);assert.equal(saves[0].url,'/signet/history/recorded--loose/dataset');assert.deepEqual(saves[0].body,{dataset_id:'dataset-b',revision:row.revision});
 h.choose('#ml-history-scope','all');release(reply({...row,dataset_id:'dataset-b',revision:'next',association:{status:'manual',method:'manual'}}));await until(()=>h.q('[data-history-assignment="recorded--loose"]').dataset.saveState==='saved');
 assert.match(h.q('#ml-run-recorded--loose [data-history-association]').textContent,/不代表已確認樣本/);assert.equal(h.q('#ml-dataset-select').value,'example-chr1');assert.equal(h.q('#ml-run-recorded--loose [data-run-stage]'),null);
});

test('assignment failure keeps the original grouping and displays the server reason',async t=>{
 const row=base('recorded--loose',{dataset_id:null,association:{status:'unclassified',method:null},capabilities:{continue_analysis:false,stage_results:[],stage6_graph:false,assign_dataset:true}});
 const h=harness(t,[row],call=>call.options.method==='PATCH'?reply({error:'This record changed; refresh history.'},409):undefined);await h.ready();h.click('[data-nav-target="history"]');h.choose('#ml-history-scope','unclassified');
 h.choose('[data-history-assignment] [data-history-dataset]','dataset-b');h.click('[data-history-assign]');await until(()=>h.q('[data-history-assignment]').dataset.saveState==='error');
 assert.match(h.q('[data-history-assignment-status]').textContent,/record changed/);assert.equal(h.q('#ml-history-scope').value,'unclassified');assert.equal(h.q('[data-run-target="recorded--loose"]').hidden,false);
});

test('recorded scheduler and tool states are labeled as saved evidence, with starting unconfirmed',async t=>{
 const row=base('recorded--starting',{status:'starting',jobs:{genotype:{state:'running',settings:{mind:.1}}},operations:[{operation:'signet_run',status:'starting',executed:'unknown',inputs:{},settings:{},resources:{},settings_evidence:'not_recorded'}]});
 const h=harness(t,[row]);await h.ready();h.click('[data-nav-target="history"]');
 assert.match(h.q('[data-history-state]').textContent,/最後保存的狀態：執行是否開始待確認/);
 assert.match(h.q('[data-history-job="genotype"] [data-history-job-state]').textContent,/最後保存的狀態：執行中/);
 assert.match(h.q('[data-history-operation] [data-history-job-state]').textContent,/最後保存的狀態：執行是否開始待確認/);
 assert.equal(h.q('[data-run-stage]'),null);
 h.click('#ml-language');assert.match(h.q('[data-history-state]').textContent,/Last recorded state: Execution start unconfirmed/);
});

test('submission recovery reviews exact live attempt then explicitly confirms without submitting analysis',async t=>{
 const row=workspace();row.jobs.expression={state:'unknown',attempt:2,run_id:'shared',step:'expression'};
 const archived=archive();archived.jobs.expression={state:'unknown',attempt:2};
 const h=harness(t,[row,archived],call=>{
  if(!call.url.endsWith('/reconcile'))return;
  assert.equal(call.url,'/signet/runs/shared/steps/expression/reconcile');
  const applied=call.body.action==='adopt';
  if(applied)row.jobs.expression.state='submitted';
  return reply({record:{...row.jobs.expression,run_id:'shared',step:'expression'},applied,
    recovery:{outcome:'adopt',detail:'12345',evidence:{scheduler_checked:true,candidates:['12345']}}});
 });
 await h.ready();h.click('[data-nav-target="history"]');
 assert.equal(h.q('#ml-run-archive--shared [data-submission-recovery]'),null);
 const submit=value=>{const form=h.q('[data-submission-recovery]');form.dispatchEvent(new h.window.SubmitEvent('submit',
  {bubbles:true,cancelable:true,submitter:form.querySelector(`[value="${value}"]`)}));};
 assert.equal(h.q('[data-submission-recovery] [value="adopt"]'),null);
 submit('review');await until(()=>h.q('[data-submission-recovery] [value="adopt"]'));
 assert.deepEqual(h.calls.filter(c=>c.url.endsWith('/reconcile'))[0].body,
  {expected_attempt:2,expected_job_id:null,action:'review',confirmed:false});
 assert.match(h.q('[data-submission-recovery]').textContent,/12345/);
 submit('adopt');await until(()=>!h.q('[data-submission-recovery]'));
 assert.equal(h.calls.filter(c=>c.url.endsWith('/reconcile')).length,2);
 assert.equal(h.calls.filter(c=>c.options.method==='POST'&&!c.url.endsWith('/reconcile')).length,0);
});

test('ambiguous submission evidence displays explanation and never offers confirmation',async t=>{
 const row=workspace();row.jobs.expression={state:'unknown',attempt:1,run_id:'shared',step:'expression'};
 const h=harness(t,[row],call=>call.url.endsWith('/reconcile')?reply({record:row.jobs.expression,applied:false,
  recovery:{outcome:'unresolved',detail:'Two candidate jobs; do not resubmit.',evidence:{candidates:['1','2']}}}):undefined);
 await h.ready();h.click('[data-nav-target="history"]');
 const form=h.q('[data-submission-recovery]');form.dispatchEvent(new h.window.SubmitEvent('submit',
  {bubbles:true,cancelable:true,submitter:form.querySelector('[value="review"]')}));
 await until(()=>h.q('[data-submission-recovery]').textContent.includes('Two candidate'));
 assert.equal(h.q('[data-submission-recovery] [value="adopt"]'),null);
 assert.equal(h.q('[data-submission-recovery] [value="unsubmitted"]'),null);
 h.click('#ml-language');assert.match(h.q('[data-submission-recovery]').textContent,/Review submission evidence/);
});

test('changing remote context invalidates an in-flight recovery review',async t=>{
 const row=workspace();row.jobs.expression={state:'unknown',attempt:1,run_id:'shared',step:'expression'};let release;
 const h=harness(t,[row],call=>call.url.endsWith('/reconcile')?new Promise(resolve=>release=resolve):undefined);
 await h.ready();h.click('[data-nav-target="history"]');
 const form=h.q('[data-submission-recovery]');form.dispatchEvent(new h.window.SubmitEvent('submit',
  {bubbles:true,cancelable:true,submitter:form.querySelector('[value="review"]')}));
 h.window.dispatchEvent(new h.window.CustomEvent('workspace-remote-context',{detail:{identity:'different',connected:true}}));
 release(reply({record:row.jobs.expression,applied:false,recovery:{outcome:'adopt',detail:'foreign',evidence:{}}}));
 await settle();await settle();
 assert.equal(h.q('[data-submission-recovery] [value="adopt"]'),null);
 assert.equal(h.q('[data-submission-recovery]').textContent.includes('foreign'),false);
});

test('completed live stage forks only after review, then separately confirms submission', async t=>{
 const row=workspace('workspace--original');row.jobs={genotype:{state:'completed'}};
 const review={source_run_id:'original',step:'genotype',revision:'rev',reuse:['expression'],invalidated:['genotype','adjust','cis','network','visualize'],parameters:{inputs:{},settings:{mind:.1},resources:{cpus:4},options:{}}};
 const h=harness(t,[row],call=>{
  if(call.url==='/signet/runs/original/steps/genotype/rerun')return reply(call.options.method==='POST'?{...review,new_run_id:'original-rerun'}:review);
  if(call.url==='/signet/runs/original-rerun/rerun/submit')return reply({state:'submitted'},202);
 });
 await h.ready();h.click('[data-nav-target="history"]');h.click('[data-run-target="workspace--original"]');
 h.click('[data-rerun-review]');await until(()=>h.q('[data-rerun-create]'));
 assert.match(h.q('[data-rerun-content]').textContent,/adjust/);
 assert.equal(h.calls.filter(call=>call.options.method==='POST').length,0);
 h.click('[data-rerun-create]');await until(()=>h.q('[data-rerun-submit]'));
 const creation=h.calls.find(call=>call.options.method==='POST');assert.equal(creation.body.revision,'rev');
 assert.equal(h.calls.some(call=>call.url.endsWith('/rerun/submit')),false);
 h.click('[data-rerun-submit]');await until(()=>h.calls.some(call=>call.url.endsWith('/rerun/submit')));
 assert.deepEqual(h.calls.find(call=>call.url.endsWith('/rerun/submit')).body,{confirmed:true});
});

test('a saved unsubmitted linked run can resume explicit confirmation after reload',async t=>{
 const row=workspace('workspace--pending-fork');row.jobs={genotype:{state:'not_submitted'}};row.rerun={source_run_id:'original',step:'genotype'};
 const h=harness(t,[row],call=>call.url==='/signet/runs/pending-fork/rerun/submit'?reply({state:'submitted'},202):undefined);
 await h.ready();h.click('[data-nav-target="history"]');h.click('[data-run-target="workspace--pending-fork"]');
 assert.equal(h.calls.some(call=>call.url.endsWith('/rerun/submit')),false);
 h.click('[data-rerun-run-id="pending-fork"]');await until(()=>h.calls.some(call=>call.url.endsWith('/rerun/submit')));
 assert.deepEqual(h.calls.find(call=>call.url.endsWith('/rerun/submit')).body,{confirmed:true});
});


test('chat context reads current canonical selection without retaining another run or dataset',async t=>{
 const h=harness(t,[workspace(),archive()]);await h.ready();
 const snapshot=()=>{const detail={context:null};h.window.dispatchEvent(new h.window.CustomEvent('workspace-context-request',{detail}));return clone(detail.context)};
 h.click('[data-nav-target="history"]');
 h.click('[data-run-target="workspace--shared"]');h.click('#ml-run-workspace--shared [data-run-stage="6"]');
 await until(()=>h.q('#lens-stage6').dataset.runState==='ready');h.click('#lens-stage6 [data-gene="A"]');
 assert.deepEqual(snapshot(),{version:1,dataset_id:'example-chr1',history_id:'workspace--shared',stage:6,selected_genes:['A']});
 const old=snapshot();old.selected_genes.push('FOREIGN-CHAT');assert.deepEqual(snapshot().selected_genes,['A']);
 h.click('#ml-stage6-back');assert.equal(snapshot(),null);
 h.click('[data-run-target="archive--shared"]');h.click('#ml-run-archive--shared [data-run-stage="6"]');
 assert.deepEqual(snapshot().selected_genes,[]);
 await until(()=>h.q('#lens-stage6').dataset.historyId==='archive--shared');h.click('#lens-stage6 [data-gene="X"]');
 assert.equal(snapshot().history_id,'archive--shared');assert.deepEqual(snapshot().selected_genes,['X']);
 h.click('[data-nav-target="settings"]');assert.equal(snapshot(),null);
});


test('analysis chat context uses only the currently selected stage run from the current dataset',async t=>{
 const h=harness(t,[workspace()]);await h.ready();h.click('[data-nav-target="analysis"]');
 h.click('.ml-stage-button[data-stage="1"]');
 const snapshot=()=>{const detail={context:null};h.window.dispatchEvent(new h.window.CustomEvent('workspace-context-request',{detail}));return clone(detail.context)};
 h.q('#lens-stage1').dataset.genotypeRunId='shared';
 assert.equal(snapshot().history_id,'workspace--shared');assert.equal(snapshot().stage,1);
 h.choose('#ml-dataset-select','dataset-b');
 assert.equal(snapshot().dataset_id,'dataset-b');assert.equal(snapshot().history_id,null);
 assert.deepEqual(snapshot().selected_genes,[]);
});

test('model toolbar opens settings without submitting and removes unsupported controls',async t=>{
 const h=harness(t,[workspace()]);await h.ready();
 const button=h.q('#ml-open-model-settings');
 assert.equal(button.tagName,'BUTTON');assert.equal(button.type,'button');
 assert.equal(button.closest('[aria-hidden="true"]'),null);
 let opened=0,submitted=0;
 h.window.addEventListener('workspace-open-model-settings',()=>opened++);
 h.q('#ml-composer').addEventListener('submit',()=>submitted++);
 h.q('#ml-input').value='Keep this draft';button.click();
 assert.equal(opened,1);assert.equal(submitted,0);
 assert.equal(h.q('#ml-input').value,'Keep this draft');
 assert.equal(h.q('.ml-mention'),null);
 assert.equal(h.q('.ml-chip-icon'),null);
 assert.equal(h.q('.ml-chips').textContent.includes('Code Mode'),false);
 assert.equal(button.getAttribute('aria-label'),'模型設定');
 h.click('#ml-language');assert.equal(button.getAttribute('aria-label'),'Model settings');
});
