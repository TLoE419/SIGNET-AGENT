const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {TextDecoder} = require('node:util');

const activatedLinks=[];

class Element {
  constructor(tag, attrs='') {
    this.tag=tag; this.children=[]; this.events={}; this.dataset={}; this.attributes={};
    this.hidden=/\bhidden(?:\s|$|=)/.test(attrs); this.open=/\bopen(?:\s|$|=)/.test(attrs);
    this.id=attrs.match(/\bid="([^"]+)"/)?.[1]; this.className=attrs.match(/\bclass="([^"]+)"/)?.[1]||'';
    for(const match of attrs.matchAll(/\bdata-([\w-]+)="([^"]*)"/g))this.dataset[match[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=match[2];
    this.classList={add:(...names)=>{this.className+=' '+names.join(' ');},remove:()=>{},toggle:()=>{}};
    this.scrollHeight=200;this.scrollTop=0;this.clientHeight=200;this.value='';this._text='';
  }
  append(...children){for(const child of children){child.parentElement=this;this.children.push(child);}}
  replaceChildren(...children){this.children=[];this.append(...children);}
  after(child){child.parentElement=this.parentElement;const siblings=this.parentElement.children;siblings.splice(siblings.indexOf(this)+1,0,child);}
  reportValidity(){return true;}
  click(){if(this.tag==='a')activatedLinks.push(this.href);else this.events.click?.();}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(c=>c!==this);}
  get lastChild(){return this.children.at(-1);}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
  set innerHTML(value){this.textContent=value;}
  setAttribute(key,value){this.attributes[key]=value;}
  addEventListener(name,fn){this.events[name]=fn;}
  querySelector(){return null;}
  querySelectorAll(tag){return this.children.flatMap(child=>[...(child.tag===tag?[child]:[]),...child.querySelectorAll(tag)]);}
  focus(){}
}

function setup(initial={}, analysisApi) {
  const ids=new Map(), all=[], root=new Element('root'), stack=[root];
  // Use the shipped markup, so a hidden ancestor or closed details catches the real regression.
  const html=(fs.readFileSync('electron/renderer/app/App.tsx','utf8').replaceAll('className=', 'class=').replaceAll('htmlFor=', 'for=') + '<script id="initial-chat"></script>');
  for(const match of html.matchAll(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g)){
    const token=match[0];if(token.startsWith('<!'))continue;
    if(token.startsWith('</')){stack.pop();continue;}
    const [,tag,attrs]=token.match(/^<([\w-]+)([\s\S]*?)>$/)||[];if(!tag)continue;
    const el=new Element(tag,attrs);all.push(el);stack.at(-1).append(el);if(el.id)ids.set(el.id,el);
    if(!['meta','link','br','hr','input','img'].includes(tag))stack.push(el);
  }
  ids.get('initial-chat').textContent=JSON.stringify(initial);
  const find=selector=>selector.startsWith('#')?ids.get(selector.slice(1)):all.find(el=>el.className.split(' ').includes(selector.slice(1)));
  let finish, calls=0;
  const gate=new Promise(resolve=>finish=resolve);
  const workspace={active:false,runs:[],baseline:null,comparison:null,proposals:[],graphs:{}};
  const events={};const storage=new Map();const navigation=[];
  const timers=new Map();let nextTimer=0, now=0;
  const timersApi=analysisApi ? {
    setTimeout(fn, delay){const id=++nextTimer;timers.set(id,{fn,delay});return id;},
    clearTimeout(id){timers.delete(id);},
    Date:{now:()=>now}
  } : {setTimeout,clearTimeout};
  const context=vm.createContext({document:{getElementById:id=>ids.get(id),createElement:tag=>new Element(tag),
    querySelector:selector=>selector.startsWith('meta')?{content:'token'}:find(selector),
    querySelectorAll:selector=>selector==='[data-tab]'?all.filter(e=>e.dataset.tab):[],addEventListener(){}},
    uiLanguage:'en',uiText(el,text){el.dataset.i18n=text;el.textContent=text;},
    crypto:{randomUUID:()=> 'test-session'},history:{replaceState(){}},location:{assign:path=>navigation.push(path)},performance:{now:()=>1000},TextDecoder,
    Event:class {constructor(type){this.type=type;}},CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}},
    addEventListener(name,fn){events[name]=fn;},dispatchEvent(event){events[event.type]?.(event);},
    sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
    setInterval(){return 1;},clearInterval(){},...timersApi,AbortController,translateUI:text=>text,
    fetch:async (path, options)=>{
      if(path.startsWith('/signet/'))return analysisApi(path, options);
      if(path.startsWith('/stage6'))return {ok:true,json:async()=>structuredClone(workspace)};
      calls++;
      if(context.failRequest)return {ok:false,json:async()=>({error:'Controlled service failure'})};
      let read=0;
      const chunk=items=>({done:false,value:Buffer.from(items.map(item=>JSON.stringify(item)+'\n').join(''))});
      return {ok:true,body:{getReader:()=>({read:async()=>{
        if(read++===0)return chunk([{type:'progress',text:'模型請求 1/5：等待回覆。'},
          {type:'progress',text:'工具 1/1：signet_catalog；驗證參數並呼叫。'},
          {type:'progress',text:'工具結果：signet_catalog；status=ok；executed=False。'},
          {type:'workspace',text:structuredClone(workspace)}]);
        if(read===2){await gate;return chunk([{type:'answer',text:'Completed capability lookup.'},{type:'done',text:'Completed'}]);}
        return {done:true};
      }})}};
    }});
  context.window=context;
  vm.runInContext(fs.readFileSync('electron/renderer/features/chat/chat.js','utf8'),context);
  vm.runInContext(fs.readFileSync('electron/renderer/features/stage6/stage6.js','utf8'),context);
  if(analysisApi)for(const file of ['step-review.js','analysis-results.js','analysis-progress.js'])
    vm.runInContext(fs.readFileSync('electron/renderer/features/chat/'+file,'utf8'),context);
  async function tick(){
    const [id, timer]=timers.entries().next().value;
    timers.delete(id);now+=timer.delay;timer.fn();
    await new Promise(setImmediate);
  }
  function visible(el){
    if(!el)return false;
    let child=el;
    for(let parent=el;parent;child=parent,parent=parent.parentElement){
      if(parent.hidden)return false;
      if(parent.tag==='details'&&!parent.open&&parent!==el&&child.tag!=='summary')return false;
    }
    return true;
  }
  return {context,ids,events,visible,finish,workspace,navigation,tick,timers,calls:()=>calls};
}

