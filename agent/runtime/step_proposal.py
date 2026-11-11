"""Conversation-scoped confirmation of one step in a linked HPC3 analysis."""
from contextvars import ContextVar
import hashlib
import json
import secrets

from agent.runtime import signet_jobs as jobs
from agent.runtime.hpc import PREPARED, REFERENCE_FILES
from agent.tools import signet

CHAT_SESSION = ContextVar('analysis_chat_session', default=None)


def _path(root, step):
    return root / f'{step}-proposal.json'


def _read(root, step):
    try:
        return json.loads(_path(root, step).read_text())
    except FileNotFoundError:
        return None


def view(root, step='genotype'):
    record = _read(root, step)
    if record is None:
        return None
    return {key: record[key] for key in ('id', 'state', 'mode', 'parameters')}


def _write(root, step, record):
    path = _path(root, step)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(record, indent=2) + '\n')
    temporary.replace(path)


def require_owner(root, session, allow_unlinked=False):
    owner = jobs.analysis_session(root)
    if not session or (owner != session and not (owner is None and allow_unlinked)):
        raise jobs.StepError('not_found', 'This analysis is not linked to this conversation.')


def next_step(records):
    return next((name for name in jobs.ANALYSIS_STEPS
                 if records.get(name, {}).get('state') != 'completed'), None)


def _available(root, step):
    records = jobs.run_records(root)
    if next_step(records) != step:
        raise jobs.StepError('conflict', 'Complete the preceding steps of this analysis first.')
    if ((root / '.active').exists()
            or any(record['state'] in jobs.ACTIVE or jobs._legacy_visualize_output_failure(record)
                   for record in records.values())):
        raise jobs.StepError('conflict', 'This analysis already has an active attempt.')
    return records.get(step, {})


def _baseline(settings, attempt):
    # Status checks can change polling metadata without changing the prior attempt.
    previous = {key: attempt.get(key) for key in ('attempt', 'job_id', 'state')}
    return hashlib.sha256(json.dumps([settings, previous], sort_keys=True).encode()).hexdigest()


def _parameters(name, step, settings, attempt, mode):
    inputs = {key: attempt.get('inputs', {}).get(key, '') for key in step.inputs}
    values = {key: settings[key] for key in step.settings}
    resources = {key: attempt.get('resources', {}).get(key, value) for key, value in step.resources.items()}
    options = {key: attempt.get('options', {}).get(key, default) for key, (_, default) in step.prompts.items()}
    if not attempt:
        if name == 'expression':
            values['restrict.tcga'] = settings['restrict.tcga.geno']
        if name == 'network' and values['memory'] == '256':
            values['memory'] = '128'
        if mode == 'example':
            if name == 'genotype':
                folder = jobs._environment()['root'] + '/' + PREPARED
                inputs = {'ped.file': folder + '/study.ped', 'map.file': folder + '/study.map',
                          'ref': folder + '/ref/chr', 'gmap': folder + '/gmap/chr'}
                values['restrict.tcga.geno'] = '1'
            elif name == 'expression':
                config = jobs._environment()
                inputs = {'gexp.file': config['source'] + '/example/gexp/example_gexp',
                          'pmap.file': config['root'] + '/' + REFERENCE_FILES['gtf']}
            elif name == 'visualize':
                values.update(freq='0.5', ntop='1')
    parameters = {'inputs': inputs, 'settings': values, 'resources': resources}
    if options:
        parameters['options'] = options
    return parameters


@jobs._one_at_a_time
def prepare(run_id, session, mode=None, *, step_name='genotype', allow_unlinked=False):
    root = jobs._root(run_id)
    require_owner(root, session, allow_unlinked)
    step = jobs._step(step_name)
    if mode is None:
        mode = (_read(root, 'genotype') or {}).get('mode', 'custom')
    if mode not in ('example', 'custom'):
        raise jobs.StepError('invalid_request', 'Choose example or custom analysis inputs.')
    settings = signet._settings(root)
    if settings.get('cohort') != step.cohort:
        raise jobs.StepError('invalid_request', 'This review requires a TCGA analysis.')
    attempt = _available(root, step_name)
    baseline = _baseline(settings, attempt)
    existing = _read(root, step_name)
    if existing and existing['state'] == 'confirmed':
        raise jobs.StepError('conflict', 'The previous confirmation may still be submitting. Check progress first.')
    if (existing and existing['state'] == 'pending' and existing['mode'] == mode
            and existing['baseline'] == baseline):
        return view(root, step_name)
    parameters = _parameters(step_name, step, settings, attempt, mode)
    if jobs.analysis_session(root) is None:
        jobs.link_conversation(run_id, session)
    _write(root, step_name, {'id': secrets.token_hex(16), 'state': 'pending', 'mode': mode,
                             'baseline': baseline, 'parameters': parameters})
    return view(root, step_name)


def _pending(root, session, step, proposal_id):
    require_owner(root, session)
    record = _read(root, step)
    if not record or record['id'] != proposal_id or record['state'] != 'pending':
        raise jobs.StepError('conflict', 'This confirmation is outdated or has already been used.')
    return record


@jobs._one_at_a_time
def decline(run_id, session, proposal_id, *, step_name='genotype'):
    root = jobs._root(run_id)
    record = _pending(root, session, step_name, proposal_id)
    record['state'] = 'declined'
    _write(root, step_name, record)
    return view(root, step_name)


@jobs._one_at_a_time
def confirm(run_id, session, proposal_id, inputs, settings, resources, options=None, *, step_name='genotype'):
    root = jobs._root(run_id)
    record = _pending(root, session, step_name, proposal_id)
    attempt = _available(root, step_name)
    if record['baseline'] != _baseline(signet._settings(root), attempt):
        record['state'] = 'stale'
        _write(root, step_name, record)
        raise jobs.StepError('conflict', 'Analysis settings changed. Open a fresh confirmation card.')
    step = jobs._step(step_name)
    if not isinstance(settings, dict) or set(settings) != set(step.settings):
        raise jobs.StepError('invalid_request', 'All step settings must be reviewed.')
    if not isinstance(resources, dict) or set(resources) != set(step.resources):
        raise jobs.StepError('invalid_request', 'All compute resources must be reviewed.')
    if step.prompts and (not isinstance(options, dict) or set(options) != set(step.prompts)):
        raise jobs.StepError('invalid_request', 'All step options must be reviewed.')
    reviewed = jobs.validate_settings(step.settings, settings)
    answers = jobs._options(step, options)
    jobs._resources(step, resources)
    config = jobs._environment()
    directory = jobs._remote_dir(config, root, run_id)
    jobs._inputs(step, inputs, (config['root'] + '/refdata', config['source'] + '/example', directory))

    # Consume the card under the submission lock before contacting the scheduler.
    parameters = {'inputs': inputs, 'settings': reviewed, 'resources': resources}
    if answers:
        parameters['options'] = answers
    record.update(state='confirmed', parameters=parameters)
    _write(root, step_name, record)
    try:
        result = jobs.submit(run_id, step_name, inputs, resources, answers, settings_override=settings)
    except jobs.StepError:
        record['state'] = 'submission_error'
        _write(root, step_name, record)
        raise
    record['state'] = 'unknown' if result['state'] == 'unknown' else 'sent'
    _write(root, step_name, record)
    return result
