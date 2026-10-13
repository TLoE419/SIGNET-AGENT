/* Design-demo navigation only. No runtime bridge or filesystem operations. */
(function(root){
 const workflows={network:['4:3','4:5','4:6','4:7'],import:['4:30','4:31',null,'4:32'],preprocessing:['4:34','4:35','4:36','4:37'],cis:['4:41','4:42','4:43','4:44']};
 const scenarios=['4:3','4:18','4:24','4:30','4:34'];
 function target(id,label,state={},inDialog=false){
  const steps=workflows[state.workflow]||workflows.network;
  if(label==='Recover analysis')return id==='4:27'&&inDialog?'4:26':'4:27';
  if(label==='Start analysis')return state.workflow==='preprocessing'?'4:38':'4:10';
  if(label==='Stop analysis')return inDialog?'4:70':'4:69';
  if(label==='Cancel')return id==='4:72'&&inDialog?steps[1]:id==='4:20'?'4:19':id==='4:27'||id==='4:28'||id==='4:29'?'4:2':'4:71';
  if(label==='Continue'){if(id===steps[0])return steps[1];if(id===steps[1]||['4:4','4:52','4:72'].includes(id))return steps[2]||steps[3];return steps[3];}
  if(label==='Back'){if(id===steps[0])return '4:2';if(id===steps[1]||id==='4:4'||id==='4:52')return steps[0];if(id===steps[2]||id==='4:53')return steps[1];return steps[2]||steps[1];}
  if(label==='Refresh status')return ({'4:10':'4:11','4:11':'4:18','4:21':'4:12','4:40':'4:12','4:25':'4:26'})[id]||id;
  if(label==='Results')return state.workflow==='import'?'4:33':'4:13';
  if(label==='View results')return '4:13';
  if(label==='Review preprocessing settings')return '4:36';
  const numbered=label.match(/^([1-4])\s+(Workflow|Data|Settings|Review)$/);if(numbered)return steps[{Workflow:0,Data:1,Settings:2,Review:3}[numbered[2]]];
  const fixed={'Analyses':'4:2','← Analyses':'4:2','Back to analyses':'4:2','Connections & Environment':'4:45','UCI HPC3 · Connected':'4:45','UCI HPC3 · Offline':'4:47','Help':'4:73','New analysis':'4:3','Import results':'4:30','Browse all screens':'9:3218','Overview':'4:11','Batches':'4:19','View batches':'4:19','History & Settings':'4:65','History & settings':'4:65','View full log':'4:74','View raw log':'4:74','View startup log':'4:74','← Results':'4:14','Back to results':'4:14','Network Summary':'4:15','Enrichment Analysis':'4:16','Circular Plot':'4:17','Open visualization':'4:61','Download & explore':'4:57','Download selected files':'4:57','Retry download':'4:57','Setup R':'4:46','Set up R':'4:46','Set up environment':'4:46','Return to analysis':'4:14','View progress':'4:11','Clear filters':'4:2','Change workflow':'4:34','Local environment':'4:46','HPC connections':'4:45','UCI HPC3':'4:45','Review PCA':'4:39','Confirm & continue':'4:40','Back to overview':'4:38','Browse HPC':'4:72','Select file':steps[1],'Choose local file':steps[1],'Replace file':steps[1],'Validate inputs':steps[1],'Edit workflow':steps[0],'Edit inputs':steps[1],'Edit settings':steps[2]||steps[1],'Review analysis':steps[3],'Review inputs':'4:23','Review failed batches':'4:19','Retry failed / missing batches':'4:20','Retry 4 batches':'4:21','Keep running':'4:11','Keep app open':'4:11','Save draft':'4:48','Discard changes':'4:2','Keep editing':steps[0],'Explain error':'4:66','Back to history':'4:65','Create new analysis from settings':'4:3','Reconnect':'4:25','Open results':'4:33','Check again':'4:27','Retry':'4:61','Scan workspace':'4:28','Check connection':'4:45','Test connection':'4:45','Save connection':'4:45','Upload & check':'4:8','Retry transfer':'4:8','Cancel transfer':'4:55'};
  return fixed[label]||null;
 }
 const api={workflows,scenarios,target};if(typeof module==='object')module.exports=api;else root.SIGNET_ROUTES=api;
})(typeof window==='object'?window:globalThis);
