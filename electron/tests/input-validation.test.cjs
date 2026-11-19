'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const directory=path.join(__dirname,'../renderer/features/workspace');
const inputs={genotype:['/pub/u/study.ped','/pub/u/study.map'],expression:['/pub/u/expression.txt'],clinical:['/pub/u/clinical.tsv']};
const clone=value=>JSON.parse(JSON.stringify(value));
const makeReport=(datasetId='dataset-a',files=inputs)=>({
 dataset_id:datasetId,inputs:clone(files),checked_at:'2026-11-17T22:00:00Z',status:'warning',read_only:true,executed:false,
 checks:['genotype','expression','clinical'].map(kind=>({id:kind+'_format',kind,label:kind,status:kind==='expression'?'warning':'passed',
  message:kind==='expression'?'Confirm expression scale and final five rows.':'Structure checked.',paths:files[kind],metrics:{samples:6},issues:[]})),
 pairing:{status:'passed',rule:'Third TCGA barcode component',genotype_patients:6,expression_patients:6,matched_patients:6,clinical_matched:6,unmatched_genotype:0,unmatched_expression:0,issues:[]},
 files:[],limits:{max_seconds:30},scope:'Structure and preliminary pairing only.',
});
function stagedReport() {
 const report=makeReport();
 report.files=Object.values(inputs).flat().map(path=>({path,complete:true,sha256:'a'.repeat(64),size:1,lines:1}));
 report.stage_readiness=Object.fromEntries(['1','2','3'].map(stage=>[stage,{status:'ready',issues:[]}]));
 return report;
}
function harness(t,reply=async()=>({ok:true,json:async()=>makeReport()})){
 const dom=new JSDOM(readFileSync(path.join(directory,'index.html'),'utf8'),{url:'http://127.0.0.1:43210',runScripts:'outside-only'});
 t.after(()=>dom.window.close());
 const {window}=dom,root=window.document.getElementById('signet-lens-left-preview');root.lang='en';
 window.document.querySelector('meta[name="chat-token"]').content='test-token';
 const calls=[];
 window.fetch=async(url,init)=>{calls.push({url,init,body:JSON.parse(init.body)});return reply(url,init)};
 window.eval(readFileSync(path.join(directory,'input-validation.js'),'utf8'));
 let dataset={id:'dataset-a',name:['資料 A','Dataset A'],inputs:clone(inputs),persisted:true,ready:true};
 const controller=window.SignetInputValidation.create({root,getDataset:()=>dataset});
 const remote=(overrides={})=>window.dispatchEvent(new window.CustomEvent('workspace-remote-context',{detail:{connected:true,identity:'user@host|session-a',environmentKey:'root-a',...overrides}}));
 const panel=root.querySelector('[data-input-validation]'),button=root.querySelector('[data-input-validate]');
 const change=value=>{dataset={...dataset,...value};controller.sync()};
 return {window,root,calls,panel,button,remote,change,controller};
}
async function waitFor(condition,message='Expected validation state'){
 const end=Date.now()+1500;
 while(!condition()) {assert.ok(Date.now()<end,message);await new Promise(resolve=>setTimeout(resolve,5))}
}

test('validation is manual, sends the saved snapshot, and preserves a report across identical refreshes',async t=>{
 const h=harness(t);assert.equal(h.button.disabled,true);h.remote();assert.equal(h.calls.length,0);
 h.button.click();await waitFor(()=>h.panel.dataset.validationState==='warning');
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/signet/datasets/dataset-a/validate');
 assert.equal(h.calls[0].init.method,'POST');assert.equal(h.calls[0].init.headers['X-Chat-Token'],'test-token');
 assert.deepEqual(h.calls[0].body,{inputs});
 assert.equal(h.panel.querySelector('[data-pairing-count="matched_patients"]').textContent,'6');
 const checked=h.panel.textContent;h.controller.sync();assert.equal(h.panel.textContent,checked);assert.equal(h.calls.length,1);
});

