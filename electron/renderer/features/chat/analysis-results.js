function createAnalysisResults(path, session, request) {
  const card = node('article', 'analysis-result-card step-review-card');
  const status = node('p', 'step-review-notice');
  status.setAttribute('role', 'status');
  const graph = node('iframe', 'analysis-result-graph');
  graph.setAttribute('title', translateUI('原版基因調控網路圖'));
  graph.dataset.i18nTitle = '原版基因調控網路圖';
  graph.setAttribute('sandbox', 'allow-scripts');
  graph.setAttribute('referrerpolicy', 'no-referrer');
  const controls = node('div', 'step-review-actions');
  const download = node('button', '', '下載分析結果');
  download.type = 'button';
  controls.append(download);
  card.append(node('strong', '', '分析結果'), status, controls);
  let loading = false, drawn = false, polling, removed = false;
  const resultsPath = path + '/results?session=' + encodeURIComponent(session);
  const originalPlots = result => (result.previews || []).filter(({url}) =>
    /^\/signet\/result-preview\/[A-Za-z0-9_-]{32}\/signet_top[1-9][0-9]*_freq[0-9.eE+-]+\.html$/.test(url));

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

  async function show(state, lastStageCard) {
    polling = state;
    if (drawn || loading || removed) return;
    loading = true;
    if (!card.parentElement) lastStageCard.after(card);
    try {
      const result = await request(resultsPath, state);
      if (state.controller.signal.aborted || removed) return;
      const {counts} = result.graph;
      const previews = originalPlots(result);
      uiText(status, `${counts.genes} 個基因 · ${counts.connections} 條連線`);
      if (previews.length > 1) {
        const picker = node('select', 'analysis-result-picker');
        picker.setAttribute('aria-label', translateUI('選擇子網路'));
        picker.dataset.i18nAria = '選擇子網路';
        for (const {subnetwork} of previews) {
          const option = node('option', '', `子網路 ${subnetwork}`);
          option.value = String(subnetwork);
          picker.append(option);
        }
        picker.addEventListener('change', async () => {
          const selected = picker.value;
          const state = polling;
          try {
            const available = originalPlots(await request(resultsPath, state));
            if (state.controller.signal.aborted || removed || picker.value !== selected) return;
            const plot = available.find(item => String(item.subnetwork) === selected);
            if (!plot) throw new Error('Missing original plot');
            graph.src = plot.url;
            uiText(status, `${counts.genes} 個基因 · ${counts.connections} 條連線`);
          } catch (_) {
            if (!state.controller.signal.aborted && !removed && picker.value === selected) {
              uiText(status, '暫時無法載入網路圖。');
            }
          }
        });
        status.after(picker);
        picker.after(graph);
      } else if (previews.length) {
        status.after(graph);
      } else {
        status.after(node('p', 'step-review-notice', '找不到原版互動圖。'));
      }
      if (previews.length) graph.src = previews[0].url;
      drawn = true;
    } catch (_) {
      if (!state.controller.signal.aborted && !removed) uiText(status, '暫時無法載入網路圖。');
    } finally {
      loading = false;
    }
  }

  return {show, remove() {removed = true; card.remove();}};
}
