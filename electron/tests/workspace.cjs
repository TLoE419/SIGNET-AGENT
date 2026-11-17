'use strict';

const assert = require('node:assert/strict');
const {once} = require('node:events');
const {createHash, randomBytes} = require('node:crypto');
const {cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app, BrowserWindow, screen} = require('electron');
const {Backend} = require('../main/backend/backend.cjs');
const {launch} = require('../main/app/main.cjs');

const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'signet-workspace-test-')));
app.setPath('appData', temporary);
const project = path.join(temporary, 'project');
const backendMetadata = path.join(temporary, 'backend-starts.json');
const datasetState = path.join(project, 'data/workspace-datasets.json');
const repo = path.resolve(__dirname, '../..');
const pythonWrapper = path.join(temporary, 'python-fixture');
const defaultPython = path.join(repo, '.venv/bin/python');
process.env.SIGNET_WORKSPACE_TEST_PYTHON = process.env.SIGNET_PYTHON || (existsSync(defaultPython) ? defaultPython : 'python3');
process.env.SIGNET_WORKSPACE_TEST_ENTRY = path.join(__dirname, 'fixtures/workspace_backend.py');
process.env.SIGNET_WORKSPACE_TEST_PROJECT = project;
process.env.SIGNET_WORKSPACE_TEST_BACKEND = backendMetadata;
process.env.SIGNET_DATASETS_STATE_FILE = datasetState;
writeFileSync(pythonWrapper, '#!/bin/sh\nexec "$SIGNET_WORKSPACE_TEST_PYTHON" "$SIGNET_WORKSPACE_TEST_ENTRY" "$@"\n', {mode: 0o700});
process.env.SIGNET_PYTHON = pythonWrapper;
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

const archiveDir = path.join(project, 'data/stage6-results');
const datasetDir = path.resolve(archiveDir, '../datasets');
const useArchivedRuns = process.argv.includes('--archived-run');
const fixturePaths = [];
let running, replacementBackend, startup;

function cleanup() {
  clearTimeout(deadline);
  for (const fixture of fixturePaths.reverse()) rmSync(fixture, {recursive: true, force: true});
  rmSync(temporary, {recursive: true, force: true});
}

function fail(error) {
  console.error(error);
  void replacementBackend?.forceStop();
  void running?.backend.forceStop();
  cleanup();
  app.exit(1);
}

const deadline = setTimeout(() => fail(Error('Workspace persistence and chat test timed out')), 90000);
app.on('will-quit', cleanup);

