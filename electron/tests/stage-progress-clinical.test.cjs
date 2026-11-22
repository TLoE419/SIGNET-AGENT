'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {JSDOM}=require('jsdom');
const source=readFileSync(require('node:path').join(__dirname,'../renderer/features/workspace/genotype-run.js'),'utf8');
const pause=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){for(let i=0;i<50;i++){if(check())return;await pause()}assert.fail('Stage controller did not settle')}
const resources={cpus:4,mem_gb:16,hours:2};
const token='a'.repeat(64);
const json=value=>({ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(value))});
function fixture(t){
 const dom=new JSDOM('<!doctype html><section id="stage"></section>',{url:'http://localhost',runScripts:'outside-only'});
 t.after(()=>dom.window.close());dom.window.eval(source);
 return {w:dom.window,panel:dom.window.document.querySelector('#stage')};
}

test('clinical choices need a fresh review and manual submission sends exactly the reviewed choices',async t=>{
 const {w,panel}=fixture(t),calls=[];
 w.fetch=async(url,options={})=>{
  const parsed=new URL(url,'http://localhost'),choices=JSON.parse(parsed.searchParams.get('choices')||'{}');
  calls.push({url,body:options.body?JSON.parse(options.body):null});
  if(options.method==='POST')return json({run_id:'clinical-run',step:'adjust',state:'pending',job_id:'900',inputs:{'cli.file':'/run/copy.tsv'},options:{npc:3},resources});
  return json({ready:choices.other==='exclude',review_token:choices.other==='exclude'?token:null,
   inputs:{'cli.file':'/pub/clinical.tsv'},options:{npc:3},resources,limits:{},issues:[],
   clinical:{rows:4,matched:4,clinical_matched:4,missing_race:0,missing_gender:0,retained:choices.other==='exclude'?3:4,excluded:choices.other==='exclude'?1:0,
    race:{asian:1,white:1,'black or african american':1,other:1},unrecognized_race:{other:1}}});
 };
 const controller=w.mountAdjustmentRun({panel,token:'page-token'});
 const q=selector=>panel.querySelector(selector);
 controller.setContext({datasetId:'dataset-a',visible:true,runs:[{run_id:'clinical-run',jobs:{genotype:{state:'completed'},expression:{state:'completed'}}}]});
 await until(()=>q('[data-adjust-clinical-choices] input'));
 assert.equal(q('[data-adjust-submit]').disabled,true);
 assert.match(q('[data-adjust-clinical-summary]').textContent,/completed Stage 1 and Stage 2 outputs/);
 assert.equal(q('[data-clinical-review-count="clinical_matched"]').textContent,'4');
 assert.equal(q('[data-clinical-review-count="missing_gender"]').textContent,'0');
 assert.equal(q('[data-adjust-clinical-choices] input:checked'),null,'unknown categories never receive a default decision');
 const excluded=q('[data-adjust-clinical-choices] input[value="exclude"]');
 excluded.checked=true;excluded.dispatchEvent(new w.Event('change',{bubbles:true}));
 assert.equal(calls.length,1,'a research choice never submits or checks remotely by itself');
 assert.equal(q('[data-adjust-submit]').disabled,true);
 q('[data-adjust-review]').click();await until(()=>!q('[data-adjust-submit]').disabled);
 assert.deepEqual(JSON.parse(new URL(calls[1].url,'http://localhost').searchParams.get('choices')),{other:'exclude'});
 assert.match(q('[data-adjust-clinical-summary]').textContent,/3 retained.*1 excluded/);
 q('[data-adjust-submit]').click();q('[data-adjust-submit]').click();
 await until(()=>panel.dataset.adjustState==='pending');
 const posts=calls.filter(call=>call.body);assert.equal(posts.length,1);
 assert.deepEqual(posts[0].body.choices,{other:'exclude'});assert.equal(posts[0].body.review_token,token);
 assert.equal(posts[0].body.options.npc,3);
});