(async()=>{
  const app=setup({sessions:[{session:'saved',title:'Saved'}]});await new Promise(setImmediate);
  const pending=vm.runInContext('send("Describe the tools without running analysis.")',app.context);
  await new Promise(setImmediate);
  const savedLink=app.ids.get('chat-list').children[0];
  assert.equal(savedLink.disabled,true);
  savedLink.events.click();
  assert.equal(app.navigation.length,0,'history must not navigate away during an active turn');
  assert.equal(app.visible(app.ids.get('activity')),false,'tool details stay collapsed during an ordinary turn');
  app.ids.get('chat-progress').open=true;
  assert.equal(app.visible(app.ids.get('activity')),true,'ordinary chat activity can be opened without a Stage 6 baseline');
  assert.equal(app.visible(app.ids.get('state')),true,'live status must have no hidden ancestor');
  assert.match(app.ids.get('activity').textContent,/signet_catalog/);
  assert.equal(app.ids.get('stage6-pane').hidden,true,'chat must not activate visualization');
  app.events['stage6-update']({detail:{...structuredClone(app.workspace),active:true}});
  app.ids.get('s6-close').events.click();
  assert.equal(app.visible(app.ids.get('activity')),true,'collapsing visualization must not hide chat activity');
  for(const tab of ['parameters','comparison','history']){
    const button=app.ids.get('s6-'+tab+'-tab');button.events.click();
    assert.equal(app.visible(app.ids.get('activity')),true,'visualization tabs must not hide chat activity');
  }
  app.finish();await pending;
  assert.equal(savedLink.disabled,false);
  assert.equal(app.visible(app.ids.get('activity')),true,'finished tool records remain accessible');
  assert.equal(app.ids.get('state').textContent,'回合結束');
  app.ids.get('chat-progress').open=false;
  assert.equal(app.visible(app.ids.get('state')),true,'collapsed progress keeps its status visible');
  assert.equal(app.visible(app.ids.get('activity')),false);
  app.ids.get('chat-progress').open=true;
  assert.match(app.ids.get('activity').textContent,/signet_catalog/);
  assert.equal(app.calls(),1,'view changes must not repeat the request');

  const restored=setup({session:'saved-session',sessions:[{session:'saved-session',title:'Saved question'},{session:'other-session',title:'<script>literal title</script>'}],messages:[{role:'assistant',text:'Saved answer'}],events:[['Saved tool result']]});
  await new Promise(setImmediate);
  assert.equal(restored.visible(restored.ids.get('chat-progress')),true,'restored history has an accessible progress control');
  restored.ids.get('chat-progress').open=true;
  assert.equal(restored.visible(restored.ids.get('activity')),true);
  assert.match(restored.ids.get('activity').textContent,/Saved tool result/);
  const links=restored.ids.get('chat-list').children;
  assert.equal(links.length,2);
  assert.equal(links[0].attributes['aria-current'],'page','the open conversation is marked');
  assert.equal(links[1].textContent,'<script>literal title</script>','titles stay literal text');
  links[0].events.click();
  assert.equal(restored.navigation.length,0,'the open conversation is not reloaded');
  links[1].events.click();
  assert.equal(restored.navigation.at(-1),'/?session=other-session');
  restored.ids.get('new-chat').events.click();
  assert.equal(restored.navigation.at(-1),'/?new=1');
  const failed=setup();await new Promise(setImmediate);failed.context.failRequest=true;
  await vm.runInContext('send("Controlled error")',failed.context);
  assert.equal(failed.visible(failed.ids.get('state')),true,'failure status remains visible when the log is closed');
  failed.ids.get('chat-progress').open=true;
  assert.equal(failed.visible(failed.ids.get('activity')),true,'failure details remain accessible');
  assert.match(failed.ids.get('activity').textContent,/Controlled service failure/);
  assert.equal(failed.ids.get('state').textContent,'需要確認');
  const session='12345678-1234-1234-1234-123456789abc';
  const other='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const stageNames=['genotype','expression','adjust','cis','network','visualize'];
  let phase='queued', progress, interruption=false, snapshotDown=false, linked=true, resolveCheck;
  const requests=[];
  const json=value=>({ok:true,json:async()=>structuredClone(value)});
  function snapshot(session, run_id){
    return {session,run_id,total_steps:6,next_step:'genotype',proposal:null,completed_steps:phase==='completed'?1:0,
      steps:stageNames.map(step=>({step,phase:step==='network'?phase:step==='visualize'?'untracked':'not_started',
        ...(step==='network'&&progress?{progress}:{})}))};
  }
  const api=async (path,options)=>{
    requests.push({path,method:options.method||'GET',signal:options.signal});
    assert.equal(options.headers['X-Chat-Token'],'token');
    if(path==='/signet/progress?session='+session)
      return snapshotDown ? {ok:false} : json({analyses:[...(linked?[snapshot(session,'real-run')]:[]), snapshot(other,'wrong-chat')]});
    if(path==='/signet/runs/real-run/steps/network') {
      if(interruption)return json({connection:'interrupted'});
      return new Promise(resolve=>{resolveCheck=()=>resolve(json({state:'running'}));});
    }
    if(path==='/signet/runs')return json({runs:[
      {run_id:'real-run',cohort:'TCGA',session:null},{run_id:'wrong-chat',cohort:'TCGA',session:other}
    ]});
    if(path==='/signet/runs/real-run/conversation'){
      assert.equal(options.method,'PATCH');assert.deepEqual(JSON.parse(options.body),{session});
      linked=true;return json({run_id:'real-run',session});
    }
    throw new Error('Unexpected path '+path);
  };
  const live=setup({session,messages:[{role:'assistant',text:'Saved research conversation'}]},api);
  await new Promise(setImmediate);
  const cards=()=>live.ids.get('messages').children.filter(el=>el.className==='analysis-progress-card');
  assert.equal(cards().length,1,'a run linked to another conversation must not appear');
  const original=cards()[0], bar=original.children[0].children[2], rows=original.children[1];
  assert.equal(rows.children.length,6);
  assert.match(original.textContent,/排隊中/);
  assert.match(rows.children[5].textContent,/尚未追蹤/);
  original.open=true;
  phase='running';progress={stage1:'31 36',stage2:'20 10'};
  await live.tick();
  assert.equal(cards()[0],original,'live updates preserve the card and expanded state');
  assert.equal(original.open,true);
  assert.match(rows.children[4].textContent,/31\/36/);
  assert.doesNotMatch(rows.children[4].textContent,/20\/10/);
  assert.equal(bar.value,0,'completed-stage progress does not count a running step');
  progress=undefined;
  await live.tick();
  assert.match(rows.children[4].textContent,/目前無分段進度/);
  phase='downloading';
  await live.tick();
  assert.match(original.textContent,/正在下載結果/);
  assert.equal(requests.filter(r=>r.path.endsWith('/steps/network')).length,1,'a slow refresh must not overlap itself');
  resolveCheck();
  await new Promise(setImmediate);
  interruption=true;
  await live.tick();
  assert.match(original.textContent,/暫時無法向 HPC3 確認/);
  assert.match(original.textContent,/正在下載結果/);
  snapshotDown=true;
  await live.tick();
  assert.match(original.textContent,/暫時無法更新/);
  assert.equal(cards()[0],original);
  snapshotDown=false;phase='completed';
  await live.tick();
  assert.equal(cards()[0],original);
  assert.equal(bar.value,1);
  assert.match(rows.children[4].textContent,/已完成/);
  assert.equal(original.children[0].children.at(-1).hidden,true,'successful status clears the stale notice');
  assert.ok(requests.every(r=>r.method==='GET'),'watching a run cannot submit a job');
  live.events.pagehide();
  assert.equal(live.timers.size,0);
  assert.equal(requests.at(-1).signal.aborted,true);

  linked=false;
  const unlinked=setup({session},api);await new Promise(setImmediate);
  const tracker=unlinked.ids.get('analysis-tracking');
  tracker.open=true;tracker.events.toggle();
  await new Promise(setImmediate);
  const picker=unlinked.ids.get('analysis-run');
  assert.deepEqual(picker.children.map(option=>option.value),['real-run']);
  picker.value='real-run';unlinked.ids.get('analysis-link').disabled=false;
  await unlinked.ids.get('analysis-link-form').events.submit({preventDefault(){}});
  await new Promise(setImmediate);
  assert.equal(unlinked.ids.get('messages').children.filter(el=>el.dataset.runId==='real-run').length,1);
  assert.equal(tracker.open,false);
  const blank=setup({},api);await new Promise(setImmediate);
  assert.equal(blank.ids.get('analysis-tracking').hidden,true);
  assert.equal(blank.timers.size,0);
  let review={id:'first-review',state:'pending',mode:'example',parameters:{
    inputs:{'ped.file':'/remote/study.ped','map.file':'/remote/study.map',ref:'/remote/ref/chr',gmap:'/remote/gmap/chr'},
    settings:{'restrict.tcga.geno':'1',mind:'0.1',geno:'0.1',hwe:'0.001',int:'5000000'},
    resources:{cpus:8,mem_gb:32,hours:4}
  }};
  let genotypePhase='not_started', finishSubmission;
  const actions=[];
  const genotypeApi=async (path, options)=>{
    if(path==='/signet/progress?session='+session)
      return json({analyses:[{...snapshot(session,'genotype-run'),completed_steps:0,proposal:review,
        steps:stageNames.map(step=>({step,phase:step==='genotype'?genotypePhase:step==='visualize'?'untracked':'not_started'}))}]});
    if(path==='/signet/runs/genotype-run/steps/genotype')return json({state:genotypePhase});
    assert.equal(options.method,'POST');
    const action=path.split('/').at(-1);
    actions.push({action,body:JSON.parse(options.body)});
    if(action==='decline'){
      review={...review,state:'declined'};
      return json(review);
    }
    if(action==='prepare'){
      review={...review,id:'new-review',state:'pending'};
      return json(review);
    }
    if(action==='confirm')return new Promise(resolve=>{
      finishSubmission=()=>{
        review={...review,state:'sent'};
        genotypePhase='submitted';
        resolve(json({state:'submitted',job_id:'123'}));
      };
    });
    throw new Error('Unexpected path '+path);
  };
  const genotypeApp=setup({session},genotypeApi);await new Promise(setImmediate);
  const genotypeMessages=genotypeApp.ids.get('messages');
  const genotypeCard=genotypeMessages.children.find(el=>el.className==='step-review-card');
  const genotypeProgress=genotypeMessages.children.find(el=>el.className==='analysis-progress-card');
  const actionButton=text=>genotypeCard.querySelectorAll('button').find(el=>el.textContent===text);
  assert.equal(genotypeCard.hidden,false,'a draft created in chat is restored from the linked analysis');
  assert.deepEqual(actions,[],'rendering the draft never sends work');
  genotypeCard.querySelectorAll('form')[0].events.submit({preventDefault(){}});
  assert.deepEqual(actions,[],'Enter in a field does not approve');
  actionButton('先不要').events.click();
  await new Promise(setImmediate);
  assert.deepEqual(actions.map(item=>item.action),['decline']);
  assert.match(genotypeCard.textContent,/尚未送出運算/);
  assert.equal(actionButton('同意，開始這一步'),undefined);
  actionButton('使用官方示範資料').events.click();
  await new Promise(setImmediate);
  const inputs=genotypeCard.querySelectorAll('input');
  inputs.find(el=>el.value==='0.1').value='0.07';
  inputs.find(el=>el.value===8).value='3';
  const confirm=actionButton('同意，開始這一步');
  confirm.events.click();confirm.events.click();
  assert.equal(confirm.disabled,true);
  assert.deepEqual(actions.map(item=>item.action),['decline','prepare','confirm']);
  assert.equal(actions.at(-1).body.settings.mind,.07);
  assert.equal(actions.at(-1).body.resources.cpus,3);
  assert.equal(actions.at(-1).body.proposal_id,'new-review');
  finishSubmission();
  await new Promise(setImmediate);
  assert.match(genotypeCard.textContent,/已送算/);
  assert.match(genotypeProgress.textContent,/已送出/);
  assert.equal(genotypeMessages.children.filter(el=>el.className==='analysis-progress-card').length,1);
  let nextIndex=1, activePhase='not_started', nextProposal;
  const confirmations=[];
  const parameters={
    expression:{inputs:{'gexp.file':'/demo/expression','pmap.file':'/demo/annotation'},settings:{'restrict.tcga':'1'}},
    adjust:{inputs:{'cli.file':'/demo/clinical.tsv'},settings:{},options:{npc:3}},
    cis:{inputs:{},settings:{'alpha.cis':'0.05'}},
    network:{inputs:{},settings:{nboots:'2',walltime:'1:00:00'}},
    visualize:{inputs:{},settings:{freq:'0.5',ntop:'1'}}
  };
  const graphDraws=[];
  const sequenceApi=async (path, options)=>{
    const step=stageNames[nextIndex];
    if(path==='/signet/progress?session='+session)return json({analyses:[{
      run_id:'same-run',session,completed_steps:nextIndex,total_steps:6,next_step:step||null,proposal:nextProposal||null,
      steps:stageNames.map((name,index)=>({step:name,phase:index<nextIndex?'completed':index===nextIndex?activePhase:'not_started'}))
    }]});
    if(path==='/signet/runs/same-run/results?session='+session)return json({graph:{
      display_nodes:['A','B'], edges:[{source:'A',target:'B'}], counts:{genes:2,connections:1}
    }});
    if(path==='/signet/runs/same-run/results/download') {
      assert.deepEqual(JSON.parse(options.body),{session});
      return json({url:'/signet/result-download?ticket=example-ticket'});
    }
    const endpoint='/signet/runs/same-run/steps/'+step;
    if(path===endpoint)return json({state:activePhase});
    assert.ok(path.startsWith(endpoint+'/proposal/'),path);
    const action=path.split('/').at(-1);
    const body=JSON.parse(options.body);
    assert.equal(body.session,session);
    if(action==='prepare'){
      nextProposal={id:step,state:'pending',mode:'example',parameters:{
        ...parameters[step],resources:{cpus:2,mem_gb:16,hours:2}
      }};
      return json(nextProposal);
    }
    if(action==='decline'){
      nextProposal={...nextProposal,state:'declined'};
      return json(nextProposal);
    }
    assert.equal(action,'confirm');
    assert.equal(body.proposal_id,step);
    confirmations.push({step,body});
    activePhase='submitted';
    nextProposal={...nextProposal,state:'sent'};
    return json({state:'submitted'});
  };
  const sequence=setup({session},sequenceApi);
  sequence.context.vis={Network:class {constructor(el, data){graphDraws.push(data);} destroy(){}}};
  await new Promise(setImmediate);
  const sequenceLog=sequence.ids.get('messages');
  const sequenceProgress=sequenceLog.children.find(el=>el.className==='analysis-progress-card');
  const sequenceReview=sequenceLog.children.find(el=>el.className==='step-review-card');
  const reviewButton=text=>sequenceReview.querySelectorAll('button').find(el=>el.textContent===text);
  assert.deepEqual(confirmations,[],'preparing the next stage never submits it');
  for(let i=1;i<6;i++){
    assert.match(sequenceReview.textContent,new RegExp('第 '+(i+1)+' 階段'));
    if(i===2){
      reviewButton('先不要').click();
      await new Promise(setImmediate);
      assert.equal(confirmations.length,1);
      assert.match(sequenceReview.textContent,/尚未送出運算/);
      reviewButton('準備本階段設定').click();
      await new Promise(setImmediate);
      sequenceReview.querySelectorAll('input').find(el=>el.value===3).value='2';
    }
    const approve=reviewButton('同意，開始這一步');
    approve.click();approve.click();
    await new Promise(setImmediate);
    assert.equal(confirmations.length,i);
    assert.match(sequenceProgress.textContent,/已送出/);
    nextIndex++;activePhase='not_started';nextProposal=null;
    await sequence.tick();
  }
  assert.equal(confirmations.find(item=>item.step==='adjust').body.options.npc,2);
  assert.equal(confirmations.find(item=>item.step==='network').body.settings.walltime,'1:00:00');
  assert.equal(confirmations.find(item=>item.step==='visualize').body.settings.freq,.5);
  assert.equal(sequenceReview.hidden,true);
  assert.equal(sequenceLog.children.filter(el=>el.className==='analysis-progress-card').length,1);
  const resultCard=sequenceLog.children.find(el=>el.className.startsWith('analysis-result-card'));
  assert.match(resultCard.textContent,/2 個基因 · 1 條連線/);
  assert.equal(graphDraws.length,1);
  assert.equal(graphDraws[0].edges[0].to,'B');
  resultCard.querySelectorAll('button')[0].click();
  await new Promise(setImmediate);
  assert.equal(activatedLinks.at(-1),'/signet/result-download?ticket=example-ticket');
  const metricSteps = [
    {step:'genotype',phase:'running',progress:{imputation:'35 36'}},
    {step:'expression',phase:'completed',progress:{expression_outputs:'2 2'}},
    {step:'adjust',phase:'completed',progress:{variant_filter:'1 1'}},
    {step:'cis',phase:'completed',progress:{low_frequency:'2 2',rare_variants:'1 1'}},
    {step:'network',phase:'completed',progress:{stage1:'3 3',stage2:'3 3'}},
    {step:'visualize',phase:'completed',progress:{subnetworks:'1 1'}}
  ];
  const measuredApp=setup({session},async path=>{
    if(path.startsWith('/signet/progress?'))return json({analyses:[{
      run_id:'measured',session,total_steps:6,completed_steps:5,next_step:'genotype',
      proposal:null,steps:metricSteps
    }]});
    return json({state:'running'});
  });
  await new Promise(setImmediate);
  const measuredCard=measuredApp.ids.get('messages').children.find(el=>el.className==='analysis-progress-card');
  assert.match(measuredCard.children[0].textContent,/第 1 階段 · 基因型前處理/);
  assert.match(measuredCard.children[0].textContent,/補值分段 · 已完成 35\/36/,'the collapsed card displays current segment progress');
  const measuredRows=measuredCard.children[1].children;
  for(const [index, text] of ['補值分段','表現前處理步驟','染色體變異篩選','低頻變異分段','建網第一組','子網路圖'].entries()){
    assert.ok(measuredRows[index].textContent.includes(text), text);
  }
  assert.match(measuredRows[3].textContent,/罕見變異分段/);
  assert.match(measuredRows[4].textContent,/建網第二組/);
  console.log('Chat progress visibility, status, history, errors and Stage 6 independence passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
