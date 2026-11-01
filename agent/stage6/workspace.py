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


def graph(root, settings):
    label = format(float(settings['freq']), '.15g')
    path = Path(settings['resv'] + '_edgelist_' + label + '.txt')
    if not path.resolve().is_relative_to(root / 'work/res'):
        raise ValueError('Result path is outside the run.')
    st._no_links(path)
    edges = []
    with path.open() as stream:
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
    selected = set().union(*groups[:int(settings['ntop'])]) if groups else set()
    return {'nodes': sorted(neighbors), 'edges': edges,
            'display_nodes': sorted(selected),
            'counts': {'connections': len(edges), 'genes': len(neighbors), 'subnetworks': len(groups),
                       'displayed': min(int(settings['ntop']), len(groups))}}


def load_run(run_id):
    root = st._run(run_id)
    record = json.loads((root / 'visualization.json').read_text())
    if record.get('status') != 'verified_completed':
        raise ValueError('Select a Stage 6 run with verified completed outputs.')
    settings = st._settings(root)
    for key in ('Afreq', 'coef', 'vis.genepos'):
        settings[key] = st._input(settings[key])
    return root, settings, record


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
                result.append({'run_id': path.parent.name, 'frequency': float(settings['freq']),
                               'top_networks': int(settings['ntop']), 'status': record['status']})
            except (OSError, ValueError, KeyError, TypeError):
                continue
        return result

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