test('missing gender shows a manual mapping or replacement and requires a fresh check',async t=>{
 const {w,panel}=fixture(t),calls=[],original='/run/frozen/clinical',replacement='/pub/corrected.tsv';
 const candidate='demographic.gender';
 w.fetch=async(url,options={})=>{
  const query=new URL(url,'http://localhost').searchParams;
  const path=query.get('clinical')||original,column=query.get('gender_column'),mapped=column===candidate;
  calls.push({query,body:options.body?JSON.parse(options.body):null});
  if(options.method==='POST')return json({run_id:'gender-run',step:'adjust',state:'completed',job_id:'901',options:{npc:3},resources});
  const ready=mapped||path===replacement;
  return json({ready,frozen:true,clinical_replacement_allowed:true,review_token:ready?token:null,
   inputs:{'cli.file':path},options:{npc:3},resources,limits:{},
   issues:ready?[]:['The clinical file needs one column named gender.'],
   clinical:{rows:4,matched:4,clinical_matched:ready?4:0,missing_columns:ready?[]:['gender'],
    gender_column_candidates:path===replacement?[]:[candidate],gender_column:mapped?candidate:null}});
 };
 const controller=w.mountAdjustmentRun({panel,token:'page-token'}),q=selector=>panel.querySelector(selector);
 controller.setContext({datasetId:'dataset-a',visible:true,runs:[{run_id:'gender-run',input_mode:'dataset',
  frozen_inputs:{clinical:[original]},jobs:{genotype:{state:'completed'},expression:{state:'completed'}}}]});
 const mapping=()=>q('[data-adjust-gender-column]');
 const choose=value=>{mapping().value=value;mapping().dispatchEvent(new w.Event('change',{bubbles:true}))};
 const submit=q('[data-adjust-submit]'),review=q('[data-adjust-review]');
 await until(()=>mapping());
 assert.equal(mapping().value,'');
 assert.equal(submit.disabled,true);
 assert.equal(q('[data-clinical-review-count="clinical_matched"]'),null,'zero is not a measured result after a schema error');
 q('[data-adjust-use-corrected-clinical]').click();
 assert.equal(w.document.activeElement,q('[data-adjust-input="cli.file"]'));
 choose(candidate);
 assert.equal(calls.length,1);
 assert.equal(submit.disabled,true);
 review.click();await until(()=>!submit.disabled);
 assert.equal(calls[1].query.get('gender_column'),candidate);
 assert.equal(mapping().value,candidate);
 choose('');
 assert.equal(submit.disabled,true,'changing the mapping invalidates the previous review');
 choose(candidate);
 review.click();await until(()=>!submit.disabled);
 submit.click();await until(()=>panel.dataset.adjustState==='completed');
 const [sent]=calls.filter(call=>call.body);
 assert.equal(sent.body.gender_column,candidate);
 assert.equal(sent.body.review_token,token);
});

