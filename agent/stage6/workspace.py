"""Session-bound Stage 6 proposals, explicit approvals and immutable result comparisons."""
from contextvars import ContextVar
import csv
import hashlib
import json
import math
from pathlib import Path
import secrets
import shutil
import threading
import time

import agent.tools.signet as st
from agent.runtime.visualization import validate_inputs

CHAT_CONTEXT = ContextVar('stage6_chat_context', default=None)
ARCHIVED_STEP_JOBS = {'1': 'genotype', '2': 'expression', '4': 'cis', '5': 'network'}


def graph(root, settings):
    label = format(float(settings['freq']), '.15g')
    path = Path(settings['resv'] + '_edgelist_' + label + '.txt')
    if not path.resolve().is_relative_to(root / 'work/res'):
        raise ValueError('Result path is outside the run.')
    return _read_graph(path, int(settings['ntop']))


def _read_graph(path, top_networks):
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
    selected = set().union(*groups[:top_networks]) if groups else set()
    return {'nodes': sorted(neighbors), 'edges': edges,
            'display_nodes': sorted(selected),
            'counts': {'connections': len(edges), 'genes': len(neighbors), 'subnetworks': len(groups),
                       'displayed': min(top_networks, len(groups))}}


def load_run(run_id):
    root = st._run(run_id)
    record = json.loads((root / 'visualization.json').read_text())
    if not isinstance(record, dict) or record.get('status') != 'verified_completed':
        raise ValueError('Select a Stage 6 run with verified completed outputs.')
    settings = st._settings(root)
    for key in ('Afreq', 'coef', 'vis.genepos'):
        settings[key] = st._input(settings[key])
    return root, settings, record


def _completed_run_summary(run_id, settings, record):
    return {'run_id': run_id, 'frequency': float(settings['freq']),
            'top_networks': int(settings['ntop']), 'status': record['status']}


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


def fingerprint(settings):
    value = {key: settings[key] for key in ('freq', 'ntop', 'id', 'assembly', 'cohort', 'nchr')}
    for key in ('Afreq', 'coef', 'vis.genepos'):
        value[key] = hashlib.sha256(Path(st._input(settings[key])).read_bytes()).hexdigest()
    label = format(float(settings['freq']), '.15g')
    value['source_export'] = hashlib.sha256(Path(settings['resv'] + '_edgelist_' + label + '.txt').read_bytes()).hexdigest()
    if settings['id'] != '9606':
        value['tf'] = hashlib.sha256(Path(st._input(settings['tf'])).read_bytes()).hexdigest()
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


