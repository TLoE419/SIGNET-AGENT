'use strict';

const assert = require('node:assert/strict');
const {mkdtempSync, rmSync, writeFileSync} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app, BrowserWindow} = require('electron');

const temporary = mkdtempSync(path.join(os.tmpdir(), 'signet-workspace-test-'));
app.setPath('userData', temporary);

function fail(error) {
  console.error(error);
  clearTimeout(deadline);
  rmSync(temporary, {recursive: true, force: true});
  app.exit(1);
}

const deadline = setTimeout(() => fail(Error('Workspace preview did not finish loading')), 30000);
app.on('will-quit', () => {
  clearTimeout(deadline);
  rmSync(temporary, {recursive: true, force: true});
});

function verifyWorkspace() {
  const find = selector => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Workspace preview is missing ${selector}`);
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

  selectGene('#lens-stage6');
  check(countRows('#lens-stage6') === 13, 'MEGF6 filtering failed in the analysis workspace');

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

app.once('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => setImmediate(async () => {
    try {
      assert.equal(BrowserWindow.getAllWindows().length, 1);
      assert.equal(window.isVisible(), true);
      assert.match(window.webContents.getURL(), /^file:\/\/.*\/build\/workspace-preview\/index\.html$/);
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
          liveBridge: typeof window.signetDesktop,
        };
      })()`);
      assert.deepEqual(initial, {geometry: [1650, 894, 53, 542], css: true, rendered: true, node: 'undefined', liveBridge: 'undefined'});
      if (process.env.SIGNET_WORKSPACE_SCREENSHOT) {
        const screenshot = await window.webContents.capturePage();
        writeFileSync(process.env.SIGNET_WORKSPACE_SCREENSHOT, screenshot.toPNG());
      }
      await window.webContents.executeJavaScript(`(${verifyWorkspace.toString()})()`);
      console.log('PASS: package entry, isolated workspace, exact frame geometry, datasets, archived inputs, reruns, and bilingual state');
      window.close();
    } catch (error) { fail(error); }
  }));
});

process.argv.push('--workspace-preview');
require(path.resolve(__dirname, '..', require('../package.json').main));
