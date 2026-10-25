const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Element {
  constructor(tag='div'){this.tag=tag;this.children=[];this.events={};this.clientWidth=400;this.clientHeight=300;this.dataset={};this.classList={toggle(){},remove(){}};}
  append(...items){this.children.push(...items);}
  replaceChildren(){this.children=[];}
  focus(){}
  setAttribute(){}
  addEventListener(name,fn){this.events[name]=fn;}
  querySelectorAll(){return [];}
}
const ids=new Map(), tabs=['parameters','comparison','history'].map(name=>Object.assign(new Element(),{dataset:{tab:name}}));
const find=(root,label)=>root.children.flatMap(n=>[n,...find(n,label)]).filter(n=>n.textContent===label);
const elements=[];
const $=id=>elements.findLast(e=>e.id===id)||ids.get(id)||(()=>{const e=new Element();ids.set(id,e);return e;})();
const pane=new Element(), workspace=new Element();
const classes=new Set();workspace.classList.toggle=(name,on)=>on?classes.add(name):classes.delete(name);
const storage=new Map(), events={}, live=[], timers=new Map();let timerId=0;
class Network {
  constructor(container,data,options){this.container=container;this.data=data;this.options=options;this.events={};this.position={x:0,y:0};this.scale=1;this.positions=Object.fromEntries(data.nodes.map(n=>[n.id,{x:n.x,y:n.y}]));live.push(this);}
  on(name,fn){this.events[name]=fn;}
  moveTo(value){this.position=value.position;this.scale=value.scale;}
  moveNode(name,x,y){this.positions[name]={x,y};}
  getPositions(){return structuredClone(this.positions);}
  getViewPosition(){return {...this.position};}
  getScale(){return this.scale;}
  setOptions(value){this.physics=value.physics.enabled;}
  destroy(){this.destroyed=true;}
}
const graph={nodes:['A','B'],display_nodes:['A','B'],edges:[{source:'A',target:'B',frequency:1,coefficient:0.5}],counts:{connections:1,genes:2,subnetworks:1}};
const data={baseline:'base',comparison:'new',runs:[{run_id:'base',frequency:1,top_networks:1}],proposals:[],graphs:{baseline:graph,comparison:graph}};
const original=JSON.stringify(data);
const context=vm.createContext({$,session:'test-session',uiLanguage:'en',busy:false,uiText(el,text){el.textContent=text;},vis:{Network},window:{vis:true,addEventListener:(name,fn)=>events[name]=fn},document:{createElement(tag){const e=new Element(tag);elements.push(e);return e;},querySelector:selector=>selector==='.stage6-pane'?pane:selector==='.workspace'?workspace:{content:'token'},querySelectorAll:()=>tabs,addEventListener(){}},history:{replaceState(){}},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},fetch:async()=>({ok:true,json:async()=>structuredClone(data)}),setInterval(){},clearInterval(){},setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);},requestAnimationFrame(fn){timers.set(++timerId,fn);return timerId;},cancelAnimationFrame(id){timers.delete(id);}});
(async()=>{
  vm.runInContext(fs.readFileSync('web/stage6.js','utf8'),context);
  await new Promise(setImmediate);
  assert.equal(live.length,2);
  const first=live[0], initial=structuredClone(first.positions);
  first.events.dragStart({nodes:['A']});assert.equal(first.physics,true);
  first.positions.A={x:321,y:123};first.position={x:100,y:200};first.scale=1.7;
  first.events.dragEnd();assert.equal(timers.size,1);
  const frame=now=>{const pending=[...timers.values()];timers.clear();for(const fn of pending)fn(now);};
  frame(0);frame(325);assert.notDeepEqual(first.positions.A,initial.A,'spring return animates rather than snapping');
  frame(650);assert.equal(first.physics,false);assert.equal(timers.size,0);
  assert.deepEqual(first.positions,initial,'released nodes return to the pre-drag layout');
  first.scale=2.1;first.events.zoom();
  assert.equal(events.resize,undefined,'window resizing must not recreate graphs');
  events['chat-busy']();
  let restored=live.at(-2);
  assert.deepEqual(restored.positions.A,initial.A);assert.equal(restored.scale,2.1);assert.deepEqual(restored.position,{x:100,y:200});
  tabs[2].events.click();tabs[1].events.click();restored=live.at(-2);
  assert.equal(restored.scale,2.1);assert.deepEqual(restored.positions.A,initial.A);
  restored.events.dragStart({nodes:[]});assert.notEqual(restored.physics,true,'panning must not start physics');restored.events.dragEnd();
  events.pagehide();
  vm.runInContext(fs.readFileSync('web/stage6.js','utf8'),context);
  await new Promise(setImmediate);
  assert.equal(live.at(-2).scale,2.1,'reload restores the saved zoom');
  assert.deepEqual(live.at(-2).positions.A,initial.A,'reload restores dragged positions');
  const interrupted=live.at(-2);
  interrupted.events.dragStart({nodes:['A']});interrupted.positions.A={x:999,y:888};interrupted.events.dragEnd();
  frame(0);frame(100);
  $('s6-close').events.click();
  assert.equal(pane.hidden,true);assert.equal($('s6-open').hidden,false);
  assert.ok(classes.has('chat-only'));
  events['chat-idle']();assert.equal(pane.hidden,true,'normal updates do not reopen a manually collapsed pane');
  $('s6-open').events.click();
  assert.equal(pane.hidden,false);assert.equal($('s6-open').hidden,true);
  assert.equal(live.at(-2).scale,2.1,'reopening preserves zoom');
  assert.deepEqual(live.at(-2).position,{x:100,y:200},'reopening preserves pan');
  assert.deepEqual(live.at(-2).positions.A,initial.A,'reopening preserves dragged nodes');
  $('s6-close').events.click();
  vm.runInContext(fs.readFileSync('web/stage6.js','utf8'),context);
  await new Promise(setImmediate);
  assert.equal(pane.hidden,true,'reload remembers manual collapse');
  $('s6-open').events.click();
  assert.equal(live.at(-2).scale,2.1);
  const reset=find($('s6-comparison'),'Reset comparison layout')[0];assert.ok(reset);reset.events.click();
  assert.deepEqual(live.at(-2).positions,initial);assert.deepEqual(live.at(-1).positions,initial);
  assert.notEqual(live.at(-2).scale,2.1);
  assert.equal(JSON.stringify(data),original,'view changes must not mutate analysis data');
  live.at(-2).events.dragStart({nodes:['A']});live.at(-2).events.dragEnd();
  frame(0);frame(650);assert.equal(live.at(-2).physics,false,'physics stops when the node is released');
  events.pagehide();assert.ok(!live.at(-2).destroyed,'pagehide must permit browser back/forward restoration');
  const count=live.length;
  events['stage6-update']({detail:{...structuredClone(data),active:false,comparison:null,proposals:[]}});
  assert.equal(pane.hidden,true,'new chat must hide visualization despite globally available baselines');
  assert.ok(classes.has('chat-only'),'chat occupies the full workspace');
  assert.equal(live.length,count,'hidden workspace does not build graphs');
  events['stage6-update']({detail:{...structuredClone(data),active:true,comparison:null,proposals:[]}});
  assert.equal(pane.hidden,false,'Stage 6 request reveals visualization');
  assert.ok(!classes.has('chat-only'));
  events['stage6-update']({detail:{...structuredClone(data),proposals:[{status:'running'}]}});
  events['stage6-update']({detail:structuredClone(data)});
  assert.equal($('state').textContent,'回合結束','completed visualization clears the running status');
  const beforeGraph={nodes:['A','B','D','E'],display_nodes:['A','B','D','E'],edges:[graph.edges[0],{source:'D',target:'E',frequency:1,coefficient:.4}],counts:{connections:2,genes:4,subnetworks:2}};
  const afterGraph={nodes:['A','B','C'],display_nodes:['A','B','C'],edges:[graph.edges[0],{source:'B',target:'C',frequency:.6,coefficient:.2}],counts:{connections:2,genes:3,subnetworks:1}};
  events['stage6-update']({detail:{...structuredClone(data),graphs:{baseline:beforeGraph,comparison:afterGraph}}});
  tabs[1].events.click();
  find($('s6-comparison'),'Difference view')[0].events.click();
  let diff=live.at(-1).data.edges;
  assert.equal(diff.length,2,'difference view hides unchanged edges by default');
  assert.ok(diff.every(e=>e.width===3.5),'changed edges have strong visual weight');
  assert.ok(diff.find(e=>e.from==='D').dashes,'removed connections use dashed arrows');
  assert.equal(diff.find(e=>e.from==='B').color,'#00856a','added connections use green arrows');
  find($('s6-comparison'),'Show shared links')[0].events.click();
  diff=live.at(-1).data.edges;
  assert.equal(diff.length,3);
  assert.equal(diff.find(e=>e.from==='A').width,.7,'shared context remains visually subdued');
  find($('s6-comparison'),'Hide shared links')[0].events.click();
  const previous=live.length;
  events['stage6-update']({detail:structuredClone(data)});
  assert.equal(live.length,previous,'no differences should show an explicit empty message');
  assert.ok(elements.some(e=>e.textContent?.startsWith('No added or removed links')));
  console.log('Elastic return, camera/layout retention, collapse, reset and analysis preservation passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
