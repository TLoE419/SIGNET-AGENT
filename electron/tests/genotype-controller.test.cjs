'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const source=readFileSync(path.join(__dirname,'../renderer/features/workspace/genotype-run.js'),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
const example={id:'example-chr1',name:['範例','Example'],persisted:true,ready:true,inputs:{genotype:['study.ped','study.map'],expression:['example_gexp'],clinical:['official-demo-chr1-restart-clinical.tsv']}};
const dataset=(id='dataset-a')=>({id,name:[id,id],persisted:true,ready:true,inputs:{genotype:[`/pub/${id}/study.ped`,`/pub/${id}/study.map`],expression:[`/pub/${id}/expression.txt`],clinical:[`/pub/${id}/clinical.tsv`]}});
const settings={'restrict.tcga.geno':2,mind:.1,geno:.1,hwe:.0001,int:5000000};
const resources={cpus:4,mem_gb:16,hours:2};
const review=d=>({dataset_id:d.id,dataset_name:d.name,mode:'dataset',source_inputs:clone(d.inputs),source_files:[],reference_sources:{reference:'/pub/ref.vcf',genetic_map:'/pub/gmap',annotation:'/pub/genes.gtf'},review_token:'token-'+d.id,ready:true,issues:[],warnings:['Confirm expression scale and the final five rows.'],inputs:{'ped.file':d.inputs.genotype[0],'map.file':d.inputs.genotype[1],ref:'/pub/ref.vcf',gmap:'/pub/gmap'},settings,resources,limits:{cpus:[1,64],mem_gb:[1,128],hours:[.1,24]}});
const legacyReview=()=>({...review(example),inputs:{'ped.file':'/pub/prepared/study.ped','map.file':'/pub/prepared/study.map',ref:'/pub/prepared/ref/chr',gmap:'/pub/prepared/gmap/chr'},settings:{...settings,'restrict.tcga.geno':1}});
const job=(id,state='pending',inputs=review(dataset()).inputs)=>({run_id:id,step:'genotype',state,job_id:'123',inputs,settings,resources,history:[{state}],submitted_at:'2026-11-17T12:00:00Z'});
const response=value=>({ok:true,status:200,json:async()=>clone(value)});
const timeoutResponse=()=>({ok:false,status:504,json:async()=>({code:'read_timeout'})});
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
async function until(check){for(let i=0;i<50;i++){if(check())return;await settle()}assert.fail('Controller did not settle')}
function harness(t,handler){
 const dom=new JSDOM('<!doctype html><section id="panel"></section>',{url:'http://localhost',runScripts:'outside-only'});t.after(()=>dom.window.close());
 const {window}=dom,calls=[],changed=[];window.eval(source);const panel=window.document.querySelector('#panel');
 window.fetch=async(url,options={})=>{const call={url,options,body:options.body?JSON.parse(options.body):undefined};calls.push(call);return handler?handler(call):response(review(dataset()))};
 const controller=window.mountGenotypeRun({panel,token:'test-token',onHistoryChanged:(...args)=>changed.push(args)});
 const context=(d,runs=[])=>controller.setContext({datasetId:d.id,dataset:d,runs,visible:true});
 const remote=overrides=>window.dispatchEvent(new window.CustomEvent('workspace-remote-context',{detail:{connected:true,identity:'account@host|session',environmentKey:'root-a',...overrides}}));
 const q=selector=>panel.querySelector(selector),click=part=>q(`[data-genotype-${part}]`).click();
 const edit=(selector,value)=>{const field=q(selector);field.value=value;field.dispatchEvent(new window.Event('input',{bubbles:true}))};
 const acknowledge=()=>{const checkbox=q('[data-genotype-acknowledge]');checkbox.checked=true;checkbox.dispatchEvent(new window.Event('change',{bubbles:true}))};
 return {window,panel,calls,changed,controller,context,remote,q,click,edit,acknowledge};
}

