const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../renderer/features/workspace/workspace.js'),'utf8');
const handler=source.slice(source.indexOf('  async function applyWorkspaceAction('),source.indexOf('  async function sendMessage('));
function fixture() {
  const record={}; const calls=[];
  const run={run_id:'same',history_id:'archive--same',dataset_id:'d'};
  const ctx={activeChat:record,navigationRevision:0,navigationAction:0,findHistoryRun:id=>id===run.history_id?run:null,
    canReadStage:()=>true,canReadGraph:()=>true,canContinue:()=>false,canStartStage:()=>false,
    historySteps:['genotype','expression','adjust','cis','network','visualize'],
    datasets:[{id:'d'}],selectDataset:d=>calls.push(['dataset',d.id]),byId:()=>({}),
    selectedRuns:new Map(),historySelectionKey:()=> 'all',clearHistoryResult:()=>{},
    openNavigation:view=>calls.push(['view',view]),loadStage3Run:()=>{},archiveSteps:new Set([1,2,4,5]),loadArchivedStep:()=>{},
    loadStage6Run:async()=>{},stage6Result:{history_id:run.history_id,graph:{nodes:['BRCA1']}},
    analysisNetwork:{dispatchEvent:e=>calls.push(['gene',e.detail.gene])},CustomEvent:class{constructor(type,data){Object.assign(this,data)}},calls,record};
  vm.createContext(ctx);vm.runInContext(handler,ctx);return ctx;
}
const action={version:1,action:'select_gene',history_id:'archive--same',stage:6,gene:'BRCA1'};
test('opens canonical source, stage and linked gene selection',async()=>{
 const c=fixture();assert.equal(await c.applyWorkspaceAction(action,c.record,0),true);
 assert.deepEqual(c.calls,[['dataset','d'],['view','history'],['gene','BRCA1']]);assert.equal(c.historyResult.historyId,'archive--same');assert.equal(c.historyResult.stage,6);
});
test('rejects stale turns, wrong source, execution and malformed actions without navigation',async()=>{
 for(const bad of [{...action,history_id:'workspace--same'},{...action,version:2},{...action,stage:'6'},{...action,action:'submit'},{...action,command:'rm'},{...action,gene:'<x>'}]){
  const c=fixture();assert.equal(await c.applyWorkspaceAction(bad,c.record,0),false);assert.equal(c.calls.length,0);
 }
 const c=fixture();c.navigationRevision=1;assert.equal(await c.applyWorkspaceAction(action,c.record,0),false);assert.equal(c.calls.length,0);
 assert.equal(await c.applyWorkspaceAction(action,{},1),false);
});
test('delayed graph cannot select after user navigation or foreign result',async()=>{
 for(const change of [c=>c.navigationRevision++,c=>c.stage6Result.history_id='workspace--same',c=>c.stage6Result.graph.nodes=[]]){
  const c=fixture();c.loadStage6Run=async()=>change(c);
  assert.equal(await c.applyWorkspaceAction(action,c.record,0),false);assert.equal(c.calls.some(x=>x[0]==='gene'),false);
 }
});
