"""Read recorded analyses without rewriting their scientific provenance.

Dataset assignment is a separate organizational overlay. It never establishes
sample identity, supplies missing historical settings, or enables execution.
"""
import copy
import hashlib
from itertools import islice
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import time

import agent.tools.signet as signet
from agent.runtime import signet_jobs as jobs, workspace_datasets

MAX_BYTES = 2 * 1024 * 1024
MAX_ASSOCIATIONS = 10000
MAX_ATTEMPTS = 1000
HISTORY_ID = r'[A-Za-z0-9][A-Za-z0-9_-]{0,95}'
_LOCK = threading.RLock()
_SNAPSHOTS = ('genotype', 'expression', 'adjust', 'cis', 'network', 'visualize')
_INPUT_KINDS = {'ped.file': 'genotype', 'map.file': 'genotype', 'gexp.file': 'expression',
                'read.file': 'expression', 'reads.file': 'expression', 'tpm.file': 'expression',
                'cli.file': 'clinical'}


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _identifier(value):
    if not isinstance(value, str) or not re.fullmatch(HISTORY_ID, value):
        raise ValueError('Invalid history identifier.')
    return value


def _json(path):
    path = signet._no_links(path)
    before = path.stat()
    if not path.is_file() or before.st_size > MAX_BYTES:
        raise ValueError('The recorded metadata is not a bounded regular file.')
    raw = path.read_bytes()
    after = path.stat()
    if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
        raise ValueError('The recorded metadata changed while being read.')
    def invalid_constant(_):
        raise ValueError('Non-finite metadata is not supported.')
    value = json.loads(raw, parse_constant=invalid_constant)
    if not isinstance(value, dict):
        raise ValueError('The recorded metadata must be an object.')
    return value, hashlib.sha256(raw).hexdigest()


def _metadata(root, archive=False):
    """Hash metadata only; do not open scientific inputs, outputs, or logs."""
    paths = ([root / name for name in ('history.json', 'verification.json', 'stages.json', 'stage3.json')] if archive else
             [root / 'manifest.json', root / 'rerun.json'] +
             [root / ('workspace-' + step + '.json') for step in _SNAPSHOTS] +
             [root / 'steps' / (step + '.json') for step in jobs.STEPS] +
             sorted(root.glob('*.json')))
    records, digests, issues = {}, {}, []
    try:
        folder = signet._no_links(root / 'steps')
    except ValueError:
        folder = None
        issues.append('The saved steps folder is reached through a link; attempt archives were not read.')
    for step in jobs.STEPS:
        attempts = list(islice(folder.glob(step + '.attempt*.json'), MAX_ATTEMPTS + 1)) if folder else []
        if len(attempts) > MAX_ATTEMPTS:
            issues.append('Too many saved attempt records; only the first 1000 are listed for ' + step + '.')
        paths.extend(sorted(attempts[:MAX_ATTEMPTS]))
    for path in dict.fromkeys(paths):
        if not path.exists() and not path.is_symlink():
            continue
        relative = str(path.relative_to(root))
        # Keep unreadable filenames too, so a damaged snapshot is a visible gap.
        digests[relative] = None
        try:
            records[relative], digests[relative] = _json(path)
        except (OSError, ValueError, TypeError):
            try:
                saved = signet._no_links(path).stat()
                digests[relative] = _digest([saved.st_dev, saved.st_ino, saved.st_size, saved.st_mtime_ns])
            except (OSError, ValueError):
                pass
            issues.append('A saved metadata record is unreadable: ' + relative)
    return records, digests, issues


def _attempt_number(value):
    if type(value) is not int or not 1 <= value <= MAX_ATTEMPTS:
        raise ValueError('The saved attempt number must be an integer from 1 to 1000.')
    return value


