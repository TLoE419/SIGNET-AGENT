function createAnalysisResults(progressCard, path, session, request) {
  const card = node('article', 'analysis-result-card step-review-card');
  const status = node('p', 'step-review-notice');
  status.setAttribute('role', 'status');
  const graph = node('div', 'analysis-result-graph');
  graph.setAttribute('aria-label', translateUI('基因調控網路圖'));
  graph.dataset.i18nAria = '基因調控網路圖';
  const controls = node('div', 'step-review-actions');
  const download = node('button', '', '下載分析結果');
  download.type = 'button';
  controls.append(download);
  card.append(node('strong', '', '分析結果'), status, graph, controls);
  let network, loading = false, drawn = false, polling, removed = false;

  download.addEventListener('click', async () => {
    if (!polling || download.disabled) return;
    const state = polling;
    download.disabled = true;
    try {
      const {url} = await request(path + '/results/download', state, {session}, 'POST');
      if (state.controller.signal.aborted || removed) return;
      if (!/^\/signet\/result-download\?ticket=[A-Za-z0-9_-]+$/.test(url)) throw new Error('Invalid download URL');
      const link = node('a', '');
      link.href = url;
      link.download = '';
      card.append(link);
      link.click();
      link.remove();
    } catch (_) {
      if (!state.controller.signal.aborted && !removed) uiText(status, '無法下載結果，請再試一次。');
    } finally {
      download.disabled = false;
    }
  });

  async function show(state) {
    polling = state;
    if (drawn || loading || removed) return;
    loading = true;
    if (!card.parentElement) progressCard.after(card);
    try {
      const result = await request(path + '/results?session=' + encodeURIComponent(session), state);
      if (state.controller.signal.aborted || removed) return;
      const {display_nodes: names, edges, counts} = result.graph;
      // Keep interactive layout responsive on large graphs. The ZIP retains the full exports.
      const selected = new Set(names);
      const visible = new Set();
      const connections = [];
      for (const edge of edges) {
        if (!selected.has(edge.source) || !selected.has(edge.target)) continue;
        const newNodes = new Set([edge.source, edge.target].filter(name => !visible.has(name)));
        if (visible.size + newNodes.size > 500 || connections.length === 3000) continue;
        for (const name of newNodes) visible.add(name);
        connections.push(edge);
      }
      const clipped = visible.size !== selected.size || connections.length === 3000;
      const nodes = [...visible].map(name => ({id:name, label:name, color:'#38795b'}));
      const links = connections.map(edge => ({from:edge.source, to:edge.target, arrows:'to'}));
      if (window.vis) {
        network = new window.vis.Network(graph, {nodes, edges:links}, {
          nodes:{shape:'dot', size:6, font:{size:12}},
          edges:{color:{color:'#889b90'}, smooth:false},
          physics:{stabilization:{iterations:120}}
        });
      }
      uiText(status, `${counts.genes} 個基因 · ${counts.connections} 條連線` +
        (clipped ? '\n圖中顯示部分連線，完整結果可下載。' : ''));
      drawn = true;
    } catch (_) {
      if (!state.controller.signal.aborted && !removed) uiText(status, '暫時無法載入網路圖。');
    } finally {
      loading = false;
    }
  }

  return {show, remove() {removed = true; network?.destroy(); card.remove();}};
}