test('Stage 1 can recheck the same dataset files after a timeout',async t=>{
 const d=dataset();let checks=0;
 const h=harness(t,()=>++checks===1?timeoutResponse():response(review(d)));
 h.remote();h.context(d);h.click('review');
 await until(()=>h.q('[data-genotype-review]').textContent==='Recheck files');
 assert.match(h.q('[data-genotype-readiness]').textContent,/Checking the remote files timed out/);
 assert.equal(h.q('[data-genotype-submit]').disabled,true);
 h.click('review');await until(()=>h.q('[data-genotype-form]').hidden===false);
 assert.equal(h.calls.length,2);assert.equal(h.calls[0].url,h.calls[1].url);
 assert.deepEqual(h.calls[0].body,h.calls[1].body);
 assert.ok(h.calls.every(call=>call.url.endsWith('/genotype/review')));
});

for (const [index,[step,mount]] of [
 ['expression','Expression'],['adjust','Adjustment'],['cis','Cis'],['network','Network'],['visualize','Visualization'],
].entries()) {
 test(`Stage ${index+2} can recheck files without submitting`,async t=>{
  let checks=0;
  const h=harness(t,()=>++checks===1?timeoutResponse():response({run_id:'same-run',ready:true,inputs:{},settings:{'restrict.tcga':1},options:{npc:2},resources,review_token:'a'.repeat(64)}));
  const controller=h.window[`mount${mount}Run`]({panel:h.panel,token:'test-token'});
  const jobs=Object.fromEntries(['genotype','expression','adjust','cis','network'].slice(0,index+1).map(name=>[name,{state:'completed'}]));
  controller.setContext({datasetId:'example-chr1',visible:true,runId:'same-run',runs:[{run_id:'same-run',jobs}]});
  const button=h.q(`[data-${step}-review]`);
  await until(()=>button.textContent==='Recheck files');
  assert.match(h.q(`[data-${step}-readiness]`).textContent,/Checking the remote files timed out/);
  assert.equal(h.q(`[data-${step}-submit]`).disabled,true);
  button.click();await until(()=>!button.disabled&&!h.q(`[data-${step}-submit]`).disabled);
  assert.equal(h.calls.length,2);
  assert.ok(h.calls.every(call=>call.url===`/signet/runs/same-run/${step}/example`&&!call.options.method));
 });
}

test('custom Stage 1 is manual and submits one acknowledged reviewed dataset snapshot',async t=>{
 const d={...dataset(),name:'Study cohort'};const h=harness(t,call=>response(call.url.endsWith('/review')?review(d):job(call.body.run_id)));
 h.remote();h.context(d);assert.equal(h.q('[data-genotype-dataset]').textContent,'Study cohort');
 assert.equal(h.calls.length,0);h.click('review');await until(()=>!h.q('[data-genotype-review]').disabled);
 assert.equal(h.calls[0].url,'/signet/datasets/dataset-a/genotype/review');assert.deepEqual(h.calls[0].body,{inputs:d.inputs});
 assert.equal(h.q('[data-genotype-input="ref"]').textContent,'/pub/ref.vcf');assert.equal(h.q('[data-genotype-setting="restrict.tcga.geno"]').value,'2');
 assert.match(h.q('[data-genotype-source-input="clinical"]').textContent,/dataset-a\/clinical/);assert.equal(h.q('[data-genotype-submit]').disabled,true);
 h.acknowledge();assert.equal(h.q('[data-genotype-submit]').disabled,false);h.click('submit');h.click('submit');
 await until(()=>h.panel.dataset.genotypeState==='pending');assert.equal(h.calls.length,2);
 assert.equal(h.calls[1].url,'/signet/datasets/dataset-a/genotype');assert.match(h.calls[1].body.run_id,/^analysis-/);
 assert.equal(h.calls[1].body.review_token,'token-dataset-a');assert.equal(h.calls[1].body.acknowledge_warnings,true);assert.deepEqual(h.calls[1].body.settings,settings);
 assert.deepEqual(h.changed[0],[h.calls[1].body.run_id,'dataset-a']);
});

test('only the exact original example and explicit nonpersisted fallback auto-use legacy review',async t=>{
 const h=harness(t,()=>response(legacyReview()));h.context(example);await until(()=>h.calls.length===1&&!h.q('[data-genotype-submit]').disabled);
 assert.equal(h.q('[data-genotype-dataset]').textContent,'Example');
 assert.equal(h.calls[0].url,'/signet/genotype/example');assert.equal(h.calls[0].options.method,undefined);assert.match(h.q('[data-genotype-input="ref"]').textContent,/chr1\.gen$/);
 const changed=clone(example);changed.inputs.clinical=['/pub/new.tsv'];h.context(changed);assert.equal(h.calls.length,1);assert.equal(h.q('[data-genotype-submit]').disabled,true);
 const fallback={...clone(example),persisted:false,inputs:{genotype:['study.ped','study.map'],expression:[],clinical:[]}};
 h.context(fallback);await until(()=>h.calls.length===2&&!h.q('[data-genotype-review]').disabled);assert.equal(h.calls[1].url,'/signet/genotype/example');
});

