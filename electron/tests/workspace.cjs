'use strict';

const assert = require('node:assert/strict');
const {randomBytes} = require('node:crypto');
const {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app, BrowserWindow, screen} = require('electron');

const temporary = mkdtempSync(path.join(os.tmpdir(), 'signet-workspace-test-'));
app.setPath('appData', temporary);
const stateFile = path.join(temporary, 'SIGNET Research Assistant', 'state', '.chat-state.json');
const existingSession = '19579628-cff7-48b1-8a7e-e275eff4272c';
const existingMessage = 'Retained workspace conversation';
const existingActivity = 'Retained workspace activity';
const firstMessage = 'Workspace test question';
const nextMessage = 'Workspace test follow-up';
const captureFile = path.join(temporary, 'provider-capture.ndjson');
mkdirSync(path.dirname(stateFile), {recursive: true});
writeFileSync(stateFile, JSON.stringify({token: randomBytes(32).toString('hex'),
  active_session: existingSession, histories: {[existingSession]: [{role: 'user', parts: [{text: existingMessage}]}]},
  events: {[existingSession]: [[existingActivity]]}}));

// Exercise the original Agent with a deterministic local model CLI.
writeFileSync(path.join(temporary, 'codex'), `#!/usr/bin/env python3
import json, os, sys

prompt = json.load(sys.stdin)
messages = prompt['messages']
with open(os.environ['SIGNET_WORKSPACE_TEST_CAPTURE'], 'a') as result:
    result.write(json.dumps(messages) + '\\n')

def emit(event):
    print(json.dumps(event), flush=True)

emit({'type': 'turn.started'})
answer = {'answer': 'Provider replied to: ' + messages[-1]['content'], 'decision_summary': '', 'tool_calls': []}
emit({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': json.dumps(answer)}})
emit({'type': 'turn.completed', 'usage': {'input_tokens': 30, 'output_tokens': 10}})
`, {mode: 0o700});
process.env.PATH = [temporary, process.env.PATH].filter(Boolean).join(path.delimiter);
process.env.SIGNET_WORKSPACE_TEST_CAPTURE = captureFile;

const archiveDir = path.resolve(__dirname, '../../data/stage6-results');
const datasetDir = path.resolve(archiveDir, '../datasets');
const useArchivedRuns = process.argv.includes('--archived-run');
const fixturePaths = [];

function cleanup() {
  clearTimeout(deadline);
  for (const fixture of fixturePaths.reverse()) rmSync(fixture, {recursive: true, force: true});
  rmSync(temporary, {recursive: true, force: true});
}

function fail(error) {
  console.error(error);
  cleanup();
  app.exit(1);
}

const deadline = setTimeout(() => fail(Error('Workspace startup and chat test timed out')), 45000);
app.on('will-quit', cleanup);