test('all six stages switch from indeterminate to measured progress and stop on unconfirmed status',async t=>{
 const specs=[['Genotype','genotype','imputation','Imputation chunks'],
  ['Expression','expression','expression_outputs','Expression preparation'],
  ['Adjustment','adjust','variant_filter','Variant filtering'],
  ['Cis','cis','low_frequency','Low-frequency jobs'],
  ['Network','network','stage1','Network phase 1'],
  ['Visualization','visualize','subnetworks','Subnetwork exports']];
 for(const [factory,step,unit,label] of specs){
  const {w,panel}=fixture(t);
  const record={run_id:'progress-run',step,state:'running',job_id:'123',attempt:1,inputs:{},settings:{},options:{npc:3},resources,
   progress:{rare_variants:'9 3',invalid:'99 100'}};
  let reported=record;
  w.fetch=async()=>json(reported);
  const jobs=Object.fromEntries(['genotype','expression','adjust','cis','network'].map(name=>[name,{state:'completed'}]));jobs[step]=record;
  const controller=w['mount'+factory+'Run']({panel,token:'page-token'});
  const dataset={id:'dataset-a',name:['資料','Data'],ready:true,persisted:true,inputs:{genotype:[],expression:[],clinical:[]}};
  controller.setContext({datasetId:'dataset-a',dataset,runId:'progress-run',visible:true,runs:[{run_id:'progress-run',dataset_id:'dataset-a',source:'live',jobs}]});
  const refresh=panel.querySelector('[data-'+step+'-refresh]');
  await until(()=>panel.querySelector('progress')&&!refresh.disabled);
  const activity=panel.querySelector('progress');
  assert.equal(activity.hasAttribute('value'),false);
  assert.match(activity.getAttribute('aria-label'),/work counts are available/);
  reported={...record,progress:{...record.progress,[unit]:'2 5'}};
  refresh.click();
  await until(()=>panel.querySelector('progress[value="2"]')&&!refresh.disabled);
  const bar=panel.querySelector('progress');assert.equal(bar.value,2);assert.equal(bar.max,5);
  assert.equal(bar.getAttribute('aria-label'),label);
  assert.match(panel.querySelector('[data-'+step+'-work-progress]').textContent,/2 \/ 5/);
  assert.equal(panel.querySelectorAll('progress').length,1);
  reported={...record,connection:'interrupted'};
  refresh.click();
  await until(()=>panel.querySelector('[data-'+step+'-notice]').textContent.includes('Connection interrupted'));
  assert.equal(panel.querySelector('progress'),null);
 }
});

test('an empty continuation selection initializes every form without an exception',t=>{
 const {w,panel}=fixture(t);
 for(const name of ['Expression','Adjustment','Cis','Network','Visualization']){
  const controller=w['mount'+name+'Run']({panel,token:'page-token'});
  assert.doesNotThrow(()=>controller.setContext({datasetId:'dataset-a',visible:true,runs:[]}));
 }
});

test('reopening a completed Stage3 shows the saved clinical decision and counts',t=>{
 const {w,panel}=fixture(t);
 w.fetch=async()=>{throw Error('Completed clinical review must remain local')};
 const clinical={source:'/original/clinical.tsv',choices:{other:'exclude'},review:{rows:4,matched:4,retained:3,excluded:1,
  race:{other:1},unrecognized_race:{other:1}}};
 const controller=w.mountAdjustmentRun({panel,token:'page-token'});
 controller.setContext({datasetId:'dataset-a',visible:true,runs:[{run_id:'saved-review',jobs:{genotype:{state:'completed'},expression:{state:'completed'},
  adjust:{run_id:'saved-review',step:'adjust',state:'completed',inputs:{'cli.file':'/run/copy.tsv'},options:{npc:3},resources,clinical}}}]});
 assert.match(panel.querySelector('[data-adjust-clinical-summary]').textContent,/3 retained.*1 excluded/);
 const decision=panel.querySelector('[data-adjust-clinical-choices] input[value="exclude"]');
 assert.equal(decision.checked,true);assert.equal(decision.closest('fieldset').disabled,true);
 assert.equal(panel.querySelector('[data-adjust-submit]').hidden,true);
});

test('clinical review distinguishes unavailable counts from zero and renders private category text inertly',async t=>{
 const {w,panel}=fixture(t);
 const category='<img src=x onerror=alert(1)>';
 w.fetch=async()=>json({ready:false,inputs:{'cli.file':'/pub/clinical.tsv'},options:{npc:3},resources,limits:{},issues:[],
  clinical:{rows:5,matched:5,clinical_matched:4,missing_gender:1,race:{[category]:1},unrecognized_race:{[category]:1}}});
 const controller=w.mountAdjustmentRun({panel,token:'page-token'});
 controller.setContext({datasetId:'dataset-a',visible:true,runs:[{run_id:'private-clinical',jobs:{genotype:{state:'completed'},expression:{state:'completed'}}}]});
 await until(()=>panel.querySelector('[data-adjust-clinical-choices] input'));
 assert.match(panel.querySelector('[data-adjust-clinical-summary]').textContent,/— retained.*— excluded/);
 assert.equal(panel.querySelector('[data-clinical-review-count="missing_race"]').textContent,'—');
 assert.equal(panel.querySelector('[data-clinical-review-count="missing_gender"]').textContent,'1');
 assert.equal(panel.querySelector('img'),null);
 assert.match(panel.querySelector('[data-adjust-clinical-choices]').textContent,/<img src=x/);
 assert.equal(panel.querySelector('[data-adjust-submit]').disabled,true);
 assert.match(panel.querySelector('[data-adjust-clinical-summary]').textContent,/completed Stage 1 and Stage 2 outputs/);
});

