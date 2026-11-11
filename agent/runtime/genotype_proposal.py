"""Conversation-scoped review of the settings for one HPC3 genotype attempt."""
from contextvars import ContextVar
import hashlib
import json
import secrets

from agent.runtime import signet_jobs as jobs
from agent.runtime.hpc import PREPARED
from agent.tools import signet

CHAT_SESSION = ContextVar('genotype_chat_session', default=None)
STEP = jobs.STEPS['genotype']
_FILE = 'genotype-proposal.json'


def _read(root):
    try:
        return json.loads((root / _FILE).read_text())
    except FileNotFoundError:
        return None


def view(root):
    record = _read(root)
    if record is None:
        return None
    return {key: record[key] for key in ('id', 'state', 'mode', 'parameters')}


def _write(root, record):
    temporary = root / (_FILE + '.tmp')
    temporary.write_text(json.dumps(record, indent=2) + '\n')
    temporary.replace(root / _FILE)


def _owned(root, session, allow_unlinked=False):
    owner = jobs.analysis_session(root)
    if not session or (owner != session and not (owner is None and allow_unlinked)):
        raise jobs.StepError('not_found', 'This analysis is not linked to this conversation.')


def _available(root):
    records = jobs.run_records(root)
    previous = records.get('genotype', {})
    if (previous and previous['state'] not in jobs.RETRYABLE) or (
            (root / '.active').exists() or any(r['state'] in jobs.ACTIVE for r in records.values())):
        raise jobs.StepError('conflict', 'This analysis already has an active or completed genotype attempt.')
    return previous


def _baseline(settings, attempt):
    # A different input or configuration must be reviewed again. Polling metadata
    # can change without changing the identity of the reviewed prior attempt.
    previous = {key: attempt.get(key) for key in ('attempt', 'job_id', 'state')}
    return hashlib.sha256(json.dumps([settings, previous], sort_keys=True).encode()).hexdigest()


@jobs._one_at_a_time
def prepare(run_id, session, mode, *, allow_unlinked=False):
    root = jobs._root(run_id)
    _owned(root, session, allow_unlinked)
    if mode not in ('example', 'custom'):
        raise jobs.StepError('invalid_request', 'Choose example or custom genotype inputs.')
    settings = signet._settings(root)
    if settings.get('cohort') != STEP.cohort:
        raise jobs.StepError('invalid_request', 'The genotype review requires a TCGA analysis.')
    attempt = _available(root)
    baseline = _baseline(settings, attempt)
    existing = _read(root)
    if existing and existing['state'] == 'confirmed':
        raise jobs.StepError('conflict', 'The previous confirmation may still be submitting. Check progress first.')
    if (existing and existing['state'] == 'pending' and existing['mode'] == mode
            and existing['baseline'] == baseline):
        return view(root)

    inputs = {key: attempt.get('inputs', {}).get(key, '') for key in STEP.inputs}
    values = {key: settings[key] for key in STEP.settings}
    resources = {key: attempt.get('resources', {}).get(key, value) for key, value in STEP.resources.items()}
    if mode == 'example':
        folder = jobs._environment()['root'] + '/' + PREPARED
        inputs = {'ped.file': folder + '/study.ped', 'map.file': folder + '/study.map',
                  'ref': folder + '/ref/chr', 'gmap': folder + '/gmap/chr'}
        values['restrict.tcga.geno'] = '1'
    if jobs.analysis_session(root) is None:
        jobs.link_conversation(run_id, session)
    _write(root, {'id': secrets.token_hex(16), 'state': 'pending', 'mode': mode, 'baseline': baseline,
                  'parameters': {'inputs': inputs, 'settings': values, 'resources': resources}})
    return view(root)


def _pending(root, session, proposal_id):
    _owned(root, session)
    record = _read(root)
    if not record or record['id'] != proposal_id or record['state'] != 'pending':
        raise jobs.StepError('conflict', 'This confirmation is outdated or has already been used.')
    return record


@jobs._one_at_a_time
def decline(run_id, session, proposal_id):
    root = jobs._root(run_id)
    record = _pending(root, session, proposal_id)
    record['state'] = 'declined'
    _write(root, record)
    return view(root)


@jobs._one_at_a_time
def confirm(run_id, session, proposal_id, inputs, settings, resources):
    root = jobs._root(run_id)
    record = _pending(root, session, proposal_id)
    attempt = _available(root)
    current = signet._settings(root)
    if record['baseline'] != _baseline(current, attempt):
        record['state'] = 'stale'
        _write(root, record)
        raise jobs.StepError('conflict', 'Analysis settings changed. Open a fresh confirmation card.')
    if not isinstance(settings, dict) or set(settings) != set(STEP.settings):
        raise jobs.StepError('invalid_request', 'All genotype settings must be reviewed.')
    if not isinstance(resources, dict) or set(resources) != set(STEP.resources):
        raise jobs.StepError('invalid_request', 'All compute resources must be reviewed.')
    reviewed = jobs.validate_settings(STEP.settings, settings)
    jobs._resources(STEP, resources)
    config = jobs._environment()
    directory = jobs._remote_dir(config, root, run_id)
    jobs._inputs(STEP, inputs, (config['root'] + '/refdata', config['source'] + '/example', directory))

    # Consume the proposal under the same run lock as submit, before contacting
    # HPC3. A lost reply cannot be replayed, even if the job outcome is unknown.
    record.update(state='confirmed', parameters={'inputs': inputs, 'settings': reviewed, 'resources': resources})
    _write(root, record)
    try:
        result = jobs.submit(run_id, 'genotype', inputs, resources, settings_override=settings)
    except jobs.StepError:
        record['state'] = 'submission_error'
        _write(root, record)
        raise
    record['state'] = 'unknown' if result['state'] == 'unknown' else 'sent'
    _write(root, record)
    return result
