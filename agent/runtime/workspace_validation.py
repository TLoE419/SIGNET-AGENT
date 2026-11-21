"""Read-only validation of one saved dataset snapshot through the existing SSH broker."""
import copy
import json
from pathlib import Path
import shlex

from agent.runtime import hpc, hpc_files, signet_jobs, workspace_datasets
from agent.runtime.jobs import validate_dataset as parser

_SOURCE = (Path(parser.__file__).with_name('clinical_rules.py').read_text(encoding='utf-8')
           + '\n' + Path(parser.__file__).read_text(encoding='utf-8'))
_ALL = object()


def _script(inputs, root, *, kind=None):
    arguments = shlex.quote(json.dumps(inputs))
    if kind is not None:
        arguments += ' ' + shlex.quote(kind)
    return (hpc._prelude(root) + 'python3 - ' + arguments
            + " <<'SIGNET_DATASET_VALIDATION'\n" + _SOURCE + '\nSIGNET_DATASET_VALIDATION\n')


def _saved(dataset_id):
    for record in workspace_datasets.list_datasets():
        if record['id'] == dataset_id:
            return record
    raise signet_jobs.StepError('not_found', 'No dataset with this ID exists.')


def _valid_inputs(inputs, kinds):
    return (isinstance(inputs, dict) and set(inputs) == set(kinds)
            and all(isinstance(paths, list) and len(paths) <= hpc_files.MAX_INSPECT_PATHS
                    and all(isinstance(path, str) for path in paths) for paths in inputs.values()))


def _matches_saved(dataset_id, selected):
    saved_inputs = _saved(dataset_id)['inputs']
    if len(selected) == len(parser.KINDS):
        return saved_inputs == selected
    return all(saved_inputs.get(kind) == paths for kind, paths in selected.items())


def validate(dataset_id, inputs, *, resolved_inputs=None, kind=_ALL):
    if kind is not _ALL and kind not in parser.KINDS:
        raise signet_jobs.StepError('invalid_request', 'Choose genotype, expression or clinical.')
    scope = None if kind is _ALL else kind
    kinds = parser.KINDS if scope is None else (scope,)
    if not _valid_inputs(inputs, workspace_datasets.KINDS):
        raise signet_jobs.StepError('invalid_request', 'Provide the saved genotype, expression and clinical path lists.')
    snapshot = copy.deepcopy(inputs)
    selected = {name: snapshot[name] for name in kinds}
    if not _matches_saved(dataset_id, selected):
        raise signet_jobs.StepError('conflict', 'The dataset files changed. Reload them before checking again.')
    if resolved_inputs is None and dataset_id == 'example-chr1':
        from agent.runtime import workspace_inputs
        aliases = {path for paths in workspace_inputs.LEGACY_INPUTS.values() for path in paths}
        if any(path in aliases for paths in selected.values() for path in paths):
            resolved_inputs = workspace_inputs.resolve_source_inputs(dataset_id, selected, signet_jobs._environment())
    effective = selected if resolved_inputs is None else copy.deepcopy(resolved_inputs)
    if not _valid_inputs(effective, kinds):
        raise signet_jobs.StepError('invalid_request', 'The resolved dataset input paths are invalid.')
    unsafe = set()
    for name, paths in effective.items():
        for path in paths:
            try:
                hpc_files._safe_path(path)
            except ValueError:
                unsafe.add(name)
    if unsafe:
        result = parser.validate({name: [] for name in kinds}, kind=scope)
        result['status'] = 'failed'
        for check in result['checks']:
            check['paths'] = effective[check['kind']]
            if check['kind'] in unsafe:
                message = 'Choose absolute remote paths with the remote file browser; saved example labels are not file locations.'
                check.update(status='failed', message=message,
                             issues=[{'code': 'absolute_remote_path', 'message': message}])
            else:
                message = 'Fix unsupported paths in the other input before reviewing this file.'
                check.update(status='unchecked', message=message,
                             issues=[{'code': 'blocked_by_paths', 'message': message}])
    elif not any(effective.values()):
        result = parser.validate(effective, kind=scope)
    else:
        result = hpc_files._call(lambda root: _script(effective, root, kind=scope), 60)
    if unsafe:
        for check in result['checks']:
            for issue in check['issues']:
                issue.update(stage=parser.KINDS.index(check['kind']) + 1, severity='error')
        if scope is None:
            result['stage_readiness'] = parser.stage_readiness(result)
    if not _matches_saved(dataset_id, selected):
        raise signet_jobs.StepError('conflict', 'The dataset files changed during review. Check the current files again.')
    report = {**result, 'dataset_id': dataset_id, 'inputs': snapshot, 'resolved_inputs': effective,
              'checked_at': signet_jobs._now()}
    if scope is not None:
        report['kind'] = scope
    return report
