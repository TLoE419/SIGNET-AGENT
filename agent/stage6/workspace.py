"""Read-only archived workspace results; execution stays in the current HPC3 services."""
import csv
import json
import math
from pathlib import Path
import threading

import agent.tools.signet as st
from agent.runtime import workspace_genotype, workspace_datasets

ARCHIVED_STEP_JOBS = {'1': 'genotype', '2': 'expression', '4': 'cis', '5': 'network'}


def graph(root, settings):
    label = format(float(settings['freq']), '.15g')
    path = Path(settings['resv'] + '_edgelist_' + label + '.txt')
    if not path.resolve().is_relative_to(root / 'work/res'):
        raise ValueError('Result path is outside the run.')
    return _read_graph(path, int(settings['ntop']))


def _read_graph(path, top_networks, selected_groups=None):
    edges = []
    with st._no_links(path).open() as stream:
        for row in csv.DictReader(stream):
            source, target = row['source_gene_symbol'], row['target_gene_symbol']
            freq, coef = float(row['frequency']), float(row['coefficient'])
            if not source or not target or not math.isfinite(freq) or not math.isfinite(coef):
                raise ValueError('Invalid exported edge.')
            edges.append({'source': source, 'target': target, 'frequency': freq, 'coefficient': coef})
    neighbors = {}
    for edge in edges:
        a, b = edge['source'], edge['target']
        neighbors.setdefault(a, set()).add(b)
        neighbors.setdefault(b, set()).add(a)
    seen, groups = set(), []
    for node in sorted(neighbors):
        if node in seen:
            continue
        stack, group = [node], set()
        while stack:
            current = stack.pop()
            if current not in group:
                group.add(current)
                stack.extend(neighbors[current] - group)
        seen.update(group)
        groups.append(group)
    groups.sort(key=lambda group: (-sum(e['source'] in group for e in edges), sorted(group)))
    if selected_groups is None:
        selected = set().union(*groups[:top_networks]) if groups else set()
    else:
        if (len(selected_groups) != top_networks
                or len({frozenset(group) for group in selected_groups}) != top_networks
                or any(group not in groups for group in selected_groups)):
            raise ValueError('The exported subnetworks do not match the completed network.')
        expected_sizes = [sum(edge['source'] in group for edge in edges) for group in groups[:top_networks]]
        selected_sizes = [sum(edge['source'] in group for edge in edges) for group in selected_groups]
        if selected_sizes != expected_sizes:
            raise ValueError('The exported subnetworks are not the requested largest components.')
        selected = set().union(*selected_groups)
    return {'nodes': sorted(neighbors), 'edges': edges,
            'display_nodes': sorted(selected),
            'counts': {'connections': len(edges), 'genes': len(neighbors), 'subnetworks': len(groups),
                       'displayed': min(top_networks, len(groups))}}


