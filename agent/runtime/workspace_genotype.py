"""Manual workspace steps for saved datasets and the original chromosome 1 example."""

from bisect import bisect_right
from collections import Counter
import json
import math
from pathlib import Path
import shlex
from statistics import median

from agent.runtime import signet_jobs as jobs
from agent.runtime.hpc import PREPARED, REFERENCE_FILES
import agent.tools.signet as signet

DATASET_ID = 'example-chr1'
SNAPSHOT = 'workspace-genotype.json'
EXPRESSION_SNAPSHOT = 'workspace-expression.json'
ADJUST_SNAPSHOT = 'workspace-adjust.json'
CIS_SNAPSHOT = 'workspace-cis.json'
NETWORK_SNAPSHOT = 'workspace-network.json'
VISUALIZE_SNAPSHOT = 'workspace-visualize.json'
_CLINICAL_REVIEW = (Path(__file__).with_name('jobs') / 'review_clinical.py').read_text()
_RETRY_SOURCES = (Path(__file__).with_name('jobs') / 'review_retry_sources.py').read_text()
DEFAULT_SETTINGS = {'restrict.tcga.geno': 1, 'mind': 0.1, 'geno': 0.1, 'hwe': 0.0001, 'int': 5000000}


def _example_inputs(config):
    directory = config['root'] + '/' + PREPARED
    return {'ped.file': directory + '/study.ped', 'map.file': directory + '/study.map',
            'ref': directory + '/ref/chr', 'gmap': directory + '/gmap/chr'}


def review_example():
    """Review the exact prepared example files without creating a run or a job."""
    try:
        signet._verify_source()
    except (ValueError, OSError) as error:
        raise jobs.StepError('not_ready', str(error)) from error
    config = jobs._environment()
    inputs = _example_inputs(config)
    step = jobs.STEPS['genotype']
    checked = jobs._inputs(step, inputs, (config['root'] + '/refdata',))
    files = jobs._files(step, checked, {'restrict.tcga.geno': '1'})
    script = (jobs._say() + jobs._input_checks(files)
              + f'if [ ! -s {shlex.quote(config["image"])} ]; then say not_ready container; exit 5; fi\n'
              + 'if ! command -v sbatch >/dev/null 2>&1; then say not_ready sbatch; exit 5; fi\n')
    try:
        code, markers, _ = jobs._shell(script)
    except OSError as error:
        raise jobs.StepError('remote_failed', 'Could not verify the prepared example files on HPC3.') from error
    if 'missing_input' in markers:
        raise jobs.StepError(
            'not_ready', f'Prepare the chromosome 1 example in the remote environment. '
            f'{markers["missing_input"]} is unavailable ({markers["missing_file"]}).')
    if 'not_ready' in markers:
        raise jobs.StepError('not_ready', 'The remote environment is missing ' + markers['not_ready'] + '.')
    if code:
        raise jobs.StepError('remote_failed', 'The prepared example file check failed on HPC3.')
    return {'inputs': inputs, 'settings': DEFAULT_SETTINGS.copy(),
            'resources': step.resources.copy(), 'limits': step.limits.copy()}


def submit_example(run_id, inputs, settings, resources):
    try:
        run_id = signet._name(run_id)
    except ValueError as error:
        raise jobs.StepError('invalid_request', str(error)) from error
    return _submit_example(run_id, inputs, settings, resources)


@jobs._one_at_a_time
def _submit_example(run_id, inputs, settings, resources):
    existing = signet.PROJECT / 'runs' / run_id
    archived = signet.PROJECT / 'data/stage6-results' / run_id
    if existing.exists() or archived.exists() or existing.is_symlink() or archived.is_symlink():
        raise jobs.StepError('conflict', f'A run named {run_id} already exists. Check its saved status.')
    if run_id in jobs.RESERVED_RUN_IDS:
        raise jobs.StepError('invalid_request', f'Run name {run_id} is reserved.')
    config = jobs._environment()
    accepted_inputs = _example_inputs(config)
    if inputs != accepted_inputs:
        raise jobs.StepError('invalid_request', 'The example inputs changed. Review the current files again.')
    if not isinstance(settings, dict) or set(settings) != set(DEFAULT_SETTINGS) or settings['restrict.tcga.geno'] != 1:
        raise jobs.StepError('invalid_request', 'Confirm all genotype settings for chromosome 1.')
    step = jobs.STEPS['genotype']
    checked = {key: jobs._setting(key, rule, settings[key]) for key, rule in step.settings.items()}
    accepted_resources = jobs._resources(step, resources)

    created = signet.configure_signet(run_id, 'TCGA')
    if created['status'] != 'created':
        raise jobs.StepError('invalid_request', created['error'])
    root = signet._run(run_id)
    jobs.update_settings(run_id, settings)
    snapshot = {
        'run_id': run_id, 'dataset_id': DATASET_ID, 'submitted_at': jobs._now(),
        'inputs': accepted_inputs, 'settings': checked, 'resources': accepted_resources,
    }
    # Save the confirmed inputs before submitting so a lost connection cannot detach the job from history.
    temporary = root / (SNAPSHOT + '.tmp')
    temporary.write_text(json.dumps(snapshot, indent=2) + '\n')
    temporary.replace(root / SNAPSHOT)
    return jobs.submit(run_id, 'genotype', accepted_inputs, resources)


def _workspace_run(run_id):
    try:
        root = signet._run(run_id)
        history = run_history(root)
    except (ValueError, OSError, KeyError, TypeError) as error:
        raise jobs.StepError('not_found', 'Select the workspace run created in Stage 1.') from error
    return root, history


def _initial(root):
    from agent.runtime.workspace_inputs import effective_snapshot
    return effective_snapshot(root, json.loads(signet._no_links(root / SNAPSHOT).read_text()))


def _dataset_id(root):
    return signet._name(_initial(root)['dataset_id'])


def _retry_context(run_id, expected_job_id, expected_attempt):
    from agent.runtime import workspace_history
    if (not isinstance(expected_job_id, str) or expected_job_id != 'none' and
            (not expected_job_id.isascii() or not expected_job_id.isdigit())
            or type(expected_attempt) is not int or not 1 <= expected_attempt < workspace_history.MAX_ATTEMPTS):
        raise jobs.StepError('invalid_request', 'Provide the displayed Stage 1 job ID and attempt number.')
    root = jobs._root(run_id)
    try:
        initial, initial_digest = workspace_history._json(root / SNAPSHOT)
        previous, previous_digest = workspace_history._json(root / 'steps/genotype.json')
        previous = workspace_history._attempt_record(previous, run_id, 'genotype')
        if initial.get('run_id') != run_id:
            raise ValueError('The original genotype snapshot identifies a different run.')
        signet._name(initial['dataset_id'])
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise jobs.StepError('not_found', 'Select a workspace run with its original Stage 1 snapshot and job record.') from error
    if ((previous.get('job_id') or 'none') != expected_job_id or previous.get('attempt', 1) != expected_attempt):
        raise jobs.StepError('conflict', 'The Stage 1 job or attempt changed. Refresh its status before reviewing a retry.')
    if previous['state'] not in jobs.RETRYABLE:
        raise jobs.StepError('conflict', 'Only a failed or cancelled Stage 1 can be retried in the same run.')
    if (root / '.active').exists() or (root / '.active').is_symlink():
        raise jobs.StepError('conflict', 'This run has an active operation. Confirm its status before retrying.')
    snapshots = (EXPRESSION_SNAPSHOT, ADJUST_SNAPSHOT, CIS_SNAPSHOT, NETWORK_SNAPSHOT, VISUALIZE_SNAPSHOT)
    evidence = [root / name for name in snapshots]
    for name in snapshots:
        evidence += list(root.glob(name[:-5] + '.review*.json'))
    for name in ('expression_tcga', 'expression_gtex', 'adjust_tcga', 'adjust_gtex', 'pca', 'plot_pca', 'cis_eqtl', 'network', 'visualization'):
        evidence += [root / (name + '.json'), root / (name + '.plan.json')]
    for step in jobs.STEPS:
        if step != 'genotype':
            evidence += list((root / 'steps').glob(step + '*.json'))
    from agent.runtime.workspace_rerun import retry_preserved_paths
    preserved = retry_preserved_paths(root)
    if any((path.exists() or path.is_symlink()) and path not in preserved for path in evidence):
        raise jobs.StepError('conflict', 'A later stage has already been reviewed or attempted. Create a separate analysis instead of replacing its Stage 1 inputs.')
    return root, initial, previous, initial_digest, previous_digest