function createHistoryFixture() {
  const name = path.basename(temporary);
  const groups = [
    {id: name + '-a', name: ['測試資料甲', 'Test dataset A'], inputs: {genotype: ['current-a.ped'], expression: ['current-a-expression'], clinical: []}},
    {id: name + '-b', name: ['測試資料乙', 'Test dataset B'], inputs: {genotype: ['current-b.ped'], expression: [], clinical: []}},
  ];
  mkdirSync(datasetDir, {recursive: true});
  mkdirSync(archiveDir, {recursive: true});
  for (const dataset of groups) {
    const filename = path.join(datasetDir, dataset.id + '.json');
    writeFileSync(filename, JSON.stringify(dataset), {flag: 'wx'});
    fixturePaths.push(filename);
  }

  const examples = [
    {group: 0, pairs: [['MEGF6', 'LRRC40'], ['ABCD3', 'MEGF6'], ['MEGF6', 'ABCD3'], ['LRRC40', 'CLK2']]},
    {group: 0, pairs: [['MEGF6', 'CYP4Z1'], ['CHD5', 'CYP4Z1']]},
    {group: 1, pairs: [['MEGF6', 'PGD'], ['PGD', 'MEGF6']]},
  ];
  const runs = examples.map(({group, pairs}, index) => {
    const run_id = name + '-run-' + index;
    const snapshot = {
      run_id, dataset_id: groups[group].id, name: ['封存執行 ' + index, 'Saved run ' + index],
      inputs: {
        genotype: ['archived-' + index + '.ped', 'archived-' + index + '.map'],
        expression: ['archived-expression-' + index],
        clinical: ['archived-clinical-' + index + '.tsv'],
      },
    };
    const genes = new Set(pairs.flat()).size;
    const connections = pairs.length;
    const folder = path.join(archiveDir, run_id);
    mkdirSync(folder);
    fixturePaths.push(folder);
    writeFileSync(path.join(folder, 'history.json'), JSON.stringify(snapshot));
    const npc = 2 + index;
    const matching = {genotype: 9, expression: 8, matched: 5, retained: 4, excluded: 1, variants: 20 + index, genes};
    const comparison = {before_sd: 0.5, covariates_sd: 0.4, after_sd: (index + 2) / 10};
    const stage3 = {run_id, npc, matching, comparison, pca: {
      points: [[-2, -1], [-1, 2], [1, -2], [2, 1]],
      variance_explained: [40, 20],
      source: 'retained_genotype',
    }};
    writeFileSync(path.join(folder, 'stage3.json'), JSON.stringify(stage3));
    writeFileSync(path.join(folder, 'verification.json'), JSON.stringify({
      run: run_id,
      jobs: {
        adjust: {state: 'completed', options: {npc}, finished_at: '2026-11-11T01:03:00-0800'},
        visualize: {state: 'completed', settings: {freq: '0.45', ntop: '1'},
          submitted_at: '2026-11-11T01:04:38-0800', finished_at: '2026-11-11T01:07:11-0800'},
      },
      graph: {connections, genes, subnetworks: 1, displayed: 1},
    }));
    writeFileSync(path.join(folder, 'signet_edgelist_0.45.txt'), [
      'source_gene_symbol,target_gene_symbol,frequency,coefficient',
      ...pairs.map(pair => [...pair, 0.5, -0.2].join(',')),
      '',
    ].join('\n'));
    const incidentPairs = pairs.filter(pair => pair.includes('MEGF6'));
    return {...snapshot, genes, connections, incident: incidentPairs.length, incidentPairs, stage3};
  });
  return {groups, runs};
}

function readArchivedHistory() {
  const read = filename => JSON.parse(readFileSync(filename, 'utf8'));
  const groups = ['example-chr1', 'simulated-cohort-b'].map(id => read(path.join(datasetDir, id + '.json')));
  const runs = [
    ['official-example-chr1-20261111', 731, 13, 1110, 0.93366491],
    ['official-example-chr1-stage-cards-20261111', 726, 10, 1112, 0.93373123],
    ['official-example-chr1-english-20261111', 706, 9, 1110, 0.93348844],
  ].map(([run_id, connections, incident, variants, after_sd]) => ({
    ...read(path.join(archiveDir, run_id, 'history.json')), genes: 95, connections, incident,
    stage3: {
      npc: 3,
      matching: {genotype: 560, expression: 554, matched: 473, retained: 471, excluded: 2, variants, genes: 95},
      comparison: {before_sd: 0.93990024, covariates_sd: 0.93650323, after_sd},
    },
  }));
  return {groups, runs};
}

let history;
try {
  history = useArchivedRuns ? readArchivedHistory() : createHistoryFixture();
} catch (error) { fail(error); }