def live_completed_result(run_id):
    """Read the exports and submitted settings of this workspace run's remote Stage 6 job."""
    root = st._run(run_id)
    snapshot = json.loads(st._no_links(root / workspace_genotype.VISUALIZE_SNAPSHOT).read_text(encoding='utf-8'))
    job = json.loads(st._no_links(root / 'steps/visualize.json').read_text(encoding='utf-8'))
    dataset_id = st._name(snapshot['dataset_id'])
    origin_path = st._no_links(root / workspace_genotype.SNAPSHOT)
    if origin_path.is_file():
        origin = json.loads(origin_path.read_text(encoding='utf-8'))
        if origin['run_id'] != run_id or origin['dataset_id'] != dataset_id:
            raise ValueError('The Stage 6 dataset does not match this run’s original inputs.')
    elif dataset_id != workspace_genotype.DATASET_ID:
        raise ValueError('The original dataset snapshot is missing from this run.')
    if (snapshot['run_id'] != run_id
            or job.get('run_id') != run_id or job.get('step') != 'visualize' or job.get('state') != 'completed'):
        raise ValueError('Select a completed Stage 6 job belonging to this workspace run.')
    settings = job['settings']
    if any(str(snapshot['settings'][key]) != str(settings[key]) for key in ('freq', 'ntop')):
        raise ValueError('The Stage 6 settings do not match the confirmed job.')
    if (any(isinstance(settings[key], bool) for key in ('freq', 'ntop'))
            or not isinstance(settings['ntop'], (int, str))):
        raise ValueError('The saved Stage 6 settings are invalid.')
    frequency = float(settings['freq'])
    top_networks = int(settings['ntop'])
    st._number(frequency, 0, 1)
    st._number(top_networks, 1, 100, integer=True)
    label = format(frequency, '.15g')
    folder = root / 'work/res/resv'
    edge_file = f'res/resv/signet_edgelist_{label}.txt'
    names = [f'res/resv/signet_top{index}_freq{label}_name.txt' for index in range(1, top_networks + 1)]
    required = job['required_outputs']
    if (not isinstance(required, list) or any(path not in required for path in [edge_file, *names])):
        raise ValueError('The completed Stage 6 outputs do not match its submitted settings.')
    for relative in required:
        if not isinstance(relative, str):
            raise ValueError('Invalid completed Stage 6 output path.')
        path = st._no_links(root / 'work' / relative)
        if not path.resolve().is_relative_to(folder.resolve()) or not path.is_file() or not path.stat().st_size:
            raise ValueError('A completed Stage 6 export is missing or outside this run.')
    selected_groups = []
    for relative in names:
        with st._no_links(root / 'work' / relative).open(encoding='utf-8') as stream:
            selected = [line.strip() for line in stream if line.strip()]
        if not selected or len(set(selected)) != len(selected):
            raise ValueError('The exported Stage 6 subnetwork names are invalid.')
        selected_groups.append(set(selected))
    try:
        result = _read_graph(root / 'work' / edge_file, top_networks, selected_groups)
    except csv.Error as error:
        raise ValueError('The saved Stage 6 edge list is not readable CSV.') from error
    seen = set()
    for edge in result['edges']:
        identity = edge['source'], edge['target']
        if (not 0 <= edge['frequency'] <= 1 or edge['frequency'] < frequency - 2.220446049250313e-16
                or any(len(edge[key]) > 240 or '\x00' in edge[key] for key in ('source', 'target'))
                or identity in seen):
            raise ValueError('The exported Stage 6 edges do not match the submitted threshold.')
        seen.add(identity)
    return {'run_id': run_id, 'frequency': frequency, 'top_networks': top_networks,
            'status': 'completed', 'source': 'live', 'job': job, 'graph': result}


def load_run(run_id):
    root = st._run(run_id)
    record = json.loads((root / 'visualization.json').read_text())
    if not isinstance(record, dict) or record.get('status') != 'verified_completed':
        raise ValueError('Select a Stage 6 run with verified completed outputs.')
    settings = st._settings(root)
    st._number(float(settings['freq']), 0, 1)
    st._number(int(settings['ntop']), 1, 100, integer=True)
    return root, settings, record


def _completed_run_summary(run_id, settings, record):
    return {'run_id': run_id, 'frequency': float(settings['freq']),
            'top_networks': int(settings['ntop']), 'status': record['status']}