def _retry_environment(root, initial, previous, config):
    directory = jobs._remote_dir(config, root, root.name)
    saved_environment = initial.get('environment', {})
    environment_keys = ('root', 'source', 'image', 'executor', 'workRoot', 'partition', 'runtimeModule')
    if (previous.get('remote_dir') != directory or previous.get('image') != config['image']
            or previous.get('partition') != config['partition']
            or initial.get('mode') == 'dataset' and any(saved_environment.get(key) != config.get(key) for key in environment_keys)):
        raise jobs.StepError('not_ready', 'Select the original remote workspace, container and runtime used by this run.')
    return directory


def _review_genotype_retry(run_id, expected_job_id, expected_attempt):
    from agent.runtime import workspace_inputs
    root, initial, previous, initial_digest, previous_digest = _retry_context(run_id, expected_job_id, expected_attempt)
    config = jobs._environment()
    directory = _retry_environment(root, initial, previous, config)
    environment_keys = ('root', 'source', 'image', 'executor', 'workRoot', 'partition', 'runtimeModule')
    step = jobs.STEPS['genotype']
    try:
        saved = previous['settings']
        settings = {key: int(saved[key]) if key in ('restrict.tcga.geno', 'int') else float(saved[key]) for key in DEFAULT_SETTINGS}
        for key, rule in step.settings.items():
            jobs._setting(key, rule, settings[key])
        resources = {key: previous['resources'][key] for key in step.resources}
        jobs._resources(step, resources)
        chromosome = int(initial['settings']['restrict.tcga.geno'])
        if settings['restrict.tcga.geno'] != chromosome:
            raise ValueError('The original chromosome differs from the saved attempt.')
    except (KeyError, ValueError, TypeError, OverflowError) as error:
        raise jobs.StepError('conflict', 'The original chromosome or saved Stage 1 settings are unavailable.') from error
    next_attempt = expected_attempt + 1
    mode = initial.get('mode', 'example')
    inputs = initial['inputs']
    warnings = ['This submits a new Stage 1 attempt in the same run; earlier attempts, files and logs remain preserved.']
    frozen = None
    if mode == 'dataset':
        plan = workspace_inputs.staging_plan(root, directory, attempt=next_attempt)
        files = plan['source_files']
        inputs = plan['inputs']
        frozen = workspace_inputs.frozen_paths(directory, next_attempt)
        warnings.append('Original source files and reference resources must remain unchanged. This attempt freezes them again and prepares fresh study-specific references in its own input directory; partial or complete earlier preparations are not reused.')
    elif initial['dataset_id'] == DATASET_ID:
        checked = jobs._inputs(step, inputs, (config['root'] + '/refdata', config['source'] + '/example', directory))
        files = [{'role': key, 'path': path} for key, path, _ in jobs._files(step, checked, {'restrict.tcga.geno': str(chromosome)})]
        warnings.append('This older example snapshot did not save input fingerprints. The original file paths are checked now; their contents at the first execution cannot be reconstructed.')
    else:
        raise jobs.StepError('conflict', 'The original dataset preparation mode was not recorded; a safe same-run retry is unavailable.')
    source_inputs = initial.get('source_inputs', {'genotype': [item['path'] for item in files], 'expression': [], 'clinical': []})
    result = {'run_id': run_id, 'dataset_id': initial['dataset_id'],
              'dataset_name': initial.get('dataset_name', ['第 1 號染色體範例', 'Chromosome 1 example']),
              'mode': mode, 'inputs': inputs, 'source_inputs': source_inputs,
              'settings': settings, 'resources': resources, 'limits': step.limits.copy(),
              'expected_job_id': previous.get('job_id'), 'expected_attempt': expected_attempt,
              'next_attempt': next_attempt, 'ready': False, 'issues': [], 'warnings': warnings}
    if frozen:
        result['frozen_inputs'] = frozen
    try:
        jobs._ensure_stopped(previous)
    except jobs.StepError as error:
        result['issues'].append(str(error))
        return result
    script = ('python3 - ' + shlex.quote(json.dumps(files)) + " <<'SIGNET_RETRY_SOURCES'\n"
              + _RETRY_SOURCES + '\nSIGNET_RETRY_SOURCES\n')
    script += jobs._say() + f'[ -s {shlex.quote(config["image"])} ] || {{ say not_ready container; exit 5; }}\n'
    script += 'command -v sbatch >/dev/null 2>&1 || { say not_ready sbatch; exit 5; }\n'
    try:
        code, values, _ = jobs._shell(script)
        source_checks = json.loads(values.get('retry_sources', '{}'))
    except (OSError, ValueError) as error:
        raise jobs.StepError('remote_failed', 'Could not check the original Stage 1 sources before retrying.') from error
    result['issues'] += source_checks.get('issues', [])
    if code or len(source_checks.get('files', [])) != len(files) or values.get('not_ready'):
        result['issues'].append('The original files, container or scheduler are not ready for this retry.')
    result['ready'] = not result['issues']
    if result['ready']:
        result['review_token'] = workspace_inputs.fingerprint({'initial': initial_digest, 'previous': previous_digest,
            'inputs': inputs, 'sources': source_checks['files'], 'environment': {key: config.get(key) for key in environment_keys}})
    return result


@jobs._one_at_a_time
def review_genotype_retry(run_id, expected_job_id, expected_attempt):
    return _review_genotype_retry(run_id, expected_job_id, expected_attempt)


@jobs._one_at_a_time
def submit_genotype_retry(run_id, inputs, settings, resources, review_token, expected_job_id, expected_attempt, acknowledge_warnings):
    root, initial, _, _, _ = _retry_context(run_id, expected_job_id, expected_attempt)
    if type(acknowledge_warnings) is not bool or not acknowledge_warnings:
        raise jobs.StepError('invalid_request', 'Acknowledge the original-input and retry-preparation warnings before submitting.')
    if not isinstance(settings, dict) or set(settings) != set(DEFAULT_SETTINGS):
        raise jobs.StepError('invalid_request', 'Confirm all five Stage 1 settings.')
    checked = {key: jobs._setting(key, rule, settings[key]) for key, rule in jobs.STEPS['genotype'].settings.items()}
    if checked['restrict.tcga.geno'] != str(initial['settings']['restrict.tcga.geno']):
        raise jobs.StepError('invalid_request', 'The chromosome is fixed by the original study. Create another run to change it.')
    accepted_resources = jobs._resources(jobs.STEPS['genotype'], resources)
    review = _review_genotype_retry(run_id, expected_job_id, expected_attempt)
    if not review['ready']:
        raise jobs.StepError('not_ready', ' '.join(review['issues']))
    if not isinstance(review_token, str) or review_token != review['review_token'] or inputs != review['inputs']:
        raise jobs.StepError('conflict', 'The original sources or attempt changed. Review Stage 1 again before submitting.')
    path = signet._no_links(root / f'workspace-genotype.review{review["next_attempt"]}.json')
    if path.exists() or path.is_symlink():
        raise jobs.StepError('conflict', 'The next Stage 1 review snapshot already exists and will not be overwritten.')
    snapshot = {**initial, 'review_attempt': review['next_attempt'], 'submitted_at': jobs._now(),
                'inputs': inputs, 'settings': checked, 'resources': accepted_resources,
                'review_token': review_token, 'acknowledge_warnings': True}
    if review.get('frozen_inputs'):
        snapshot['frozen_inputs'] = review['frozen_inputs']
    with path.open('x') as stream:
        stream.write(json.dumps(snapshot, indent=2) + '\n')
    try:
        jobs.update_settings(run_id, settings)
        return jobs.submit(run_id, 'genotype', inputs, resources)
    finally:
        try:
            current = jobs._load(root, 'genotype')
        except (OSError, ValueError, jobs.StepError):
            current = None
        if isinstance(current, dict) and current.get('attempt', 1) != review['next_attempt']:
            path.unlink(missing_ok=True)