def _attempt_record(record, run_id, step, number=None, partial=False):
    if not isinstance(record, dict):
        raise ValueError('The saved attempt snapshot is unavailable or unreadable.')
    for key, expected in (('run_id', run_id), ('step', step)):
        if record.get(key) != expected and (not partial or key in record):
            raise ValueError('The saved attempt does not identify this run and step.')
    if record.get('state') not in (*jobs.ACTIVE, *jobs.TERMINAL):
        raise ValueError('The saved attempt state is invalid.')
    if any(key in record and not isinstance(record[key], dict) for key in ('inputs', 'settings', 'resources', 'options')):
        raise ValueError('The saved attempt settings or input fields are invalid.')
    for key in ('outputs', 'remote_outputs', 'required_outputs', 'missing_outputs', 'failure_hints'):
        if key in record and (not isinstance(record[key], list) or
                              any(not isinstance(value, str) for value in record[key])):
            raise ValueError('The saved attempt output or error evidence is invalid.')
    if 'history' in record and (not isinstance(record['history'], list) or
                                any(not isinstance(event, dict) or
                                    any(key in event and not isinstance(event[key], str) for key in ('state', 'at'))
                                    for event in record['history'])):
        raise ValueError('The saved attempt timeline is invalid.')
    if any(key in record and record[key] is not None and not isinstance(record[key], str)
           for key in ('submitted_at', 'started_at', 'finished_at', 'ended_at')):
        raise ValueError('The saved attempt timestamps are invalid.')
    saved_number = _attempt_number(record['attempt']) if 'attempt' in record else None
    if number is not None and (saved_number if saved_number is not None else 1) != number:
        raise ValueError('The saved attempt number disagrees with its archive filename.')
    return copy.deepcopy(record)


def _attempt_result(record):
    if record is None:
        return {'status': 'not_recorded', 'outputs': []}
    state = record.get('state')
    status = 'recorded_' + state if state in jobs.TERMINAL else 'pending' if state in jobs.ACTIVE else 'not_recorded'
    # These are saved observations, never checks of today's mutable work/res.
    required = record.get('required_outputs', [])
    downloaded = record.get('outputs', [])
    remote = record.get('remote_outputs', [])
    missing = record.get('missing_outputs', [])
    relative = lambda path: path[5:] if path.startswith('work/') else path
    saved_downloaded = {relative(path) for path in downloaded}
    saved_missing = {relative(path) for path in missing}
    saved_remote = {relative(path) for path in remote}
    paths = dict.fromkeys([*required, *downloaded, *remote, *missing])
    seen, outputs = set(), []
    for path in paths:
        key = relative(path)
        if key not in seen:
            outputs.append({'path': path, 'status': 'missing' if key in saved_missing else
                            'downloaded' if key in saved_downloaded else 'remote' if key in saved_remote else 'not_recorded'})
            seen.add(key)
    return {'status': status, 'outputs': outputs}


def _attempts(row, records, digests, issues):
    """Expose exact retry snapshots without borrowing current settings/results."""
    result = {}
    archive = row['source'] == 'archive'
    for step in jobs.STEPS:
        prefix = 'steps/' + step + '.attempt'
        filenames = [path for path in digests if path.startswith(prefix)]
        current_path = 'verification.json#jobs.' + step if archive else 'steps/' + step + '.json'
        current = row.get('jobs', {}).get(step) if archive else records.get(current_path)
        if (current is None or isinstance(current, dict) and current.get('state') == 'not_submitted') and not filenames and current_path not in digests:
            continue
        entries, known, number = [], set(), None
        current_issues = []
        availability = 'recorded'
        try:
            current = _attempt_record(current, row['run_id'], step, partial=archive)
            if 'attempt' in current:
                number = _attempt_number(current['attempt'])
            elif not archive and not filenames:
                number = 1
            else:
                current_issues.append('The current attempt number was not recorded; it is not inferred from other files.')
        except ValueError as error:
            availability = 'invalid' if current_path in digests or current is not None else 'missing'
            current = None
            current_issues.append(str(error))
        for filename in sorted(filenames):
            match = re.fullmatch(re.escape(prefix) + r'([1-9][0-9]{0,3})\.json', filename)
            prior_number = int(match[1]) if match and int(match[1]) <= MAX_ATTEMPTS else None
            prior_issues = []
            prior = None
            try:
                if prior_number is None:
                    raise ValueError('The saved attempt archive filename has an invalid number.')
                if number is not None and prior_number >= number:
                    raise ValueError('The archived attempt is not earlier than the current attempt.')
                prior = _attempt_record(records.get(filename), row['run_id'], step, prior_number)
                known.add(prior_number)
            except ValueError as error:
                prior_issues.append(str(error))
            entries.append({'number': prior_number, 'current': False, 'record_file': filename,
                            'availability': 'recorded' if prior is not None else 'invalid',
                            'record': prior, 'issues': prior_issues, 'result': _attempt_result(prior)})
        slots = set(range(1, number)) if number is not None else set(range(1, max(known, default=0) + 1))
        existing = {entry['number'] for entry in entries}
        for missing in sorted(slots - existing):
            entries.append({'number': missing, 'current': False,
                            'record_file': f'steps/{step}.attempt{missing}.json', 'availability': 'missing',
                            'record': None, 'issues': ['This prior attempt snapshot was not saved or is missing.'],
                            'result': _attempt_result(None)})
        entries.append({'number': number, 'current': True, 'record_file': current_path,
                        'availability': availability, 'record': current, 'issues': current_issues,
                        'result': _attempt_result(current)})
        entries.sort(key=lambda entry: (entry['number'] is None, entry['number'] or 0, entry['current']))
        result[step] = entries
        for entry in entries:
            if not archive or entry['availability'] != 'recorded':
                issues.extend(entry['record_file'] + ': ' + message for message in entry['issues'])
    return result