def recorded_completed_result(run_id):
    """A history graph needs saved parameters, never today's mutable config."""
    root = st._run(run_id)
    path = st._no_links(root / 'visualization.json')
    if path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError('The visualization record is too large.')
    record = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(record, dict):
        raise ValueError('The visualization record must be an object.')
    settings = record.get('settings')
    if (record.get('status') != 'verified_completed' or not isinstance(settings, dict)
            or any(key not in settings for key in ('freq', 'ntop'))):
        raise ValueError('The original visualization settings were not recorded.')
    if any(isinstance(settings[key], bool) for key in ('freq', 'ntop')):
        raise ValueError('Invalid saved visualization settings.')
    try:
        frequency = float(settings['freq'])
        top_networks = int(settings['ntop'])
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError('Invalid saved visualization settings.') from error
    st._number(frequency, 0, 1)
    st._number(top_networks, 1, 100, integer=True)
    if float(settings['ntop']) != top_networks:
        raise ValueError('Invalid saved subnetwork count.')
    prefix = settings.get('resv', str(root / 'work/res/resv/signet'))
    saved = {'freq': frequency, 'ntop': top_networks, 'resv': prefix}
    try:
        result = graph(root, saved)
    except csv.Error as error:
        raise ValueError('The recorded graph is unreadable.') from error
    seen = set()
    for edge in result['edges']:
        identity = edge['source'], edge['target']
        if (identity in seen or not frequency - 2.220446049250313e-16 <= edge['frequency'] <= 1
                or any(len(edge[key]) > 240 or '\x00' in edge[key] for key in ('source', 'target'))):
            raise ValueError('The recorded graph does not match its saved settings.')
        seen.add(identity)
    if not seen or top_networks > result['counts']['subnetworks']:
        raise ValueError('The recorded graph is incomplete.')
    return {'run_id': run_id, 'frequency': frequency, 'top_networks': top_networks,
            'status': 'verified_completed', 'source': 'recorded', 'graph': result}


def _archive_directory():
    return st.PROJECT / 'data/stage6-results'


def _load_archive(run_id):
    directory = st._no_links(_archive_directory() / st._name(run_id))
    record = json.loads(st._no_links(directory / 'verification.json').read_text())
    job = record['jobs']['visualize']
    if record['run'] != run_id or job['state'] != 'completed':
        raise ValueError('Select a completed archived Stage 6 result.')
    frequency = float(job['settings']['freq'])
    top_networks = int(job['settings']['ntop'])
    st._number(frequency, 0, 1)
    st._number(top_networks, 1, 100, integer=True)
    path = st._no_links(directory / f'signet_edgelist_{frequency:.15g}.txt')
    if not path.is_file():
        raise ValueError('Missing archived Stage 6 edge list.')
    counts = record['graph']
    if (not isinstance(counts, dict) or set(counts) != {'connections', 'genes', 'subnetworks', 'displayed'}
            or any(type(count) is not int or count < 1 for count in counts.values())):
        raise ValueError('Missing or invalid archived Stage 6 graph counts.')
    return ({'run_id': run_id, 'frequency': frequency, 'top_networks': top_networks,
             'status': 'completed', 'source': 'archive'}, path, record)


def _history_text(value, limit=4096):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or '\x00' in value:
        raise ValueError('Invalid archive metadata text.')
    return value


def _history_name(value):
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError('Archive names require a Chinese and an English label.')
    return [_history_text(label, 240) for label in value]


def _history_inputs(value):
    if not isinstance(value, dict):
        raise ValueError('Input snapshots require a list for each input type.')
    snapshot = {}
    for kind in ('genotype', 'expression', 'clinical'):
        paths = value.get(kind, [])
        if not isinstance(paths, list):
            raise ValueError('Input snapshots require a list for each input type.')
        # These are metadata for display. Never open a path from a snapshot.
        snapshot[kind] = [_history_text(path) for path in paths]
    return snapshot


def _finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _stage3_snapshot(record, run_id, saved_npc):
    if (not isinstance(record, dict) or record.get('run_id') != run_id
            or type(record.get('npc')) is not int or record['npc'] != saved_npc):
        raise ValueError('Stage 3 snapshot does not match the archived adjustment.')

    matching = record['matching']
    expected_counts = {'genotype', 'expression', 'matched', 'retained', 'excluded', 'variants', 'genes'}
    if (not isinstance(matching, dict) or matching.keys() != expected_counts
            or any(type(value) is not int or value < 0 for value in matching.values())
            or matching['matched'] > min(matching['genotype'], matching['expression'])
            or matching['matched'] != matching['retained'] + matching['excluded']):
        raise ValueError('Invalid archived Stage 3 matching counts.')

    pca = record.get('pca')
    if pca is not None:
        points, variance = pca['points'], pca['variance_explained']
        if (pca['source'] != 'retained_genotype'
                or not isinstance(points, list) or len(points) != matching['retained']
                or any(not isinstance(point, list) or len(point) != 2
                       or not all(map(_finite_number, point)) for point in points)
                or not isinstance(variance, list) or len(variance) != 2
                or any(not _finite_number(value) or not 0 <= value <= 100 for value in variance)):
            raise ValueError('Invalid archived Stage 3 PCA display data.')
        pca = {'points': points, 'variance_explained': variance, 'source': 'retained_genotype'}

    comparison = record.get('comparison')
    if comparison is not None:
        before, after, covariates = comparison['before_sd'], comparison['after_sd'], comparison.get('covariates_sd')
        if (any(not _finite_number(value) or value < 0 for value in (before, after))
                or (covariates is not None and (not _finite_number(covariates) or covariates < 0))):
            raise ValueError('Invalid archived Stage 3 expression comparison.')
        comparison = {'before_sd': before, 'after_sd': after, 'covariates_sd': covariates}

    return {'run_id': run_id, 'npc': saved_npc, 'matching': matching, 'pca': pca, 'comparison': comparison}


