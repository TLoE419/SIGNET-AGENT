const $=id=>document.getElementById(id);
const names={preparing:'Preparing',ready:'Ready',starting:'Starting',running:'Running',verifying:'Verifying',succeeded:'Verified',failed:'Failed',interrupted:'Interrupted',skipped:'Skipped',cancelling:'Cancelling',cancelled:'Cancelled'};
let selected=localStorage.getItem('selected-analysis')||'',schema,imports={},busy=false,refreshing=false,connected=false,loadedResult='',listFingerprint='',detailFingerprint='';
async function call(method,...args){const r=await window.desktop[method](...args);if(!r.ok)throw Error(r.error);return r.value}
function message(text){$('message').textContent=text}
async function safe(fn){try{await fn()}catch(e){message(e.message)}}
async function connection(){const s=await call('status');connected=s.connected;$('connection').textContent=connected?'Ready':'Controller unavailable'; $('create-button').disabled=!connected;}
function label(a){return a.controller!=='node-v1'&&/[\p{Script=Han}]/u.test(a.label)?'Historical analysis ('+a.id.slice(2,10)+')':a.label;}
async function reconnect(){try{await call('reconnect');schema=await call('schema');setupForm();await connection();await refresh();message('')}catch(e){connected=false;$('connection').textContent='Controller unavailable: '+e.message;$('create-button').disabled=true}}
function setupForm(){
 if(!$('parameters').childElementCount){for(const [key,s] of Object.entries(schema.parameters)){const label=document.createElement('label');label.textContent=s.label;const input=document.createElement('input');input.type='number';input.value=s.default;input.min=s.min;input.max=s.max;input.step=s.integer?'1':'any';input.dataset.param=key;input.required=true;label.append(input);$('parameters').append(label)}
 const label=document.createElement('label');label.textContent='GTEx tissue identifier';const input=document.createElement('input');input.value='Lung';input.dataset.param='tissue';label.append(input);$('parameters').append(label);}
 fileFields();
}
function fileFields(){
 imports={};const custom=$('dataset').value==='custom';$('cohort').disabled=!custom;if(!custom)$('cohort').value='TCGA';$('input-files').hidden=!custom;$('input-files').replaceChildren();
 if(!custom)return;const cohort=$('cohort').value;
 for(const [key,name] of schema.files[cohort]){const row=document.createElement('p'),button=document.createElement('button'),status=document.createElement('span');button.type='button';button.textContent='Choose '+name;status.textContent=' Not selected';
 button.onclick=()=>safe(async()=>{const selected=await call('pick',key,cohort);if(!selected.canceled){imports[key]=selected.token;status.textContent=' '+selected.name;}});row.append(button,status);$('input-files').append(row);}
}
$('dataset').onchange=()=>schema&&fileFields();$('cohort').onchange=()=>schema&&fileFields();
async function refresh(){if(refreshing)return;refreshing=true;try{
 const list=await call('list');if(selected&&!list.some(a=>a.id===selected)){selected='';localStorage.removeItem('selected-analysis')}
 const fingerprint=JSON.stringify([selected,list.map(a=>[a.id,a.label,a.status])]);
 if(fingerprint!==listFingerprint){listFingerprint=fingerprint;$('list').replaceChildren();for(const a of list){const b=document.createElement('button');b.className='item'+(a.id===selected?' selected':'');b.textContent=`${label(a)} · ${names[a.status]||a.status}`;const identifier=document.createElement('div');identifier.className='id';identifier.textContent=a.id;b.append(identifier);b.onclick=()=>safe(async()=>{await call('closeVisualization');selected=a.id;detailFingerprint='';localStorage.setItem('selected-analysis',selected);await refresh()});$('list').append(b)}}
 if(selected)await show();
 }finally{refreshing=false}}