def _identity(root, digests, archive=False):
    keys = ('history.json', 'verification.json', 'stages.json', 'stage3.json') if archive else ('manifest.json',)
    key = next((name for name in keys if (root / name).exists()), keys[0])
    try:
        saved = signet._no_links(root / key).stat()
        return _digest([digests.get(key), saved.st_dev, saved.st_ino, saved.st_size, saved.st_mtime_ns])
    except (OSError, ValueError):
        return _digest([str(root), None])


def _present(root, relative, nonempty=True):
    path = signet._no_links(root / relative)
    return path.is_file() and os.access(path, os.R_OK) and (not nonempty or path.stat().st_size > 0)


def _readable_stages(row, root, records):
    """Check the local artifacts the existing result readers actually require.

    Large scientific matrices are not parsed again during a history listing;
    their reader still validates their contents when the user opens a result.
    """
    stages = []
    for number, step in enumerate(_SNAPSHOTS, 1):
        stage = str(number)
        job = row.get('jobs', {}).get(step, {})
        if job.get('state') != 'completed':
            continue
        try:
            if number == 6:
                if row.get('graph'):
                    stages.append(stage)
            elif row['source'] == 'archive':
                from agent.stage6.workspace import _archived_step_summary, _stage3_snapshot
                if number == 3:
                    snapshot, _ = _json(root / 'stage3.json')
                    _stage3_snapshot(snapshot, row['run_id'], job['options']['npc'])
                else:
                    saved = records['stages.json']
                    if saved['run_id'] != row['run_id']:
                        raise ValueError('The stage record identifies another run.')
                    _archived_step_summary(stage, saved['stages'][stage])
                stages.append(stage)
            elif row['source'] == 'live':
                if number <= 4 and job.get('remote_outputs'):
                    stages.append(stage)
                    continue
                required = [jobs._resolve(path, job.get('settings', {})) for path in jobs.STEPS[step].required]
                if number == 3:
                    required += ['res/resa/' + name for name in ('workspace-genotype-ids.txt',
                                 'workspace-clinical.tsv', 'workspace-pca.evec', 'workspace-pca.eval')]
                    required += ['res/rest/signet_gene_name', 'res/rest/signet_gexpID', 'res/resg/signet_Genotype.sampleID']
                elif number == 4:
                    required += ['res/resc/signet_net.genename', 'res/resc/signet_net.gexp.data',
                                 'res/resc/signet_all.eQTL.data']
                elif number == 5:
                    required += ['res/resn/signet_net.genepos']
                available = all(_present(root / 'work', path) for path in required)
                if number == 4:
                    available = available and all(_present(root / 'work', 'res/resc/signet_' + category + '.eQTL.data', False)
                                                   for category in ('common', 'low', 'rare'))
                if available:
                    stages.append(stage)
        except (OSError, ValueError, KeyError, TypeError, OverflowError):
            continue
    return stages


def _ownership(records, run_id, existing=None):
    claims = set()
    if existing is not None and existing.get('dataset_id') is not None:
        claims.add(signet._name(existing['dataset_id']))
    for relative, record in records.items():
        if relative.startswith('steps/') and '.attempt' in relative:
            continue
        if 'dataset_id' not in record:
            continue
        # The configured manifest has no run_id; all execution snapshots must
        # explicitly identify this run before their dataset claim is accepted.
        if relative != 'manifest.json' and record.get('run_id') != run_id:
            continue
        claims.add(signet._name(record['dataset_id']))
    return claims