def review_dataset(dataset_id, inputs):
    from agent.runtime.workspace_inputs import review
    return review(dataset_id, inputs)


def submit_dataset(dataset_id, run_id, inputs, settings, resources, review_token, acknowledge_warnings):
    try:
        signet._name(run_id)
    except ValueError as error:
        raise jobs.StepError('invalid_request', str(error)) from error
    return _submit_dataset(run_id, dataset_id, inputs, settings, resources, review_token, acknowledge_warnings)


@jobs._one_at_a_time
def _submit_dataset(run_id, dataset_id, inputs, settings, resources, review_token, acknowledge_warnings):
    from agent.runtime import workspace_inputs
    existing = signet.PROJECT / 'runs' / run_id
    archived = signet.PROJECT / 'data/stage6-results' / run_id
    if existing.exists() or archived.exists() or existing.is_symlink() or archived.is_symlink():
        raise jobs.StepError('conflict', 'This run already exists. Check its saved status.')
    if run_id in jobs.RESERVED_RUN_IDS:
        raise jobs.StepError('invalid_request', 'This run name is reserved. Choose a different name.')
    if type(acknowledge_warnings) is not bool or not isinstance(review_token, str):
        raise jobs.StepError('invalid_request', 'Confirm the reviewed sources and warnings explicitly.')
    source = workspace_inputs.saved(dataset_id)
    review = workspace_inputs.review(dataset_id, source['inputs'])
    if not review['ready']:
        raise jobs.StepError('not_ready', ' '.join(review['issues']))
    if review['review_token'] != review_token or inputs != review['inputs']:
        raise jobs.StepError('conflict', 'The reviewed dataset or reference resources changed. Review Stage 1 again.')
    if review['warnings'] and not acknowledge_warnings:
        raise jobs.StepError('invalid_request', 'Acknowledge the input and reference-preparation warnings before submitting.')
    if not isinstance(settings, dict) or set(settings) != set(DEFAULT_SETTINGS):
        raise jobs.StepError('invalid_request', 'Confirm all genotype settings.')
    checked = {key: jobs._setting(key, rule, settings[key]) for key, rule in jobs.STEPS['genotype'].settings.items()}
    if checked['restrict.tcga.geno'] != str(review['settings']['restrict.tcga.geno']):
        raise jobs.StepError('invalid_request', 'The selected chromosome must match the reviewed study and reference.')
    accepted_resources = jobs._resources(jobs.STEPS['genotype'], resources)
    if review['mode'] == 'example':
        return _submit_example(run_id, inputs, settings, resources)
    config = review['environment']
    root = signet.PROJECT / 'runs' / run_id
    directory = jobs._remote_dir(config, root, run_id)
    frozen = workspace_inputs.frozen_paths(directory)
    step_inputs = {'ped.file': frozen['genotype'][0], 'map.file': frozen['genotype'][1],
                   'ref': frozen['ref'], 'gmap': frozen['gmap']}
    created = signet.configure_signet(run_id, 'TCGA')
    if created['status'] != 'created':
        raise jobs.StepError('invalid_request', created['error'])
    jobs.update_settings(run_id, settings)
    snapshot = {'run_id': run_id, 'dataset_id': dataset_id, 'dataset_name': source['name'], 'mode': 'dataset',
                'submitted_at': jobs._now(), 'inputs': step_inputs, 'settings': checked,
                'resources': accepted_resources, 'remote_dir': directory, 'source_inputs': source['inputs'],
                'frozen_inputs': frozen, 'source_files': review['source_files'],
                'reference_sources': review['reference_sources'], 'environment': config,
                'review_token': review_token, 'acknowledge_warnings': acknowledge_warnings}
    temporary = root / (SNAPSHOT + '.tmp')
    temporary.write_text(json.dumps(snapshot, indent=2) + '\n')
    temporary.replace(root / SNAPSHOT)
    return jobs.submit(run_id, 'genotype', step_inputs, resources)


def _expression_run(run_id):
    root, history = _workspace_run(run_id)
    genotype = history['jobs']['genotype']
    if genotype['state'] != 'completed':
        raise jobs.StepError('not_ready', 'Wait for Stage 1 of this run to complete before submitting Stage 2.')
    return root, history


def _expression_inputs(config):
    q = shlex.quote
    annotation = config['root'] + '/' + REFERENCE_FILES['gtf']
    table = config['root'] + '/refdata/selected.tsv'
    script = (jobs._say() + f'annotation={q(annotation)}\n'
              + f'if [ -f {q(table)} ]; then\n'
              + f'  while IFS=$\'\\t\' read -r key path; do [ "$key" != gtf ] || annotation="$path"; done < {q(table)}\n'
              + 'fi\nsay annotation "$annotation"\n')
    try:
        code, values, _ = jobs._shell(script)
    except OSError as error:
        raise jobs.StepError('remote_failed', 'Could not read the configured gene annotation on HPC3.') from error
    if code or not values.get('annotation'):
        raise jobs.StepError('remote_failed', 'Could not read the configured gene annotation on HPC3.')
    # The pinned example inventory uses gexp; upstream config.ini.default still says gexp-prep.
    return {'gexp.file': config['source'] + '/example/gexp/example_gexp',
            'pmap.file': values['annotation']}


def _review_expression(run_id):
    root, history = _expression_run(run_id)
    config = jobs._environment()
    if history['jobs']['genotype']['remote_dir'] != jobs._remote_dir(config, root, run_id):
        raise jobs.StepError('not_ready', 'Select the remote environment used by Stage 1 of this run.')
    initial = _initial(root)
    frozen = initial.get('frozen_inputs') if initial.get('mode') == 'dataset' else None
    inputs = {'gexp.file': frozen['expression'][0], 'pmap.file': frozen['annotation']} if frozen else _expression_inputs(config)
    chromosome = int(initial['settings']['restrict.tcga.geno'])
    step = jobs.STEPS['expression']
    checked = jobs._inputs(step, inputs, (config['root'] + '/refdata', config['source'] + '/example', jobs._remote_dir(config, root, run_id)))
    files = jobs._files(step, checked, {'restrict.tcga': str(chromosome)})
    script = (jobs._say() + jobs._input_checks(files)
              + f'if [ ! -s {shlex.quote(config["image"])} ]; then say not_ready container; exit 5; fi\n'
              + 'if ! command -v sbatch >/dev/null 2>&1; then say not_ready sbatch; exit 5; fi\n')
    if frozen:
        from agent.runtime.workspace_inputs import frozen_checks
        script += frozen_checks(jobs._remote_dir(config, root, run_id), initial.get('genotype_attempt', 1))
    try:
        code, values, _ = jobs._shell(script)
    except OSError as error:
        raise jobs.StepError('remote_failed', 'Could not verify the expression inputs on HPC3.') from error
    if 'missing_input' in values:
        raise jobs.StepError('not_ready', 'The Stage 2 input is unavailable: ' + values['missing_file'])
    if code or 'not_ready' in values:
        raise jobs.StepError('not_ready', 'The Stage 2 environment is not ready. Check remote settings.')
    return {'run_id': run_id, 'inputs': inputs, 'settings': {'restrict.tcga': chromosome}, 'frozen': bool(frozen),
            'resources': step.resources.copy(), 'limits': step.limits.copy()}


@jobs._one_at_a_time
def review_expression(run_id):
    """Confirm this run's Stage 2 files without modifying it or submitting a job."""
    return _review_expression(run_id)


