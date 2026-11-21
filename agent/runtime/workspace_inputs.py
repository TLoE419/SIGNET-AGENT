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
_REVIEW = (Path(__file__).with_name('jobs') / 'review_dataset_sources.py').read_text()
_STAGE = (Path(__file__).with_name('jobs') / 'stage_dataset.py').read_text()


def saved(dataset_id):
    return workspace_validation._saved(dataset_id)


def legacy(dataset_id, inputs):
    return dataset_id == 'example-chr1' and inputs == LEGACY_INPUTS


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _references(config):
    names = {'reference': ('ref', hpc.REFERENCE_FILES['ref']),
             'genetic_map': ('gmap', hpc.REFERENCE_FILES['gmap']),
             'annotation': ('gtf', hpc.REFERENCE_FILES['gtf'])}
    script = hpc._prelude(config['root'])
    for role, (key, relative) in names.items():
        script += f'path="$(selected_of {key})"; [ -n "$path" ] || path="$W/{relative}"; say {role} "$path"\n'
    code, values, _ = jobs._shell(script)
    if code or any(not values.get(role) for role in names):
        raise jobs.StepError('remote_failed', 'Could not read the selected reference resources.')
    return {role: hpc_files._safe_path(values[role]) for role in names}


def review(dataset_id, inputs):
    from agent.runtime import workspace_genotype as workspace
    record = saved(dataset_id)
    if not isinstance(inputs, dict) or set(inputs) != set(workspace_datasets.KINDS):
        raise jobs.StepError('invalid_request', 'Provide the saved genotype, expression and clinical input lists.')
    if inputs != record['inputs']:
        raise jobs.StepError('conflict', 'The dataset files changed. Reload them before reviewing Stage 1.')
    config = jobs._environment()
    result = {'dataset_id': dataset_id, 'dataset_name': record['name'], 'source_inputs': inputs,
              'mode': 'example' if legacy(dataset_id, inputs) else 'dataset',
              'inputs': {}, 'settings': workspace.DEFAULT_SETTINGS.copy(),
              'resources': jobs.STEPS['genotype'].resources.copy(), 'limits': jobs.STEPS['genotype'].limits.copy(),
              'reference_sources': {}, 'source_files': [], 'ready': False, 'issues': [], 'warnings': []}
    if result['mode'] == 'example':
        result.update(workspace.review_example(), ready=True)
    else:
        report = workspace_validation.validate(dataset_id, inputs)
        if report.get('status') not in ('passed', 'warning') or not report.get('checks'):
            result['issues'] = [item['message'] for check in report.get('checks', []) for item in check.get('issues', [])]
            result['issues'] += [item['message'] for item in report.get('pairing', {}).get('issues', [])]
            if not result['issues']:
                result['issues'] = [report.get('reason') or report.get('error') or 'Complete the dataset format review before Stage 1.']
            return result
        result['warnings'] = [item['message'] for check in report['checks'] if check['status'] == 'warning' for item in check['issues']]
        result['warnings'] += [item['message'] for item in report['pairing']['issues']]
        references = _references(config)
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
        result['reference_sources'] = references
        by_role = {item['role']: item['path'] for item in result['source_files']}
        result['inputs'] = {'ped.file': by_role.get('ped', ''), 'map.file': by_role.get('map', ''),
                            'ref': by_role.get('reference', ''), 'gmap': by_role.get('genetic_map', '')}
        if source_review['chromosome']:
            result['settings']['restrict.tcga.geno'] = source_review['chromosome']
        result['warnings'].append('Stage 1 will freeze this dataset and annotation, prepare study-matched references inside the same Slurm job, then run the original SIGNET genotype workflow. Preparation can remove unmatched study markers; this does not establish biological validity.')
        result['ready'] = not result['issues']
    if saved(dataset_id)['inputs'] != inputs:
        raise jobs.StepError('conflict', 'The dataset files changed during review. Review again.')
    result['environment'] = config
    result['review_token'] = fingerprint({key: result[key] for key in (
        'dataset_id', 'dataset_name', 'source_inputs', 'mode', 'inputs', 'settings', 'reference_sources', 'source_files', 'environment')})
    return result


def frozen_paths(directory):
    base = directory + '/inputs'
    return {'genotype': [base + '/prepared/study.ped', base + '/prepared/study.map'],
            'expression': [base + '/frozen/expression'], 'clinical': [base + '/frozen/clinical'],
            'annotation': base + '/frozen/annotation', 'ref': base + '/prepared/ref/chr',
            'gmap': base + '/prepared/gmap/chr'}


def frozen_checks(directory):
    frozen = frozen_paths(directory)
    paths = [directory + '/work/' + relative for relative in REQUIRED]
    paths += [frozen['expression'][0], frozen['clinical'][0], frozen['annotation']]
    return jobs._input_checks([('frozen_dataset', path, directory) for path in paths])


def staging_plan(root, directory):
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
    return {'run_id': root.name, 'dataset_id': snapshot['dataset_id'], 'directory': directory, 'source_files': files}


def stage_command(plan):
    source = 'PREPARE_SOURCE = ' + repr(hpc._PREPARE_SOURCE) + '\n' + _STAGE
    return ('python3 - ' + shlex.quote(json.dumps(plan)) + " <<'SIGNET_DATASET_STAGE'\n"
            + source + '\nSIGNET_DATASET_STAGE\n')
