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
const metadata = value => ({history_id: value.historyId, identity: value.identity, revision: value.revision,
  source: value.source, run_id: value.runId, frequency: .8, top_networks: 2, download_available: true,
  previews: [1, 2].map(subnetwork => ({subnetwork, url: `/stage6/result-preview/${'p'.repeat(32)}/signet_top${subnetwork}_freq0.8.html`})),
  plots: [{kind: 'circular', subnetwork: 1, url: null, pdf: 'signet_circular_top1_freq0.8.pdf'}],
  thresholds: [{cutoff: .8, genes: 3, connections: 2}, {cutoff: 1, genes: 2, connections: 1}]});
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
  window.eval(readFileSync(path.join(folder, 'result-assets.js'), 'utf8'));
  const controller = window.mountStage6Assets({stage, token: 'page-secret'});
  const q = selector => stage.querySelector(selector);
  const open = () => { q('.s6-original-results').open = true; q('.s6-original-results').dispatchEvent(new window.Event('toggle')); };
  return {window, stage, controller, calls, downloads, q, open, tbody};
}

test('original controls load lazily, switch original subnetworks and isolate the frame', async t => {
  const h = harness(t); h.controller.setContext(context());
  assert.equal(h.calls.length, 0); h.open();
  await until(() => h.q('.s6-original-select select'));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.headers['X-Chat-Token'], 'page-secret');
  assert.match(h.calls[0].url, /revision=b{64}/);
  const select = h.q('.s6-original-select select'); select.value = '2'; select.dispatchEvent(new h.window.Event('change'));
  [...h.q('.s6-original-content').querySelectorAll('button')].find(button => button.textContent === '檢視原始網路').click();
  const frame = h.q('iframe'); assert.ok(frame);
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(frame.referrerPolicy, 'no-referrer');
  assert.match(frame.src, /signet_top2_freq0.8.html$/);
  assert.equal(h.q('.s6-original-dialog').open, true);
  h.controller.clear();
  assert.equal(h.q('.s6-original-dialog').open, false);
  assert.equal(h.q('iframe'), null);
  assert.equal(h.q('.s6-original-results').hidden, true);
});

test('a late live metadata response cannot replace an archive context with the same run name', async t => {
  let finishLive;
  const h = harness(t, url => url.includes('/workspace--') ? new Promise(resolve => finishLive = resolve) : metadata(context('archive')));
  h.controller.setContext(context()); h.open(); await until(() => finishLive);
  const oldSignal = h.calls[0].options.signal;
  h.controller.setContext(context('archive'));
  await until(() => h.q('.s6-original-select'));
  assert.equal(oldSignal.aborted, true);
  finishLive(metadata(context())); await flush();
  const pdf = [...h.q('.s6-original-content').querySelectorAll('button')].find(button => button.textContent === '下載原始 PDF');
  // Switch again while the download is pending; no stale anchor may be clicked.
  let finishDownload;
  h.window.fetch = async (url, options) => ({ok: true, json: async () => new Promise(resolve => finishDownload = resolve)});
  pdf.click(); await until(() => finishDownload);
  h.controller.setContext(context('live', 'next'));
  finishDownload({url: `/stage6/result-download?ticket=${'t'.repeat(32)}`}); await flush();
  assert.equal(h.downloads.length, 0);
});

test('original PDF download is explicit and keeps source, identity, revision and filename', async t => {
  const value = context('archive');
  const h = harness(t, (url) => url.endsWith('/download') ? {url: `/stage6/result-download?ticket=${'t'.repeat(32)}`} : metadata(value));
  h.controller.setContext(value); h.open(); await until(() => h.q('.s6-original-plot button'));
  h.q('.s6-original-plot button').click(); await until(() => h.downloads.length);
  const call = h.calls.find(call => call.body);
  assert.match(call.url, /archive--same/);
  assert.deepEqual(call.body, {identity: value.identity, revision: value.revision, asset: 'signet_circular_top1_freq0.8.pdf'});
  assert.equal(h.downloads[0], `http://127.0.0.1:1234/stage6/result-download?ticket=${'t'.repeat(32)}`);
  assert.equal(h.q('iframe'), null);
});