test('an explicit replacement permission repairs frozen clinical input after fresh review without rerunning upstream',async t=>{
 const {w,panel}=fixture(t),calls=[];
 const original='/run/inputs/frozen/clinical',replacement='/pub/corrected-clinical.tsv';
 const source={run_id:'repair-clinical',input_mode:'dataset',frozen_inputs:{clinical:[original]},jobs:{genotype:{state:'completed'},expression:{state:'completed'}}};
 w.fetch=async(url,options={})=>{
  const parsed=new URL(url,'http://localhost'),selected=parsed.searchParams.get('clinical')||original;
  calls.push({url,body:options.body?JSON.parse(options.body):null});
  if(options.method==='POST')return json({run_id:source.run_id,step:'adjust',state:'pending',job_id:'901',inputs:{'cli.file':'/run/reviewed-clinical.tsv'},options:{npc:3},resources});
  return json({ready:selected===replacement,frozen:true,clinical_replacement_allowed:true,clinical_replacement:selected!==original,
   review_token:selected===replacement?token:null,inputs:{'cli.file':selected},options:{npc:3},resources,limits:{},
   issues:selected===replacement?[]:['Clinical columns need repair.'],
   clinical:{rows:4,matched:4,retained:4,excluded:0,choices:selected===replacement?{}:{old:'exclude'},
    missing_columns:selected===replacement?[]:['gender'],gender_column_candidates:[],
    unrecognized_race:selected===replacement?{}:{old:1}}});
 };
 const controller=w.mountAdjustmentRun({panel,token:'page-token'}),q=selector=>panel.querySelector(selector);
 controller.setContext({datasetId:'dataset-a',visible:true,runs:[source]});
 await until(()=>q('[data-adjust-input="cli.file"]').value===original&&!q('[data-adjust-review]').disabled);
 const clinical=q('[data-adjust-input="cli.file"]');
 assert.equal(clinical.readOnly,false);assert.equal(q('[data-adjust-submit]').disabled,true);
 assert.match(q('[data-adjust-clinical-replacement]').textContent,/reuses completed Stages 1 and 2/);
 assert.equal(q('[data-adjust-original-path]').textContent,original);
 assert.equal(q('[data-adjust-gender-column]'),null,'no mapping can be chosen without a suitable column');
 q('[data-adjust-use-corrected-clinical]').click();
 assert.equal(w.document.activeElement,clinical);
 clinical.value='/pub/corrected';clinical.dispatchEvent(new w.Event('input',{bubbles:true}));
 assert.equal(clinical.readOnly,false,'the first keystroke must not revoke the explicit edit permission');
 clinical.value=replacement;clinical.dispatchEvent(new w.Event('input',{bubbles:true}));
 assert.equal(calls.length,1,'editing a path cannot submit or check automatically');
 assert.equal(q('[data-adjust-clinical-choices] input'),null,'old category choices cannot apply to a replacement file');
 assert.equal(q('[data-adjust-submit]').disabled,true);
 q('[data-adjust-review]').click();await until(()=>!q('[data-adjust-submit]').disabled);
 const query=new URL(calls[1].url,'http://localhost').searchParams;
 assert.equal(query.get('clinical'),replacement);assert.equal(query.has('choices'),false);
 assert.equal(source.frozen_inputs.clinical[0],original,'the original frozen selection must remain unchanged');
 q('[data-adjust-submit]').click();await until(()=>panel.dataset.adjustState==='pending');
 const posts=calls.filter(call=>call.body);assert.equal(posts.length,1);
 assert.deepEqual(posts[0].body.inputs,{'cli.file':replacement});assert.deepEqual(posts[0].body.choices,{});
 assert.equal(posts[0].body.review_token,token);assert.equal(clinical.disabled,true);assert.equal(clinical.readOnly,true);
 assert.ok(calls.every(call=>call.url.includes('/adjust/')),'replacement cannot rerun Stages 1 or 2');
});