function createHistoryFixture() {
  const name = path.basename(temporary);
  const groups = [
    {id: name + '-a', name: ['測試資料甲', 'Test dataset A'], inputs: {genotype: ['current-a.ped'], expression: ['current-a-expression'], clinical: []}},
    {id: name + '-b', name: ['測試資料乙', 'Test dataset B'], inputs: {genotype: ['current-b.ped'], expression: [], clinical: []}},
  ];
  for (const [index, dataset] of groups.entries()) {
    dataset.folder = '/fixture/cohort-' + index;
    dataset.default_inputs = dataset.inputs;
    dataset.alternative_inputs = {genotype: index === 0 ? ['replacement-a.ped', 'replacement-a.map'] : [],
      expression: [], clinical: []};
    dataset.selections = {genotype: 0, expression: 0, clinical: 0};
  }
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

    const samples = 9 + index;
    const stages = {
      1: {samples, variants: 8, nonzero_bins: [index + 1, 0, 1, 1, 1, 4 - index],
        genotype_codes: [samples * 8 - 5, 4, 1]},
      2: {samples, genes, histogram: [{lower: 10, upper: 11, count: samples}, {lower: 11, upper: 12, count: samples * (genes - 1)}],
        gene_summary: [{gene: 'MEGF6', min: 10.5, median: 11, max: 11.4}]},
      4: {genes: 1, counts: {common: 2 + index, low: 1, rare: 0},
        pairs: [{gene: 'MEGF6', variant: '10', category: 'common', p_value: 0.01}]},
      5: {genes, frequencies: [{frequency: 0.5, count: connections}],
        edges: pairs.map(([source, target]) => ({source, target, frequency: 0.5}))},
    };
    writeFileSync(path.join(folder, 'stages.json'), JSON.stringify({run_id, stages}));
    const stepSettings = {
      1: {mind: String((index + 1) / 10)},
      2: {'restrict.tcga': '1'},
      4: {'alpha.cis': '0.05'},
      5: {nboots: '2'},
    };
    const controllerCpus = index + 2;
    const finished_at = '2026-11-11T01:03:00-0800';
    const beforeAdjustmentAndNetwork = Object.fromEntries(Object.entries({1: 'genotype', 2: 'expression', 4: 'cis', 5: 'network'})
      .map(([stage, key]) => [key, {state: 'completed', finished_at, settings: stepSettings[stage],
        resources: {cpus: stage === '1' ? controllerCpus : 2, mem_gb: 16, hours: 3}}]));
    writeFileSync(path.join(folder, 'verification.json'), JSON.stringify({
      run: run_id,
      jobs: {
        ...beforeAdjustmentAndNetwork,
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
    const stageBars = {
      1: stages[1].nonzero_bins,
      2: stages[2].histogram.map(bin => bin.count),
      4: Object.values(stages[4].counts),
      5: stages[5].frequencies.map(bin => bin.count),
    };
    return {...snapshot, genes, connections, incident: incidentPairs.length, incidentPairs, stage3,
      stageBars, controllerCpus, stepSettings};
  });
  return {groups, runs};
}

function readArchivedHistory() {
  cpSync(path.join(repo, 'data/datasets'), datasetDir, {recursive: true});
  cpSync(path.join(repo, 'data/stage6-results'), archiveDir, {recursive: true});
  const read = filename => JSON.parse(readFileSync(filename, 'utf8'));
  const groups = ['example-chr1', 'simulated-cohort-b'].map(id => read(path.join(datasetDir, id + '.json')));
  const runs = [
    ['official-example-chr1-20261111', 731, 13, 1110, 0.93366491, 8, [1884, 495, 138, 131, 174, 161], [156, 35, 15], [394, 337]],
    ['official-example-chr1-stage-cards-20261111', 726, 10, 1112, 0.93373123, 16, [1883, 497, 137, 132, 172, 162], [159, 36, 15], [391, 335]],
    ['official-example-chr1-english-20261111', 706, 9, 1110, 0.93348844, 16, [1884, 496, 137, 132, 173, 161], [155, 35, 14], [372, 334]],
  ].map(([run_id, connections, incident, variants, after_sd, controllerCpus, genotype, cis, network]) => ({
    ...read(path.join(archiveDir, run_id, 'history.json')), genes: 95, connections, incident, controllerCpus,
    stageBars: {1: genotype, 2: [617, 5634, 16258, 18300, 9462, 2116, 230, 13], 4: cis, 5: network},
    stepSettings: {1: {mind: '0.1'}, 2: {'restrict.tcga': '1'}, 4: {'alpha.cis': '0.05'}, 5: {nboots: '2'}},
    stage3: {
      npc: 3,
      matching: {genotype: 560, expression: 554, matched: 473, retained: 471, excluded: 2, variants, genes: 95},
      comparison: {before_sd: 0.93990024, covariates_sd: 0.93650323, after_sd},
    },
  }));
  return {groups, runs};
}

function createLiveHistoryFixture() {
  const run_id = 'workspace-persistence-live';
  const root = path.join(project, 'runs', run_id);
  const inputs = {'ped.file': '/fixture/original.ped', 'map.file': '/fixture/original.map',
    ref: '/fixture/original-ref/chr', gmap: '/fixture/original-map/chr'};
  const settings = {'restrict.tcga.geno': '1', mind: '0.07', geno: '0.08', hwe: '0.0001', int: '5000000'};
  const snapshot = {run_id, dataset_id: 'example-chr1', submitted_at: '2026-11-17T01:00:00-0800',
    inputs, settings, resources: {cpus: 3, mem_gb: 12, hours: 2}};
  mkdirSync(path.join(root, 'steps'), {recursive: true});
  mkdirSync(path.join(root, 'work/res/resg'), {recursive: true});
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({run_id}));
  writeFileSync(path.join(root, 'workspace-genotype.json'), JSON.stringify(snapshot));
  writeFileSync(path.join(root, 'steps/genotype.json'), JSON.stringify({...snapshot, step: 'genotype',
    state: 'completed', job_id: '9001', finished_at: '2026-11-17T01:05:00-0800'}));
  writeFileSync(path.join(root, 'work/config.ini'), 'mind = 0.07\ngeno = 0.08\nrestrict.tcga.geno = 1\nfreq = 0.45\nntop = 1\n');
  writeFileSync(path.join(root, 'work/res/resg/signet_Geno'), '0 1\n2 0\n');
  writeFileSync(path.join(root, 'work/res/resg/signet_Genotype.sampleID'), 'P1\nP2\n');
  const example = path.join(datasetDir, 'example-chr1.json');
  if (!existsSync(example)) writeFileSync(example, JSON.stringify({id: 'example-chr1',
    name: ['第 1 號染色體範例', 'Chromosome 1 example'],
    inputs: {genotype: ['study.ped', 'study.map'], expression: ['example_gexp'], clinical: ['clinical.tsv']}}));
  return {run_id, inputs: {genotype: [inputs['ped.file'], inputs['map.file'], inputs.ref + '1.gen', inputs.gmap + '1.map']},
    settings, root};
}

function frozenFiles(directories) {
  const hashes = {};
  function visit(directory) {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else hashes[path.relative(project, filename)] = createHash('sha256').update(readFileSync(filename)).digest('hex');
    }
  }
  directories.forEach(visit);
  return hashes;
}