function saveButton(id,key,label){const b=document.createElement('button');b.textContent=label;b.onclick=()=>safe(async()=>{b.disabled=true;try{const r=await call('save',id,key);message(r.canceled?'Save cancelled.':'Saved: '+r.path)}finally{b.disabled=false}});return b}
async function show(){
 const a=await call('detail',selected),fingerprint=JSON.stringify(a);if(fingerprint===detailFingerprint)return;
 $('detail').replaceChildren();for(const text of [label(a),'Analysis ID: '+a.id,'Status: '+(names[a.status]||a.status),a.error||a.launcher_warning||'',a.cancel_error?'Cancellation unconfirmed: '+a.cancel_error:''].filter(Boolean)){const p=document.createElement('p');p.textContent=text;$('detail').append(p)}
 $('reveal').hidden=false;$('reveal').onclick=()=>safe(()=>call('reveal',a.id));
 const active=['starting','running','verifying','cancelling'].includes(a.status);$('cancel').hidden=!active||a.controller!=='node-v1';$('cancel').disabled=busy||a.status==='cancelling';$('cancel').onclick=()=>safe(async()=>{busy=true;try{await call('cancel',a.id);message('Cancellation requested; checking remote jobs.');detailFingerprint='';await refresh()}finally{busy=false}});
 $('stage-controls').replaceChildren();
 for(const s of a.stages||[]){const p=document.createElement('p');p.textContent=s.name+': '+(names[s.status]||s.status)+' ';
 if(s.status==='ready'&&a.controller==='node-v1'){const b=document.createElement('button');b.textContent='Run stage';const before=a.stages.slice(0,a.stages.indexOf(s));const independent=s.id==='expression'&&a.cohort==='TCGA';
 b.disabled=busy||active||['failed','interrupted','cancelled'].includes(a.status)||(!independent&&before.some(x=>!['succeeded','skipped'].includes(x.status)));
 b.onclick=()=>safe(async()=>{busy=true;b.disabled=true;try{await call('start',a.id,s.id);message('Stage started.');detailFingerprint='';await refresh()}finally{busy=false}});p.append(b);}
 $('stage-controls').append(p);}
 $('stage-downloads').replaceChildren();for(const [key,name] of Object.entries(a.artifacts||{}))$('stage-downloads').append(saveButton(a.id,key,'Save '+name));
 $('progress').replaceChildren();if(a.active_stage==='network'||(!a.stages&&a.progress))for(const s of a.progress?.stages||[]){const p=document.createElement('p');p.textContent=`Network phase ${s.stage}: ${s.completed} / ${s.total||'not assigned'} commands`;$('progress').append(p)}
 for(const j of a.progress?.scheduler?.jobs||[]){const p=document.createElement('p');p.textContent=`Scheduler job ${j.JobIDRaw}：${j.State}; exit code ${j.ExitCode}; runtime ${j.RunTime}`;$('progress').append(p)}
 if(a.progress?.scheduler?.error){const p=document.createElement('p');p.textContent=a.progress.scheduler.error;$('progress').append(p)}
 $('logs-box').hidden=!!a.legacy;
 if(!a.legacy){const logs=await call('logs',a.id);$('logs').textContent=Object.entries(logs).map(([k,v])=>k+'\n'+v).join('\n\n')||'No logs yet'}
 $('results').hidden=!a.verification&&!Object.keys(a.artifacts||{}).length;
 $('show-result').hidden=!a.officialVisualization||!a.stages?.some(s=>s.id==='visualization'&&s.status==='succeeded');$('downloads').replaceChildren();$('result-summary').textContent='';
 if(a.verification){const v=a.verification;$('result-summary').textContent=`${v.shape[0]} targets × ${v.shape[1]} sources; ${v.job_ids.length} actual scheduler jobs verified; frequency ≥ 0.5: ${v.counts['0.5']} edges.`;

 $('show-result').onclick=()=>safe(async()=>{$('show-result').disabled=true;try{message('Starting official Shiny visualization…');const result=await call('visualization',a.id);loadedResult=a.id;$('viewer').src=result.url;$('viewer').hidden=false;message('Official visualization ready.');}finally{$('show-result').disabled=false;}});}
 if(loadedResult!==a.id){$('viewer').hidden=true;$('viewer').removeAttribute('src')}
 detailFingerprint=fingerprint;
}
$('create').onsubmit=e=>{e.preventDefault();safe(async()=>{$('create-button').disabled=true;try{const parameters={};for(const input of document.querySelectorAll('[data-param]'))parameters[input.dataset.param]=input.type==='number'?Number(input.value):input.value;
 const a=await call('create',{label:$('label').value,dataset:$('dataset').value,cohort:$('cohort').value,parameters,imports});selected=a.id;localStorage.setItem('selected-analysis',selected);detailFingerprint='';message('Analysis created. Run its stages in order.');await refresh();}finally{$('create-button').disabled=!connected}})};
$('refresh').onclick=()=>safe(refresh);$('reconnect').onclick=()=>safe(reconnect);
reconnect().finally(()=>setInterval(()=>safe(refresh),5000));