test('a rejected replacement remains editable but cannot reuse an old review token',async t=>{
 const {w,panel}=fixture(t);let rejected=false;
 w.fetch=async()=>rejected?{ok:false,status:400,json:async()=>({error:'The selected path is not allowed.'})}:json({ready:true,frozen:true,
  clinical_replacement_allowed:true,review_token:token,inputs:{'cli.file':'/run/frozen/clinical'},options:{npc:3},resources,limits:{}});
 const controller=w.mountAdjustmentRun({panel,token:'page-token'}),q=selector=>panel.querySelector(selector);
 controller.setContext({datasetId:'dataset-a',visible:true,runs:[{run_id:'repair-rejected',input_mode:'dataset',frozen_inputs:{clinical:['/run/frozen/clinical']},
  jobs:{genotype:{state:'completed'},expression:{state:'completed'}}}]});
 await until(()=>!q('[data-adjust-submit]').disabled);
 const clinical=q('[data-adjust-input="cli.file"]');clinical.value='/outside/not-allowed';clinical.dispatchEvent(new w.Event('input',{bubbles:true}));
 rejected=true;q('[data-adjust-review]').click();await until(()=>!q('[data-adjust-review]').disabled);
 assert.equal(clinical.readOnly,false);assert.equal(clinical.value,'/outside/not-allowed');
 assert.equal(q('[data-adjust-submit]').disabled,true);assert.match(panel.textContent,/selected path is not allowed/);
});

test('a failed Stage 3 submission keeps the replacement and the actual error',async t=>{
 const {w,panel}=fixture(t),calls=[];
 const original='/run/inputs/frozen/clinical',replacement='/project/refdata/repaired.tsv';
 const context={datasetId:'dataset',visible:true,runs:[{run_id:'stage3-copy-error',
  input_mode:'dataset',frozen_inputs:{clinical:[original]},jobs:{genotype:{state:'completed'},expression:{state:'completed'}}}]};
 let controller;
 w.fetch=async(url,options={})=>{
  const clinical=new URL(url,'http://localhost').searchParams.get('clinical')||original;
  calls.push({clinical,method:options.method});
  if(options.method==='POST')return {ok:false,status:412,json:async()=>({code:'not_ready',error:'The reviewed copy could not be prepared.'})};
  return json({ready:clinical===replacement,frozen:true,clinical_replacement_allowed:true,
   review_token:clinical===replacement?token:null,inputs:{'cli.file':clinical},options:{npc:3},resources,limits:{},
   issues:clinical===original?['The clinical file needs one column named gender.']:[]});
 };
 controller=w.mountAdjustmentRun({panel,token:'page-token',onHistoryChanged:()=>Promise.resolve().then(()=>controller.setContext(context))});
 const q=selector=>panel.querySelector(selector);
 controller.setContext(context);
 const path=q('[data-adjust-input="cli.file"]'),review=q('[data-adjust-review]'),submit=q('[data-adjust-submit]');
 await until(()=>path.value===original&&!review.disabled);
 path.value=replacement;path.dispatchEvent(new w.Event('input',{bubbles:true}));
 review.click();await until(()=>!submit.disabled);
 submit.click();await pause();
 assert.equal(path.value,replacement);
 assert.equal(path.readOnly,false);
 assert.equal(submit.disabled,true);
 assert.match(panel.textContent,/The reviewed copy could not be prepared/);
 assert.equal(calls.length,3,'do not replace the failure with an automatic review of the frozen file');
 review.click();await until(()=>!submit.disabled);
 assert.equal(calls.at(-1).clinical,replacement);
});
