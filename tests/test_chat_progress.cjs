const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {TextDecoder} = require('node:util');

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
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(c=>c!==this);}
  get lastChild(){return this.children.at(-1);}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
  set innerHTML(value){this.textContent=value;}
  setAttribute(key,value){this.attributes[key]=value;}
  addEventListener(name,fn){this.events[name]=fn;}
  querySelector(){return null;}
  querySelectorAll(){return [];}
  focus(){}
}

function setup(initial={}) {
  const ids=new Map(), all=[], root=new Element('root'), stack=[root];
  // Use the shipped markup, so a hidden ancestor or closed details catches the real regression.
  const html=fs.readFileSync('web/index.html','utf8');
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
  const events={};const storage=new Map();
  const context=vm.createContext({document:{getElementById:id=>ids.get(id),createElement:tag=>new Element(tag),
    querySelector:selector=>selector.startsWith('meta')?{content:'token'}:find(selector),
    querySelectorAll:selector=>selector==='[data-tab]'?all.filter(e=>e.dataset.tab):[],addEventListener(){}},
    uiLanguage:'en',uiText(el,text){el.dataset.i18n=text;el.textContent=text;},
    crypto:{randomUUID:()=> 'test-session'},history:{replaceState(){}},location:{assign(){}},performance:{now:()=>1000},TextDecoder,
    Event:class {constructor(type){this.type=type;}},CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}},
    addEventListener(name,fn){events[name]=fn;},dispatchEvent(event){events[event.type]?.(event);},
    sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
    setInterval(){return 1;},clearInterval(){},setTimeout,clearTimeout,
    fetch:async path=>{
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
  vm.runInContext(fs.readFileSync('web/chat.js','utf8'),context);
  vm.runInContext(fs.readFileSync('web/stage6.js','utf8'),context);
  function visible(el){
    if(!el)return false;
    let child=el;
    for(let parent=el;parent;child=parent,parent=parent.parentElement){
      if(parent.hidden)return false;
      if(parent.tag==='details'&&!parent.open&&parent!==el&&child.tag!=='summary')return false;
    }
    return true;
  }
  return {context,ids,events,visible,finish,workspace,calls:()=>calls};
}

(async()=>{
  const app=setup();await new Promise(setImmediate);
  const pending=vm.runInContext('send("Describe the tools without running analysis.")',app.context);
  await new Promise(setImmediate);
  assert.equal(app.visible(app.ids.get('activity')),true,'ordinary chat progress must be visible without a Stage 6 baseline');
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
  assert.equal(app.visible(app.ids.get('activity')),true,'finished tool records remain accessible');
  assert.equal(app.ids.get('state').textContent,'回合結束');
  app.ids.get('chat-progress').open=false;
  assert.equal(app.visible(app.ids.get('state')),true,'collapsed progress keeps its status visible');
  assert.equal(app.visible(app.ids.get('activity')),false);
  app.ids.get('chat-progress').open=true;
  assert.match(app.ids.get('activity').textContent,/signet_catalog/);
  assert.equal(app.calls(),1,'view changes must not repeat the request');

  const restored=setup({session:'saved-session',messages:[{role:'assistant',text:'Saved answer'}],events:[['Saved tool result']]});
  await new Promise(setImmediate);
  assert.equal(restored.visible(restored.ids.get('chat-progress')),true,'restored history has an accessible progress control');
  restored.ids.get('chat-progress').open=true;
  assert.equal(restored.visible(restored.ids.get('activity')),true);
  assert.match(restored.ids.get('activity').textContent,/Saved tool result/);
  const failed=setup();await new Promise(setImmediate);failed.context.failRequest=true;
  await vm.runInContext('send("Controlled error")',failed.context);
  assert.equal(failed.visible(failed.ids.get('activity')),true,'failure details remain visible');
  assert.match(failed.ids.get('activity').textContent,/Controlled service failure/);
  assert.equal(failed.ids.get('state').textContent,'需要確認');
  console.log('Chat progress visibility, status, history, errors and Stage 6 independence passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
