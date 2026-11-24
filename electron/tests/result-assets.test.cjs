'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const folder = path.join(__dirname, '../renderer/features/workspace');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check) { for (let i = 0; i < 80; i++) { if (check()) return; await flush(); } assert.fail('Original result controls did not settle'); }
const context = (source = 'live', runId = 'same') => ({historyId: `${source === 'live' ? 'workspace' : source}--${runId}`,
  source, runId, identity: 'a'.repeat(64), revision: 'b'.repeat(64)});
const preview = name => `/stage6/result-preview/${'p'.repeat(32)}/${name}`;
const subnetwork = number => ({number, genes: 3, edges: 2, enrichment_terms: false, modularity_groups: 2,
  networks: Object.fromEntries(['enrichment', 'modularity'].map(criterion => [criterion, preview(`signet_dashboard_freq0.8_top${number}_${criterion}.html`)])),
  missing: {enrichment_radar: {code: 'too_few', category: 'KEGG', count: 0, minimum: 4},
    enrichment_hist: {code: 'too_few', category: 'Process', count: 2, minimum: 5}},
  pathway: number === 2 ? [{description: 'Cell cycle, Term: GO:1', p_value: 1e-4, text: 'Related genes: D,E'},
    {description: 'Mitosis, Term: GO:2', p_value: 1e-2, text: 'Related genes: D'}] : [],
  table: {columns: ['source gene', 'source chr', 'source start', 'source end', 'target gene', 'target chr', 'target start', 'target end'],
    rows: [['MEGF6', '1', 100, 200, 'Z', '1', 300, 400], ['A', '1', 10, 20, 'MEGF6', '1', 100, 200]]}});
const metadata = value => ({history_id: value.historyId, identity: value.identity, revision: value.revision,
  source: value.source, run_id: value.runId, frequency: .8, top_networks: 2, download_available: true,
  previews: [1, 2].map(subnetwork => ({subnetwork, url: preview(`signet_top${subnetwork}_freq0.8.html`)})),
  plots: [{kind: 'circular', subnetwork: 1, url: null, pdf: 'signet_circular_top1_freq0.8.pdf'}],
  thresholds: [{cutoff: .8, genes: 3, connections: 2}, {cutoff: 1, genes: 2, connections: 1}],
  dashboard: {available: true, reason: null, summary: {subnetworks: 2, genes: 5, edges: 4},
    top_nodes: [{gene: 'MEGF6', degree: 3, subnetwork: 1}, {gene: 'D', degree: 2, subnetwork: 2}, {gene: 'B', degree: 1, subnetwork: 1}],
    ppi: Array.from({length: 25}, (_, index) => ({protein1: `P${index + 1}`, protein2: 'MEGF6', score: 900 - index})),
    subnetworks: [subnetwork(1), subnetwork(2)]}});
function harness(t, respond = () => metadata(context())) {
  const dom = new JSDOM(readFileSync(path.join(folder, 'index.html'), 'utf8'), {url: 'http://127.0.0.1:1234/', runScripts: 'outside-only'});
  t.after(() => dom.window.close());
  const {window} = dom, calls = [], downloads = [];
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.href); };
  window.fetch = async (url, options = {}) => {
    calls.push({url, options, body: options.body ? JSON.parse(options.body) : null});
    return {ok: true, json: async () => respond(url, options)};
  };
  const stage = window.document.querySelector('#lens-stage6'); stage.hidden = false;
  const tbody = stage.querySelector('tbody');
  tbody.innerHTML = '<tr><td data-focused="true">MEGF6</td><td>Z</td><td>0.8</td><td>-0.9</td></tr><tr><td>A</td><td>MEGF6</td><td>1</td><td>0.2</td></tr><tr><td>B</td><td>C</td><td>0.9</td><td>-0.4</td></tr>';
  window.eval(readFileSync(path.join(folder, 'stage6-dashboard.js'), 'utf8'));
  window.eval(readFileSync(path.join(folder, 'result-assets.js'), 'utf8'));
  const controller = window.mountStage6Assets({stage, token: 'page-secret'});
  const q = selector => stage.querySelector(selector), all = selector => [...stage.querySelectorAll(selector)];
  const open = () => { q('.s6-original-results').open = true; q('.s6-original-results').dispatchEvent(new window.Event('toggle')); };
  const press = (text, scope = '.s6-original-content') => all(`${scope} button`).find(button => button.textContent === text).click();
  const dashboard = async () => { await until(() => all('.s6-original-content button').some(b => b.textContent === 'Open SIGNET dashboard'));
    press('Open SIGNET dashboard'); await until(() => q('.s6-dash-tabs')); };
  const tab = name => press(name, '.s6-dash-tabs');
  return {window, stage, controller, calls, downloads, q, all, open, press, dashboard, tab, tbody};
}

