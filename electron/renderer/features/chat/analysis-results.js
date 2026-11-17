const SVG_NS = 'http://www.w3.org/2000/svg';
function svgNode(tag, attributes = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, String(value));
  return el;
}
const shortNumber = value => String(Number(value.toPrecision(3)));

// SIGNET's signet_count_vs_freq plot (netvis/extract_edges.R), redrawn from the -n matrix:
// genes and connections kept at bootstrap-frequency cutoffs 0.8 to 1.
function thresholdChart(points) {
  const section = node('section', 'analysis-result-section');
  section.append(node('h3', '', '頻率門檻與連線數'),
    node('p', 'analysis-result-note', '同 SIGNET 原版 signet_count_vs_freq：重抽樣出現比例至少為各門檻時，留下的連線數與基因數。'));
  const width = 560, height = 230, left = 16, right = 16, top = 22, bottom = 40;
  const most = Math.max(...points.flatMap(point => [point.connections, point.genes]), 1);
  const slot = (width - left - right) / points.length, bar = Math.min(34, slot / 3);
  const y = count => top + (1 - count / most) * (height - top - bottom);
  const chart = svgNode('svg', {viewBox:`0 0 ${width} ${height}`, class:'analysis-threshold-chart', role:'img'});
  chart.setAttribute('aria-label', translateUI('頻率門檻與連線數'));
  chart.append(svgNode('line', {x1:left, y1:y(0), x2:width - right, y2:y(0), class:'axis'}));
  points.forEach((point, index) => {
    const middle = left + slot * (index + .5);
    for (const [key, offset, kind] of [['connections', -1, 'edges'], ['genes', 0, 'genes']]) {
      const x = middle + offset * bar;
      chart.append(svgNode('rect', {x, y:y(point[key]), width:bar, height:y(0) - y(point[key]), class:'bar ' + kind}));
      const value = svgNode('text', {x:x + bar / 2, y:y(point[key]) - 4, 'text-anchor':'middle', class:'value'});
      value.textContent = String(point[key]);
      chart.append(value);
    }
    const label = svgNode('text', {x:middle, y:height - 22, 'text-anchor':'middle'});
    label.textContent = String(point.cutoff);
    chart.append(label);
  });
  const axisName = svgNode('text', {x:width / 2, y:height - 4, 'text-anchor':'middle', class:'axis-name'});
  axisName.textContent = translateUI('門檻（重抽樣出現比例）');
  chart.append(axisName);
  const legend = node('p', 'analysis-chart-legend');
  for (const [kind, label] of [['edges', '連線數'], ['genes', '基因數']]) {
    const key = node('span', 'legend-key ' + kind);
    legend.append(key, node('span', '', label));
  }
  section.append(chart, legend);
  return section;
}

// PNG copies of SIGNET's own PDF plots, rendered on HPC3 when -v finished.
function signetPlots(images) {
  const section = node('section', 'analysis-result-section');
  section.append(node('h3', '', 'SIGNET 原版圖表'));
  const names = {circular:'圓形染色體圖', enrichment_hist:'富集分析長條圖', enrichment_radar:'富集分析雷達圖'};
  if (!images.length) {
    section.append(node('p', 'analysis-result-note', '這次分析沒有圖片版本；圓形染色體圖等原版圖表在下載的結果中（PDF）。'));
    return section;
  }
  for (const image of images) {
    const figure = node('figure', 'analysis-signet-plot');
    const picture = node('img', '');
    picture.src = image.url;
    picture.alt = translateUI(`${names[image.kind]}（子網路 ${image.subnetwork}）`);
    figure.append(picture, node('figcaption', '', `${names[image.kind]}（子網路 ${image.subnetwork}）`));
    section.append(figure);
  }
  if (!images.some(image => image.kind !== 'circular')) {
    section.append(node('p', 'analysis-result-note', 'STRING 這次沒有找到顯著的富集路徑，所以 SIGNET 沒有產生富集分析圖。'));
  }
  return section;
}

// Every exported connection, most stable first; gene names are shown as they are, never translated.
function edgeTable(edges) {
  const section = node('section', 'analysis-result-section');
  section.append(node('h3', '', '連線表'),
    node('p', 'analysis-result-note', '依重抽樣出現比例由高到低排列；比例越高越穩定。係數為正代表促進，為負代表抑制。'));
  const search = node('input', 'analysis-edge-search');
  search.type = 'search';
  search.setAttribute('placeholder', translateUI('搜尋基因'));
  search.dataset.i18nPlaceholder = '搜尋基因';
  search.setAttribute('aria-label', translateUI('搜尋基因'));
  search.dataset.i18nAria = '搜尋基因';
  const count = node('p', 'analysis-result-note');
  const scroller = node('div', 'analysis-edge-scroll');
  const table = node('table', 'analysis-edge-table');
  const head = node('tr', '');
  for (const label of ['調控基因', '目標基因', '出現比例', '係數']) head.append(node('th', '', label));
  const thead = node('thead', '');
  thead.append(head);
  const body = node('tbody', '');
  const sorted = [...edges].sort((a, b) => b.frequency - a.frequency
    || Math.abs(b.coefficient) - Math.abs(a.coefficient) || a.source.localeCompare(b.source));
  const rows = sorted.map(edge => {
    const row = node('tr', '');
    for (const value of [edge.source, edge.target, shortNumber(edge.frequency), shortNumber(edge.coefficient)]) {
      const cell = node('td', '');
      cell.textContent = value;
      row.append(cell);
    }
    return {row, genes:(edge.source + ' ' + edge.target).toLowerCase()};
  });
  function filter() {
    const query = search.value.trim().toLowerCase();
    let shown = 0;
    for (const {row, genes} of rows) {
      row.hidden = Boolean(query) && !genes.includes(query);
      if (!row.hidden) shown++;
    }
    uiText(count, `顯示 ${shown}/${rows.length} 條連線`);
  }
  body.append(...rows.map(({row}) => row));
  table.append(thead, body);
  scroller.append(table);
  search.addEventListener('input', filter);
  filter();
  section.append(search, count, scroller);
  return section;
}

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

  const originalImages = result => (result.images || []).filter(({kind, url}) =>
    ['circular', 'enrichment_hist', 'enrichment_radar'].includes(kind)
    && /^\/signet\/result-preview\/[A-Za-z0-9_-]{32}\/signet_[a-z_]+_top[1-9][0-9]*_freq[0-9.eE+-]+\.png$/.test(url));

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
      const extras = [];
      extras.push(signetPlots(originalImages(result)));
      if (result.thresholds?.length) extras.push(thresholdChart(result.thresholds));
      if (result.graph.edges?.length) extras.push(edgeTable(result.graph.edges));
      controls.before(...extras);
      drawn = true;
    } catch (_) {
      if (!state.controller.signal.aborted && !removed) uiText(status, '暫時無法載入網路圖。');
    } finally {
      loading = false;
    }
  }

  return {show, remove() {removed = true; card.remove();}};
}
