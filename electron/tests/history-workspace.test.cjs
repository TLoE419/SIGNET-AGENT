'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const folder=path.join(__dirname,'../renderer/features/workspace');
const html=readFileSync(path.join(folder,'index.html'),'utf8');
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
function harness(t,rows,handler,initialChat={}){
 const dom=new JSDOM(html.replace('__INITIAL_CHAT__',JSON.stringify(initialChat)),{url:'http://localhost',runScripts:'outside-only',pretendToBeVisual:true});t.after(async()=>{await settle();await settle();dom.window.close()});
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
 assert.equal(detail.hidden,false);assert.equal(detail.querySelectorAll('[data-run-stage]').length,0);assert.match(detail.querySelector('[data-history-state]').textContent,/execution not recorded/);
 assert.match(detail.querySelector('[data-settings-evidence]').textContent,/execution not implied/);assert.match(detail.querySelector('[data-history-saved="settings"]').textContent,/npc7/);
 assert.match(detail.querySelector('[data-history-saved="inputs"]').textContent,/old\/expression/);assert.equal(h.contexts.expression.runs.length,0);
 h.choose('#ml-history-scope','all');assert.equal([...h.window.document.querySelectorAll('[data-run-target]')].filter(row=>!row.hidden).length,4);
 h.click('[data-run-target="recorded--retired"]');assert.match(h.q('#ml-run-recorded--retired [data-history-association]').textContent,/retired-dataset/);
 assert.equal([...h.q('#ml-dataset-select').options].some(option=>option.value==='retired-dataset'),false);
});

test('frozen input paths are visible immediately and use the saved run instead of dataset defaults', async t => {
 const saved = archive();
 saved.inputs = {genotype:['/frozen/cohort A/study.ped','/frozen/cohort A/study.map'],
  expression:['/frozen/expression & <version>.tsv'],clinical:['/frozen/clinical.tsv']};
 saved.reference_sources = {annotation:'/frozen/annotation.gtf'};
 const h = harness(t, [saved]);
 await h.ready();
 h.click('[data-nav-target="history"]');
 h.click('[data-run-target="archive--shared"]');
 const inputs = h.q('#ml-run-archive--shared dl.ml-run-inputs');
 assert.ok(inputs);
 assert.equal(inputs.closest('[hidden], details'), null);
 assert.deepEqual([...inputs.querySelectorAll('code')].map(file => file.textContent),
  [...Object.values(saved.inputs).flat(), saved.reference_sources.annotation]);
 assert.equal(inputs.querySelector('version'), null);
});

test('history shows saved clock times without their zone suffixes', async t => {
 const run = archive();
 run.submitted_at = '2026-11-16T09:20:00-0800';
 run.finished_at = '2026-11-16T13:41:00-08:00';
 const h = harness(t, [run]);
 await h.ready();
 h.click('[data-nav-target="history"]');
 h.click('[data-run-target="archive--shared"]');
 const listTime = h.q('[data-run-target="archive--shared"] time');
 assert.equal(listTime.textContent, '2026-11-16 09:20:00');
 assert.equal(listTime.dateTime, run.submitted_at);
 const times = [...h.q('.ml-history-overview').querySelectorAll('time')];
 assert.deepEqual(times.map(time => time.textContent), ['2026-11-16 09:20:00', '2026-11-16 13:41:00']);
 assert.deepEqual(times.map(time => time.dateTime), [run.submitted_at, run.finished_at]);
});