test('the dashboard loads lazily and shows the Network Summary like the Shiny tab', async t => {
  const h = harness(t); h.controller.setContext(context());
  assert.equal(h.calls.length, 0); h.open(); await h.dashboard();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.headers['X-Chat-Token'], 'page-secret');
  assert.match(h.calls[0].url, /revision=b{64}/);
  assert.equal(h.q('.s6-original-dialog').open, true);
  assert.deepEqual(h.all('.s6-dash-tabs button').map(b => [b.textContent, b.getAttribute('aria-selected')]),
    [['Network Summary', 'true'], ['Enrichment Analysis', 'false'], ['Circular Plot', 'false']]);
  assert.equal(h.q('.s6-dash-headline').textContent, 'There are a total of 2 subnetworks with 5 genes and 4 regulation effects in the network');
  // plotly draws the first factor level (smallest degree) at the bottom; red marks the largest degree.
  const bars = h.all('.s6-dash-bar');
  assert.deepEqual(bars.map(bar => bar.querySelector('text').textContent), ['MEGF6', 'D', 'B']);
  assert.equal(bars[0].querySelector('rect').getAttribute('fill'), 'rgba(255, 0, 0, 0.4)');
  assert.match(bars[0].querySelector('title').textContent, /Subnetwork number:1/);
  // Top Edges is a 20-row page, searchable and sortable like DT.
  const edges = h.all('.s6-dash-box')[1];
  assert.equal(edges.querySelectorAll('tbody tr').length, 20);
  assert.match(edges.querySelector('.s6-dt-footer').textContent, /Showing 1 to 20 of 25 entries/);
  [...edges.querySelectorAll('button')].find(b => b.textContent === 'Next').click();
  assert.equal(edges.querySelectorAll('tbody tr').length, 5);
  const search = edges.querySelector('input'); search.value = 'p2'; search.dispatchEvent(new h.window.Event('input'));
  assert.match(edges.querySelector('.s6-dt-footer').textContent, /of 7 entries \(filtered from 25 total entries\)/);
  edges.querySelectorAll('th')[3].click();
  assert.equal(edges.querySelector('tbody tr').cells[1].textContent, 'P25');
  assert.ok(h.q('.s6-cutoff-chart'));
  h.controller.clear();
  assert.equal(h.q('.s6-original-dialog').open, false);
  assert.equal(h.q('.s6-dash-tabs'), null);
  assert.equal(h.q('.s6-original-results').hidden, true);
});

test('Enrichment Analysis switches subnetwork and criterion, isolates the frame and sends uploaded genes to it', async t => {
  const h = harness(t); h.controller.setContext(context()); h.open(); await h.dashboard();
  h.tab('Enrichment Analysis');
  let frame = h.q('iframe.s6-dash-network');
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(frame.referrerPolicy, 'no-referrer');
  assert.match(frame.src, /signet_dashboard_freq0\.8_top1_modularity\.html$/);
  assert.match(h.q('.s6-dash-pathway').textContent, /No enrichment detected/);
  assert.match(h.q('.s6-dash-figures').textContent, /KEGG radar only with at least 4 enriched terms; STRING found none/);
  assert.match(h.q('.s6-dash-figures').textContent, /Process histogram only with at least 5 enriched terms; STRING found 2/);
  const select = h.q('.s6-dash-controls select'); select.value = '2'; select.dispatchEvent(new h.window.Event('change'));
  assert.match(h.q('iframe.s6-dash-network').src, /top2_modularity\.html$/);
  assert.equal(h.all('.s6-dash-pathway rect').length, 3);
  assert.match(h.q('.s6-dash-pathway title').textContent, /Related genes: D,E/);
  const enrichment = h.all('.s6-dash-radio input').find(input => input.value === 'enrichment');
  enrichment.checked = true; enrichment.dispatchEvent(new h.window.Event('change'));
  frame = h.q('iframe.s6-dash-network');
  assert.match(frame.src, /top2_enrichment\.html$/);
  assert.match(h.q('.s6-dash-main').textContent, /no choices/);
  const file = h.q('.s6-dash-file input');
  Object.defineProperty(file, 'files', {value: [{name: 'genes.txt', text: async () => 'D\nE  D\n'}]});
  file.dispatchEvent(new h.window.Event('change')); await flush(); await flush();
  frame = h.q('iframe.s6-dash-network');
  const sent = []; Object.defineProperty(frame, 'contentWindow', {value: {postMessage: (message, target) => sent.push([message, target])}});
  frame.dispatchEvent(new h.window.Event('load'));
  assert.equal(JSON.stringify(sent), JSON.stringify([[{signetGenes: ['D', 'E']}, '*']]));
  assert.match(h.q('.s6-dash-controls').textContent, /2 genes read from genes.txt/);
  h.press('Clear gene list', '.s6-dash-controls');
  frame = h.q('iframe.s6-dash-network'); sent.length = 0;
  Object.defineProperty(frame, 'contentWindow', {value: {postMessage: (message) => sent.push(message)}});
  frame.dispatchEvent(new h.window.Event('load'));
  assert.deepEqual(sent, []);
  h.q('.s6-original-dialog').close();
  assert.equal(h.q('iframe'), null);
});

