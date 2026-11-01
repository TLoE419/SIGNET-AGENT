/* Stage 6 workspace: proposals are read-only until an explicit authenticated click. */
(() => {
  let data = null, tab = 'parameters', mode = 'side', showShared = false, expanded = false, networks = [], requestBusy = false, timer = null;
  // Presentation state stays in this browser tab, separate from research files and run records.
  const viewStorageKey = 'signet-stage6-view-v1:' + session;
  const collapsedStorageKey='signet-stage6-collapsed:' + session;
  // Starts collapsed; it opens only after the researcher chooses to show it in this tab.
  let collapsed=true;
  try {collapsed=sessionStorage.getItem(collapsedStorageKey)!=='false';} catch (_) {}
  function setCollapsed(value) {
    collapsed=value;
    try {sessionStorage.setItem(collapsedStorageKey,String(value));} catch (_) {}
    render();
    $(value?'s6-open':'s6-close').focus();
  }
  let views = new Map();
  try { views = new Map(JSON.parse(sessionStorage.getItem(viewStorageKey) || '[]')); } catch (_) {}
  function persistViews() {
    try { sessionStorage.setItem(viewStorageKey, JSON.stringify([...views])); } catch (_) {}
  }
  function disposeGraphs(save = true) {
    networks.forEach(view => view.dispose(save)); networks = [];
  }
  function resetLayout() {
    disposeGraphs(false); views.clear(); persistViews(); render();
  }
  const T = (en, zh) => uiLanguage === 'zh-Hant' ? zh : en;
  const make = (tag, cls, text) => {
    const n = document.createElement(tag); n.className = cls || '';
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const text = (en, zh) => T(en, zh);
  function button(label, fn, cls = '') {
    const n = make('button', cls, label); n.type = 'button'; n.addEventListener('click', fn); return n;
  }
  function error(value) { $('s6-error').textContent = value; $('s6-error').hidden = !value; }
  async function api(path, payload) {
    const options = {headers: {'X-Chat-Token': document.querySelector('meta[name="chat-token"]').content}};
    if (payload) {options.method = 'POST'; options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify({session, ...payload});}
    const r = await fetch(payload ? path : path + '?session=' + session, options);
    const result = await r.json(); if (!r.ok) throw Error(result.error || r.statusText); return result;
  }
  async function refresh() {
    try { accept(await api('/stage6')); } catch (e) { error(e.message); }
  }
  function accept(value) {
    const oldPending = data?.proposals.filter(p => p.status === 'pending').at(-1)?.id;
    const oldComparison = data?.comparison;
    const wasRunning = data?.proposals.some(p=>p.status==='running');
    data = value;
    const pending = data.proposals.filter(p => p.status === 'pending').at(-1);
    if (data.comparison && data.comparison !== oldComparison) tab = 'comparison';
    if (pending && pending.id !== oldPending) tab = 'parameters';
    const running = data.proposals.some(p => p.status === 'running');
    if(wasRunning && !running && !busy) uiText($('state'),'回合結束');
    if(wasRunning && !running && data.proposals.at(-1)?.status!=='verified_completed') {tab='history';error(text('Visualization did not complete. The baseline is preserved; inspect the run history.', '視覺化尚未成功完成。基準結果仍保留，請查看執行紀錄。'));}
    if (running && !timer) timer = setInterval(refresh, 2500);
    if (!running && timer) {clearInterval(timer); timer = null;}
    history.replaceState(null, '', '/?session=' + session);
    render();
  }
  async function action(path, payload) {
    if (requestBusy || busy) return;
    requestBusy = true; error(''); render();
    try {await api(path, payload); if(path==='/stage6/compare')tab='comparison'; if(path==='/stage6/select')tab='parameters'; await refresh();} catch(e) {error(e.message);}
    finally {requestBusy = false; render();}
  }
  function card(title) { const n = make('section', 's6-card'); n.append(make('h3', '', title)); return n; }
  function baselineChooser(parent) {
    const row = make('div', 's6-baseline');
    const label = make('label', '', text('Baseline result', '比較基準'));
    const select = make('select'); select.id = 's6-baseline-select'; label.htmlFor = select.id;
    for (const run of data.runs) {
      const option = make('option', '', run.run_id); option.value = run.run_id; select.append(option);
    }
    select.value = data.baseline || '';
    select.disabled = requestBusy || busy || data.proposals.some(p => p.status === 'running');
    select.addEventListener('change', () => action('/stage6/select', {run_id:select.value}));
    row.append(label, select); parent.append(row);
    const files = make('div', 's6-chips');
    ['signet_Afreq', 'signet_CoeffMat0', 'signet_net.genepos'].forEach(name => files.append(make('span', '', name)));
    parent.append(files);
  }
  function parameterPanel() {
    const parent = $('s6-parameters'); parent.replaceChildren();
    if (!data.runs.length) {
      parent.append(card(text('No verified Stage 6 baseline available', '尚無已驗證的第六階段基準結果')));
      parent.append(make('p', 's6-note', text('This download includes no data or results. Configure the scientific runtime and provide your own inputs before creating a baseline. See docs/ADVANCED.md.', '下載版本未附資料或結果。請先設定科學執行環境並提供自己的輸入，完成分析後才能選擇基準。詳見 docs/ADVANCED.md。')));
      return;
    }
    baselineChooser(parent);
    const p = data.proposals.filter(p => ['pending','running'].includes(p.status)).at(-1);
    const baseline = data.runs.find(r => r.run_id === data.baseline);
    if(!baseline) {parent.append(make('p','s6-note',text('Baseline unavailable. Select another verified result.', '基準結果無法使用，請選擇另一份已驗證結果。')));return;}
    const box = card(p ? text('Review parameter changes', '確認參數修改') : text('Adjust parameters through chat', '透過對話調整參數'));
    if (!p) {
      box.append(make('p', '', text('Describe a change on the left. No visualization runs until you confirm here.', '在左側描述修改。只有在此確認後才會執行視覺化。')));
      box.append(make('p', 's6-muted', `freq = ${baseline.frequency} · ntop = ${baseline.top_networks}`));
      box.append(button(text('Try: lower frequency to 0.8', '試試：把頻率門檻降至 0.8'), () => {
        $('prompt').value = text('Set the Stage 6 frequency threshold to 0.8. Keep other parameters unchanged. Prepare the proposal only.', '把第六階段的頻率門檻改成 0.8，其餘保持不變，先提出修改供我確認。'); $('prompt').focus();
      }, 's6-secondary'));
    } else {
      const table = make('table', 's6-parameter-table'), head = make('tr');
      [text('Parameter','參數'),text('Current','原設定'),text('Proposed','新設定')].forEach(t => head.append(make('th','',t)));
      table.append(head);
      [[text('Frequency threshold (freq)','頻率門檻（freq）'),'frequency'],[text('Top subnetworks (ntop)','顯示子網路數（ntop）'),'top_networks']].forEach(([title,key]) => {
        const row = make('tr'); row.append(make('td','',title),make('td','',p.before[key]));
        row.append(make('td', p.before[key] !== p.after[key] ? 's6-changed' : '', p.after[key])); table.append(row);
      });
      box.append(table, make('p','s6-note',text('Same input data · Other settings unchanged · Stage 6 only', '相同輸入資料 · 其餘設定不變 · 僅執行第六階段')));
      if (p.status === 'pending') {
        const actions = make('div','s6-actions');
        actions.append(button(text('Cancel','取消'),()=>action('/stage6/cancel',{proposal_id:p.id}),'s6-secondary'));
        const confirm = button(text('Confirm & run','確認並執行'),()=>action('/stage6/confirm',{proposal_id:p.id}),'s6-primary');
        confirm.id = 's6-confirm'; actions.append(confirm);
        actions.querySelectorAll('button').forEach(b => b.disabled = requestBusy || busy); box.append(actions);
      } else {
        const elapsed=Math.max(0,Math.floor(Date.now()/1000-p.confirmed));
        const phase=data.progress||text('Running in the existing Docker environment','正在既有容器環境執行');
        box.append(make('p','s6-running',`${phase} · ${Math.floor(elapsed/60)}m ${elapsed%60}s · ${text('Original result preserved','原結果仍保留')}`));
      }
    }
    parent.append(box);
    const grids = make('div','s6-graphs');
    const before = card(text('Current network','目前網路圖')); before.append(graphContainer('s6-preview-before'));
    const after = card(text('New result','新結果')); after.append(make('div','s6-empty',text('Available after confirmation and successful execution', '確認且執行成功後顯示')));
    grids.append(before,after); parent.append(grids);
    drawGraph('s6-preview-before', data.graphs.baseline, null, 'before');
  }
  function graphContainer(id) {const n = make('div','s6-network'); n.id = id; n.tabIndex = 0; n.setAttribute('aria-label',text('Interactive gene network','可互動基因網路')); return n;}
  function edgeKey(e) {return JSON.stringify([e.source,e.target]);}
  function comparisonEdges(graph, other, type) {
    const selected=g=>g.edges.filter(e=>g.display_nodes.includes(e.source)&&g.display_nodes.includes(e.target));
    if(type!=='difference')return selected(graph);
    return [...new Map([...selected(graph),...selected(other)].map(e=>[edgeKey(e),e])).values()];
  }
  function showComparison() {
    const parent = $('s6-comparison'); parent.replaceChildren();
    const a = data.graphs.baseline, b = data.graphs.comparison;
    if (!a || !b) {parent.append(make('div','s6-empty',text('Complete a confirmed change to compare results. The baseline remains available under Parameters.', '確認修改並執行完成後，即可比較結果。基準結果可在參數頁查看。')));return;}
    const summary=make('div','s6-summary-strip');
    summary.append(make('span','s6-completed',text('Completed · Original retained','已完成 · 原結果已保留')));
    parent.append(summary);
    const change=data.proposals.find(p=>p.run_id===data.comparison);
    const oldFrequency=change?.before.frequency ?? data.runs.find(r=>r.run_id===data.baseline)?.frequency;
    const newFrequency=change?.after.frequency ?? data.runs.find(r=>r.run_id===data.comparison)?.frequency;
    if(change)summary.append(make('span','',`freq ${change.before.frequency} → ${change.after.frequency} · ntop ${change.before.top_networks} → ${change.after.top_networks}`));
    const metrics = make('div','s6-metrics');
    [['connections','Connections','連結數'],['genes','Genes','基因數'],['subnetworks','Subnetworks','子網路數']].forEach(([key,en,zh]) => {
      const box = card(text(en,zh)); const delta = b.counts[key]-a.counts[key];
      box.append(make('strong','',`${a.counts[key]} → ${b.counts[key]}`),make('span','s6-delta',`${delta>0?'+':''}${delta}`));metrics.append(box);
    });parent.append(metrics);
    const ak = new Set(a.edges.map(edgeKey)), bk = new Set(b.edges.map(edgeKey));
    parent.append(make('p','s6-note',`${text('Shared','共同')} ${[...ak].filter(k=>bk.has(k)).length} · ${text('Added','新增')} ${[...bk].filter(k=>!ak.has(k)).length} · ${text('Removed','移除')} ${[...ak].filter(k=>!bk.has(k)).length}`));
    const controls = make('div','s6-view-controls');
    controls.append(button(text('Side by side','並排比較'),()=>{mode='side';render();},mode==='side'?'selected':''),button(text('Difference view','差異圖'),()=>{mode='difference';render();},mode==='difference'?'selected':''));
    controls.append(button(text('Reset comparison layout','重設比較排版'),resetLayout));
    controls.append(button(expanded?text('Exit expanded view','離開放大'):text('Expand','放大'),()=>{expanded=!expanded;document.querySelector('.stage6-pane').classList.toggle('s6-expanded',expanded);render();})); parent.append(controls);
    if(mode==='difference') {
      const shown=comparisonEdges(b,a,'difference');
      const added=shown.filter(e=>!ak.has(edgeKey(e))).length;
      const removed=shown.filter(e=>!bk.has(edgeKey(e))).length;
      const shared=shown.length-added-removed;
      const panel=make('div','s6-difference-controls');
      const toggle=button(showShared?text('Hide shared links','隱藏共同連結'):text('Show shared links','顯示共同連結'),()=>{showShared=!showShared;render();},'s6-secondary');
      toggle.setAttribute('aria-pressed',String(showShared));
      panel.append(make('strong','s6-added',`+ ${added} ${text('added','新增')}`),make('strong','s6-removed',`− ${removed} ${text('removed','移除')}`),toggle);
      parent.append(panel,make('p','s6-muted',text(
        `Selected subnetworks: ${shared} shared links ${showShared?'shown faintly':'hidden'}. Green solid arrows are added; orange dashed arrows are removed.`,
        `指定子網路中的 ${shared} 條共同連結${showShared?'淡化顯示':'已隱藏'}。綠色粗實線箭頭表示新增，橘色粗虛線箭頭表示移除。`)));
    }
    const grids = make('div', mode==='side'?'s6-graphs':'s6-one-graph');
    if(mode==='side') {
      for (const [id,title] of [['s6-before',text('Before','修改前')+' · freq '+oldFrequency],['s6-after',text('After','修改後')+' · freq '+newFrequency]]) {
        const box = card(title); box.append(graphContainer(id));grids.append(box);
      }
    } else {const box=card(text('Changed connections','連結差異'));box.append(graphContainer('s6-diff'));grids.append(box);}
    const legend=make('p','s6-legend');
    [['Shared','共同保留','s6-shared'],['Added','新增','s6-added'],['Removed','移除','s6-removed']].forEach(([en,zh,cls])=>legend.append(make('span',cls,'● '+text(en,zh))));
    parent.append(grids,legend);
    parent.append(make('p','s6-muted',text('Counts cover the full filtered network. Graphs show the selected top subnetworks. Resampling frequency is not a probability of truth.', '統計涵蓋完整篩選網路；圖中顯示指定排名的子網路。重抽樣出現比例不是真實性的機率。')));
    const details=make('div','s6-selection',text('Select a gene or connection to inspect its values.','點選基因或連結查看數值。'));details.id='s6-selection';parent.append(details);
    const files = make('details','s6-outputs'); files.append(make('summary','',text('Output files','輸出檔案')),make('p','s6-run-label',data.baseline+' → '+data.comparison));
    for (const [title,run] of [[text('Before','修改前'),data.baseline],[text('After','修改後'),data.comparison]]) {
      const record = data.proposals.find(p=>p.run_id===run)?.result;
      const defaults = ['signet_count_vs_freq.pdf'];
      const names = record ? record.output_files.filter(p=>p.startsWith('work/res/resv/')&&!p.slice(14).includes('/')).map(p=>p.split('/').at(-1)) : defaults;
      for (const name of names) {
        const link=make('a','',title+' · '+name);link.href='/stage6/file?session='+session+'&run='+encodeURIComponent(run)+'&name='+encodeURIComponent(name);files.append(link);
      }
    }parent.append(files);
    if(mode==='side') {drawGraph('s6-before',a,b,'before');drawGraph('s6-after',b,a,'after');}
    else drawGraph('s6-diff',b,a,'difference');
  }
  function drawGraph(id, graph, other, type) {
    if (!graph || !window.vis) return;
    const container=$(id); if(!container) return;
    const viewKey=JSON.stringify([id,data.baseline,data.comparison,type==='difference'?showShared:null]);
    const saved=views.get(viewKey);
    const names=[...new Set([...graph.nodes,...(other?.nodes||[])])].sort();
    const positions = names.map((name,i)=>({name,x:Math.cos(i*2.399963)*Math.sqrt(i+1)*27,y:Math.sin(i*2.399963)*Math.sqrt(i+1)*27}));
    // Deterministic layout on the union gives the same gene the same position in both views.
    const union = [...new Map([...graph.edges,...(other?.edges||[])].map(e=>[edgeKey(e),e])).values()].sort((a,b)=>edgeKey(a).localeCompare(edgeKey(b)));const index = new Map(names.map((n,i)=>[n,i]));
    // shortcut: quadratic layout is for example-sized graphs; large graphs use the initial spiral.
    for(let step=0;step<(positions.length>500?0:140);step++) {
      const delta=positions.map(()=>({x:0,y:0}));
      for(let i=0;i<positions.length;i++) for(let j=i+1;j<positions.length;j++) {
        const dx=positions[i].x-positions[j].x,dy=positions[i].y-positions[j].y,d=Math.max(30,Math.hypot(dx,dy));
        const force=120/(d*d);delta[i].x+=dx*force;delta[i].y+=dy*force;delta[j].x-=dx*force;delta[j].y-=dy*force;
      }
      for(const e of union) {const i=index.get(e.source),j=index.get(e.target); if(i===j)continue;
        const dx=positions[j].x-positions[i].x,dy=positions[j].y-positions[i].y;
        delta[i].x+=dx*.02;delta[i].y+=dy*.02;delta[j].x-=dx*.02;delta[j].y-=dy*.02;
      }
      positions.forEach((p,i)=>{const scale=Math.min(1,5/Math.max(1,Math.hypot(delta[i].x,delta[i].y)));p.x+=delta[i].x*scale-.003*p.x;p.y+=delta[i].y*scale-.003*p.y;});
    }
    const common=new Set(other?.edges.map(edgeKey)||[]), current=new Set(graph.edges.map(edgeKey));
    let edges=comparisonEdges(graph,other,type);
    if(type==='difference'&&!showShared)edges=edges.filter(e=>!current.has(edgeKey(e))||!common.has(edgeKey(e)));
    const visible=new Set(edges.flatMap(e=>[e.source,e.target]));
    const nodes=positions.filter(p=>visible.has(p.name)).map(p=>({id:p.name,label:p.name,x:saved?.positions?.[p.name]?.x ?? p.x,y:saved?.positions?.[p.name]?.y ?? p.y,color:'#99b7ef',size:8}));
    if(!nodes.length) {
      container.append(make('div','s6-empty',text('No added or removed links in the selected subnetworks. Show shared links to see the network context.', '指定子網路沒有新增或移除的連結。可顯示共同連結查看網路背景。')));
      return;
    }
    const net=new vis.Network(container,{nodes,edges:edges.map((e,i)=>({id:i,from:e.source,to:e.target,arrows:'to',
      width:type==='difference'?(common.has(edgeKey(e))&&current.has(edgeKey(e))?0.7:3.5):1,
      color:type==='difference'&&!current.has(edgeKey(e))?'#c2691d':other&&!common.has(edgeKey(e))?(type==='before'?'#c2691d':'#00856a'):(type==='difference'?'rgba(170,180,187,0.22)':'#b0bac4'),
      dashes:type==='difference'&&!current.has(edgeKey(e)),title:`frequency: ${e.frequency}; coefficient: ${e.coefficient}`}))},
      {physics:{enabled:false,solver:'barnesHut',stabilization:false,minVelocity:0.75,maxVelocity:20,barnesHut:{damping:0.3}},nodes:{shape:'dot',font:{size:14,color:'#344843'}},edges:{smooth:false},interaction:{hover:true,dragNodes:true,dragView:true,zoomView:true,keyboard:{enabled:true,bindToWindow:false}},layout:{improvedLayout:false}});
    const shownUnion=type==='difference'?visible:new Set([...graph.display_nodes,...(other?.display_nodes||[])]);
    const fitted=positions.filter(p=>shownUnion.has(p.name));
    const xs=fitted.map(p=>p.x),ys=fitted.map(p=>p.y);
    const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
    const bounds=Math.max(80,(maxX-minX)/2,(maxY-minY)/2);
    net.moveTo({position:{x:(minX+maxX)/2,y:(minY+maxY)/2},scale:Math.min(container.clientWidth,container.clientHeight)/(bounds*2.4)});
    if(saved) net.moveTo({position:saved.position,scale:saved.scale});
    let dragging=false, returnFrame=null, restPositions=null;
    const remember=()=>{
      views.set(viewKey,{positions:restPositions || net.getPositions(),position:net.getViewPosition(),scale:net.getScale()});
      persistViews();
    };
    function springBack() {
      net.setOptions({physics:{enabled:false}});
      const from=net.getPositions(), target=restPositions;
      let started;
      function step(now) {
        started ??= now;
        const t=Math.min(1,(now-started)/650);
        const eased=t===1?1:1-Math.exp(-7*t)*Math.cos(10*t);
        for(const [name,to] of Object.entries(target)) {
          const origin=from[name];
          net.moveNode(name,t===1?to.x:origin.x+(to.x-origin.x)*eased,t===1?to.y:origin.y+(to.y-origin.y)*eased);
        }
        if(t<1)returnFrame=requestAnimationFrame(step);
        else {returnFrame=null;restPositions=null;remember();}
      }
      returnFrame=requestAnimationFrame(step);
      remember();
    }
    net.on('dragStart',e=>{
      dragging=e.nodes.length>0;
      if(dragging) {
        cancelAnimationFrame(returnFrame);returnFrame=null;
        restPositions ??= net.getPositions();
        net.setOptions({physics:{enabled:true}});
      }
    });
    net.on('dragEnd',()=>{
      const wasNodeDrag=dragging;dragging=false;
      if(wasNodeDrag)springBack();else remember();
    });
    net.on('zoom',remember);
    net.on('select',e=>{const target=$('s6-selection');if(!target)return;
      if(e.nodes.length) {
        const name=e.nodes[0],incoming=edges.filter(edge=>edge.target===name).length,outgoing=edges.filter(edge=>edge.source===name).length;
        target.textContent=`${name} · ${text('Shown incoming','圖中入連結')}: ${incoming} · ${text('Shown outgoing','圖中出連結')}: ${outgoing}`;
      } else if(e.edges.length) {
        const edge=edges[e.edges[0]];
        target.textContent=`${edge.source} → ${edge.target} · ${text('Frequency','出現頻率')}: ${edge.frequency} · ${text('Coefficient','係數')}: ${edge.coefficient}`;
      }
    });networks.push({save:remember,dispose(save){
      cancelAnimationFrame(returnFrame);if(save)remember();net.destroy();
    }});
  }
  function historyPanel() {
    const parent=$('s6-history');parent.replaceChildren();
    parent.append(make('h3','',text('Stage 6 changes and runs','第六階段修改與執行')));
    for(const p of [...data.proposals].reverse()) {
      const row=card(p.status+' · '+(p.run_id||text('Not executed','尚未執行')));
      row.append(make('p','',`freq ${p.before.frequency} → ${p.after.frequency} · ntop ${p.before.top_networks} → ${p.after.top_networks}`));
      if(p.error)row.append(make('p','',p.error));
      if(p.result?.notes) row.append(make('p','s6-muted',p.result.notes.join(' ')));
      if(p.status==='verified_completed') {
        row.append(button(text('View comparison','查看比較'),()=>action('/stage6/compare',{proposal_id:p.id}),'s6-secondary'));
        row.append(button(text('Use as baseline','設為比較基準'),()=>action('/stage6/select',{run_id:p.run_id}),'s6-secondary'));
      }
      parent.append(row);
    }
  }
  function render() {
    if(!data)return;
    disposeGraphs();
    const available=Boolean(data.active || data.comparison || data.proposals.length);
    const visible=available && !collapsed;
    $('s6-open').hidden=!available;
    $('s6-open').classList.toggle('active',visible);
    $('s6-open').setAttribute('aria-expanded',String(visible));
    $('s6-open-label').textContent=text('Network visualization','網路視覺化');
    $('s6-close').textContent=text('Collapse','收合');
    const pane=document.querySelector('.stage6-pane');
    pane.hidden=!visible;
    document.querySelector('.workspace').classList.toggle('chat-only',!visible);
    if(!visible){expanded=false;pane.classList.remove('s6-expanded');}
    ['parameters','comparison','history'].forEach(name=>{
      $('s6-'+name).hidden=name!==tab;
      const t=$('s6-'+name+'-tab');t.setAttribute('aria-selected',String(name===tab));t.tabIndex=name===tab?0:-1;t.setAttribute('aria-controls','s6-'+name);
      t.textContent={parameters:text('Parameters','參數'),comparison:text('Comparison','結果比較'),history:text('Run history','執行紀錄')}[name];
    });
    if(visible && tab==='parameters')parameterPanel();
    if(visible && tab==='comparison')showComparison();
    if(visible && tab==='history')historyPanel();
    const running = data.proposals.some(p=>p.status==='running');
    if(running && !busy) uiText($('state'),'執行中');
    $('send').disabled = running || busy;
    $('prompt').disabled = running;
    $('new-chat').disabled = running || busy;
    if(data.error)error(data.error);
  }
  $('s6-open').addEventListener('click',()=>setCollapsed(!collapsed));
  $('s6-close').addEventListener('click',()=>setCollapsed(true));
  const tabs=[...document.querySelectorAll('[data-tab]')];
  tabs.forEach((b,i)=>{b.addEventListener('click',()=>{tab=b.dataset.tab;render();});b.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const next=tabs[(i+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length];next.click();next.focus();}});});
  window.addEventListener('stage6-update',e=>accept(e.detail));
  window.addEventListener('panel-request',e=>{if(e.detail?.panel==='visualization'&&collapsed===e.detail.visible)setCollapsed(!e.detail.visible);});
  window.addEventListener('languagechange',render);
  window.addEventListener('chat-idle',render);
  window.addEventListener('chat-busy',render);
  window.addEventListener('pagehide',()=>networks.forEach(view=>view.save()));
  // vis-network resizes its own canvas; rebuilding here would discard an active drag.
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&expanded){expanded=false;document.querySelector('.stage6-pane').classList.remove('s6-expanded');render();}});
  refresh();
})();