@jobs._one_at_a_time
def submit_expression(run_id, inputs, settings, resources):
    root, _ = _expression_run(run_id)
    record_path = jobs._record_path(root, 'expression')
    previous = jobs._load(root, 'expression') if record_path.exists() else None
    if previous and previous.get('state') not in jobs.RETRYABLE:
        raise jobs.StepError('conflict', 'Stage 2 already has a recorded job. Check its status before submitting.')
    if jobs._active_step(root) or (root / '.active').exists():
        raise jobs.StepError('conflict', 'A step of this run is still active. Check its status first.')
    review = _review_expression(run_id)
    if inputs != review['inputs']:
        raise jobs.StepError('invalid_request', 'The Stage 2 input files changed. Review the current files again.')
    if not isinstance(settings, dict) or set(settings) != {'restrict.tcga'}:
        raise jobs.StepError('invalid_request', 'Confirm the chromosome 1 expression setting.')
    chromosome = jobs._setting('restrict.tcga', 'chromosome', settings['restrict.tcga'])
    if chromosome != _initial(root)['settings']['restrict.tcga.geno']:
        raise jobs.StepError('invalid_request', 'Stage 2 must use the same chromosome as this run\'s genotype stage.')
    accepted_resources = jobs._resources(jobs.STEPS['expression'], resources)
    if previous:
        jobs._ensure_stopped(previous)
    path = signet._no_links(root / EXPRESSION_SNAPSHOT)
    review_attempt = 1
    if path.exists():
        saved = json.loads(path.read_text())
        review_attempt = saved['review_attempt'] + 1
        archive = root / f'workspace-expression.review{saved["review_attempt"]}.json'
        if archive.exists() or archive.is_symlink():
            raise jobs.StepError('conflict', 'The previous Stage 2 review archive already exists.')
        with archive.open('x') as stream:
            stream.write(json.dumps(saved, indent=2) + '\n')
    snapshot = {'run_id': run_id, 'dataset_id': _dataset_id(root), 'review_attempt': review_attempt,
                'submitted_at': jobs._now(), 'inputs': inputs,
                'settings': {'restrict.tcga': chromosome}, 'resources': accepted_resources}
    jobs.update_settings(run_id, settings)
    temporary = root / (EXPRESSION_SNAPSHOT + '.tmp')
    temporary.write_text(json.dumps(snapshot, indent=2) + '\n')
    temporary.replace(path)
    return jobs.submit(run_id, 'expression', inputs, resources)


def _adjust_inputs(config, clinical):
    if clinical is not None:
        return {'cli.file': clinical}
    q = shlex.quote
    default = config['root'] + '/' + REFERENCE_FILES['clinical']
    archived_example = config['root'] + '/refdata/official-demo-chr1-restart-clinical.tsv'
    table = config['root'] + '/refdata/selected.tsv'
    script = (jobs._say() + f'clinical={q(default)}\n'
              + f'if [ -s {q(archived_example)} ]; then clinical={q(archived_example)}; fi\n'
              + f'if [ -f {q(table)} ]; then\n'
              + f'  while IFS=$\'\\t\' read -r key path; do [ "$key" != clinical ] || clinical="$path"; done < {q(table)}\n'
              + 'fi\nsay clinical "$clinical"\n')
    try:
        code, values, _ = jobs._shell(script)
    except OSError as error:
        raise jobs.StepError('remote_failed', 'Could not read the configured clinical file on HPC3.') from error
    if code or not values.get('clinical'):
        raise jobs.StepError('remote_failed', 'Could not read the configured clinical file on HPC3.')
    return {'cli.file': values['clinical']}


def _clinical_choices(choices):
    if choices is None:
        return {}
    if (not isinstance(choices, dict) or len(choices) > 64 or
            any(not isinstance(key, str) or not 1 <= len(key) <= 240 or
                value not in ('not_reported', 'exclude') for key, value in choices.items())):
        raise jobs.StepError('invalid_request', 'Choose the recorded treatment for each unrecognized clinical race value.')
    return choices.copy()


def _adjust_review_token(run_id, inputs, choices, clinical, history, config):
    import re
    from agent.runtime.workspace_inputs import fingerprint
    digests = clinical.get('upstream_digests', {})
    if (not isinstance(clinical.get('source_digest'), str)
            or not re.fullmatch(r'[a-f0-9]{64}', clinical['source_digest'])
            or not isinstance(digests, dict) or set(digests) != {'genotype', 'expression'}
            or any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value) for value in digests.values())):
        raise jobs.StepError('review_required', 'The clinical source fingerprints are unavailable. Check the clinical file again.')
    return fingerprint({'version': 1, 'run_id': run_id, 'source': inputs['cli.file'], 'choices': choices,
        'source_digest': clinical['source_digest'], 'upstream_digests': digests,
        'upstream': {name: {key: history['jobs'][name].get(key) for key in
            ('run_id', 'step', 'job_id', 'attempt', 'remote_dir', 'image', 'partition')}
            for name in ('genotype', 'expression')},
        'environment': {key: config.get(key) for key in
            ('root', 'source', 'image', 'executor', 'workRoot', 'partition', 'runtimeModule')},
        'reviewer': _CLINICAL_REVIEW})


def _review_adjust(run_id, clinical=None, choices=None, out=None):
    choices = _clinical_choices(choices)
    root, history = _workspace_run(run_id)
    config = jobs._environment()
    step = jobs.STEPS['adjust']
    initial = _initial(root)
    frozen = initial.get('frozen_inputs') if initial.get('mode') == 'dataset' else None
    if frozen and clinical is not None and clinical != frozen['clinical'][0]:
        raise jobs.StepError('invalid_request', 'This run uses its frozen clinical file; create a new run to use different inputs.')
    inputs = {'cli.file': frozen['clinical'][0]} if frozen else _adjust_inputs(config, clinical)
    directory = jobs._remote_dir(config, root, run_id)
    checked = jobs._inputs(step, inputs, (config['root'] + '/refdata', config['source'] + '/example', directory))
    result = {'run_id': run_id, 'inputs': inputs, 'options': {'npc': 3},
              'resources': step.resources.copy(), 'limits': step.limits.copy(),
              'ready': False, 'issues': [], 'clinical': None, 'choices': choices, 'frozen': bool(frozen)}
    issues = result['issues']
    for name in ('genotype', 'expression'):
        record = history['jobs'].get(name)
        if not record or record['state'] != 'completed':
            issues.append(f'Wait for {name} to complete in this same run.')
        elif record['remote_dir'] != directory:
            issues.append(f'Select the remote environment used by {name} of this run.')
    if issues:
        result['reason'] = ' '.join(issues)
        return result
    q = shlex.quote
    script = jobs._say()
    if out:
        script += jobs._output_guard(root, history['jobs']['expression'])
    script += jobs._input_checks(jobs._files(step, checked, {}))
    if frozen:
        from agent.runtime.workspace_inputs import frozen_checks
        script += frozen_checks(directory, initial.get('genotype_attempt', 1))
    for relative in step.needs:
        path = directory + '/work/' + relative
        script += f'if [ ! -s {q(path)} ]; then say missing_prior {q(relative)}; exit 5; fi\n'
    script += (f'if [ ! -s {q(config["image"])} ]; then say not_ready container; exit 5; fi\n'
               + 'if ! command -v sbatch >/dev/null 2>&1; then say not_ready sbatch; exit 5; fi\n')
    script += ('python3 - ' + ' '.join(q(path) for path in (
        inputs['cli.file'], directory + '/work/res/resg/signet_Genotype.sampleID',
        directory + '/work/res/rest/signet_gexpID', json.dumps(choices), *([out] if out else []))) + " <<'SIGNET_CLINICAL_REVIEW'\n"
        + _CLINICAL_REVIEW + '\nSIGNET_CLINICAL_REVIEW\n')
    try:
        code, values, _ = jobs._shell(script)
    except OSError as error:
        raise jobs.StepError('remote_failed', 'Could not check the clinical file on HPC3.') from error
    if 'missing_input' in values:
        issues.append('The clinical file is unavailable: ' + values['missing_file'])
    elif 'missing_prior' in values:
        issues.append('This run is missing an earlier-stage intermediate: ' + values['missing_prior'])
    elif 'not_ready' in values:
        issues.append('The remote environment is missing ' + values['not_ready'] + '.')
    elif code or not values.get('clinical'):
        issues.append('The clinical compatibility check could not finish on HPC3.')
    else:
        result['clinical'] = json.loads(values['clinical'])
        issues.extend(result['clinical']['issues'])
        if set(choices) - set(result['clinical'].get('unrecognized_race', {})):
            issues.append('The clinical categories changed. Review the current unrecognized values again.')
        if out and not result['clinical'].get('written'):
            issues.append('The reviewed clinical copy could not be prepared.')
    result['ready'] = not issues
    result['reason'] = ' '.join(issues)
    if result['ready']:
        result['review_token'] = _adjust_review_token(run_id, inputs, choices, result['clinical'], history, config)
    return result