class Workspace:
    def __init__(self, server):
        self.server = server
        self.path = server.state_file.with_name('.stage6-workspace.json') if server.state_file else None
        self.sessions = json.loads(self.path.read_text()) if self.path and self.path.exists() else {}
        for session in self.sessions.values():
            for proposal in session.get('proposals', []):
                if proposal['status'] == 'running':
                    proposal['status'] = 'unknown'
                    proposal['error'] = 'Service restarted. Inspect the recorded run; this work will not replay.'
        self.lock = threading.RLock()

    def save(self):
        if self.path:
            temporary = self.path.with_suffix('.tmp')
            temporary.write_text(json.dumps(self.sessions, indent=2) + '\n')
            temporary.chmod(0o600)
            temporary.replace(self.path)

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
        for path in sorted(_archive_directory().glob('*/verification.json')):
            run_id = path.parent.name
            if run_id in runs:
                continue
            try:
                runs[run_id], _, _ = _load_archive(run_id)
            except (OSError, ValueError, KeyError, TypeError):
                continue
        return list(runs.values())

    def completed_result(self, run_id, *, archive_only=False):
        if not archive_only:
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
        for path in sorted((st.PROJECT / 'data/datasets').glob('*.json')):
            try:
                record = json.loads(st._no_links(path).read_text(encoding='utf-8'))
                dataset_id = st._name(record['id'])
                if dataset_id != path.stem:
                    continue
                dataset = {'id': dataset_id, 'name': _history_name(record['name']),
                           'inputs': _history_inputs(record['inputs'])}
                if 'folder' in record:
                    dataset['folder'] = _history_text(record['folder'])
                datasets[dataset_id] = dataset
            except (OSError, ValueError, KeyError, TypeError):
                continue

        runs = []
        for path in sorted(_archive_directory().glob('*/history.json')):
            try:
                saved = json.loads(st._no_links(path).read_text(encoding='utf-8'))
                run_id = st._name(saved['run_id'])
                dataset_id = st._name(saved['dataset_id'])
                if run_id != path.parent.name or dataset_id not in datasets:
                    continue
                summary, _, verification = _load_archive(run_id)
                runs.append({**summary, 'dataset_id': dataset_id, 'name': _history_name(saved['name']),
                             'inputs': _history_inputs(saved['inputs']), 'jobs': verification['jobs'],
                             'graph': verification['graph']})
            except (OSError, ValueError, KeyError, TypeError):
                continue
        return {'datasets': list(datasets.values()), 'runs': runs}

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

    def state(self, session):
        return self.sessions.setdefault(session, {'baseline': None, 'comparison': None, 'proposals': []})

    def view(self, session, activate=False):
        with self.lock:
            state = self.state(session)
            if activate and not state.get('active'):
                state['active'] = True
                self.save()
            active = bool(state.get('active') or state['comparison'] or state['proposals'])
            runs = self.available()
            # Selection is read-only; it does not approve any scientific parameter change.
            if not state['baseline'] and runs:
                state['baseline'] = runs[0]['run_id']
                self.save()
            value = {'active': active, 'baseline': state['baseline'], 'comparison': state['comparison'], 'runs': runs,
                     'proposals': state['proposals'], 'graphs': {}}
            running = next((p for p in reversed(state['proposals']) if p['status'] == 'running'), None)
            if running:
                logs = st.PROJECT / 'runs' / running['run_id'] / 'logs/visualization.stdout'
                out = logs.read_text(errors='replace') if logs.is_file() else ''
                phase = ('Collecting and verifying outputs' if 'SIGNET_STAGE6_EXPORTS_COMPLETED' in out else
                         'Exporting subnetworks and enrichment' if 'Generating results for network' in out else
                         'Loading online annotations' if 'Loading results into Shiny' in out else
                         'Extracting edges and summary plots' if 'Extracting directed' in out else
                         'Preparing isolated run')
                value['progress'] = phase
            for key in ('baseline', 'comparison'):
                if active and state.get(key):
                    try:
                        root, settings, _ = load_run(state[key])
                        value['graphs'][key] = graph(root, settings)
                    except (OSError, ValueError, KeyError) as exc:
                        value['error'] = str(exc)
            return value

    def select(self, session, run_id):
        load_run(run_id)
        with self.lock:
            state = self.state(session)
            if any(p['status'] == 'running' for p in state['proposals']):
                raise ValueError('A visualization is running.')
            for p in state['proposals']:
                if p['status'] == 'pending':
                    p['status'] = 'superseded'
            state.update(baseline=run_id, comparison=None, active=True)
            self.save()
        return self.view(session)

    def propose(self, session, frequency=-1, top_networks=0):
        with self.lock:
            state = self.state(session)
            if not state['baseline']:
                self.view(session)
            if not state['baseline']:
                raise ValueError('No completed baseline is available. Create a verified Stage 6 baseline first.')
            if any(p['status'] == 'running' for p in state['proposals']):
                raise ValueError('A visualization is running.')
            _, settings, _ = load_run(state['baseline'])
            old = {'frequency': float(settings['freq']), 'top_networks': int(settings['ntop'])}
            pending = next((p for p in reversed(state['proposals']) if p['status'] == 'pending'), None)
            current = pending['after'] if pending else old
            new = {'frequency': current['frequency'] if frequency == -1 else frequency,
                   'top_networks': current['top_networks'] if top_networks == 0 else top_networks}
            st._number(new['frequency'], 0, 1)
            st._number(new['top_networks'], 1, 100, True)
            if new == old:
                if pending:
                    pending['status'] = 'cancelled'
                    self.save()
                return {'status': 'unchanged', 'executed': False,
                        'reason': 'Changes cleared; settings match the baseline. No visualization started.'}
            candidate = {**settings, 'freq': str(new['frequency']), 'ntop': str(new['top_networks'])}
            validate_inputs(candidate)
            for p in state['proposals']:
                if p['status'] == 'pending':
                    p['status'] = 'superseded'
            proposal = {'id': secrets.token_hex(16), 'status': 'pending', 'baseline': state['baseline'],
                        'before': old, 'after': new, 'fingerprint': fingerprint(settings), 'created': time.time()}
            state['proposals'].append(proposal)
            self.save()
            return {'status': 'awaiting_confirmation', 'executed': False, 'proposal': proposal,
                    'instruction': 'The researcher must click Confirm & run. Do not call run_visualization.'}

    def cancel(self, session, proposal_id):
        with self.lock:
            p = next((p for p in self.state(session)['proposals'] if p['id'] == proposal_id), None)
            if not p or p['status'] != 'pending':
                raise ValueError('This proposal is no longer awaiting confirmation.')
            p['status'] = 'cancelled'
            self.save()
        return self.view(session)

    def compare(self, session, proposal_id):
        with self.lock:
            state = self.state(session)
            if any(p['status'] == 'running' for p in state['proposals']):
                raise ValueError('A visualization is running.')
            p = next((p for p in state['proposals'] if p['id'] == proposal_id), None)
            if not p or p['status'] != 'verified_completed':
                raise ValueError('No verified comparison is available for this proposal.')
            load_run(p['baseline'])
            load_run(p['run_id'])
            for item in state['proposals']:
                if item['status'] == 'pending':
                    item['status'] = 'superseded'
            state.update(baseline=p['baseline'], comparison=p['run_id'])
            self.save()
        return self.view(session)

    def approve(self, session, proposal_id):
        # Called only by the authenticated human-action endpoint, never by a model tool.
        with self.lock:
            state = self.state(session)
            p = next((p for p in state['proposals'] if p['id'] == proposal_id), None)
            if not p or p['status'] != 'pending' or p['baseline'] != state['baseline']:
                raise ValueError('This proposal is stale or already consumed.')
            _, settings, _ = load_run(p['baseline'])
            if fingerprint(settings) != p['fingerprint']:
                p['status'] = 'stale'
                self.save()
                raise ValueError('Baseline settings or input files changed. Create a new proposal.')
            candidate = {**settings, 'freq': str(p['after']['frequency']), 'ntop': str(p['after']['top_networks'])}
            validate_inputs(candidate)
            p.update(status='running', run_id='vis_' + secrets.token_hex(12), confirmed=time.time())
            self.save()
            return p

    def execute(self, session, proposal):
        from google.genai import types
        try:
            _, settings, _ = load_run(proposal['baseline'])
            if fingerprint(settings) != proposal['fingerprint']:
                raise ValueError('Inputs changed after confirmation; execution was not started.')
            created = st.configure_signet(proposal['run_id'], cohort=settings['cohort'], nchr=int(settings['nchr']))
            if created['status'] != 'created':
                raise ValueError(created.get('error', 'Could not create isolated run.'))
            snapshot = st.PROJECT / 'runs' / proposal['run_id'] / 'work/data/stage6-inputs'
            snapshot.mkdir()
            for index, key in enumerate(('Afreq', 'coef', 'vis.genepos')):
                target = snapshot / str(index)
                shutil.copyfile(settings[key], target)
                settings[key] = str(target)
            if settings['id'] != '9606':
                target = snapshot / 'tf'
                shutil.copyfile(settings['tf'], target)
                settings['tf'] = str(target)
            if fingerprint(settings) != proposal['fingerprint']:
                raise ValueError('Inputs changed while making the run snapshot; execution was not started.')
            result = st.run_visualization(proposal['run_id'], settings['Afreq'], settings['coef'],
                settings['vis.genepos'], proposal['after']['frequency'], proposal['after']['top_networks'],
                int(settings['id']), settings['assembly'], settings.get('tf', '') if settings['id'] != '9606' else '')
            with self.lock:
                proposal['status'] = result['status']
                proposal['result'] = result
                if result['status'] == 'verified_completed':
                    self.state(session)['comparison'] = proposal['run_id']
        except Exception as exc:
            with self.lock:
                proposal.update(status='unknown', error=str(exc))
        finally:
            with self.lock:
                proposal['finished'] = time.time()
                self.save()
                text = ('Confirmed Stage 6 changes: freq = ' + str(proposal['after']['frequency']) +
                        '; ntop = ' + str(proposal['after']['top_networks']) + '. Baseline: ' + proposal['baseline'] + '.')
                answer = ('Visualization completed and outputs verified. Compare the networks on the right. Original results retained.'
                          if proposal['status'] == 'verified_completed' else
                          'Visualization status: ' + proposal['status'] + '. Original results retained; inspect Run history.')
                history = self.server.histories.setdefault(session, [])
                history.extend([types.Content(role='user', parts=[types.Part.from_text(text=text)]),
                                types.Content(role='model', parts=[types.Part.from_text(text=answer)])])
                self.server.events.setdefault(session, []).append([text, answer])
                self.server.save_state()
            self.server.turn_lock.release()


