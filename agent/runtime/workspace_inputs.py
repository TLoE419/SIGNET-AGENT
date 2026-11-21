"""Dataset-aware Stage 1 review and trusted run-local input staging."""
import hashlib
import json
from pathlib import Path
import shlex

import agent.tools.signet as signet
from agent.runtime import hpc, hpc_files, signet_jobs as jobs, workspace_datasets, workspace_validation

LEGACY_INPUTS = {'genotype': ['study.ped', 'study.map'], 'expression': ['example_gexp'],
                 'clinical': ['official-demo-chr1-restart-clinical.tsv']}
SNAPSHOT = 'workspace-genotype.json'
REQUIRED = ('res/resg/workspace-inputs.json', 'res/resg/workspace-reference-preparation.json')
_REVIEW = ((Path(__file__).with_name('jobs') / 'step_inputs.py').read_text() + '\n'
           + (Path(__file__).with_name('jobs') / 'review_dataset_sources.py').read_text())
_PREPARE_SOURCE = (Path(__file__).with_name('jobs') / 'prepare_reference.py').read_text()
_STAGE = (Path(__file__).with_name('jobs') / 'stage_dataset.py').read_text()


def saved(dataset_id):
    return workspace_validation._saved(dataset_id)


def legacy(dataset_id, inputs):
    return dataset_id == 'example-chr1' and inputs == LEGACY_INPUTS


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _references(config, overrides=None):
    names = {'reference': ('ref', hpc.REFERENCE_FILES['ref']),
             'genetic_map': ('gmap', hpc.REFERENCE_FILES['gmap']),
             'annotation': ('gtf', hpc.REFERENCE_FILES['gtf'])}
    overrides = {} if overrides is None else overrides
    if not isinstance(overrides, dict) or set(overrides) - {'ref', 'gmap', 'gtf'}:
        raise jobs.StepError('invalid_request', 'Choose reference, genetic-map and annotation files only.')
    chosen = {key: hpc_files._safe_path(path) for key, path in overrides.items()}
    script = jobs._say() + f"W={shlex.quote(config['root'])}\n" + r'''
selected_of() {
  local key path found=""
  [ -f "$W/refdata/selected.tsv" ] || return 0
  while IFS=$'\t' read -r key path; do if [ "$key" = "$1" ]; then found="$path"; fi; done < "$W/refdata/selected.tsv"
  printf %s "$found"
}
'''
    for role, (key, relative) in names.items():
        if key in chosen:
            script += f'say {role} {shlex.quote(chosen[key])}\n'
        else:
            script += f'path="$(selected_of {key})"; [ -n "$path" ] || path="$W/{relative}"; say {role} "$path"\n'
    code, values, _ = jobs._shell(script)
    if code or any(not values.get(role) for role in names):
        raise jobs.StepError('remote_failed', 'Could not read the selected reference resources.')
    return {role: hpc_files._safe_path(values[role]) for role in names}


def resolve_source_inputs(dataset_id, inputs, config):
    """Resolve only the built-in example labels; custom relative paths remain invalid."""
    resolved = {kind: list(paths) for kind, paths in inputs.items()}
    if dataset_id != 'example-chr1':
        return resolved
    aliases = {'study.ped', 'study.map', 'example_gexp', 'official-demo-chr1-restart-clinical.tsv'}
    if not any(path in aliases for paths in inputs.values() for path in paths):
        return resolved
    mapping = {'example_gexp': config['source'] + '/example/gexp/example_gexp'}
    if 'genotype' in inputs:
        q = shlex.quote
        prepared = config['root'] + '/' + hpc.PREPARED
        original = config['source'] + '/example/geno'
        script = jobs._say() + f'''if [ -s {q(prepared + '/study.ped')} ] && [ -s {q(prepared + '/study.map')} ]; then
  say ped {q(prepared + '/study.ped')}; say map {q(prepared + '/study.map')}
else
  say ped {q(original + '/example.ped')}; say map {q(original + '/example.map')}
fi
'''
        code, values, _ = jobs._shell(script)
        if code or not values.get('ped') or not values.get('map'):
            raise jobs.StepError('remote_failed', 'Could not resolve the chromosome 1 example input paths.')
        mapping.update({'study.ped': values['ped'], 'study.map': values['map']})
    if LEGACY_INPUTS['clinical'][0] in inputs.get('clinical', []):
        from agent.runtime.workspace_genotype import _adjust_inputs
        mapping[LEGACY_INPUTS['clinical'][0]] = _adjust_inputs(config, None)['cli.file']
    for kind, paths in resolved.items():
        resolved[kind] = [mapping.get(path, path) if path in LEGACY_INPUTS[kind] else path for path in paths]
    return resolved