def _count(value):
    return type(value) is int and value >= 0


def _archived_step_summary(stage, summary):
    if not isinstance(summary, dict):
        raise ValueError('Invalid archived summary.')
    if stage == '1':
        samples, variants = summary['samples'], summary['variants']
        bins, codes = summary['nonzero_bins'], summary['genotype_codes']
        valid = (set(summary) == {'samples', 'variants', 'nonzero_bins', 'genotype_codes'}
                 and _count(samples) and _count(variants)
                 and isinstance(bins, list) and len(bins) == 6 and all(map(_count, bins))
                 and isinstance(codes, list) and len(codes) == 3 and all(map(_count, codes))
                 and sum(bins) == variants and sum(codes) == samples * variants)
    elif stage == '2':
        samples, genes = summary['samples'], summary['genes']
        bars, excerpt = summary['histogram'], summary['gene_summary']
        valid = (set(summary) == {'samples', 'genes', 'histogram', 'gene_summary'}
                 and _count(samples) and _count(genes)
                 and isinstance(bars, list) and all(
                     isinstance(bar, dict) and set(bar) == {'lower', 'upper', 'count'}
                     and _finite_number(bar['lower']) and _finite_number(bar['upper'])
                     and bar['lower'] < bar['upper'] and _count(bar['count']) for bar in bars)
                 and sum(bar['count'] for bar in bars) == samples * genes
                 and isinstance(excerpt, list) and len(excerpt) <= min(5, genes)
                 and all(
                     isinstance(row, dict) and set(row) == {'gene', 'min', 'median', 'max'}
                     and _history_text(row['gene'], 240)
                     and all(_finite_number(row[key]) for key in ('min', 'median', 'max'))
                     and row['min'] <= row['median'] <= row['max'] for row in excerpt))
    elif stage == '4':
        genes, counts, pairs = summary['genes'], summary['counts'], summary['pairs']
        valid = (set(summary) == {'genes', 'counts', 'pairs'} and _count(genes)
                 and isinstance(counts, dict) and set(counts) == {'common', 'low', 'rare'}
                 and all(map(_count, counts.values())) and genes <= sum(counts.values())
                 and isinstance(pairs, list) and len(pairs) <= min(5, sum(counts.values()))
                 and all(
                     isinstance(row, dict) and set(row) == {'gene', 'variant', 'category', 'p_value'}
                     and _history_text(row['gene'], 240) and _history_text(row['variant'], 240)
                     and isinstance(row['category'], str) and counts.get(row['category'], 0) > 0
                     and _finite_number(row['p_value']) and 0 <= row['p_value'] <= 1 for row in pairs))
    else:
        genes, frequencies, edges = summary['genes'], summary['frequencies'], summary['edges']
        valid = (set(summary) == {'genes', 'frequencies', 'edges'} and _count(genes)
                 and isinstance(frequencies, list) and all(
                     isinstance(row, dict) and set(row) == {'frequency', 'count'}
                     and _finite_number(row['frequency']) and 0 < row['frequency'] <= 1
                     and _count(row['count']) for row in frequencies)
                 and isinstance(edges, list) and len(edges) <= min(5, sum(row['count'] for row in frequencies))
                 and all(
                     isinstance(row, dict) and set(row) == {'source', 'target', 'frequency'}
                     and _history_text(row['source'], 240) and _history_text(row['target'], 240)
                     and _finite_number(row['frequency']) and 0 < row['frequency'] <= 1 for row in edges))
    if not valid:
        raise ValueError('Invalid archived stage summary.')
    return summary