def get_visualization_workspace() -> dict:
    """Read the current Stage 6 baseline, parameters and proposal history. Does not execute."""
    context = CHAT_CONTEXT.get()
    if not context:
        return {'status': 'unavailable', 'executed': False, 'reason': 'Open the chat workspace.'}
    value = context[0].view(context[1], activate=True)
    # Full graph arrays belong in the UI, not in model history.
    value.pop('graphs', None)
    value['proposals'] = [{key: p[key] for key in ('id', 'status', 'baseline', 'before', 'after', 'run_id') if key in p} for p in value['proposals'][-5:]]
    return {'status': 'ok', **value}


def propose_visualization_change(frequency: float = -1, top_networks: int = 0) -> dict:
    """Propose Stage 6 parameter changes for human review; NEVER executes.

    frequency: Desired threshold 0..1; -1 leaves the baseline threshold unchanged.
    top_networks: Desired subnetwork count 1..100; 0 leaves the baseline count unchanged.
    Only change parameters requested by the researcher. Confirmation must be clicked in the UI.
    """
    context = CHAT_CONTEXT.get()
    if not context:
        return {'status': 'unavailable', 'executed': False, 'reason': 'Open the chat workspace.'}
    try:
        return context[0].propose(context[1], frequency, top_networks)
    except (OSError, ValueError, KeyError) as exc:
        return {'status': 'invalid', 'executed': False, 'error': str(exc)}