test('a late live metadata response cannot replace an archive context with the same run name', async t => {
  let finishLive;
  const h = harness(t, url => url.includes('/workspace--') ? new Promise(resolve => finishLive = resolve) : metadata(context('archive')));
  h.controller.setContext(context()); h.open(); await until(() => finishLive);
  const oldSignal = h.calls[0].options.signal;
  h.controller.setContext(context('archive'));
  await h.dashboard();
  assert.equal(oldSignal.aborted, true);
  finishLive(metadata(context())); await flush();
  assert.match(h.q('.s6-original-dialog strong').textContent, /same/);
  h.tab('Circular Plot');
  const pdf = h.all('.s6-dash-box button').find(button => button.textContent === 'Download original PDF');
  // Switch again while the download is pending; no stale anchor may be clicked.
  let finishDownload;
  h.window.fetch = async (url, options) => ({ok: true, json: async () => new Promise(resolve => finishDownload = resolve)});
  pdf.click(); await until(() => finishDownload);
  h.controller.setContext(context('live', 'next'));
  finishDownload({url: `/stage6/result-download?ticket=${'t'.repeat(32)}`}); await flush();
  assert.equal(h.downloads.length, 0);
});

test('Circular Plot downloads the original PDF and lists the edge positions', async t => {
  const value = context('archive');
  const h = harness(t, (url) => url.endsWith('/download') ? {url: `/stage6/result-download?ticket=${'t'.repeat(32)}`} : metadata(value));
  h.controller.setContext(value); h.open(); await h.dashboard(); h.tab('Circular Plot');
  assert.match(h.q('.s6-dash-box').textContent, /No image preview was retained; the original PDF is available/);
  const table = h.all('.s6-dash-box')[1];
  assert.equal(table.querySelector('h4').textContent, 'Nodes and regulation information summary');
  assert.deepEqual([...table.querySelectorAll('th')].map(th => th.textContent).slice(1, 3), ['source gene', 'source chr']);
  assert.equal(table.querySelectorAll('tbody tr').length, 2);
  h.all('.s6-dash-box button').find(button => button.textContent === 'Download original PDF').click();
  await until(() => h.downloads.length);
  const call = h.calls.find(call => call.body);
  assert.match(call.url, /archive--same/);
  assert.deepEqual(call.body, {identity: value.identity, revision: value.revision, asset: 'signet_circular_top1_freq0.8.pdf'});
  assert.equal(h.downloads[0], `http://127.0.0.1:1234/stage6/result-download?ticket=${'t'.repeat(32)}`);
  assert.equal(h.q('iframe'), null);
});