test('saved file changes abort an old check and never accept its late report',async t=>{
 let release;const h=harness(t,()=>new Promise(resolve=>release=resolve));h.remote();h.button.click();
 await waitFor(()=>h.calls.length===1);
 h.change({inputs:{...clone(inputs),clinical:['/pub/u/new-clinical.tsv']}});
 assert.equal(h.calls[0].init.signal.aborted,true);
 release({ok:true,json:async()=>makeReport()});await new Promise(resolve=>setTimeout(resolve,10));
 assert.notEqual(h.panel.dataset.validationState,'warning');assert.equal(h.panel.querySelector('[data-pairing-count="matched_patients"]'),null);
 assert.equal(h.calls.length,1,'changing files must not auto-check');
});

test('switching datasets cannot display a late report from the previous dataset',async t=>{
 let release;const h=harness(t,()=>new Promise(resolve=>release=resolve));h.remote();h.button.click();
 await waitFor(()=>h.calls.length===1);h.change({id:'dataset-b',name:['資料 B','Dataset B']});
 release({ok:true,json:async()=>makeReport()});await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(h.panel.textContent.includes('Dataset A'),false);assert.notEqual(h.panel.dataset.validationState,'warning');
});

test('disconnect and account or environment changes invalidate the report without replaying a check',async t=>{
 const h=harness(t);h.remote();h.button.click();await waitFor(()=>h.panel.dataset.validationState==='warning');
 h.remote({connected:false});assert.equal(h.button.disabled,true);assert.notEqual(h.panel.dataset.validationState,'warning');
 h.remote({identity:'other@host|session-b',environmentKey:'root-b'});
 assert.equal(h.button.disabled,false);assert.notEqual(h.panel.dataset.validationState,'warning');assert.equal(h.calls.length,1);
});

test('server conflicts cannot leave a previous success visible',async t=>{
 let failing=false;const h=harness(t,async()=>failing?{ok:false,status:409,json:async()=>({error:'The saved inputs changed. Check again.',code:'conflict'})}:{ok:true,json:async()=>makeReport()});
 h.remote();h.button.click();await waitFor(()=>h.panel.dataset.validationState==='warning');
 failing=true;h.button.click();await waitFor(()=>h.panel.textContent.includes('The saved inputs changed.'));
 assert.notEqual(h.panel.dataset.validationState,'warning');assert.equal(h.panel.querySelector('[data-pairing-count="matched_patients"]'),null);
});

test('contradictory server reports cannot turn failed checks into an overall pass',async t=>{
 const report=makeReport();report.status='passed';report.checks[0].status='failed';
 report.files=Object.values(inputs).flat().map(path=>({path,complete:true,size:1,lines:1}));
 const h=harness(t,async()=>({ok:true,json:async()=>report}));h.remote();h.button.click();
 await waitFor(()=>h.panel.dataset.validationState==='unavailable');
 assert.equal(h.panel.querySelector('[data-validation-check]'),null);
});

test('bounded or changed-file checks remain incomplete rather than becoming a pass',async t=>{
 const report=makeReport();report.status='incomplete';report.checks[0].status='unchecked';
 report.checks[0].message='The file exceeds the read limit.';report.pairing.status='unchecked';
 const h=harness(t,async()=>({ok:true,json:async()=>report}));h.remote();h.button.click();
 await waitFor(()=>h.panel.dataset.validationState==='incomplete');
 assert.equal(h.panel.textContent.includes('exceeds the read limit'),true);
 assert.equal(h.panel.querySelector('[data-validation-check="genotype_format"]').dataset.status,'unchecked');
});

test('report content renders as text and switching language never resubmits the request',async t=>{
 const report=makeReport();report.checks[0].message='<img src=x onerror=alert(1)> structural issue';
 const h=harness(t,async()=>({ok:true,json:async()=>report}));h.remote();h.button.click();
 await waitFor(()=>h.panel.dataset.validationState==='warning');assert.equal(h.panel.querySelector('img'),null);
 assert.equal(h.panel.textContent.includes('<img src=x'),true);
 h.root.lang='zh-Hant';h.controller.sync();assert.match(h.button.textContent,/檢查/);assert.equal(h.calls.length,1);
});