let history, liveHistory, originalFiles;
try {
  history = useArchivedRuns ? readArchivedHistory() : createHistoryFixture();
  liveHistory = createLiveHistoryFixture();
  originalFiles = frozenFiles([archiveDir, liveHistory.root]);
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
  const savedStage = find('#lens-history-stage');
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
  const token = document.querySelector('meta[name="chat-token"]').content;
  const initialCatalog = await fetch('/signet/datasets', {headers: {'X-Chat-Token': token}}).then(reply => reply.json());
  const savedHistory = await fetch('/stage6/history', {headers: {'X-Chat-Token': token}}).then(reply => reply.json());
  const liveRuns = savedHistory.runs.filter(run => run.source === 'live');
  for (const group of groups) {
    const groupRuns = expectedList(group);
    const runIds = groupRuns.map(run => run.run_id).sort();
    go('data');
    selectDataset(group.id);
    check(datasetPicker.value === group.id, 'Could not select dataset ' + group.id);
    const current = find('#ml-input-genotype [data-current-files]').textContent;
    check(group.inputs.genotype.every(file => current.includes(file)), 'Dataset showed the wrong current files');
    const alternatives = initialCatalog.datasets.find(dataset => dataset.id === group.id)?.alternative_inputs.genotype;
    if (group === groups[0] && alternatives?.length) {
      click('#ml-input-genotype [data-input-replace]');
      click('#ml-file-picker input[value="1"]');
      click('[data-input-apply]');
      await waitFor(() => find('#ml-input-genotype .ml-current-input').dataset.saveState === 'applied',
        'Alternate input selection was not saved');
      check(alternatives.every(file => find('#ml-input-genotype [data-current-files]').textContent.includes(file)),
        'Could not select alternate draft files to test the saved history');
    }
    check(JSON.stringify(resultIds()) === JSON.stringify(runIds), 'Stage 6 picker showed another dataset’s runs');

    go('history');
    const expectedHistoryIds = [...runIds, ...liveRuns.filter(run => run.dataset_id === group.id).map(run => run.run_id)].sort();
    check(JSON.stringify(historyIds()) === JSON.stringify(expectedHistoryIds), 'History showed another dataset’s runs');
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


      for (const stage of [1, 2, 4, 5]) {
        click(`[data-run-stage="${stage}"][data-run-id="${run.run_id}"]`);
        await waitFor(() => savedStage.dataset.runState === 'ready' && savedStage.dataset.runId === run.run_id &&
          savedStage.dataset.stage === String(stage), 'Could not load archived Stage ' + stage + ' for ' + run.run_id);
        check(visible('#lens-history-stage .ml-count-chart') && visible('#lens-history-stage [data-stage-table]') &&
          !visible(detail) && !visible('#lens-stage6'), 'The archived Stage ' + stage + ' view or table is hidden');
        const bars = [...savedStage.querySelectorAll('.ml-count-label')].map(label =>
          Number(label.textContent.trim().replaceAll(',', '')));
        check(JSON.stringify(bars) === JSON.stringify(run.stageBars[stage]),
          'Archived Stage ' + stage + ' used output counts from another run');
        for (const [key, value] of Object.entries(run.stepSettings[stage])) {
          const field = savedStage.querySelector(`[data-stage-setting="${key}"]`);
          check(field?.textContent.includes(value) || field?.dataset.value === value, 'Wrong historical setting: ' + key);
        }
        if (stage === 1) {
          const cpus = savedStage.querySelector('[data-stage-resource="cpus"]');
          check(cpus?.textContent.includes(String(run.controllerCpus)), 'Wrong resources from the original genotype job');
        }
        click('#lens-history-stage [data-run-back]');
        check(visible(detail) && !visible('#lens-history-stage'), 'Back from Stage ' + stage + ' lost the timeline');
      }

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
  await waitFor(() => find('#ml-dataset-form').dataset.saveState === 'saved' &&
    datasetPicker.selectedOptions[0]?.textContent === 'Third workspace dataset', 'New dataset was not saved and selected');
  const id = datasetPicker.value;
  check(id.startsWith('dataset-') && !id.startsWith('draft-'), 'New dataset did not receive a persisted ID');
  const catalog = await fetch('/signet/datasets', {headers: {'X-Chat-Token': token}}).then(reply => reply.json());
  const created = catalog.datasets.find(dataset => dataset.id === id);
  check(Boolean(created), 'New dataset was missing from the backend catalog');
  for (const type of ['genotype', 'expression', 'clinical']) {
    click(`[data-input-target="${type}"]`);
    click(`#ml-input-${type} [data-input-replace]`);
    click('#ml-file-picker input[value="1"]');
    click('[data-input-apply]');
    await waitFor(() => find(`#ml-input-${type} .ml-current-input`).dataset.saveState === 'applied',
      'File choice was not saved for ' + type);
    const current = find(`#ml-input-${type} [data-current-files]`).textContent;
    check(created.alternative_inputs[type].length > 0 && created.alternative_inputs[type].every(file => current.includes(file)),
      'The new dataset did not apply its own alternate ' + type + ' files');
  }
  click('[data-input-target="genotype"]');
  click('#ml-input-genotype [data-input-reset]');
  await waitFor(() => find('#ml-input-genotype .ml-current-input').dataset.saveState === 'default',
    'Resetting genotype files to their default was not saved');
  click('#ml-language');
  check(datasetPicker.selectedOptions[0]?.textContent === 'Third workspace dataset', 'Language change lost the new dataset');
  go('history');
  check(!historyIds().length && visible('#ml-empty-history') && !resultIds().length, 'New dataset inherited saved runs');
  const saved = await fetch('/signet/datasets', {headers: {'X-Chat-Token': token}}).then(reply => reply.json());
  const record = saved.datasets.find(dataset => dataset.id === id);
  check(record.selections.genotype === 0 && record.selections.expression === 1 && record.selections.clinical === 1,
    'The backend did not retain the per-type default and alternate choices');
  return {created: record, changed: saved.datasets.find(dataset => dataset.id === groups[0].id)};
}

async function verifyPersistedWorkspace({saved, groups, runs, live, changeLive = false}) {
  const find = selector => {
    const element = document.querySelector(selector);
    if (!element) throw Error('Missing control after reopening: ' + selector);
    return element;
  };
  const click = selector => {
    const element = find(selector);
    if (element instanceof HTMLElement) element.click();
    else element.dispatchEvent(new MouseEvent('click', {bubbles: true}));
  };
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const waitFor = async (condition, description) => {
    const end = Date.now() + 10000;
    while (!condition()) {
      check(Date.now() < end, description);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const visible = selector => Boolean(find(selector).getClientRects().length);
  const go = view => click(`[data-nav-target="${view}"]`);
  const picker = find('#ml-dataset-select');
  const selectDataset = id => {
    picker.value = id;
    picker.dispatchEvent(new Event('change', {bubbles: true}));
    check(picker.value === id, 'A saved dataset disappeared after backend restart: ' + id);
  };
  const visibleHistory = () => [...document.querySelectorAll('#ml-run-list [data-run-target]')]
    .filter(button => button.getClientRects().length).map(button => button.dataset.runTarget).sort();
  const token = document.querySelector('meta[name="chat-token"]').content;
  await waitFor(() => [...picker.options].some(option => option.value === saved.created.id),
    'The persisted dataset catalog did not reload');
  const catalog = await fetch('/signet/datasets', {headers: {'X-Chat-Token': token}}).then(reply => reply.json());
  for (const record of [saved.created, saved.changed, saved.liveDataset].filter(Boolean)) {
    const current = catalog.datasets.find(dataset => dataset.id === record.id);
    check(JSON.stringify(current) === JSON.stringify(record), 'Saved dataset configuration changed across restart: ' + record.id);
    go('data');
    selectDataset(record.id);
    for (const type of ['genotype', 'expression', 'clinical']) {
      click(`[data-input-target="${type}"]`);
      const text = find(`#ml-input-${type} [data-current-files]`).textContent;
      check(record.inputs[type].every(file => text.includes(file)), 'Reopened ' + type + ' files differ from the saved configuration');
    }
  }
  go('data');
  selectDataset(saved.created.id);
  for (const type of ['genotype', 'expression', 'clinical']) {
    click(`[data-input-target="${type}"]`);
    click(`#ml-input-${type} [data-input-replace]`);
    check(find(`#ml-file-picker input[value="${saved.created.selections[type]}"]`).checked,
      'The persisted default/alternate selection was lost for ' + type);
    click('[data-input-cancel]');
  }
  go('history');
  check(!visibleHistory().length && visible('#ml-empty-history'), 'The new dataset inherited another dataset’s history after restart');

  for (const group of groups) {
    go('data');
    selectDataset(group.id);
    go('history');
    const expected = runs.filter(run => run.dataset_id === group.id).map(run => run.run_id);
    if (group.id === 'example-chr1') expected.push(live.run_id);
    check(JSON.stringify(visibleHistory()) === JSON.stringify(expected.sort()), 'Reopened history crossed dataset boundaries');
  }

  const archived = runs[0];
  go('data');
  selectDataset(archived.dataset_id);
  go('history');
  click(`[data-run-target="${archived.run_id}"]`);
  const archivedFiles = [...find(`#ml-run-${archived.run_id}`).querySelectorAll('.ml-run-inputs code')].map(node => node.textContent);
  check(JSON.stringify(archivedFiles) === JSON.stringify(['genotype', 'expression', 'clinical'].flatMap(type => archived.inputs[type])),
    'Editing current files replaced an archived run’s original inputs');
  for (const stage of [1, 2, 4, 5, 3, 6]) {
    click(`[data-run-stage="${stage}"][data-run-id="${archived.run_id}"]`);
    const panel = find(stage === 3 ? '#lens-history-stage3' : stage === 6 ? '#lens-stage6' : '#lens-history-stage');
    await waitFor(() => panel.dataset.runState === 'ready' && panel.dataset.runId === archived.run_id,
      'A saved stage did not reopen after backend restart: ' + stage);
    if ([1, 2, 4, 5].includes(stage)) {
      for (const [key, value] of Object.entries(archived.stepSettings[stage])) {
        check(panel.querySelector(`[data-stage-setting="${key}"]`)?.textContent.includes(value),
          'Reopening an archive replaced its recorded settings: ' + key);
      }
    } else if (stage === 3) {
      check(Number(panel.querySelector('[data-s3-components]').textContent) === archived.stage3.npc,
        'Reopening an archive changed its principal component count');
    } else {
      if (panel.dataset.selectedGene) click('#lens-stage6 [data-s6-clear]');
      check(panel.querySelectorAll('tbody tr').length === archived.connections, 'Reopened archived graph has the wrong connections');
    }
    click(`${stage === 3 ? '#lens-history-stage3' : stage === 6 ? '#lens-stage6' : '#lens-history-stage'} [data-run-back]`);
  }

  go('data');
  selectDataset('example-chr1');
  if (changeLive) {
    click('[data-input-target="genotype"]');
    click('#ml-input-genotype [data-input-replace]');
    click('#ml-file-picker input[value="1"]');
    click('[data-input-apply]');
    await waitFor(() => find('#ml-input-genotype .ml-current-input').dataset.saveState === 'applied',
      'The live dataset file change was not saved');
  }
  go('history');
  click(`[data-run-target="${live.run_id}"]`);
  const liveFiles = [...find(`#ml-run-${live.run_id}`).querySelectorAll('.ml-run-inputs code')].map(node => node.textContent);
  check(JSON.stringify(liveFiles) === JSON.stringify(live.inputs.genotype), 'Current dataset files replaced the live run’s frozen input snapshot');
  click(`[data-run-stage="1"][data-run-id="${live.run_id}"]`);
  const panel = find('#lens-history-stage');
  await waitFor(() => panel.dataset.runState === 'ready' && panel.dataset.runId === live.run_id,
    'The completed live Stage 1 result did not reopen');
  check(panel.querySelector('[data-stage-setting="mind"]')?.textContent === live.settings.mind,
    'Current dataset configuration replaced the live run’s saved setting');
  check(JSON.stringify([...panel.querySelectorAll('.ml-count-label')].map(node => Number(node.textContent))) === JSON.stringify([0, 0, 0, 0, 0, 2]),
    'The live result changed when dataset files were edited');
  const finalCatalog = await fetch('/signet/datasets', {headers: {'X-Chat-Token': token}}).then(reply => reply.json());
  return {...saved, liveDataset: finalCatalog.datasets.find(dataset => dataset.id === 'example-chr1')};
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
      let saved = await window.webContents.executeJavaScript(`(${verifyWorkspace.toString()})(${JSON.stringify(history)})`);
      const persistenceInputs = () => JSON.stringify({saved, ...history, live: liveHistory});
      saved = await window.webContents.executeJavaScript(`(${verifyPersistedWorkspace.toString()})(${JSON.stringify({saved, ...history, live: liveHistory, changeLive: true})})`);
      assert.deepEqual(frozenFiles([archiveDir, liveHistory.root]), originalFiles,
        'Editing dataset files mutated archived or live analysis snapshots');
      const persistedBytes = readFileSync(datasetState);
      const firstStart = JSON.parse(readFileSync(backendMetadata, 'utf8'));
      assert.equal(firstStart.starts.length, 1);

      // Replace the real Python process, then reload the renderer. This proves
      // disk persistence rather than keeping the original JavaScript objects.
      running = await startup;
      await running.backend.stop();
      assert.equal(running.backend.exited, true);
      replacementBackend = new Backend(running.backend.options);
      const reopenedOrigin = await replacementBackend.start();
      assert.equal(reopenedOrigin, running.origin);
      const reopened = JSON.parse(readFileSync(backendMetadata, 'utf8'));
      assert.equal(reopened.starts.length, 2);
      assert.notEqual(reopened.starts[0], reopened.starts[1], 'The backend process was not restarted');
      const loaded = once(window.webContents, 'did-finish-load');
      window.webContents.reload();
      await loaded;
      await window.webContents.executeJavaScript(`(${verifyPersistedWorkspace.toString()})(${persistenceInputs()})`);
      assert.deepEqual(readFileSync(datasetState), persistedBytes, 'Reopening rewrote the saved dataset configuration');
      assert.deepEqual(frozenFiles([archiveDir, liveHistory.root]), originalFiles,
        'Reopening stage results mutated archived or live analysis snapshots');
      await replacementBackend.stop();
      replacementBackend = undefined;
      console.log(`PASS: workspace geometry, Agent chat, dataset/file/default persistence across a Python restart, scoped history, immutable live and archived snapshots, all six archived stages (${history.runs.map(run => `${run.connections}/${run.incident}`).join(', ')} total/MEGF6 edges); all data isolated in a temporary project`);
      window.close();
    } catch (error) { fail(error); }
  }));
});

startup = launch({provider: 'codex'});
startup.then(value => { running = value; }).catch(fail);