test('search and sort apply to gene-selected rows, survive replacement and translate without changing selection', async t => {
  const h = harness(t); h.controller.setContext(context());
  const search = h.q('.s6-table-tools input'), sort = h.q('.s6-table-tools select');
  search.value = 'megf6'; search.dispatchEvent(new h.window.Event('input'));
  assert.equal([...h.tbody.rows].filter(row => !row.hidden).length, 2);
  sort.value = 'frequency'; sort.dispatchEvent(new h.window.Event('change'));
  assert.equal(h.tbody.rows[0].cells[0].textContent, 'A');
  assert.equal(h.q('td[data-focused=true]').textContent, 'MEGF6');
  h.tbody.innerHTML = '<tr><td data-focused="true">MEGF6</td><td>NEW</td><td>0.99</td><td>0.1</td></tr><tr><td>X</td><td>Y</td><td>1</td><td>0.2</td></tr>';
  await flush(); assert.equal([...h.tbody.rows].filter(row => !row.hidden).length, 1);
  h.stage.closest('[lang]').lang = 'en'; await flush();
  assert.equal(search.placeholder, 'Search connections');
  assert.equal(h.q('.s6-original-results summary').textContent, 'Original analysis results');
  assert.equal(h.q('td[data-focused=true]').textContent, 'MEGF6');
  assert.equal(search.value, 'megf6');
});

test('missing exports and matrix stay explicit, and foreign preview URLs are never opened', async t => {
  const value = metadata(context()); value.previews[0].url = 'https://example.invalid/widget.html'; value.plots = []; value.thresholds = null;
  const h = harness(t, () => value); h.controller.setContext(context()); h.open(); await until(() => h.q('.s6-original-select'));
  [...h.q('.s6-original-content').querySelectorAll('button')].find(button => button.textContent === '檢視原始網路').click();
  assert.equal(h.q('iframe'), null);
  assert.match(h.q('.s6-original-content').textContent, /未保留原始頻率矩陣/);
  assert.equal(h.q('.s6-cutoff-counts'), null);
  assert.equal(h.q('.s6-cutoff-chart'), null);
});

test('cutoff chart uses only complete real count pairs and keeps readable bilingual axes and legend', async t => {
  const value = metadata(context()), h = harness(t, () => value);
  h.controller.setContext(context()); h.open(); await until(() => h.q('.s6-cutoff-chart'));
  const points = () => [...h.q('.s6-cutoff-chart').querySelectorAll('circle')].map(point => [point.dataset.series, Number(point.dataset.cutoff), Number(point.dataset.count)]);
  assert.deepEqual(points(), [['genes', .8, 3], ['genes', 1, 2], ['connections', .8, 2], ['connections', 1, 1]]);
  assert.equal(h.q('.s6-cutoff-chart svg').getAttribute('role'), 'img');
  assert.match(h.q('.s6-cutoff-chart').textContent, /重抽樣頻率門檻/);
  assert.match(h.q('.s6-cutoff-legend').textContent, /基因.*連線/);
  assert.equal(h.q('.s6-cutoff-counts tbody').rows.length, 2);
  h.stage.closest('[lang]').lang = 'en'; await flush();
  assert.match(h.q('.s6-cutoff-chart').textContent, /Bootstrap frequency cutoff/);
  assert.match(h.q('.s6-cutoff-legend').textContent, /Genes.*Connections/);
  assert.equal(points().length, 4);
  value.thresholds = [{cutoff: .8, genes: 3, connections: null}, {cutoff: 1, genes: 2, connections: 1}];
  [...h.q('.s6-original-actions').querySelectorAll('button')].find(button => button.textContent === 'Refresh').click();
  await until(() => !h.q('.s6-cutoff-chart'));
  await flush();
  assert.equal(h.q('.s6-cutoff-counts'), null);
  assert.match(h.q('.s6-original-content').textContent, /cutoff counts are unavailable/);
});