async function verifyWorkspace({groups, runs}) {
  const find = selector => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Workspace is missing ${selector}`);
    return element;
  };
  const click = selector => {
    const element = find(selector);
    if (element instanceof HTMLElement) element.click();
    else element.dispatchEvent(new MouseEvent('click', {bubbles: true}));
  };
  const go = view => click(`[data-nav-target="${view}"]`);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const visible = selector => Boolean(find(selector).getClientRects().length);
  const waitFor = async (condition, description) => {
    const end = Date.now() + 10000;
    while (!condition()) {
      check(Date.now() < end, description);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const datasetPicker = find('#ml-dataset-select');
  const stage3 = find('#lens-history-stage3');
  const stage6 = find('#lens-stage6');
  const resultPicker = find('#ml-stage6-run');
  const selectDataset = id => {
    datasetPicker.value = id;
    datasetPicker.dispatchEvent(new Event('change', {bubbles: true}));
  };
  const resultIds = () => [...resultPicker.options].map(option => option.value).filter(Boolean).sort();
  const historyIds = () => [...document.querySelectorAll('#ml-run-list [data-run-target]')]
    .filter(button => button.getClientRects().length).map(button => button.dataset.runTarget).sort();
  const countRows = () => stage6.querySelectorAll('tbody tr').length;
  const expectedList = group => runs.filter(run => run.dataset_id === group.id);
  const stageButton = (stage) => `[data-stage="${stage}"]`;
  function showStage(stage) {
    if (!visible(stageButton(stage))) click('#ml-stage-tab');
    click(stageButton(stage));
  }

  await waitFor(() => [...datasetPicker.options].some(option => option.value === groups[0].id),
    'Dataset catalog failed to load');
  for (const group of groups) {
    const groupRuns = expectedList(group);
    const runIds = groupRuns.map(run => run.run_id).sort();
    go('data');
    selectDataset(group.id);
    check(datasetPicker.value === group.id, 'Could not select dataset ' + group.id);
    const current = find('#ml-input-genotype [data-current-files]').textContent;
    check(group.inputs.genotype.every(file => current.includes(file)), 'Dataset showed the wrong current files');
    if (group.id === 'example-chr1') {
      click('#ml-input-genotype [data-input-replace]');
      click('#ml-file-picker input[value="1"]');
      click('[data-input-apply]');
      check(find('#ml-input-genotype [data-current-files]').textContent.includes('study-qc-preview.ped'),
        'Could not select alternate draft files to test the saved history');
    }
    check(JSON.stringify(resultIds()) === JSON.stringify(runIds), 'Stage 6 picker showed another dataset’s runs');

    go('history');
    check(JSON.stringify(historyIds()) === JSON.stringify(runIds), 'History showed another dataset’s runs');
    if (!groupRuns.length) {
      check(visible('#ml-empty-history') && !visible('#lens-stage6'), 'The unused dataset inherited a result');
      continue;
    }

    for (const run of groupRuns) {
      click(`[data-run-target="${run.run_id}"]`);
      const detail = `#ml-run-${run.run_id}`;
      const archive = find(`${detail} .ml-run-inputs`);
      if (!archive.open) archive.querySelector('summary').click();
      const names = [...archive.querySelectorAll('code')].map(file => file.textContent);
      const original = ['genotype', 'expression', 'clinical'].flatMap(kind => run.inputs[kind]);
      check(visible(detail) && JSON.stringify(names) === JSON.stringify(original),
        'Run did not show its own saved input files: ' + run.run_id);

      const adjustment = `[data-run-adjustment="${run.run_id}"]`;
      click(adjustment);
      await waitFor(() => stage3.dataset.runState === 'ready' && stage3.dataset.runId === run.run_id,
        'Could not load Stage 3 from history: ' + run.run_id);
      check(visible('#lens-history-stage3 .s3-chart'), 'Selected Stage 3 chart is hidden');
      check(!visible(detail), 'Run detail remained visible in Stage 3');
      check(!visible('#lens-stage6'), 'Stage 6 remained visible in Stage 3');
      const {npc, matching, comparison} = run.stage3;
      const numberFrom = selector => Number(stage3.querySelector(selector).textContent.trim().replaceAll(',', ''));
      check(numberFrom('[data-s3-components]') === npc, 'Wrong archived principal component setting');
      for (const [key, value] of Object.entries(matching)) {
        check(numberFrom(`[data-s3-count="${key}"]`) === value, 'Wrong Stage 3 matching count: ' + key);
      }
      check(stage3.querySelectorAll('.s3-points circle').length === matching.retained,
        'Stage 3 chart does not contain the retained samples');
      check(visible('#lens-history-stage3 [data-s3-difference]'), 'Stage 3 expression comparison is hidden');
      for (const kind of ['before', 'covariates', 'after']) {
        const displayed = numberFrom(`[data-s3-comparison="${kind}"] td:nth-child(2)`);
        check(displayed === Number(comparison[kind + '_sd'].toFixed(5)), 'Wrong Stage 3 expression comparison: ' + kind);
      }
      click('#lens-history-stage3 [data-run-back]');
      check(visible(detail) && !visible('#lens-history-stage3'), 'Back from Stage 3 did not restore the run detail');

      click(`[data-run-network="${run.run_id}"]`);
      await waitFor(() => stage6.dataset.runState === 'ready' && stage6.dataset.runId === run.run_id,
        'Could not load Stage 6 from history: ' + run.run_id);
      check(visible('#lens-stage6') && stage6.querySelectorAll('[data-gene]').length === run.genes &&
        countRows() === run.connections, 'History did not open the selected run’s graph and table');
      click('#lens-stage6 [data-gene="MEGF6"]');
      const selected = [...stage6.querySelectorAll('tbody tr')].map(row => [row.cells[0].textContent, row.cells[1].textContent]);
      check(selected.length === run.incident && selected.every(pair => pair.includes('MEGF6')),
        'MEGF6 did not filter to the selected run’s edges');
      if (run.incidentPairs) {
        check(JSON.stringify(selected.sort()) === JSON.stringify(run.incidentPairs.sort()),
          'A selected run lost or replaced a directed edge');
      }
      click('#lens-stage6 [data-run-back]');
      check(visible(detail) && !visible('#lens-stage6'), 'Back from Stage 6 did not restore the run detail');
    }
  }

  go('data');
  selectDataset(groups[0].id);
  go('analysis');
  showStage(6);
  const first = runs.find(run => run.dataset_id === groups[0].id);
  resultPicker.value = first.run_id;
  resultPicker.dispatchEvent(new Event('change', {bubbles: true}));
  await waitFor(() => stage6.dataset.runId === first.run_id && stage6.dataset.runState === 'ready',
    'Stage 6 picker did not reopen the original run');
  if (stage6.dataset.selectedGene !== 'MEGF6') click('#lens-stage6 [data-gene="MEGF6"]');
  if (groups[0].id === 'example-chr1') {
    showStage(3);
    check(visible('#lens-stage3') && !visible('#lens-stage6'), 'Stage 3 did not show its result');
    showStage(6);
    check(visible('#lens-stage6') && stage6.dataset.runId === first.run_id &&
      stage6.dataset.selectedGene === 'MEGF6' && countRows() === first.incident, 'Stage 6 lost the selected run or gene');
  } else {
    check(!visible(stageButton(3)), 'Another dataset inherited the example Stage 3 preview');
  }

  go('data');
  click('#ml-dataset-add');
  find('#ml-dataset-name').value = 'Third workspace dataset';
  click('#ml-dataset-create');
  check(datasetPicker.selectedOptions[0]?.textContent === 'Third workspace dataset', 'New dataset was not selected');
  click('#ml-language');
  check(datasetPicker.selectedOptions[0]?.textContent === 'Third workspace dataset', 'Language change lost the new dataset');
  go('history');
  check(!historyIds().length && visible('#ml-empty-history') && !resultIds().length, 'New dataset inherited saved runs');
}