def _operation(root, filename, record, digests, issues):
    operation = record.get('operation')
    if not isinstance(operation, str) or filename not in (operation + '.json', operation + '.plan.json'):
        return None
    signet._name(operation)
    if any(key in record and not isinstance(record[key], dict) for key in ('inputs', 'settings', 'parameters', 'resources')):
        raise ValueError('Saved operation fields must be objects.')
    if 'status' in record and not isinstance(record['status'], str):
        raise ValueError('The recorded operation status must be text.')
    prepared = filename.endswith('.plan.json')
    result = {'operation': operation, 'record_file': filename,
              'record_revision': digests[filename],
              'status': 'prepared' if prepared else record.get('status', 'unknown'),
              'executed': False if prepared else 'unknown' if record.get('status') == 'starting' else record.get('executed', 'unknown'),
              'inputs': copy.deepcopy(record.get('inputs', {})),
              'inputs_evidence': 'recorded' if isinstance(record.get('inputs'), dict) else 'not_recorded',
              'settings': copy.deepcopy(record.get('settings', record.get('parameters', {}))),
              'resources': copy.deepcopy(record.get('resources', {})),
              'settings_evidence': 'recorded' if 'settings' in record or 'parameters' in record else 'not_recorded'}
    if prepared and record.get('settings_snapshot'):
        # A saved plan's fixed sibling is the only permitted config read. The
        # arbitrary recorded path and today's mutable work/config.ini are not.
        snapshot = signet._no_links(root / (operation + '.config.ini'))
        try:
            if snapshot.stat().st_size > MAX_BYTES:
                raise ValueError('The prepared settings snapshot is too large.')
            raw = snapshot.read_bytes()
            result['settings'] = {key.strip(): value.strip() for line in raw.decode().splitlines()
                                  if '=' in line and not line.lstrip().startswith('#')
                                  for key, value in [line.split('=', 1)]}
            result['settings_evidence'] = 'prepared_snapshot'
            digests[snapshot.name] = hashlib.sha256(raw).hexdigest()
        except (OSError, ValueError, UnicodeError):
            issues.append('The prepared settings snapshot is unreadable: ' + snapshot.name)
    for key in ('returncode', 'output_files', 'output_list_truncated', 'stdout_log', 'stderr_log',
                'submitted_at', 'started_at', 'finished_at', 'ended_at', 'reason', 'runtime', 'remote_directory'):
        if key in record:
            result[key] = copy.deepcopy(record[key])
    return result


def _recorded(root, records, digests, issues, include_steps=True):
    run_id = signet._name(root.name)
    step_records = {}
    if include_steps:
        for step in jobs.STEPS:
            record = records.get('steps/' + step + '.json')
            if record is None:
                continue
            if record.get('run_id') != run_id or record.get('step') != step:
                issues.append('A saved step does not identify this run: ' + step)
                continue
            if (record.get('state') not in (*jobs.ACTIVE, *jobs.TERMINAL)
                    or any(key in record and not isinstance(record[key], dict) for key in ('inputs', 'settings', 'resources', 'options'))):
                issues.append('A saved step contains invalid state or snapshot fields: ' + step)
                continue
            step_records[step] = copy.deepcopy(record)
    operations = []
    for filename, record in records.items():
        if '/' not in filename:
            try:
                result = _operation(root, filename, record, digests, issues)
            except (OSError, ValueError, KeyError, TypeError):
                issues.append('A saved operation is unreadable: ' + filename)
                continue
            if result is not None:
                operations.append(result)
    inputs = {kind: [] for kind in workspace_datasets.KINDS}
    for record in [*step_records.values(), *operations]:
        values = record.get('inputs', {})
        if not isinstance(values, dict):
            continue
        for key, kind in _INPUT_KINDS.items():
            path = values.get(key)
            if isinstance(path, str) and path and path not in inputs[kind]:
                inputs[kind].append(path)
    states = [value.get('state', 'unknown') for value in step_records.values()]
    if not states:
        states = [value['status'] for value in operations]
    result = {'run_id': run_id, 'source': 'recorded', 'origin': 'agent' if operations else 'slurm',
              'name': [run_id, run_id], 'inputs': inputs, 'jobs': step_records,
              'operations': operations,
              # File/catalog order cannot establish which of several operations
              # is the freshest. Each saved step retains its own exact state.
              'status': (states[0] if len(states) == 1 else 'recorded') if states else
                        'recorded' if any(path.startswith('steps/') and '.attempt' in path for path in digests) else 'configured',
              'graph': None}
    timestamps = [value for record in [*step_records.values(), *operations]
                  for key in ('submitted_at', 'started_at') for value in [record.get(key)]
                  if isinstance(value, str)]
    if timestamps:
        result['submitted_at'] = min(timestamps)
    rerun = records.get('rerun.json')
    if rerun and isinstance(rerun.get('source_run'), str):
        try:
            result['provenance'] = {'source_run': signet._name(rerun['source_run']),
                                    'from_step': rerun.get('from_step')}
        except ValueError:
            issues.append('The recorded rerun parent identifier is invalid.')
    return result