@jobs._one_at_a_time
def review_adjust(run_id, clinical=None, choices=None):
    """Return the review form and readiness without changing this run or its files."""
    return _review_adjust(run_id, clinical, choices)


@jobs._one_at_a_time
def submit_adjust(run_id, inputs, options, resources, choices=None, review_token=None):
    root, _ = _workspace_run(run_id)
    path = jobs._record_path(root, 'adjust')
    previous = jobs._load(root, 'adjust') if path.exists() else None
    if previous and previous.get('state') not in jobs.RETRYABLE:
        raise jobs.StepError('conflict', 'Stage 3 already has a recorded job. Check its status before submitting.')
    if jobs._active_step(root) or (root / '.active').exists():
        raise jobs.StepError('conflict', 'A step of this run is still active. Check its status first.')
    if not isinstance(inputs, dict) or set(inputs) != {'cli.file'}:
        raise jobs.StepError('invalid_request', 'Confirm the clinical file for this run.')
    answers = jobs._options(jobs.STEPS['adjust'], options)
    accepted_resources = jobs._resources(jobs.STEPS['adjust'], resources)
    choices = _clinical_choices(choices)
    review = _review_adjust(run_id, inputs['cli.file'], choices)
    if not review['ready']:
        raise jobs.StepError('not_ready', review['reason'])
    if review_token is not None and (not isinstance(review_token, str)
            or review_token != review.get('review_token')):
        raise jobs.StepError('review_required', 'The clinical source, choices or upstream results changed. Check the clinical file again before submitting.')
    if previous:
        jobs._ensure_stopped(previous)
    path = signet._no_links(root / ADJUST_SNAPSHOT)
    attempt = 1
    archive = saved = None
    if path.exists():
        saved = json.loads(path.read_text())
        attempt = saved['review_attempt'] + 1
        archive = root / f'workspace-adjust.review{saved["review_attempt"]}.json'
        if archive.exists() or archive.is_symlink():
            raise jobs.StepError('conflict', 'The previous Stage 3 review archive already exists.')
    config = jobs._environment()
    directory = jobs._remote_dir(config, root, run_id)
    token = review.get('review_token')
    suffix = '-' + token if token else ''
    prepared = directory + f'/inputs/clinical/review{attempt}{suffix}/clinical.tsv'
    source = review['inputs']['cli.file']
    prepared_review = _review_adjust(run_id, source, choices, prepared)
    if not prepared_review['ready']:
        raise jobs.StepError('not_ready', prepared_review['reason'])
    if (prepared_review.get('review_token') != review.get('review_token')
            or prepared_review['clinical'].get('source_digest') != review['clinical'].get('source_digest')
            or prepared_review['clinical'].get('upstream_digests') != review['clinical'].get('upstream_digests')):
        raise jobs.StepError('review_required', 'The clinical source or upstream results changed while preparing the reviewed copy. The copy was preserved; check the clinical file again before submitting.')
    if archive is not None:
        with archive.open('x') as stream:
            stream.write(json.dumps(saved, indent=2) + '\n')
    accepted_inputs = {'cli.file': prepared}
    clinical = {'source': source, 'choices': choices, 'review': prepared_review['clinical']}
    snapshot = {'run_id': run_id, 'dataset_id': _dataset_id(root), 'review_attempt': attempt,
                'submitted_at': jobs._now(), 'inputs': accepted_inputs, 'clinical': clinical,
                'options': answers, 'resources': accepted_resources}
    temporary = root / (ADJUST_SNAPSHOT + '.tmp')
    temporary.write_text(json.dumps(snapshot, indent=2) + '\n')
    temporary.replace(path)
    try:
        result = jobs.submit(run_id, 'adjust', accepted_inputs, resources, answers)
    finally:
        record_path = jobs._record_path(root, 'adjust')
        if record_path.is_file():
            record = jobs._load(root, 'adjust')
            if record.get('inputs') == accepted_inputs:
                record['clinical'] = clinical
                jobs._save(root, record)
    result['clinical'] = clinical
    return result


def _review_cis(run_id):
    root, history = _workspace_run(run_id)
    config = jobs._environment()
    step = jobs.STEPS['cis']
    current = signet._settings(root)
    jobs._check_current(step, current)
    settings = {key: float(current[key]) if rule == 'alpha' else int(current[key])
                for key, rule in step.settings.items()}
    directory = jobs._remote_dir(config, root, run_id)
    sources = {key: directory + '/work/' + relative for key, relative in step.links.items()}
    result = {'run_id': run_id, 'inputs': {}, 'settings': settings,
              'resources': step.resources.copy(), 'limits': step.limits.copy(),
              'input_sources': sources, 'ready': False, 'issues': []}
    issues = result['issues']
    for name in ('genotype', 'expression', 'adjust'):
        record = history['jobs'].get(name)
        if not record or record['state'] != 'completed':
            issues.append(f'Wait for {name} to complete in this same run.')
        elif record['remote_dir'] != directory:
            issues.append(f'Select the remote environment used by {name} of this run.')
    if issues:
        result['reason'] = ' '.join(issues)
        return result
    q = shlex.quote
    script = jobs._say() + jobs._input_checks([(key, path, directory) for key, path in sources.items()])
    script += (f'if [ ! -s {q(config["image"])} ]; then say not_ready container; exit 5; fi\n'
               + 'if ! command -v sbatch >/dev/null 2>&1; then say not_ready sbatch; exit 5; fi\n')
    try:
        code, values, _ = jobs._shell(script)
    except OSError as error:
        raise jobs.StepError('remote_failed', 'Could not check the Stage 4 inputs on HPC3.') from error
    if 'missing_input' in values:
        issues.append('This run is missing a Stage 4 input: ' + values['missing_file'])
    elif 'not_ready' in values:
        issues.append('The remote environment is missing ' + values['not_ready'] + '.')
    elif code:
        issues.append('The Stage 4 input check could not finish on HPC3.')
    result['ready'] = not issues
    result['reason'] = ' '.join(issues)
    return result


@jobs._one_at_a_time
def review_cis(run_id):
    """Review the same run's association settings and preceding outputs without submitting."""
    return _review_cis(run_id)


@jobs._one_at_a_time
def submit_cis(run_id, inputs, settings, resources):
    root, _ = _workspace_run(run_id)
    record_path = jobs._record_path(root, 'cis')
    previous = jobs._load(root, 'cis') if record_path.exists() else None
    if previous and previous.get('state') not in jobs.RETRYABLE:
        raise jobs.StepError('conflict', 'Stage 4 already has a recorded job. Check its status before submitting.')
    if jobs._active_step(root) or (root / '.active').exists():
        raise jobs.StepError('conflict', 'A step of this run is still active. Check its status first.')
    if inputs != {}:
        raise jobs.StepError('invalid_request', 'Stage 4 uses the preceding outputs of this run; inputs must be {}.')
    step = jobs.STEPS['cis']
    if not isinstance(settings, dict) or set(settings) != set(step.settings):
        raise jobs.StepError('invalid_request', 'Confirm the significance threshold, permutation count and analysis range.')
    checked = {key: jobs._setting(key, rule, settings[key]) for key, rule in step.settings.items()}
    accepted_resources = jobs._resources(step, resources)
    review = _review_cis(run_id)
    if not review['ready']:
        raise jobs.StepError('not_ready', review['reason'])
    if previous:
        jobs._ensure_stopped(previous)
    path = signet._no_links(root / CIS_SNAPSHOT)
    attempt = 1
    if path.exists():
        saved = json.loads(path.read_text())
        attempt = saved['review_attempt'] + 1
        archive = root / f'workspace-cis.review{saved["review_attempt"]}.json'
        if archive.exists() or archive.is_symlink():
            raise jobs.StepError('conflict', 'The previous Stage 4 review archive already exists.')
        with archive.open('x') as stream:
            stream.write(json.dumps(saved, indent=2) + '\n')
    snapshot = {'run_id': run_id, 'dataset_id': _dataset_id(root), 'review_attempt': attempt,
                'submitted_at': jobs._now(), 'inputs': {}, 'settings': checked,
                'input_sources': review['input_sources'], 'resources': accepted_resources}
    jobs.update_settings(run_id, settings)
    temporary = root / (CIS_SNAPSHOT + '.tmp')
    temporary.write_text(json.dumps(snapshot, indent=2) + '\n')
    temporary.replace(path)
    return jobs.submit(run_id, 'cis', {}, resources)


