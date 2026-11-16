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
const useArchivedRun = process.argv.includes('--archived-run');
let fixtureDir;
const stage6Example = useArchivedRun
  ? {run: 'official-example-chr1-20261111', connections: 731, genes: 95, incident: 13}
  : {connections: 4, genes: 4, incident: 3, pairs: [['ABCD3', 'MEGF6'], ['MEGF6', 'ABCD3'], ['MEGF6', 'LRRC40']]};

function cleanup() {
  clearTimeout(deadline);
  if (fixtureDir) rmSync(fixtureDir, {recursive: true, force: true});
  rmSync(temporary, {recursive: true, force: true});
}

function fail(error) {
  console.error(error);
  cleanup();
  app.exit(1);
}

const deadline = setTimeout(() => fail(Error('Workspace startup and chat test timed out')), 45000);
app.on('will-quit', cleanup);

try {
  if (!useArchivedRun) {
    mkdirSync(archiveDir, {recursive: true});
    fixtureDir = mkdtempSync(path.join(archiveDir, 'workspace-test-'));
    stage6Example.run = path.basename(fixtureDir);
    const {run, connections, genes} = stage6Example;
    writeFileSync(path.join(fixtureDir, 'verification.json'), JSON.stringify({
      run,
      jobs: {visualize: {state: 'completed', settings: {freq: '0.45', ntop: '1'}}},
      graph: {connections, genes, subnetworks: 1, displayed: 1},
    }));
    writeFileSync(path.join(fixtureDir, 'signet_edgelist_0.45.txt'), [
      'source_gene_symbol,target_gene_symbol,frequency,coefficient',
      'MEGF6,LRRC40,0.5,0.1',
      'ABCD3,MEGF6,1,-0.2',
      'MEGF6,ABCD3,1,0.03',
      'LRRC40,CLK2,0.5,0.25',
      '',
    ].join('\n'));
  }
} catch (error) { fail(error); }