def _state_path():
    value = os.environ.get('SIGNET_HISTORY_STATE_FILE')
    path = Path(value) if value else signet.PROJECT / 'data/workspace-history.json'
    if not path.is_absolute():
        raise ValueError('The history state file must have an absolute path.')
    return signet._no_links(path)


def _load():
    try:
        path = _state_path()
        if not path.exists():
            return {}
        saved, _ = _json(path)
        if (set(saved) != {'version', 'associations'} or type(saved['version']) is not int or saved['version'] != 1
                or not isinstance(saved['associations'], list) or len(saved['associations']) > MAX_ASSOCIATIONS):
            raise ValueError('Invalid history metadata format.')
        associations = {}
        for item in saved['associations']:
            if (not isinstance(item, dict) or set(item) != {'history_id', 'dataset_id', 'record_identity', 'assigned_at'}
                    or not re.fullmatch(r'[a-f0-9]{64}', item['record_identity'])
                    or not isinstance(item['assigned_at'], str) or len(item['assigned_at']) > 64):
                raise ValueError('Invalid history association.')
            key = _identifier(item['history_id'])
            signet._name(item['dataset_id'])
            if key in associations:
                raise ValueError('Duplicate history association.')
            associations[key] = item
        return associations
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise jobs.StepError('conflict', 'The saved history assignments are unreadable. They have not been overwritten.') from error


def _save(associations):
    raw = (json.dumps({'version': 1, 'associations': list(associations.values())}, indent=2) + '\n').encode()
    if len(raw) > MAX_BYTES or len(associations) > MAX_ASSOCIATIONS:
        raise jobs.StepError('invalid_request', 'The history assignment store is full.')
    try:
        path = _state_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        signet._no_links(path.parent)
        descriptor, temporary = tempfile.mkstemp(prefix='.workspace-history-', suffix='.tmp', dir=path.parent)
        try:
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            signet._no_links(path)
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)
    except (OSError, ValueError) as error:
        raise jobs.StepError('conflict', 'The history assignment could not be saved. Previous records remain unchanged.') from error