def _review_network(run_id):
    root, history = _workspace_run(run_id)
    config = jobs._environment()
    step = jobs.STEPS['network']
    current = signet._settings(root)
    settings, applied = {}, []
    resource_defaults = {'ncores': 16, 'memory': 32, 'walltime': '4:00:00'}
    for key, rule in step.settings.items():
        text = current[key]
        try:
            value = text if rule == 'hms' else float(text) if rule == 'alpha' else int(text)
            jobs._setting(key, rule, value)
        except (ValueError, jobs.StepError):
            if key not in resource_defaults:
                raise jobs.StepError('invalid_request', f'The saved {key} value is invalid. Review the run settings.')
            value = resource_defaults[key]
            applied.append(f'The saved {key} value {text} is outside the supported range. Review the proposed value {value}.')
        settings[key] = value
    cis = history['jobs'].get('cis')
    saved_alpha = cis.get('settings', {}).get('alpha.cis') if cis else None
    source_settings = {**current, **({'alpha.cis': saved_alpha} if saved_alpha is not None else {})}
    jobs._setting('alpha.cis', 'alpha', float(source_settings['alpha.cis']))
    directory = jobs._remote_dir(config, root, run_id)
    sources = {key: directory + '/work/' + jobs._resolve(relative, source_settings)
               for key, relative in step.links.items()}
    result = {'run_id': run_id, 'inputs': {}, 'settings': settings,
              'resources': step.resources.copy(), 'limits': step.limits.copy(),
              'input_sources': sources, 'source_cis_alpha': saved_alpha,
              'defaults_applied': applied, 'ready': False, 'issues': []}
    issues = result['issues']
    for name in ('genotype', 'expression', 'adjust', 'cis'):
        record = history['jobs'].get(name)
        if not record or record['state'] != 'completed':
            issues.append(f'Wait for {name} to complete in this same run.')
        elif record['remote_dir'] != directory:
            issues.append(f'Select the remote environment used by {name} of this run.')
    if cis and saved_alpha is None:
        issues.append('The completed association step has no saved significance threshold.')
    if issues:
        result['reason'] = ' '.join(issues)
        return result
    q = shlex.quote
    script = jobs._say() + jobs._input_checks([(key, path, directory) for key, path in sources.items()])
    script += (f'if [ ! -s {q(config["image"])} ]; then say not_ready container; exit 5; fi\n'
               + 'if ! command -v sbatch >/dev/null 2>&1; then say not_ready sbatch; exit 5; fi\n')
    try:
        code, values, _ = jobs._shell(script)
    except OSError as error:
        raise jobs.StepError('remote_failed', 'Could not check the Stage 5 inputs on HPC3.') from error
    if 'missing_input' in values:
        issues.append('This run is missing a Stage 5 input: ' + values['missing_file'])
    elif 'not_ready' in values:
        issues.append('The remote environment is missing ' + values['not_ready'] + '.')
    elif code:
        issues.append('The Stage 5 input check could not finish on HPC3.')
    result['ready'] = not issues
    result['reason'] = ' '.join(issues)
    return result


@jobs._one_at_a_time
def review_network(run_id):
    """Review the original association result and worker/control resources without submitting."""
    return _review_network(run_id)


@jobs._one_at_a_time
def submit_network(run_id, inputs, settings, resources):
    root, _ = _workspace_run(run_id)
    record_path = jobs._record_path(root, 'network')
    previous = jobs._load(root, 'network') if record_path.exists() else None
    if previous and previous.get('state') not in jobs.RETRYABLE:
        raise jobs.StepError('conflict', 'Stage 5 already has a recorded job. Check its status before submitting.')
    if jobs._active_step(root) or (root / '.active').exists():
        raise jobs.StepError('conflict', 'A step of this run is still active. Check its status first.')
    if inputs != {}:
        raise jobs.StepError('invalid_request', 'Stage 5 uses the preceding outputs of this run; inputs must be {}.')
    step = jobs.STEPS['network']
    if not isinstance(settings, dict) or set(settings) != set(step.settings):
        raise jobs.StepError('invalid_request', 'Confirm the bootstrap, correlation and compute-job settings.')
    checked = {key: jobs._setting(key, rule, settings[key]) for key, rule in step.settings.items()}
    accepted_resources = jobs._resources(step, resources)
    review = _review_network(run_id)
    if not review['ready']:
        raise jobs.StepError('not_ready', review['reason'])
    if previous:
        jobs._ensure_stopped(previous)
    path = signet._no_links(root / NETWORK_SNAPSHOT)
    attempt = 1
    if path.exists():
        saved = json.loads(path.read_text())
        attempt = saved['review_attempt'] + 1
        archive = root / f'workspace-network.review{saved["review_attempt"]}.json'
        if archive.exists() or archive.is_symlink():
            raise jobs.StepError('conflict', 'The previous Stage 5 review archive already exists.')
        with archive.open('x') as stream:
            stream.write(json.dumps(saved, indent=2) + '\n')
    snapshot = {'run_id': run_id, 'dataset_id': _dataset_id(root), 'review_attempt': attempt,
                'submitted_at': jobs._now(), 'inputs': {}, 'settings': checked,
                'input_sources': review['input_sources'], 'source_cis_alpha': review['source_cis_alpha'],
                'resources': accepted_resources}
    # The network's significance file belongs to the completed cis attempt even after later edits.
    jobs.update_settings(run_id, settings)
    signet._update(root, {'alpha.cis': review['source_cis_alpha']})
    temporary = root / (NETWORK_SNAPSHOT + '.tmp')
    temporary.write_text(json.dumps(snapshot, indent=2) + '\n')
    temporary.replace(path)
    return jobs.submit(run_id, 'network', {}, resources)


def _review_visualize(run_id, settings):
    from agent.runtime.visualization import validate_inputs

    root, history = _workspace_run(run_id)
    config = jobs._environment()
    step = jobs.STEPS['visualize']
    checked = {key: jobs._setting(key, rule, settings[key]) for key, rule in step.settings.items()}
    directory = jobs._remote_dir(config, root, run_id)
    sources = {key: directory + '/work/' + relative for key, relative in step.links.items()}
    result = {'run_id': run_id, 'inputs': {},
              'settings': {'freq': float(checked['freq']), 'ntop': int(checked['ntop'])},
              'resources': step.resources.copy(), 'limits': step.limits.copy(),
              'input_sources': sources, 'ready': False, 'issues': [], 'validation': None}
    issues = result['issues']
    for name in ('genotype', 'expression', 'adjust', 'cis', 'network'):
        record = history['jobs'].get(name)
        if not record or record['state'] != 'completed':
            issues.append(f'Wait for {name} to complete in this same run.')
        elif record['remote_dir'] != directory:
            issues.append(f'Select the remote environment used by {name} of this run.')
    if not issues:
        try:
            local = {key: str(signet._no_links(root / 'work' / relative)) for key, relative in step.links.items()}
            result['validation'] = validate_inputs({**local, **checked})
        except (OSError, ValueError, OverflowError) as error:
            issues.append(str(error))
    if issues:
        result['reason'] = ' '.join(issues)
        return result
    q = shlex.quote
    script = jobs._say() + jobs._input_checks([(key, path, directory) for key, path in sources.items()])
    script += (f'if [ ! -s {q(config["image"])} ]; then say not_ready container; exit 5; fi\n'
               + 'if ! command -v sbatch >/dev/null 2>&1; then say not_ready sbatch; exit 5; fi\n')
    try:
        code, values, _ = jobs._shell(script)
    except OSError as error:
        raise jobs.StepError('remote_failed', 'Could not check the Stage 6 inputs on HPC3.') from error
    if 'missing_input' in values:
        issues.append('This run is missing a Stage 6 input: ' + values['missing_file'])
    elif 'not_ready' in values:
        issues.append('The remote environment is missing ' + values['not_ready'] + '.')
    elif code:
        issues.append('The Stage 6 input check could not finish on HPC3.')
    result['ready'] = not issues
    result['reason'] = ' '.join(issues)
    return result