def review(dataset_id, inputs):
    from agent.runtime import workspace_genotype as workspace
    record = saved(dataset_id)
    if not isinstance(inputs, dict) or set(inputs) != set(workspace_datasets.KINDS):
        raise jobs.StepError('invalid_request', 'Provide the saved genotype, expression and clinical input lists.')
    if inputs != record['inputs']:
        raise jobs.StepError('conflict', 'The dataset files changed. Reload them before reviewing Stage 1.')
    config = jobs._environment()
    reference_choices = record.get('references', {}).copy()
    result = {'dataset_id': dataset_id, 'dataset_name': record['name'], 'source_inputs': inputs,
              'mode': 'example' if legacy(dataset_id, inputs) and not reference_choices else 'dataset',
              'inputs': {}, 'settings': workspace.DEFAULT_SETTINGS.copy(),
              'resources': jobs.STEPS['genotype'].resources.copy(), 'limits': jobs.STEPS['genotype'].limits.copy(),
              'reference_sources': {}, 'reference_choices': reference_choices,
              'resolved_inputs': inputs, 'source_files': [], 'ready': False, 'issues': [], 'warnings': []}
    if result['mode'] == 'example':
        result.update(workspace.review_example(), ready=True)
    else:
        resolved = resolve_source_inputs(dataset_id, inputs, config)
        report = workspace_validation.validate(dataset_id, inputs, resolved_inputs=resolved)
        if report.get('code') == 'remote_timeout':
            raise jobs.StepError('read_timeout', 'Checking the input files on HPC3 timed out.')
        result['validation'] = report
        result['resolved_inputs'] = report.get('resolved_inputs', inputs)
        first_stage = report.get('stage_readiness', {}).get('1', {})
        if first_stage.get('status') != 'ready':
            result['issues'] = [item['message'] for item in first_stage.get('issues', [])]
            if not result['issues']:
                result['issues'] = ['Complete the dataset input review before Stage 1.']
            return result
        result['warnings'] = [item['message'] for item in first_stage.get('issues', [])
                              if item['severity'] == 'warning']
        for number in ('2', '3'):
            for item in report['stage_readiness'][number]['issues']:
                result['warnings'].append('Stage ' + number + ': ' + item['message'])
        references = _references(config, reference_choices)
        sources = {item['role']: item for item in report['files']}
        sources.update({role: {'path': path} for role, path in references.items()})
        payload = shlex.quote(json.dumps(sources))
        script = f"python3 - {payload} <<'SIGNET_DATASET_SOURCES'\n{_REVIEW}\nSIGNET_DATASET_SOURCES\n"
        code, values, _ = jobs._shell(script)
        if code or not values.get('sources'):
            raise jobs.StepError('remote_failed', 'Could not review study-specific reference resources.')
        source_review = json.loads(values['sources'])
        result['source_files'] = source_review['files']
        result['issues'] = source_review['issues']
        result['warnings'].extend(source_review.get('warnings', []))
        result['reference_compatibility'] = source_review.get('compatibility', {})
        result['reference_sources'] = references
        by_role = {item['role']: item['path'] for item in result['source_files']}
        result['inputs'] = {'ped.file': by_role.get('ped', ''), 'map.file': by_role.get('map', ''),
                            'ref': by_role.get('reference', ''), 'gmap': by_role.get('genetic_map', '')}
        if source_review['chromosome']:
            result['settings']['restrict.tcga.geno'] = source_review['chromosome']
        result['warnings'].append('Stage 1 will freeze this dataset and annotation, prepare study-matched references inside the same Slurm job, then run the original SIGNET genotype workflow. Preparation can remove unmatched study markers; this does not establish biological validity.')
        result['ready'] = not result['issues']
    current = saved(dataset_id)
    if current['inputs'] != inputs or current.get('references', {}) != reference_choices:
        raise jobs.StepError('conflict', 'The dataset files changed during review. Review again.')
    result['environment'] = config
    result['review_token'] = fingerprint({key: result[key] for key in (
        'dataset_id', 'dataset_name', 'source_inputs', 'resolved_inputs', 'reference_choices', 'mode',
        'inputs', 'settings', 'reference_sources', 'source_files', 'environment')})
    return result