test('clinical choices are deferred to Stage 3 while Stage 1 inputs remain usable',async t=>{
 const report=stagedReport();report.pairing.missing_race=5;
 report.checks[2].metrics={rows:70,missing_race:67};
 report.stage_readiness['3']={status:'needs_review',issues:[{code:'clinical_choices',stage:3,severity:'needs_review',message:'Choose how to handle unknown clinical categories.'}]};
 const h=harness(t,async()=>({ok:true,json:async()=>report}));h.remote();h.button.click();
 await waitFor(()=>h.panel.dataset.validationState==='warning');
 assert.match(h.panel.querySelector('[data-validation-summary]').textContent,/Stage 1 input checks passed/);
 assert.equal(h.panel.querySelector('[data-validation-check="clinical_format"]').dataset.status,'passed');
 assert.equal(h.panel.querySelector('[data-validation-stage="3"]').dataset.status,'needs_review');
 assert.equal(h.panel.querySelector('[data-pairing-count="missing_race"]').textContent,'5');
 assert.match(h.panel.querySelector('[data-validation-check="clinical_format"]').textContent,/Rows with missing, unknown or unreported race67/);
 assert.match(h.panel.querySelector('[data-validation-pairing]').textContent,/Matched patients with missing or unknown race5/);
 assert.match(h.panel.textContent,/actual preprocessed outputs/);
 assert.equal(h.panel.querySelector('input[type="radio"]'),null,'the data page cannot decide clinical choices');
 assert.equal(h.calls.length,1,'validation must not submit or rerun anything');
 h.root.lang='zh-Hant';h.controller.sync();
 assert.match(h.panel.querySelector('[data-validation-summary]').textContent,/第 1 階段的輸入檢查通過/);
 assert.match(h.panel.querySelector('[data-validation-stage="3"]').textContent,/需要確認/);
 assert.match(h.panel.querySelector('[data-validation-check="clinical_format"]').textContent,/族群缺值、未知或未回報的資料列數67/);
});

test('a readable later-stage format failure does not falsely block Stage 1 or hide preliminary pairing',async t=>{
 const report=stagedReport();report.status='failed';report.checks[2].status='failed';
 report.stage_readiness['3']={status:'blocked',issues:[{code:'clinical_columns',stage:3,severity:'error',message:'Clinical columns must be corrected.'}]};
 const h=harness(t,async()=>({ok:true,json:async()=>report}));h.remote();h.button.click();
 await waitFor(()=>h.panel.dataset.validationState==='failed');
 assert.match(h.panel.querySelector('[data-validation-summary]').textContent,/Stage 1 input checks passed/);
 assert.equal(h.panel.querySelector('[data-validation-stage="3"]').dataset.status,'blocked');
 assert.equal(h.panel.querySelector('[data-pairing-count="matched_patients"]').textContent,'6');
 assert.match(h.panel.textContent,/Stage 3: Clinical columns/);
});

test('contradictory stage readiness never approves unread or failed Stage 1 inputs',async t=>{
 for(const change of [report=>report.checks[0].status='failed',report=>report.files[0].complete=false,report=>delete report.files[0].sha256,
  report=>report.status='incomplete',
  report=>report.stage_readiness['1'].issues.push({code:'blocked',stage:1,severity:'error',message:'Blocked.'}),
  report=>report.stage_readiness['3'].status='invented']){
  const report=stagedReport();change(report);
  const h=harness(t,async()=>({ok:true,json:async()=>report}));h.remote();h.button.click();
  await waitFor(()=>h.panel.dataset.validationState==='unavailable');
  assert.equal(h.panel.querySelector('[data-validation-stage]'),null);
 }
});

test('stage-specific issue text is inert and a global pass cannot hide unresolved stage choices',async t=>{
 const report=stagedReport();report.stage_readiness['3']={status:'needs_review',issues:[{code:'clinical_choices',stage:3,severity:'needs_review',message:'<script>throw 1</script> inspect privately'}]};
 const h=harness(t,async()=>({ok:true,json:async()=>report}));h.remote();h.button.click();
 await waitFor(()=>h.panel.dataset.validationState==='warning');
 assert.equal(h.panel.querySelector('script'),null);assert.match(h.panel.textContent,/<script>throw 1/);
 report.status='passed';report.checks[1].status='passed';h.button.click();
 await waitFor(()=>h.panel.dataset.validationState==='unavailable');
});