test('reference overrides route the example to manual dataset review and invalidate a stale review',async t=>{
 const selected={...clone(example),references:{gtf:'/pub/first.gtf'}};
 const result=review(selected);result.reference_sources.annotation='/pub/first.gtf';result.reference_choices=selected.references;
 const h=harness(t,()=>response(result));
 h.remote();h.context(selected);assert.equal(h.calls.length,0);
 h.click('review');await until(()=>!h.q('[data-genotype-form]').hidden);
 assert.equal(h.calls[0].url,'/signet/datasets/example-chr1/genotype/review');
 assert.match(h.q('[data-genotype-source-input="annotation"]').textContent,/first\.gtf/);
 h.acknowledge();assert.equal(h.q('[data-genotype-submit]').disabled,false);
 h.context({...selected,references:{gtf:'/pub/replaced.gtf'}});
 assert.equal(h.q('[data-genotype-submit]').disabled,true);
 assert.equal(h.q('[data-genotype-form]').hidden,true);
 assert.equal(h.calls.length,1,'changing a reference must not run or recheck by itself');
});

test('an unavailable dataset catalog blocks new legacy review and submission',async t=>{
 const h=harness(t,()=>response(legacyReview()));const unavailable={...clone(example),ready:false};
 h.context(unavailable);h.click('review');h.click('submit');await settle();assert.equal(h.calls.length,0);assert.equal(h.q('[data-genotype-submit]').disabled,true);
 h.context(example);await until(()=>!h.q('[data-genotype-submit]').disabled);assert.equal(h.calls.length,1);
 h.context(unavailable);assert.equal(h.q('[data-genotype-submit]').disabled,true);h.click('submit');await settle();assert.equal(h.calls.length,1);
});

test('drafts and confirmation belong to their own dataset and changed inputs invalidate only the draft',async t=>{
 const a=dataset(),b=dataset('dataset-b');const h=harness(t,call=>response(review(call.url.includes('dataset-b')?b:a)));
 h.remote();h.context(a);h.click('review');await until(()=>!!h.q('[data-genotype-setting="mind"]').value);h.edit('[data-genotype-setting="mind"]','0.07');h.acknowledge();
 h.context(b);assert.equal(h.q('[data-genotype-form]').hidden,true);h.click('review');await until(()=>!h.q('[data-genotype-review]').disabled);h.edit('[data-genotype-setting="mind"]','0.2');
 h.context(a);assert.equal(h.q('[data-genotype-setting="mind"]').value,'0.07');assert.equal(h.q('[data-genotype-acknowledge]').checked,true);
 h.remote();assert.equal(h.q('[data-genotype-acknowledge]').checked,true,'identical context events must preserve a review');
 const edited=clone(a);edited.inputs.expression=['/pub/new-expression.txt'];h.context(edited);assert.equal(h.q('[data-genotype-form]').hidden,true);assert.equal(h.q('[data-genotype-acknowledge]').checked,false);assert.equal(h.calls.length,2);
});

test('an old dataset review cannot render after a dataset or account switch',async t=>{
 let release;const a=dataset(),b=dataset('dataset-b');const h=harness(t,()=>new Promise(resolve=>release=resolve));
 h.remote();h.context(a);h.click('review');assert.equal(h.calls.length,1);h.context(b);assert.equal(h.calls[0].options.signal.aborted,true);
 release(response(review(a)));await settle();assert.equal(h.panel.dataset.genotypeDatasetId,'dataset-b');assert.equal(h.q('[data-genotype-form]').hidden,true);
 h.click('review');const second=release;h.remote({identity:'other@host|session'});assert.equal(h.calls[1].options.signal.aborted,true);second(response(review(b)));await settle();assert.equal(h.q('[data-genotype-submit]').disabled,true);
});