test('same canonical run IDs retain independent graph sources and selections',async t=>{
 const h=harness(t,[workspace(),archive()]);await h.ready();h.click('[data-nav-target="history"]');
 const archivedTimeline=h.q('#ml-run-archive--shared .ml-history-stage-workspace');
 assert.equal(archivedTimeline.querySelectorAll('[data-history-select-stage]').length,6);
 assert.deepEqual([...archivedTimeline.querySelectorAll('[data-run-stage]')].map(button=>button.dataset.runStage),['1','6']);
 assert.equal(h.q('#ml-history-scope-note').textContent,'2 runs');
 h.click('[data-run-target="workspace--shared"]');h.click('#ml-run-workspace--shared [data-history-select-stage="6"]');
 assert.equal(h.q('#ml-run-workspace--shared [data-history-stage-panel="6"]').hidden,false);
 assert.equal(h.q('#ml-run-workspace--shared [data-history-stage-panel="1"]').hidden,true);
 h.click('#ml-run-workspace--shared [data-run-stage="6"]');await until(()=>h.q('#lens-stage6').dataset.runState==='ready');
 assert.equal(h.q('#lens-stage6').dataset.historyId,'workspace--shared');h.click('#lens-stage6 [data-gene="A"]');
 h.click('#ml-stage6-back');h.click('[data-run-target="archive--shared"]');h.click('#ml-run-archive--shared [data-history-select-stage="6"]');
 h.click('#ml-run-archive--shared [data-run-stage="6"]');await until(()=>h.q('#lens-stage6').dataset.historyId==='archive--shared');
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

test('a saved result timeout explains the retry and reopens the same run and stage',async t=>{
 const requests=[];
 const h=harness(t,[workspace()],call=>{
  if(!call.url.startsWith('/stage/results?'))return;
  requests.push(call);
  if(requests.length===1)return reply({error:'Reading the saved result files on HPC3 timed out.'},504);
  return reply({run_id:'shared',stage:1,job:{state:'completed'},summary:{samples:2,variants:3,nonzero_bins:[0,0,0,0,0,3],genotype_codes:[2,2,2]}});
 });
 await h.ready();h.click('[data-nav-target="history"]');
 h.click('[data-run-target="workspace--shared"]');h.click('#ml-run-workspace--shared [data-run-stage="1"]');
 await until(()=>h.q('#lens-history-stage').dataset.runState==='timeout');
 assert.match(h.q('[data-stage-status]').textContent,/Reading the results timed out/);
 assert.equal(h.q('#ml-archive-stage-retry').hidden,false);h.click('#ml-archive-stage-retry');
 await until(()=>h.q('#lens-history-stage').dataset.runState==='ready');
 assert.equal(h.q('#ml-archive-stage-retry').hidden,true);
 assert.equal(requests.length,2);
 assert.ok(requests.every(call=>call.url===requests[0].url&&!call.options.method));
});

test('manual assignment uses source-scoped revision and remains honest after switching scope',async t=>{
 const row=base('recorded--loose',{dataset_id:null,association:{status:'unclassified',method:null},capabilities:{continue_analysis:false,stage_results:[],stage6_graph:false,assign_dataset:true}});let release;
 const h=harness(t,[row],call=>call.options.method==='PATCH'?new Promise(resolve=>release=resolve):undefined);await h.ready();h.click('[data-nav-target="history"]');h.choose('#ml-history-scope','unclassified');
 h.choose('[data-history-assignment="recorded--loose"] [data-history-dataset]','dataset-b');h.click('[data-history-assignment="recorded--loose"] [data-history-assign]');
 assert.equal(h.q('[data-history-assignment="recorded--loose"]').dataset.saveState,'saving');h.click('[data-history-assignment="recorded--loose"] [data-history-assign]');
 const saves=h.calls.filter(call=>call.options.method==='PATCH');assert.equal(saves.length,1);assert.equal(saves[0].url,'/signet/history/recorded--loose/dataset');assert.deepEqual(saves[0].body,{dataset_id:'dataset-b',revision:row.revision});
 h.choose('#ml-history-scope','all');release(reply({...row,dataset_id:'dataset-b',revision:'next',association:{status:'manual',method:'manual'}}));await until(()=>h.q('[data-history-assignment="recorded--loose"]').dataset.saveState==='saved');
 assert.match(h.q('#ml-run-recorded--loose [data-history-association]').textContent,/does not verify sample/);assert.equal(h.q('#ml-dataset-select').value,'example-chr1');assert.equal(h.q('#ml-run-recorded--loose [data-run-stage]'),null);
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
 assert.match(h.q('[data-history-state]').textContent,/Last recorded state: Execution start unconfirmed/);
 assert.match(h.q('[data-history-job="genotype"] [data-history-job-state]').textContent,/Last recorded state: Running/);
 assert.match(h.q('[data-history-operation] [data-history-job-state]').textContent,/Last recorded state: Execution start unconfirmed/);
 assert.equal(h.q('[data-run-stage]'),null);
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
 assert.equal(h.q('#ml-run-workspace--shared').hidden,false);
 assert.deepEqual(h.calls.filter(c=>c.url.endsWith('/reconcile'))[0].body,
  {expected_attempt:2,expected_job_id:null,action:'review',confirmed:false});
 assert.match(h.q('[data-submission-recovery]').textContent,/12345/);
 submit('adopt');await until(()=>!h.q('[data-submission-recovery]'));
 assert.equal(h.calls.filter(c=>c.url.endsWith('/reconcile')).length,2);
 assert.equal(h.calls.filter(c=>c.options.method==='POST'&&!c.url.endsWith('/reconcile')).length,0);
});

test('linked rerun review renders translated parameter fields without creating a run',async t=>{
 const row=workspace();
 const h=harness(t,[row],call=>call.url.endsWith('/genotype/rerun')?reply({
  reuse:[],invalidated:['genotype','expression'],parameters:{settings:{mind:.1,'<custom>':'0.7'},resources:{cpus:4}},
 }):undefined);
 await h.ready();h.click('[data-nav-target="history"]');h.click('[data-rerun-review="genotype"]');
 await until(()=>h.q('[data-rerun-editor]'));
 const editor=h.q('[data-rerun-editor]');
 const label=key=>editor.querySelector(`[data-rerun-field="${key}"]`).closest('label').textContent;
 assert.equal(label('mind'),'Max. sample missingness');assert.equal(label('<custom>'),'<custom>');
 assert.equal(editor.getAttribute('aria-label'),'Linked run parameters');
 assert.equal(editor.querySelector('[data-rerun-name]').checkValidity(),true);
 assert.equal(label('mind'),'Max. sample missingness');
 assert.ok(h.calls.every(call=>!call.options.method||call.options.method==='GET'));
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
 assert.match(h.q('[data-submission-recovery]').textContent,/Review submission evidence/);
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
 assert.equal(h.q('[data-rerun-parameters]'),null,'Researchers edit labelled fields instead of raw parameter objects');
 const missingness=h.q('[data-rerun-group="settings"][data-rerun-field="mind"]');
 assert.match(missingness.closest('label').textContent,/Max\. sample missingness/);missingness.value='0.2';
 assert.equal(h.calls.filter(call=>call.options.method==='POST').length,0);
 h.click('[data-rerun-create]');await until(()=>h.q('[data-rerun-submit]'));
 const creation=h.calls.find(call=>call.options.method==='POST');assert.equal(creation.body.revision,'rev');
 assert.equal(creation.body.parameters.settings.mind,0.2);assert.equal(review.parameters.settings.mind,0.1);
 assert.equal(h.calls.some(call=>call.url.endsWith('/rerun/submit')),false);
 h.click('[data-rerun-submit]');await until(()=>h.calls.some(call=>call.url.endsWith('/rerun/submit')));
 assert.deepEqual(h.calls.find(call=>call.url.endsWith('/rerun/submit')).body,{confirmed:true});
});

test('a saved unsubmitted linked run can resume explicit confirmation after reload',async t=>{
 const row=workspace('workspace--pending-fork');row.jobs={genotype:{state:'not_submitted'}};row.rerun={source_run_id:'original',step:'genotype'};
 const h=harness(t,[row],call=>call.url==='/signet/runs/pending-fork/rerun/submit'?reply({state:'submitted'},202):undefined);
 await h.ready();h.click('[data-nav-target="history"]');h.click('[data-run-target="workspace--pending-fork"]');
 h.click('[data-rerun-run-id="pending-fork"]');await until(()=>h.calls.some(call=>call.url.endsWith('/rerun/submit')));
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

const activeTranscript='#ml-chat-transcripts > div:not([hidden])';
const messageBy=sender=>`${activeTranscript} .ml-chat-message[data-chat-sender="${sender}"]`;
const authorBy=sender=>`${messageBy(sender)} > .ml-chat-author`;

for (const terminal of [
 {type:'answer',text:'Check the **sample labels**.'},
 {type:'error',text:'The assistant could not reply.'},
 {type:'done',status:'completed',text:''},
]) {
 test(`chat waiting dots clear on ${terminal.type} and stay out of the saved conversation`,async t=>{
  let stream;
  const body=new ReadableStream({start(controller){stream=controller}});
  const h=harness(t,[workspace()],({url})=>{
   if(url==='/chat')return {ok:true,body};
   if(url.startsWith('/bootstrap?'))return reply({initial:{}});
  });
  await h.ready();
  h.window.TextDecoder=TextDecoder;
  h.window.eval(readFileSync(path.join(folder,'../chat/markdown.js'),'utf8'));
  const send=h.q('#ml-send');
  const status=h.q('#ml-chat-status');
  const thinking=()=>h.q(`${messageBy('assistant')} .ml-thinking`);
  const emit=event=>stream.enqueue(Buffer.from(JSON.stringify(event)+'\n'));

  assert.equal(thinking(),null);
  h.q('#ml-input').value='What should I check?';
  send.click();
  assert.ok(send.disabled);
  assert.match(h.q(`${messageBy('user')} .ml-message`).textContent,/What should I check\?/);
  assert.equal(h.q(authorBy('user')).textContent,'You');
  assert.equal(h.q(authorBy('assistant')).textContent,'Agent');
  assert.ok(h.q(`${authorBy('assistant')} [data-lucide="bot"][aria-hidden="true"]`));
  assert.equal(h.q(`${authorBy('user')} [data-lucide]`),null);
  assert.equal(thinking()?.getAttribute('aria-hidden'),'true');
  assert.deepEqual([...thinking().children].map(dot=>dot.tagName),['SPAN','SPAN','SPAN']);
  assert.equal(status.closest('[aria-live]').getAttribute('aria-live'),'polite');
  assert.match(status.textContent,/Waiting for SIGNET Agent/);
  assert.ok(thinking());

  emit(terminal);
  if(terminal.type!=='done'){
   await until(()=>!thinking());
   assert.ok(send.disabled,'The stream is still open after the first answer or error');
   emit({type:'done',status:terminal.type==='error'?'failed':'completed',text:''});
  }
  stream.close();
  await until(()=>!send.disabled);
  assert.equal(thinking(),null);
  if(terminal.type==='answer')assert.equal(h.q(`${messageBy('assistant')} .ml-live-reply strong`).textContent,'sample labels');
  if(terminal.type==='error')assert.match(h.q(messageBy('assistant')).textContent,/The assistant could not reply/);
  if(terminal.type==='done')assert.equal(h.q(messageBy('assistant')),null);

  const recordId=h.q(activeTranscript).id;
  h.click('#ml-new');
  h.click('#ml-chat-list-toggle');
  h.click(`#ml-chat-records [aria-controls="${recordId}"]`);
  await until(()=>h.q(activeTranscript).id===recordId&&!send.disabled);
  assert.equal(h.q('#ml-chat-transcripts .ml-thinking'),null);
  assert.equal(h.q(authorBy('user')).textContent,'You');
  assert.equal(h.q(authorBy('assistant'))?.textContent,terminal.type==='done'?undefined:'Agent');
 });
}

test('saved chat responses load the same sender labels as live responses',async t=>{
 const session='saved-conversation';
 const messages=[{role:'user',text:'A saved question'},{role:'assistant',text:'A saved **response**'}];
 const h=harness(t,[workspace()],({url})=>{
  if(url===`/bootstrap?session=${session}`)return reply({initial:{messages}});
 },{sessions:[{session,title:'Saved conversation'}]});
 await h.ready();
 h.window.eval(readFileSync(path.join(folder,'../chat/markdown.js'),'utf8'));
 h.click('#ml-chat-list-toggle');
 h.click('#ml-chat-records button');
 await until(()=>h.q(`${messageBy('assistant')} .ml-live-reply strong`));
 assert.equal(h.q(`${messageBy('user')} .ml-message`).textContent,'A saved question');
 assert.equal(h.q(authorBy('user')).textContent,'You');
 assert.equal(h.q(authorBy('assistant')).textContent,'Agent');
 assert.equal(h.q(`${messageBy('assistant')} .ml-live-reply strong`).textContent,'response');
 assert.ok(h.q(`${authorBy('assistant')} [data-lucide="bot"][aria-hidden="true"]`));
 assert.equal(h.q(`${activeTranscript} .ml-thinking`),null);
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
 assert.equal(button.getAttribute('aria-label'),'Model settings');
});