test('search and sort apply to gene-selected rows without changing selection when rows are replaced', async t => {
  const h = harness(t); h.controller.setContext(context());
  const search = h.q('.s6-table-tools input'), sort = h.q('.s6-table-tools select');
  search.value = 'megf6'; search.dispatchEvent(new h.window.Event('input'));
  assert.equal([...h.tbody.rows].filter(row => !row.hidden).length, 2);
  sort.value = 'frequency'; sort.dispatchEvent(new h.window.Event('change'));
  assert.equal(h.tbody.rows[0].cells[0].textContent, 'A');
  assert.equal(h.q('td[data-focused=true]').textContent, 'MEGF6');
  h.tbody.innerHTML = '<tr><td data-focused="true">MEGF6</td><td>NEW</td><td>0.99</td><td>0.1</td></tr><tr><td>X</td><td>Y</td><td>1</td><td>0.2</td></tr>';
  await flush(); assert.equal([...h.tbody.rows].filter(row => !row.hidden).length, 1);
  assert.equal(search.placeholder, 'Search connections');
  assert.equal(h.q('.s6-original-results summary').textContent, 'Original analysis results');
  assert.equal(h.q('td[data-focused=true]').textContent, 'MEGF6');
  assert.equal(search.value, 'megf6');
});

test('missing exports and matrix stay explicit, and foreign preview URLs are never opened', async t => {
  const value = metadata(context()); value.plots = []; value.thresholds = null;
  value.dashboard = {available: false, reason: {code: 'not_exported'}, summary: null, top_nodes: [], ppi: [],
    subnetworks: [{number: 1, networks: {enrichment: 'https://example.invalid/widget.html', modularity: null},
      missing: {circular: {code: 'missing'}, enrichment_radar: {code: 'not_recorded', category: 'KEGG'}}}]};
  const h = harness(t, () => value); h.controller.setContext(context()); h.open(); await h.dashboard();
  assert.match(h.q('.s6-dash-body').textContent, /finished before the dashboard export was added\. Rerun Stage 6/);
  assert.match(h.q('.s6-dash-body').textContent, /The original frequency matrix was not retained/);
  assert.equal(h.q('.s6-cutoff-chart'), null);
  h.tab('Enrichment Analysis');
  for (const criterion of ['modularity', 'enrichment']) {
    const input = h.all('.s6-dash-radio input').find(input => input.value === criterion);
    input.checked = true; input.dispatchEvent(new h.window.Event('change'));
    assert.equal(h.q('iframe'), null);
  }
  assert.match(h.q('.s6-dash-figures').textContent, /KEGG term list was not saved/);
  h.tab('Circular Plot');
  assert.match(h.q('.s6-dash-body').textContent, /The figure file is missing from this run/);
});

test('an HPC3 export failure is shown with its reason', async t => {
  const value = metadata(context());
  value.dashboard = {available: false, reason: {code: 'export_failed', detail: 'could not find function "visNetwork"'}, summary: null,
    top_nodes: [], ppi: [], subnetworks: [{number: 1, networks: {enrichment: null, modularity: null}, missing: {}}]};
  const h = harness(t, () => value); h.controller.setContext(context()); h.open(); await h.dashboard();
  assert.match(h.q('.s6-dash-body').textContent, /could not be exported on HPC3: could not find function "visNetwork"/);
  h.tab('Enrichment Analysis');
  assert.match(h.q('.s6-dash-main').textContent, /The dashboard network was not exported for this subnetwork/);
});

test('cutoff chart uses only complete real count pairs and keeps accessible English axes and legend', async t => {
  const value = metadata(context()), h = harness(t, () => value);
  h.controller.setContext(context()); h.open(); await h.dashboard();
  const points = () => [...h.q('.s6-cutoff-chart').querySelectorAll('circle')].map(point => [point.dataset.series, Number(point.dataset.cutoff), Number(point.dataset.count)]);
  assert.deepEqual(points(), [['genes', .8, 3], ['genes', 1, 2], ['connections', .8, 2], ['connections', 1, 1]]);
  assert.equal(h.q('.s6-cutoff-chart svg').getAttribute('role'), 'img');
  assert.equal(h.q('.s6-cutoff-counts tbody').rows.length, 2);
  assert.match(h.q('.s6-cutoff-chart').textContent, /Bootstrap frequency cutoff/);
  assert.match(h.q('.s6-cutoff-legend').textContent, /Genes.*Connections/);
  value.thresholds = [{cutoff: .8, genes: 3, connections: null}, {cutoff: 1, genes: 2, connections: 1}];
  h.press('Refresh', '.s6-original-actions');
  await until(() => !h.q('.s6-cutoff-chart'));
  await flush();
  assert.equal(h.q('.s6-cutoff-counts'), null);
  assert.match(h.q('.s6-dash-body').textContent, /cutoff counts are unavailable/);
});