@jobs._one_at_a_time
def review_visualize(run_id, freq=None, ntop=None):
    """Check the reviewed threshold against this run's completed network without creating work."""
    root, _ = _workspace_run(run_id)
    current = signet._settings(root)
    try:
        settings = {'freq': float(current['freq'] if freq is None else freq),
                    'ntop': int(current['ntop'] if ntop is None else ntop)}
    except (ValueError, TypeError) as error:
        raise jobs.StepError('invalid_request', 'Confirm a numeric frequency and whole-number subnetwork count.') from error
    return _review_visualize(run_id, settings)


@jobs._one_at_a_time
def submit_visualize(run_id, inputs, settings, resources):
    root, _ = _workspace_run(run_id)
    record_path = jobs._record_path(root, 'visualize')
    previous = jobs._load(root, 'visualize') if record_path.exists() else None
    if previous and previous.get('state') not in jobs.RETRYABLE:
        raise jobs.StepError('conflict', 'Stage 6 already has a recorded job. Check its status before submitting.')
    if jobs._active_step(root) or (root / '.active').exists():
        raise jobs.StepError('conflict', 'A step of this run is still active. Check its status first.')
    if inputs != {}:
        raise jobs.StepError('invalid_request', 'Stage 6 uses the completed network of this run; inputs must be {}.')
    step = jobs.STEPS['visualize']
    if not isinstance(settings, dict) or set(settings) != set(step.settings):
        raise jobs.StepError('invalid_request', 'Confirm the frequency threshold and subnetwork count.')
    checked = {key: jobs._setting(key, rule, settings[key]) for key, rule in step.settings.items()}
    accepted_resources = jobs._resources(step, resources)
    review = _review_visualize(run_id, settings)
    if not review['ready']:
        raise jobs.StepError('not_ready', review['reason'])
    if previous:
        jobs._ensure_stopped(previous)
    path = signet._no_links(root / VISUALIZE_SNAPSHOT)
    attempt = 1
    if path.exists():
        saved = json.loads(path.read_text())
        attempt = saved['review_attempt'] + 1
        archive = root / f'workspace-visualize.review{saved["review_attempt"]}.json'
        if archive.exists() or archive.is_symlink():
            raise jobs.StepError('conflict', 'The previous Stage 6 review archive already exists.')
        with archive.open('x') as stream:
            stream.write(json.dumps(saved, indent=2) + '\n')
    snapshot = {'run_id': run_id, 'dataset_id': _dataset_id(root), 'review_attempt': attempt,
                'submitted_at': jobs._now(), 'inputs': {}, 'settings': checked,
                'input_sources': review['input_sources'], 'resources': accepted_resources,
                'validation': review['validation']}
    jobs.update_settings(run_id, settings)
    temporary = root / (VISUALIZE_SNAPSHOT + '.tmp')
    temporary.write_text(json.dumps(snapshot, indent=2) + '\n')
    temporary.replace(path)
    return jobs.submit(run_id, 'visualize', {}, resources)


def run_history(root):
    """Return the most recent recorded step alongside the immutable review snapshot."""
    run_id = root.name
    snapshot = _initial(root)
    dataset_id = signet._name(snapshot['dataset_id'])
    if snapshot['run_id'] != run_id:
        raise ValueError('The genotype history does not identify this run.')
    job = {key: snapshot[key] for key in ('submitted_at', 'inputs', 'settings', 'resources')}
    job['state'] = 'submitting' if (root / '.active').exists() else 'not_submitted'
    path = signet._no_links(root / 'steps/genotype.json')
    if path.is_file():
        record = jobs._load(root, 'genotype')
        if record['run_id'] != run_id or record['step'] != 'genotype':
            raise ValueError('The genotype step record does not belong to this run.')
        job.update(record)
    inputs = job['inputs']
    chromosome = job['settings']['restrict.tcga.geno']
    result = {
        'run_id': run_id, 'dataset_id': dataset_id, 'source': 'live',
        'name': ['第 1 號染色體 · 基因型準備', 'Chromosome 1 · Genotype preparation'],
        'inputs': {'genotype': [inputs['ped.file'], inputs['map.file'],
                                inputs['ref'] + chromosome + '.gen', inputs['gmap'] + chromosome + '.map'],
                   'expression': [], 'clinical': []},
        'jobs': {'genotype': job}, 'status': job['state'], 'graph': None,
    }
    expression_path = signet._no_links(root / EXPRESSION_SNAPSHOT)
    if expression_path.is_file():
        expression = json.loads(expression_path.read_text(encoding='utf-8'))
        if expression['run_id'] != run_id or expression['dataset_id'] != dataset_id:
            raise ValueError('The expression history does not identify this run.')
        expression_job = {key: expression[key] for key in ('submitted_at', 'inputs', 'settings', 'resources')}
        expression_job['state'] = 'submitting' if (root / '.active').exists() else 'not_submitted'
        if signet._no_links(root / 'steps/expression.json').is_file():
            record = jobs._load(root, 'expression')
            if record['run_id'] != run_id or record['step'] != 'expression':
                raise ValueError('The expression step record does not belong to this run.')
            expression_job.update(record)
        result['jobs']['expression'] = expression_job
        result['inputs']['expression'] = [expression_job['inputs'][key] for key in ('gexp.file', 'pmap.file')]
        result['status'] = expression_job['state']
        result['name'] = ['第 1 號染色體 · 分析', 'Chromosome 1 · Analysis']
    adjust_path = signet._no_links(root / ADJUST_SNAPSHOT)
    if adjust_path.is_file():
        adjustment = json.loads(adjust_path.read_text(encoding='utf-8'))
        if adjustment['run_id'] != run_id or adjustment['dataset_id'] != dataset_id:
            raise ValueError('The adjustment history does not identify this run.')
        adjustment_job = {key: adjustment[key] for key in ('submitted_at', 'inputs', 'options', 'resources')}
        if adjustment.get('clinical'):
            adjustment_job['clinical'] = adjustment['clinical']
        adjustment_job['state'] = 'submitting' if (root / '.active').exists() else 'not_submitted'
        if signet._no_links(root / 'steps/adjust.json').is_file():
            record = jobs._load(root, 'adjust')
            if record['run_id'] != run_id or record['step'] != 'adjust':
                raise ValueError('The adjustment step record does not belong to this run.')
            adjustment_job.update(record)
        result['jobs']['adjust'] = adjustment_job
        result['inputs']['clinical'] = [adjustment_job['inputs']['cli.file']]
        result['status'] = adjustment_job['state']
        result['name'] = ['第 1 號染色體 · 分析', 'Chromosome 1 · Analysis']
    cis_path = signet._no_links(root / CIS_SNAPSHOT)
    if cis_path.is_file():
        association = json.loads(cis_path.read_text(encoding='utf-8'))
        if association['run_id'] != run_id or association['dataset_id'] != dataset_id:
            raise ValueError('The association history does not identify this run.')
        association_job = {key: association[key] for key in ('submitted_at', 'inputs', 'settings', 'resources', 'input_sources')}
        association_job['state'] = 'submitting' if (root / '.active').exists() else 'not_submitted'
        if signet._no_links(root / 'steps/cis.json').is_file():
            record = jobs._load(root, 'cis')
            if record['run_id'] != run_id or record['step'] != 'cis':
                raise ValueError('The association step record does not belong to this run.')
            association_job.update(record)
        result['jobs']['cis'] = association_job
        result['status'] = association_job['state']
        result['name'] = ['第 1 號染色體 · 分析', 'Chromosome 1 · Analysis']
    network_path = signet._no_links(root / NETWORK_SNAPSHOT)
    if network_path.is_file():
        network = json.loads(network_path.read_text(encoding='utf-8'))
        if network['run_id'] != run_id or network['dataset_id'] != dataset_id:
            raise ValueError('The network history does not identify this run.')
        network_job = {key: network[key] for key in
                       ('submitted_at', 'inputs', 'settings', 'resources', 'input_sources', 'source_cis_alpha')}
        network_job['state'] = 'submitting' if (root / '.active').exists() else 'not_submitted'
        if signet._no_links(root / 'steps/network.json').is_file():
            record = jobs._load(root, 'network')
            if record['run_id'] != run_id or record['step'] != 'network':
                raise ValueError('The network step record does not belong to this run.')
            network_job.update(record)
        result['jobs']['network'] = network_job
        result['status'] = network_job['state']
        result['name'] = ['第 1 號染色體 · 分析', 'Chromosome 1 · Analysis']
    visualize_path = signet._no_links(root / VISUALIZE_SNAPSHOT)
    if visualize_path.is_file():
        visualization = json.loads(visualize_path.read_text(encoding='utf-8'))
        if visualization['run_id'] != run_id or visualization['dataset_id'] != dataset_id:
            raise ValueError('The visualization history does not identify this run.')
        visualize_job = {key: visualization[key] for key in
                         ('submitted_at', 'inputs', 'settings', 'resources', 'input_sources')}
        visualize_job['validation'] = visualization.get('validation')
        visualize_job['state'] = 'submitting' if (root / '.active').exists() else 'not_submitted'
        if signet._no_links(root / 'steps/visualize.json').is_file():
            record = jobs._load(root, 'visualize')
            if record['run_id'] != run_id or record['step'] != 'visualize':
                raise ValueError('The visualization step record does not belong to this run.')
            visualize_job.update(record)
        result['jobs']['visualize'] = visualize_job
        result['status'] = visualize_job['state']
        result['name'] = ['第 1 號染色體 · 分析', 'Chromosome 1 · Analysis']
        if visualize_job['state'] == 'completed':
            from agent.stage6.workspace import live_completed_result
            try:
                result['graph'] = live_completed_result(run_id)['graph']['counts']
            except (OSError, ValueError, KeyError, TypeError, OverflowError):
                result['result_error'] = 'The saved Stage 6 graph could not be read.'
    if snapshot.get('mode') == 'dataset':
        result.update(input_mode='dataset', dataset_name=snapshot['dataset_name'],
                      frozen_inputs=snapshot['frozen_inputs'], inputs=snapshot['source_inputs'],
                      name=snapshot['dataset_name'])
        summary = signet._no_links(root / 'work/res/resg/workspace-reference-preparation.json')
        if summary.is_file():
            try:
                result['reference_preparation'] = json.loads(summary.read_text())
            except (OSError, ValueError, TypeError):
                result['result_error'] = 'The saved reference-preparation summary is incomplete or unreadable.'
    linked = signet._no_links(root / 'rerun.json')
    if linked.is_file():
        plan = json.loads(linked.read_text())
        result['rerun'] = {key: plan[key] for key in ('source_run_id', 'step', 'reuse', 'invalidated', 'created_at')}
        target_state = result['jobs'].get(plan['step'], {}).get('state', 'not_submitted')
        if target_state != 'completed':
            result['status'] = target_state
    return result