test('submission completion stays with its captured dataset and preserves its frozen files',async t=>{
 const a=dataset(),b=dataset('dataset-b');let release;
 const h=harness(t,call=>call.url.endsWith('/review')?response(review(a)):new Promise(resolve=>release=resolve));
 h.remote();h.context(a);h.click('review');await until(()=>!h.q('[data-genotype-review]').disabled);h.acknowledge();h.click('submit');
 const runId=h.panel.dataset.genotypeRunId;h.context(b);release(response(job(runId)));await settle();
 assert.equal(h.panel.dataset.genotypeDatasetId,'dataset-b');assert.equal(h.panel.dataset.genotypeRunId,undefined);
 const edited=clone(a);edited.inputs.expression=['/pub/later.txt'];h.context(edited);assert.equal(h.panel.dataset.genotypeRunId,runId);assert.equal(h.panel.dataset.genotypeState,'pending');
 assert.match(h.q('[data-genotype-source-input="expression"]').textContent,/dataset-a\/expression/);assert.equal(h.q('[data-genotype-source-input="expression"]').textContent.includes('later.txt'),false);
});

test('restored runs and new-run drafts are scoped to the selected dataset',async t=>{
 const a=dataset(),b=dataset('dataset-b');const h=harness(t);
 const run=(d,id)=>({run_id:id,dataset_id:d.id,input_mode:'dataset',inputs:d.inputs,jobs:{genotype:job(id,'completed')}});
 h.remote();h.context(a,[run(a,'run-a')]);assert.equal(h.panel.dataset.genotypeRunId,'run-a');
 h.context(b,[run(b,'run-b')]);assert.equal(h.panel.dataset.genotypeRunId,'run-b');h.click('new');assert.equal(h.panel.dataset.genotypeRunId,undefined);assert.equal(h.calls.length,0);
 h.context(b,[run(b,'run-b')]);assert.equal(h.panel.dataset.genotypeRunId,undefined,'history polling must not undo Prepare a new run');h.context(a,[run(a,'run-a')]);assert.equal(h.panel.dataset.genotypeRunId,'run-a');
});

test('restoring a submitted run clears obsolete input-review warnings',t=>{
 const d=dataset(),edited=clone(d),h=harness(t);h.remote();h.context(d);
 edited.inputs.clinical=['/pub/changed-clinical.tsv'];h.context(edited);
 assert.equal(h.q('[data-genotype-notice]').hidden,false);
 h.context(edited,[{run_id:'saved-run',dataset_id:d.id,input_mode:'dataset',inputs:d.inputs,jobs:{genotype:job('saved-run','completed')}}]);
 assert.equal(h.panel.dataset.genotypeState,'completed');assert.equal(h.q('[data-genotype-notice]').hidden,true);
});

test('a delayed status response cannot replace a newer completed history snapshot',async t=>{
 const d=dataset();let release;const h=harness(t,()=>new Promise(resolve=>release=resolve));
 const run=record=>({run_id:'existing',dataset_id:d.id,input_mode:'dataset',inputs:d.inputs,jobs:{genotype:record}});
 h.remote();h.context(d,[run(job('existing'))]);assert.equal(h.calls.length,1);
 h.context(d,[run({...job('existing','completed'),finished_at:'2026-11-17T13:00:00Z'})]);assert.equal(h.panel.dataset.genotypeState,'completed');
 release(response(job('existing')));await settle();assert.equal(h.panel.dataset.genotypeState,'completed');
});

test('a retired status request cannot unlock a new run status request',async t=>{
 const d=dataset();let oldRelease,newRelease;
 const h=harness(t,call=>{
  if(call.url.endsWith('/review'))return response(review(d));
  if(call.body?.run_id)return response(job(call.body.run_id));
  return new Promise(resolve=>{if(call.url.includes('/existing/'))oldRelease=resolve;else newRelease=resolve});
 });
 const run=record=>({run_id:'existing',dataset_id:d.id,input_mode:'dataset',inputs:d.inputs,jobs:{genotype:record}});
 h.remote();h.context(d,[run(job('existing'))]);h.context(d,[run({...job('existing','completed'),finished_at:'2026-11-17T13:00:00Z'})]);
 h.click('new');h.click('review');await until(()=>!h.q('[data-genotype-review]').disabled);h.acknowledge();h.click('submit');
 await until(()=>h.panel.dataset.genotypeState==='pending');const newId=h.panel.dataset.genotypeRunId;
 h.click('refresh');assert.equal(h.q('[data-genotype-refresh]').disabled,true);
 oldRelease(response(job('existing')));await settle();assert.equal(h.panel.dataset.genotypeRunId,newId);assert.equal(h.q('[data-genotype-refresh]').disabled,true);
 newRelease(response({...job(newId,'completed'),finished_at:'2026-11-17T14:00:00Z'}));await until(()=>h.panel.dataset.genotypeState==='completed');
});