async function verifyWorkspace({run, connections, genes, incident, pairs}) {
  const find = selector => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Workspace is missing ${selector}`);
    return element;
  };
  const click = selector => find(selector).click();
  const go = view => click(`[data-nav-target="${view}"]`);
  const visible = selector => Boolean(find(selector).getClientRects().length);
  const countRows = selector => find(selector).querySelectorAll('tbody tr').length;
  const selectDataset = value => {
    const menu = find('#ml-dataset-select');
    menu.value = value;
    menu.dispatchEvent(new Event('change', {bubbles: true}));
  };
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const activeFiles = () => find('#ml-input-genotype [data-current-files]').textContent;
  const archive = '#ml-run-1 .ml-run-inputs';
  const archiveFiles = () => [...find(archive).querySelectorAll('code')].map(file => file.textContent);
  const selectGene = panel => find(`${panel} [data-gene="MEGF6"]`).dispatchEvent(new MouseEvent('click', {bubbles: true}));

  const waitFor = async (condition, description) => {
    const end = Date.now() + 10000;
    while (!condition()) {
      check(Date.now() < end, description);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const stage6 = find('#lens-stage6');
  const resultPicker = find('#ml-stage6-run');
  click('#ml-stage-tab');
  click('[data-stage="6"]');
  await waitFor(() => [...resultPicker.options].some(option => option.value === run), 'Completed run was not listed');
  check(resultPicker.value === '' && stage6.dataset.runState === 'choose', 'Stage 6 should wait for the reader to select a run');
  check(!stage6.querySelector('[data-gene]') && countRows('#lens-stage6') === 0, 'Unselected Stage 6 showed a network or edges');

  resultPicker.value = run;
  resultPicker.dispatchEvent(new Event('change', {bubbles: true}));
  await waitFor(() => stage6.dataset.runState === 'ready', 'Selected Stage 6 result did not load');
  check(stage6.querySelectorAll('[data-gene]').length === genes, 'The graph did not render the selected run genes');
  check(visible('#lens-stage6 [data-gene="MEGF6"]') && countRows('#lens-stage6') === connections,
    'The graph or table did not display the selected run connections');

  selectGene('#lens-stage6');
  const selectedPairs = [...stage6.querySelectorAll('tbody tr')].map(row => [row.cells[0].textContent, row.cells[1].textContent]);
  check(visible('#lens-stage6 .ml-result-table') && selectedPairs.length === incident &&
    selectedPairs.every(pair => pair.includes('MEGF6')),
    'MEGF6 filtering did not retain exactly the incident edges');
  if (pairs) check(JSON.stringify(selectedPairs.sort()) === JSON.stringify(pairs.sort()),
    'MEGF6 filtering lost or replaced a directed edge');
  click('[data-stage="3"]');
  check(visible('#lens-stage3') && !visible('#lens-stage6'), 'Stage 3 did not show its PCA result');
  click('[data-stage="6"]');
  check(visible('#lens-stage6') && resultPicker.value === run && stage6.dataset.selectedGene === 'MEGF6' &&
    countRows('#lens-stage6') === incident, 'Stage 6 lost its selected run or gene');

  go('data');
  click('#ml-input-genotype [data-input-replace]');
  click('#ml-file-picker input[value="1"]');
  click('[data-input-apply]');
  check(activeFiles().includes('study-qc-preview.ped'), 'The replacement was not applied');

  go('history');
  click('[data-run-target="1"]');
  click(`${archive} summary`);
  const savedInputs = ['study.ped', 'study.map', 'example_gexp', 'official-demo-chr1-restart-clinical.tsv'];
  check(visible(archive) && JSON.stringify(archiveFiles()) === JSON.stringify(savedInputs), 'The archived files were altered');
  click('[data-run-network="1"]');
  selectGene('#ml-run-network-1');
  check(visible('#ml-run-network-1') && countRows('#ml-run-network-1') === 10, 'Stage-progress rerun returned the wrong edges');
  click('[data-run-target="2"]');
  click('[data-run-network="2"]');
  selectGene('#ml-run-network-2');
  check(visible('#ml-run-network-2') && countRows('#ml-run-network-2') === 9, 'English rerun returned the wrong edges');

  go('data');
  selectDataset('simulated-cohort-b');
  check(activeFiles().includes('cohort-b.ped'), 'Switching datasets did not replace the active file list');
  go('history');
  check(visible('#ml-empty-history') && !visible('#ml-run-network-2'), 'The second dataset inherited run history');
  go('analysis');
  click('#ml-stage-tab');
  check(visible('#ml-empty-analysis') && visible('#ml-empty-stage') && !visible('#lens-stage6'), 'The second dataset inherited an analysis result');

  go('data');
  click('#ml-dataset-add');
  find('#ml-dataset-name').value = 'Third preview dataset';
  click('#ml-dataset-create');
  check(find('#ml-dataset-select').selectedOptions[0]?.textContent === 'Third preview dataset' &&
    activeFiles().includes('尚未選擇檔案'), 'A new dataset was not selected with empty inputs');
  click('#ml-language');
  check(find('#ml-dataset-select').options.length === 3 &&
    find('#ml-dataset-select').selectedOptions[0]?.textContent === 'Third preview dataset' &&
    activeFiles().includes('No files selected'), 'Changing language lost the new dataset');

  selectDataset('example-chr1');
  check(activeFiles().includes('study-qc-preview.ped'), 'Revisiting the example lost its pending files');
  go('history');
  click('[data-run-target="1"]');
  check(visible(archive) && JSON.stringify(archiveFiles()) === JSON.stringify(savedInputs), 'Revisiting the archive changed its filenames');
  click('[data-run-network="1"]');
  check(countRows('#ml-run-network-1') === 10 && find('#ml-run-network-1 .s6-row-count').textContent === '10 edges',
    'The English interface did not retain the rerun selection');
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
      await window.webContents.executeJavaScript(`(${verifyWorkspace.toString()})(${JSON.stringify(stage6Example)})`);
      console.log(`PASS: unchanged workspace geometry, Agent chat, datasets, demo run history, and Stage 6 saved result (${stage6Example.connections} edges, ${stage6Example.incident} incident to MEGF6)`);
      window.close();
    } catch (error) { fail(error); }
  }));
});

require(path.resolve(__dirname, '..', require('../package.json').main));