class Workspace:
    def __init__(self, server):
        self.server = server
        self.path = server.state_file.with_name('.stage6-workspace.json') if server.state_file else None
        # Legacy proposal checkpoints are retired; archive reads must not restore execution state.
        self.sessions = {}
        self.lock = threading.RLock()

    def available(self):
        result = []
        for path in sorted((st.PROJECT / 'runs').glob('*/visualization.json')):
            try:
                _, settings, record = load_run(path.parent.name)
                result.append(_completed_run_summary(path.parent.name, settings, record))
            except (OSError, ValueError, KeyError, TypeError):
                continue
        return result

    def completed_runs(self):
        runs = {result['run_id']: result for result in self.available()}
        for path in sorted((st.PROJECT / 'runs').glob(f'*/{workspace_genotype.VISUALIZE_SNAPSHOT}')):
            try:
                result = live_completed_result(path.parent.name)
                runs[path.parent.name] = {key: result[key] for key in
                                          ('run_id', 'frequency', 'top_networks', 'status', 'source')}
            except (OSError, ValueError, KeyError, TypeError, csv.Error):
                continue
        for path in sorted(_archive_directory().glob('*/verification.json')):
            run_id = path.parent.name
            if run_id in runs:
                continue
            try:
                runs[run_id], _, _ = _load_archive(run_id)
            except (OSError, ValueError, KeyError, TypeError):
                continue
        return list(runs.values())

    def completed_result(self, run_id, *, archive_only=False, live_only=False, recorded_only=False):
        if sum((archive_only, live_only, recorded_only)) > 1:
            raise ValueError('Select one completed-result source.')
        if recorded_only:
            return recorded_completed_result(run_id)
        if not archive_only:
            try:
                result = live_completed_result(run_id)
            except (OSError, ValueError, KeyError, TypeError, csv.Error):
                if live_only:
                    raise ValueError('No readable completed workspace Stage 6 result.')
            else:
                return result
            try:
                root, settings, record = load_run(run_id)
            except (OSError, ValueError, KeyError, TypeError):
                pass
            else:
                summary = _completed_run_summary(run_id, settings, record)
                return {**summary, 'graph': graph(root, settings)}
        summary, path, record = _load_archive(run_id)
        result = _read_graph(path, summary['top_networks'])
        if result['counts'] != record['graph']:
            raise ValueError('Archived edge list counts do not match the verification record.')
        return {**summary, 'graph': result}

    def archived_history(self):
        datasets = {}
        for record in workspace_datasets.list_datasets():
            dataset = {key: record[key] for key in ('id', 'name', 'inputs')}
            if record['folder']:
                dataset['folder'] = record['folder']
            datasets[record['id']] = dataset

        runs = []
        folders = {path.parent for pattern in ('*/history.json', '*/verification.json')
                   for path in _archive_directory().glob(pattern)}
        for folder in sorted(folders):
            try:
                run_id = st._name(folder.name)
                path = st._no_links(folder / 'history.json')
                saved = None
                issues = []
                if path.is_file():
                    try:
                        if path.stat().st_size > 2 * 1024 * 1024:
                            raise ValueError('Archive history metadata is too large.')
                        saved = json.loads(path.read_text(encoding='utf-8'))
                        if not isinstance(saved, dict) or saved.get('run_id') != run_id:
                            raise ValueError('Archive history does not identify this run.')
                    except (OSError, ValueError, TypeError):
                        saved = None
                        issues.append('The archived history metadata could not be read reliably.')
                else:
                    issues.append('Original dataset, input and setting metadata was not recorded with this archive.')
                dataset_id = None
                name = [run_id, run_id]
                inputs = {'genotype': [], 'expression': [], 'clinical': []}
                if saved:
                    try:
                        dataset_id = st._name(saved['dataset_id'])
                    except (ValueError, KeyError, TypeError):
                        issues.append('The archive does not record a valid dataset identity.')
                    try:
                        name = _history_name(saved['name'])
                        inputs = _history_inputs(saved['inputs'])
                    except (ValueError, KeyError, TypeError):
                        issues.append('Some original archive labels or input files were not recorded reliably.')
                try:
                    verification_path = st._no_links(folder / 'verification.json')
                    if verification_path.stat().st_size > 2 * 1024 * 1024:
                        raise ValueError('Archive verification metadata is too large.')
                    summary, _, verification = _load_archive(run_id)
                except (OSError, ValueError, KeyError, TypeError):
                    summary = {'run_id': run_id, 'status': 'unknown', 'source': 'archive'}
                    verification = {'jobs': {}, 'graph': None}
                    issues.append('Verified archive results are unavailable; no completed result is inferred.')
                runs.append({**summary, 'dataset_id': dataset_id, 'name': name,
                             'inputs': inputs, 'jobs': verification['jobs'], 'graph': verification['graph'],
                             **({'issues': issues} if issues else {})})
            except (OSError, ValueError, KeyError, TypeError):
                continue
        return {'datasets': list(datasets.values()), 'runs': runs}

    def history(self):
        history = self.archived_history()
        live = []
        for snapshot in sorted((st.PROJECT / 'runs').glob(f'*/{workspace_genotype.SNAPSHOT}')):
            try:
                live.append(workspace_genotype.run_history(st._run(snapshot.parent.name)))
            except (OSError, ValueError, KeyError, TypeError):
                continue
        dataset_ids = {entry['id'] for entry in history['datasets']}
        for run in live:
            if run['dataset_id'] not in dataset_ids:
                fallback_name = (['第 1 號染色體範例', 'Chromosome 1 example']
                                 if run['dataset_id'] == workspace_genotype.DATASET_ID
                                 else [run['dataset_id'], run['dataset_id']])
                history['datasets'].append({
                    'id': run['dataset_id'],
                    'name': run.get('dataset_name', fallback_name),
                    'inputs': run['inputs'],
                })
                dataset_ids.add(run['dataset_id'])
        history['runs'].extend(live)
        from agent.runtime import workspace_history
        return workspace_history.merge(history)

    def _archived_history_run(self, run_id):
        run_id = st._name(run_id)
        for entry in self.archived_history()['runs']:
            if entry['run_id'] == run_id:
                return entry
        raise ValueError('Run has no archived history.')

    def archived_stage_result(self, run_id, stage):
        run = self._archived_history_run(run_id)
        job = run['jobs'][ARCHIVED_STEP_JOBS[stage]]
        if job['state'] != 'completed':
            raise ValueError('Run has no completed archived result for this stage.')
        path = st._no_links(_archive_directory() / run_id / 'stages.json')
        record = json.loads(path.read_text(encoding='utf-8'))
        if record['run_id'] != run_id:
            raise ValueError('The stage summary belongs to a different run.')
        summary = _archived_step_summary(stage, record['stages'][stage])
        json.dumps(job, allow_nan=False)
        return {'run_id': run_id, 'stage': int(stage), 'job': job, 'summary': summary}

    def archived_stage3(self, run_id):
        run = self._archived_history_run(run_id)
        if run['jobs']['adjust']['state'] != 'completed':
            raise ValueError('Run has no completed archived adjustment.')
        saved_npc = run['jobs']['adjust']['options']['npc']
        if type(saved_npc) is not int or not 0 <= saved_npc <= 10:
            raise ValueError('Invalid archived number of principal components.')
        path = st._no_links(_archive_directory() / run_id / 'stage3.json')
        record = json.loads(path.read_text(encoding='utf-8'))
        return _stage3_snapshot(record, run_id, saved_npc)