test('a not-ready review or stale token refusal cannot enable a custom submission',async t=>{
 const d=dataset();let ready=false;const h=harness(t,call=>call.url.endsWith('/review')?response({...review(d),ready,issues:ready?[]:['Reference data is unavailable.']}):{ok:false,status:409,json:async()=>({error:'The source files changed.'})});
 h.remote();h.context(d);h.click('review');await until(()=>!h.q('[data-genotype-review]').disabled);h.acknowledge();assert.equal(h.q('[data-genotype-submit]').disabled,true);assert.match(h.q('[data-genotype-notice]').textContent,/Reference data/);
 ready=true;h.click('review');await until(()=>!h.q('[data-genotype-review]').disabled);assert.equal(h.q('[data-genotype-acknowledge]').checked,false);h.acknowledge();h.click('submit');await until(()=>h.panel.dataset.genotypeRunId===undefined);assert.equal(h.q('[data-genotype-submit]').disabled,true);assert.match(h.q('[data-genotype-notice]').textContent,/source files changed/);
});

test('custom Stage 3 confirms its frozen clinical path without sending an inline override',async t=>{
 const h=harness(t);const calls=[];h.window.fetch=async(url,options={})=>{calls.push({url,body:options.body?JSON.parse(options.body):null});return response({ready:true,frozen:true,inputs:{'cli.file':'/run/frozen/clinical.tsv'},options:{npc:3},resources,limits:{}})};
 const adjust=h.window.mountAdjustmentRun({panel:h.panel,token:'test-token'});
 adjust.setContext({datasetId:'dataset-a',visible:true,runs:[{run_id:'custom-run',input_mode:'dataset',frozen_inputs:{clinical:['/run/frozen/clinical.tsv']},jobs:{genotype:{state:'completed'},expression:{state:'completed'}}}]});
 await until(()=>calls.length===1&&!h.q('[data-adjust-review]').disabled);
 const clinical=h.q('[data-adjust-input="cli.file"]');assert.equal(clinical.readOnly,true);assert.equal(clinical.value,'/run/frozen/clinical.tsv');
 clinical.value='/pub/unrelated.tsv';clinical.dispatchEvent(new h.window.Event('input',{bubbles:true}));h.q('[data-adjust-review]').click();await until(()=>calls.length===2&&!h.q('[data-adjust-review]').disabled);
 assert.equal(calls[1].url,'/signet/runs/custom-run/adjust/example');assert.equal(clinical.value,'/run/frozen/clinical.tsv');
});

test('Stage 2 chromosome bounds follow each reviewed run while remaining readonly',async t=>{
 const h=harness(t);h.window.fetch=async url=>response({ready:true,inputs:{'gexp.file':'/run/expression.txt','pmap.file':'/run/genes.gtf'},settings:{'restrict.tcga':url.includes('run-two')?2:1},resources,limits:{}});
 const expression=h.window.mountExpressionRun({panel:h.panel,token:'test-token'});
 const run=id=>({run_id:id,input_mode:'dataset',jobs:{genotype:{state:'completed'}}});
 const context=id=>expression.setContext({datasetId:'dataset-a',visible:true,runId:id,runs:[run('run-two'),run('run-one')]});
 context('run-two');await until(()=>!h.q('[data-expression-review]').disabled);
 const chromosome=h.q('[data-expression-setting="restrict.tcga"]');assert.equal(chromosome.value,'2');assert.equal(chromosome.min,'2');assert.equal(chromosome.max,'2');assert.equal(chromosome.readOnly,true);
 context('run-one');await until(()=>!h.q('[data-expression-review]').disabled);assert.equal(chromosome.value,'1');assert.equal(chromosome.min,'1');assert.equal(chromosome.max,'1');
 context('run-two');assert.equal(chromosome.value,'2');assert.equal(chromosome.min,'2');assert.equal(chromosome.max,'2');
});