def completed_result(run_id, stage='1'):
    root = signet._run(run_id)
    name = {'1': 'genotype', '2': 'expression', '4': 'cis', '5': 'network'}[stage]
    job = run_history(root)['jobs'][name]
    if job['state'] != 'completed':
        raise ValueError(f'The {name} step is not complete.')
    if stage == '4':
        from agent.runtime.workspace_cis import summary as cis_summary
        summary = cis_summary(root, job)
    elif stage == '5':
        from agent.runtime.workspace_network import summary as network_summary
        summary = network_summary(root, job)
    else:
        summary = genotype_summary(root) if stage == '1' else expression_summary(root)
    return {'run_id': run_id, 'stage': int(stage), 'job': job, 'summary': summary}


def expression_summary(root):
    """Summarize the downloaded matrix with bounded memory and no remote queries."""
    directory = root / 'work/res/rest'
    sample_ids = signet._no_links(directory / 'signet_gexpID')
    names_path = signet._no_links(directory / 'signet_gene_name')
    positions = signet._no_links(directory / 'signet_gene_pos')
    matrix = signet._no_links(directory / 'signet_gexp')
    with sample_ids.open(encoding='utf-8') as stream:
        samples = sum(bool(line.strip()) for line in stream)
    with names_path.open(encoding='utf-8') as stream:
        names = [line.strip() for line in stream if line.strip()]
    genes = len(names)
    with positions.open(encoding='utf-8') as stream:
        position_count = sum(bool(line.strip()) for line in stream)
    if not samples or not genes or position_count != genes:
        raise ValueError('The expression output has inconsistent sample or gene identifiers.')
    if any(not name or len(name) > 240 for name in names):
        raise ValueError('The expression output contains invalid gene names.')
    minimum, maximum, rows = math.inf, -math.inf, 0
    excerpt = [[] for _ in names[:5]]
    with matrix.open(encoding='utf-8') as stream:
        for line in stream:
            if not line.strip():
                continue
            row = [float(value) for value in line.split()]
            if len(row) != genes or not all(map(math.isfinite, row)):
                raise ValueError('The expression matrix contains invalid or inconsistent values.')
            minimum = min(minimum, min(row))
            maximum = max(maximum, max(row))
            rows += 1
            for index, values in enumerate(excerpt):
                values.append(row[index])
    if rows != samples:
        raise ValueError('The expression output does not match its sample identifiers.')
    if minimum == maximum:
        bounds = [minimum - 0.5, maximum + 0.5]
    else:
        bounds = [minimum + (maximum - minimum) * index / 10 for index in range(11)]
    histogram = [{'lower': lower, 'upper': upper, 'count': 0} for lower, upper in zip(bounds, bounds[1:])]
    with matrix.open(encoding='utf-8') as stream:
        for line in stream:
            for text in line.split():
                value = float(text)
                index = min(len(histogram) - 1, bisect_right(bounds, value) - 1)
                histogram[index]['count'] += 1
    return {'samples': samples, 'genes': genes, 'histogram': histogram,
            'gene_summary': [{'gene': name, 'min': min(values), 'median': median(values), 'max': max(values)}
                             for name, values in zip(names[:5], excerpt)]}


def genotype_summary(root):
    """Read only the local Stage 1 outputs already collected by the status operation."""
    directory = root / 'work/res/resg'
    sample_ids = signet._no_links(directory / 'signet_Genotype.sampleID')
    with sample_ids.open(encoding='utf-8') as stream:
        samples = sum(1 for line in stream if line.strip())
    if not samples:
        raise ValueError('The genotype output has no sample identifiers.')

    genotypes = signet._no_links(directory / 'signet_Geno')
    codes = Counter()
    nonzero = []
    sample_rows = 0
    with genotypes.open(encoding='utf-8') as stream:
        for line in stream:
            row = line.split()
            if not row:
                continue
            if not nonzero:
                nonzero = [0] * len(row)
            if len(row) != len(nonzero):
                raise ValueError('The genotype output contains rows of different widths.')
            codes.update(row)
            for index, code in enumerate(row):
                nonzero[index] += code != '0'
            sample_rows += 1
    if sample_rows != samples or not nonzero or set(codes) - {'0', '1', '2'}:
        raise ValueError('The genotype output does not match its sample identifiers or encoding.')
    bins = [0] * 6
    for count in nonzero:
        percent = count * 100
        index = sum(percent >= threshold * samples for threshold in (1, 5, 10, 25, 50))
        bins[index] += 1
    return {'samples': samples, 'variants': len(nonzero), 'nonzero_bins': bins,
            'genotype_codes': [codes[str(code)] for code in range(3)]}