def frozen_paths(directory, attempt=1):
    if type(attempt) is not int or not 1 <= attempt <= 1000:
        raise jobs.StepError('invalid_request', 'The genotype attempt number is invalid.')
    base = directory + '/inputs' + (f'/attempt{attempt}' if attempt > 1 else '')
    return {'genotype': [base + '/prepared/study.ped', base + '/prepared/study.map'],
            'expression': [base + '/frozen/expression'], 'clinical': [base + '/frozen/clinical'],
            'annotation': base + '/frozen/annotation', 'ref': base + '/prepared/ref/chr',
            'gmap': base + '/prepared/gmap/chr'}


def frozen_checks(directory, attempt=1):
    frozen = frozen_paths(directory, attempt)
    paths = [directory + '/work/' + relative for relative in REQUIRED]
    paths += [frozen['expression'][0], frozen['clinical'][0], frozen['annotation']]
    return jobs._input_checks([('frozen_dataset', path, directory) for path in paths])


def step_inputs(directory, attempt=1):
    frozen = frozen_paths(directory, attempt)
    return {'ped.file': frozen['genotype'][0], 'map.file': frozen['genotype'][1],
            'ref': frozen['ref'], 'gmap': frozen['gmap']}


def staging_plan(root, directory, attempt=None):
    path = signet._no_links(root / SNAPSHOT)
    if not path.is_file():
        return None
    snapshot = json.loads(path.read_text())
    if snapshot.get('mode') != 'dataset':
        return None
    if snapshot.get('run_id') != root.name or snapshot.get('remote_dir') != directory:
        raise jobs.StepError('conflict', 'The frozen dataset belongs to a different run or environment.')
    files = snapshot['source_files']
    if {item['role'] for item in files} != {'ped', 'map', 'expression', 'clinical', 'reference', 'genetic_map', 'annotation'}:
        raise jobs.StepError('invalid_request', 'The frozen dataset source manifest is incomplete.')
    for item in files:
        if (hpc_files._safe_path(item['path']) != item['path'] or str(Path(item['path']).parent) == '/'
                or not isinstance(item['identity'], list) or len(item['identity']) != 5):
            raise jobs.StepError('invalid_request', 'The frozen dataset source manifest is invalid.')
    if attempt is None:
        record_path = signet._no_links(root / 'steps/genotype.json')
        attempt = jobs._load(root, 'genotype').get('attempt', 1) if record_path.is_file() else 1
    frozen = frozen_paths(directory, attempt)
    return {'run_id': root.name, 'dataset_id': snapshot['dataset_id'], 'directory': directory,
            'attempt': attempt, 'inputs_directory': str(Path(frozen['expression'][0]).parent.parent),
            'inputs': step_inputs(directory, attempt), 'source_files': files}


def effective_snapshot(root, snapshot):
    """Later stages consume the successful attempt's files, not the first failed freeze."""
    if snapshot.get('mode') != 'dataset':
        return snapshot
    path = signet._no_links(root / 'steps/genotype.json')
    if not path.is_file():
        return snapshot
    from agent.runtime.workspace_history import _json
    record, _ = _json(path)
    attempt = record.get('attempt', 1)
    frozen = frozen_paths(snapshot['remote_dir'], attempt)
    expected = step_inputs(snapshot['remote_dir'], attempt)
    if (record.get('run_id') != root.name or record.get('step') != 'genotype'
            or record.get('remote_dir') != snapshot['remote_dir'] or record.get('inputs') != expected):
        raise jobs.StepError('conflict', 'The current genotype files do not match this run and attempt.')
    return {**snapshot, 'frozen_inputs': frozen, 'genotype_attempt': attempt}


def stage_command(plan):
    source = 'PREPARE_SOURCE = ' + repr(_PREPARE_SOURCE) + '\n' + _STAGE
    return ('python3 - ' + shlex.quote(json.dumps(plan)) + " <<'SIGNET_DATASET_STAGE'\n"
            + source + '\nSIGNET_DATASET_STAGE\n')