def merge(history):
    """Normalize supplied workspace/archive rows and discover other local runs."""
    with _LOCK:
        history = copy.deepcopy(history)
        associations = _load()
        datasets = {record['id']: record for record in history['datasets']}
        collected = []
        workspace_runs = {record['run_id'] for record in history['runs'] if record['source'] == 'live'}
        for record in history['runs']:
            archive = record['source'] == 'archive'
            root = signet.PROJECT / ('data/stage6-results' if archive else 'runs') / signet._name(record['run_id'])
            records, digests, issues = _metadata(root, archive)
            if record['source'] == 'live':
                legacy = _recorded(root, records, digests, issues, include_steps=False)
                record['operations'] = legacy['operations']
            collected.append((record, root, records, digests, issues, archive))
        for root in sorted((signet.PROJECT / 'runs').glob('*')):
            try:
                signet._name(root.name)
                signet._no_links(root)
                if not root.is_dir() or not (root / 'manifest.json').is_file():
                    continue
                records, digests, issues = _metadata(root)
                record = _recorded(root, records, digests, issues, include_steps=root.name not in workspace_runs)
                if root.name in workspace_runs:
                    continue
                collected.append((record, root, records, digests, issues, False))
            except (OSError, ValueError, KeyError, TypeError):
                continue
        result = []
        for row, root, records, digests, issues, archive in collected:
            source = row['source']
            prefix = 'workspace' if source == 'live' else source
            row['history_id'] = prefix + '--' + row['run_id']
            row['record_identity'] = _identity(root, digests, archive)
            row['revision'] = _digest([row['record_identity'], digests])
            row['origin'] = row.get('origin', 'workspace' if source == 'live' else 'archive')
            row.setdefault('operations', [])
            invalid_claim = False
            try:
                claims = _ownership(records, row['run_id'], row)
            except (ValueError, TypeError):
                claims = set()
                invalid_claim = True
                issues.append('A recorded dataset identifier is invalid.')
            conflict = len(claims) > 1
            dataset_id = next(iter(claims)) if len(claims) == 1 else None
            association = {'status': 'recorded' if dataset_id else 'unclassified',
                           'method': ('snapshot' if source == 'live' else 'archive' if archive else 'manifest') if dataset_id else None}
            assignment = associations.get(row['history_id'])
            if conflict:
                issues.append('Saved metadata contains conflicting dataset ownership. Review the original records.')
            if not claims and not invalid_claim and assignment:
                if assignment['record_identity'] == row['record_identity'] and assignment['dataset_id'] in datasets:
                    dataset_id = assignment['dataset_id']
                    association = {'status': 'manual', 'method': 'manual'}
                else:
                    issues.append('The prior manual assignment no longer matches this run or an available dataset.')
            row['dataset_id'] = dataset_id
            row['association'] = association
            legacy_graph = False
            if source == 'recorded' and records.get('visualization.json', {}).get('status') == 'verified_completed':
                try:
                    from agent.stage6.workspace import recorded_completed_result
                    row['graph'] = recorded_completed_result(row['run_id'])['graph']['counts']
                    legacy_graph = True
                except (OSError, ValueError, KeyError, TypeError, ImportError):
                    issues.append('The original visualization settings or graph exports were not recorded or are unreadable.')
            row['capabilities'] = {'continue_analysis': source == 'live' and not conflict and not invalid_claim,
                                   'stage_results': _readable_stages(row, root, records) if source in ('live', 'archive') else [],
                                   'stage6_graph': (legacy_graph or source in ('live', 'archive') and bool(row.get('graph'))) and not conflict and not invalid_claim,
                                   'assign_dataset': source in ('recorded', 'archive') and not claims and not invalid_claim}
            if conflict or invalid_claim:
                row['capabilities']['stage_results'] = []
            row['attempts'] = _attempts(row, records, digests, issues)
            row['output_revalidation'] = {}
            for step, entries in row['attempts'].items():
                current = next((entry for entry in entries if entry['current'] and entry['availability'] == 'recorded'), None)
                if row['capabilities']['continue_analysis'] and current:
                    row['output_revalidation'][step] = jobs.output_revalidation(current['record'])
                else:
                    row['output_revalidation'][step] = {
                        'eligible': False, 'active': False,
                        'reason': 'Only the current readable live workspace attempt can be rechecked.'}
            row['issues'] = list(dict.fromkeys([*row.get('issues', []), *issues]))
            result.append(row)
        from agent.runtime.workspace_run_labels import enrich_rows
        return {'datasets': list(datasets.values()), 'runs': enrich_rows(result)}


def assign_dataset(history_id, dataset_id, revision, history_loader):
    """Assign only unclassified/previously manual legacy records, with a stale guard."""
    with _LOCK:
        try:
            _identifier(history_id)
            signet._name(dataset_id)
            if not isinstance(revision, str) or not re.fullmatch(r'[a-f0-9]{64}', revision):
                raise ValueError('Provide the current history revision.')
        except (ValueError, TypeError) as error:
            raise jobs.StepError('invalid_request', str(error)) from error
        if dataset_id not in {record['id'] for record in workspace_datasets.list_datasets()}:
            raise jobs.StepError('not_found', 'No saved dataset with this ID exists.')
        history = history_loader()
        row = next((record for record in history['runs'] if record['history_id'] == history_id), None)
        if row is None:
            raise jobs.StepError('not_found', 'No recorded analysis with this history ID exists.')
        if not row['capabilities']['assign_dataset']:
            raise jobs.StepError('conflict', 'Recorded dataset ownership cannot be replaced by a manual assignment.')
        if row['revision'] != revision:
            raise jobs.StepError('conflict', 'The run records changed. Refresh history before assigning a dataset.')
        associations = _load()
        associations[history_id] = {'history_id': history_id, 'dataset_id': dataset_id,
                                    'record_identity': row['record_identity'],
                                    'assigned_at': time.strftime('%Y-%m-%dT%H:%M:%S%z')}
        _save(associations)
        return next(record for record in history_loader()['runs'] if record['history_id'] == history_id)