async function verifyChat({existingMessage, existingActivity, firstMessage, nextMessage}) {
  const select = selector => document.querySelector(selector);
  const visible = selector => select(selector)?.innerText || '';
  const click = selector => select(selector).click();
  const waitFor = async (condition, description) => {
    const end = Date.now() + 10000;
    while (!condition()) {
      if (Date.now() > end) throw Error(description);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const contains = (selector, text) => visible(selector).includes(text);
  const expectChat = message => waitFor(() => contains('#ml-chat-transcripts', message), `Missing conversation text: ${message}`);
  const showActivity = async message => {
    click('#ml-chat-activity-toggle');
    await waitFor(() => contains('#ml-chat-events', message), `Missing activity: ${message}`);
    click('#ml-chat-activity-toggle');
  };
  const send = async message => {
    select('#ml-input').value = message;
    select('#ml-input').dispatchEvent(new Event('input', {bubbles: true}));
    click('#ml-send');
    await expectChat('Provider replied to: ' + message);
    await waitFor(() => !select('#ml-send').disabled, 'Send stayed disabled after the turn finished');
  };

  await expectChat(existingMessage);
  await showActivity(existingActivity);
  click('#ml-new');
  await waitFor(() => !contains('#ml-chat-transcripts', existingMessage), 'New chat kept the prior transcript');
  click('#ml-language');
  await send(firstMessage);
  click('#ml-language');
  await send(nextMessage);
  await showActivity('Codex');
  click('#ml-chat-list-toggle');
  await waitFor(() => contains('#ml-chat-records', existingMessage), 'Saved conversation disappeared after sending a new message');
  [...document.querySelectorAll('#ml-chat-records button')].find(button => button.textContent.includes(existingMessage)).click();
  await expectChat(existingMessage);
  click('#ml-chat-list-toggle');
  await waitFor(() => contains('#ml-chat-records', firstMessage), 'New conversation was not added to saved chats');
  [...document.querySelectorAll('#ml-chat-records button')].find(button => button.textContent.includes(firstMessage)).click();
  await expectChat('Provider replied to: ' + nextMessage);
}

app.once('browser-window-created', (_event, window) => {
  window.webContents.on('console-message', ({level, message, sourceId, lineNumber}) => {
    if (level === 'error') console.error(`${sourceId}:${lineNumber}: ${message}`);
  });
  window.webContents.once('did-finish-load', () => setImmediate(async () => {
    try {
      assert.equal(BrowserWindow.getAllWindows().length, 1);
      assert.equal(window.isVisible(), true);
      assert.match(window.webContents.getURL(), /^http:\/\/127\.0\.0\.1:\d+\/$/);
      const {width, height} = screen.getDisplayMatching(window.getBounds()).workAreaSize;
      const [contentWidth, contentHeight] = window.getContentSize();
      const [windowWidth, windowHeight] = window.getSize();
      if (width >= 1650 + windowWidth - contentWidth && height >= 894 + windowHeight - contentHeight) {
        assert.deepEqual([contentWidth, contentHeight], [1650, 894]);
      }
      const preferences = window.webContents.getLastWebPreferences();
      assert.equal(preferences.nodeIntegration, false);
      assert.equal(preferences.contextIsolation, true);
      assert.equal(preferences.sandbox, true);
      const initial = await window.webContents.executeJavaScript(`(() => {
        const shell = document.querySelector('.ml-app');
        return {
          geometry: [shell.offsetWidth, shell.offsetHeight, shell.querySelector('.ml-rail').offsetWidth, shell.querySelector('.ml-chat').offsetWidth],
          css: [...document.styleSheets].some(sheet => sheet.href?.endsWith('/workspace.css')),
          rendered: document.querySelectorAll('.ml-stage-button').length === 6 && !!shell.querySelector('svg.lucide'),
          node: typeof window.require,
          liveBridge: typeof window.signetDesktop?.model,
        };
      })()`);
      assert.deepEqual(initial, {geometry: [1650, 894, 53, 542], css: true, rendered: true, node: 'undefined', liveBridge: 'object'});
      if (process.env.SIGNET_WORKSPACE_SCREENSHOT) {
        const screenshot = await window.webContents.capturePage();
        writeFileSync(process.env.SIGNET_WORKSPACE_SCREENSHOT, screenshot.toPNG());
      }
      const chatInputs = JSON.stringify({existingMessage, existingActivity, firstMessage, nextMessage});
      await window.webContents.executeJavaScript(`(${verifyChat.toString()})(${chatInputs})`);
      const prompts = readFileSync(captureFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(prompts.length, 2);
      assert.match(prompts[0][0].content, /UI language for this turn is English/);
      assert.match(prompts[1][0].content, /UI language for this turn is Traditional Chinese/);
      assert.equal(prompts[0].at(-1).content, firstMessage);
      assert.deepEqual(prompts[1].slice(-3).map(message => message.content),
        [firstMessage, 'Provider replied to: ' + firstMessage, nextMessage]);
      const stored = JSON.parse(readFileSync(stateFile, 'utf8'));
      assert.notEqual(stored.active_session, existingSession);
      assert.deepEqual(stored.histories[stored.active_session].map(message => message.parts[0].text),
        [firstMessage, 'Provider replied to: ' + firstMessage, nextMessage, 'Provider replied to: ' + nextMessage]);
      assert.deepEqual(stored.events[existingSession], [[existingActivity]]);
      await window.webContents.executeJavaScript(`(${verifyWorkspace.toString()})(${JSON.stringify(history)})`);
      console.log(`PASS: workspace geometry, Agent chat, scoped dataset history, frozen inputs, archived Stage 3 and Stage 6 (${history.runs.map(run => `${run.connections}/${run.incident}`).join(', ')} total/MEGF6 edges)`);
      window.close();
    } catch (error) { fail(error); }
  }));
});

require(path.resolve(__dirname, '..', require('../package.json').main));
