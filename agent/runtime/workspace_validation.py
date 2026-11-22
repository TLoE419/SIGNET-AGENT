"""Read-only validation of one saved dataset snapshot through the existing SSH broker."""
import copy
import json
from pathlib import Path
import shlex

from agent.runtime import hpc, hpc_files, signet_jobs, workspace_datasets
from agent.runtime.jobs import validate_dataset as parser

_SOURCE = Path(parser.__file__).read_text(encoding='utf-8')


def _script(inputs, root):
    return (hpc._prelude(root) + 'python3 - ' + shlex.quote(json.dumps(inputs))
            + " <<'SIGNET_DATASET_VALIDATION'\n" + _SOURCE + '\nSIGNET_DATASET_VALIDATION\n')


def _saved(dataset_id):
    for record in workspace_datasets.list_datasets():
        if record['id'] == dataset_id:
            return record
    raise signet_jobs.StepError('not_found', 'No dataset with this ID exists.')


def validate(dataset_id, inputs):
    if (not isinstance(inputs, dict) or set(inputs) != set(workspace_datasets.KINDS)
            or any(not isinstance(paths, list) or len(paths) > hpc_files.MAX_INSPECT_PATHS
                   or any(not isinstance(path, str) for path in paths) for paths in inputs.values())):
        raise signet_jobs.StepError('invalid_request', 'Provide the saved genotype, expression and clinical path lists.')
    snapshot = copy.deepcopy(inputs)
    if _saved(dataset_id)['inputs'] != snapshot:
        raise signet_jobs.StepError('conflict', 'The dataset files changed. Reload them before checking again.')
    unsafe = set()
    for kind, paths in snapshot.items():
        for path in paths:
            try:
                hpc_files._safe_path(path)
            except ValueError:
                unsafe.add(kind)
    if unsafe:
        result = parser.validate({kind: [] for kind in parser.KINDS})
        result['status'] = 'failed'
        for check in result['checks']:
            check['paths'] = snapshot[check['kind']]
            if check['kind'] in unsafe:
                message = 'Choose absolute remote paths with the remote file browser; saved example labels are not file locations.'
                check.update(status='failed', message=message,
                             issues=[{'code': 'absolute_remote_path', 'message': message}])
            else:
                message = 'Fix unsupported paths in the other input before reviewing this file.'
                check.update(status='unchecked', message=message,
                             issues=[{'code': 'blocked_by_paths', 'message': message}])
    elif not any(snapshot.values()):
        result = parser.validate(snapshot)
    else:
        result = hpc_files._call(lambda root: _script(snapshot, root), 60)
    if _saved(dataset_id)['inputs'] != snapshot:
        raise signet_jobs.StepError('conflict', 'The dataset files changed during review. Check the current files again.')
    return {**result, 'dataset_id': dataset_id, 'inputs': snapshot, 'checked_at': signet_jobs._now()}
