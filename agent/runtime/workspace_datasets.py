"""Persist current dataset choices separately from immutable scientific run records."""
import copy
import json
import os
from pathlib import Path
import tempfile
import threading
import uuid

import agent.tools.signet as signet
from agent.runtime import hpc_files
from agent.runtime.signet_jobs import StepError

KINDS = ('genotype', 'expression', 'clinical')
REFERENCE_KEYS = ('ref', 'gmap', 'gtf')
_UNSET = object()
MAX_DATASETS = 256
MAX_STORE_BYTES = 2 * 1024 * 1024
_LOCK = threading.RLock()
_ALTERNATIVES = {
    'example-chr1': {'genotype': ['study-qc-preview.ped', 'study-qc-preview.map'],
                     'expression': ['expression-review.tsv'], 'clinical': ['clinical-review.tsv']},
    'simulated-cohort-b': {'genotype': ['cohort-b-reviewed.ped', 'cohort-b-reviewed.map'],
                           'expression': ['cohort-b-expression-review.tsv'],
                           'clinical': ['cohort-b-clinical-review.tsv']},
}


def _text(value, limit=4096, empty=False):
    if (not isinstance(value, str) or len(value) > limit
            or any(ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in value)
            or not empty and not value.strip()):
        raise ValueError('Dataset labels and paths must be bounded, plain text.')
    return value.strip()


def display_name(value):
    # Older saved datasets and run snapshots used a two-entry label.
    if isinstance(value, list) and len(value) == 2:
        _text(value[0], 240)
        value = value[1]
    return _text(value, 240)


def _inputs(value, complete=True):
    if not isinstance(value, dict) or set(value) - set(KINDS):
        raise ValueError('Use genotype, expression and clinical input lists only.')
    result = {kind: [] for kind in KINDS} if complete else {}
    for kind, paths in value.items():
        if not isinstance(paths, list) or len(paths) > 128:
            raise ValueError('Each input type requires a list of at most 128 paths.')
        result[kind] = [_text(path) for path in paths]
        if len(set(result[kind])) != len(result[kind]):
            raise ValueError('An input list cannot contain duplicate paths.')
    return result


def _reference_paths(value, allow_clear=False):
    if not isinstance(value, dict) or set(value) - set(REFERENCE_KEYS):
        raise ValueError('Use ref, gmap and gtf reference choices only.')
    for path in value.values():
        if path is None and allow_clear:
            continue
        canonical = hpc_files._safe_path(path)
        if canonical != path or any(path == root or path.startswith(root + '/') for root in hpc_files._UNREADABLE_ON_COMPUTE):
            raise ValueError('Choose a canonical absolute reference path in shared storage.')
    return value.copy()


def _record(value):
    allowed = {'id', 'name', 'folder', 'inputs', 'default_inputs', 'alternative_inputs', 'selections', 'references'}
    if not isinstance(value, dict) or set(value) - allowed:
        raise ValueError('Invalid saved dataset fields.')
    dataset_id = signet._name(value['id'])
    name = display_name(value['name'])
    defaults = _inputs(value.get('default_inputs', value.get('inputs', {})))
    alternatives = _inputs(value.get('alternative_inputs', _ALTERNATIVES.get(dataset_id, {})))
    current = _inputs(value.get('inputs', defaults))
    selections = {}
    for kind in KINDS:
        selections[kind] = int(current[kind] != defaults[kind])
        if selections[kind]:
            alternatives[kind] = current[kind].copy()
    if 'selections' in value and (not isinstance(value['selections'], dict)
            or set(value['selections']) != set(KINDS)
            or any(type(index) is not int or index not in (0, 1) for index in value['selections'].values())
            or value['selections'] != selections):
        raise ValueError('Dataset selections do not match its current input paths.')
    record = {'id': dataset_id, 'name': name,
              'folder': _text(value.get('folder', ''), empty=True), 'inputs': current,
              'default_inputs': defaults, 'alternative_inputs': alternatives, 'selections': selections}
    if 'references' in value:
        record['references'] = _reference_paths(value['references'])
    return record


def _seeds():
    records = {}
    for path in sorted((signet.PROJECT / 'data/datasets').glob('*.json')):
        try:
            record = _record(json.loads(signet._no_links(path).read_text(encoding='utf-8')))
            if record['id'] == path.stem:
                records[record['id']] = record
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return records


def _state_path():
    override = os.environ.get('SIGNET_DATASETS_STATE_FILE')
    path = Path(override) if override else signet.PROJECT / 'data/workspace-datasets.json'
    if not path.is_absolute():
        raise ValueError('The dataset state file must have an absolute path.')
    return signet._no_links(path)


def _load():
    try:
        path = _state_path()
        if not path.exists():
            return {}, set()
        if not path.is_file() or path.stat().st_size > MAX_STORE_BYTES:
            raise ValueError('Invalid dataset state file.')
        saved = json.loads(path.read_text(encoding='utf-8'))
        if (not isinstance(saved, dict) or set(saved) - {'version', 'datasets', 'deleted'}
                or type(saved['version']) is not int or saved['version'] != 1
                or not isinstance(saved['datasets'], list) or len(saved['datasets']) > MAX_DATASETS):
            raise ValueError('Invalid dataset state format.')
        deleted_ids = saved.get('deleted', [])
        if not isinstance(deleted_ids, list):
            raise ValueError('Invalid deleted dataset identifiers.')
        deleted = {signet._name(dataset_id) for dataset_id in deleted_ids}
        if len(deleted) != len(deleted_ids):
            raise ValueError('Duplicate deleted dataset identifiers.')
        records = {}
        for item in saved['datasets']:
            record = _record(item)
            original_name = item['name']
            if isinstance(original_name, list):
                item = {**item, 'name': original_name[1]}
            if record != item or record['id'] in records or record['id'] in deleted:
                raise ValueError('Invalid or duplicate saved dataset.')
            records[record['id']] = record
        return records, deleted
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise StepError('conflict', 'The saved dataset catalog is unreadable. It has not been overwritten.') from error


def _save(records, deleted):
    state = {'version': 1, 'datasets': list(records.values())}
    if deleted:
        state['deleted'] = sorted(deleted)
    data = (json.dumps(state, ensure_ascii=False, indent=2) + '\n').encode()
    if len(records) > MAX_DATASETS or len(data) > MAX_STORE_BYTES:
        raise StepError('invalid_request', 'The saved dataset catalog is full.')
    try:
        path = _state_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        signet._no_links(path.parent)
        descriptor, temporary = tempfile.mkstemp(prefix='.workspace-datasets-', suffix='.tmp', dir=path.parent)
        try:
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            signet._no_links(path)
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)
    except (OSError, ValueError) as error:
        raise StepError('conflict', 'The dataset choices could not be saved. Previous records remain unchanged.') from error


def _catalog(overlay, deleted):
    return {key: value for key, value in {**_seeds(), **overlay}.items() if key not in deleted}


def catalog_snapshot():
    with _LOCK:
        overlay, deleted = _load()
        return list(_catalog(overlay, deleted).values()), deleted


def list_datasets():
    return catalog_snapshot()[0]


def ensure_not_deleted(dataset_id):
    if dataset_id is None:
        return
    with _LOCK:
        _, deleted = _load()
        if dataset_id in deleted:
            raise StepError('conflict', 'This dataset was deleted. Its analysis records are available in Run history.')


def create_dataset(name, folder='', inputs=None, alternative_inputs=None):
    with _LOCK:
        overlay, deleted = _load()
        catalog = _catalog(overlay, deleted)
        try:
            dataset_id = 'dataset-' + str(uuid.uuid4())
            record = _record({'id': dataset_id, 'name': name, 'folder': folder,
                              'inputs': {} if inputs is None else inputs,
                              'alternative_inputs': {} if alternative_inputs is None else alternative_inputs})
        except (ValueError, KeyError, TypeError) as error:
            raise StepError('invalid_request', str(error)) from error
        if dataset_id in catalog or dataset_id in deleted or any(
                record['name'].casefold() == item['name'].casefold() for item in catalog.values()):
            raise StepError('conflict', 'A dataset with this name already exists.')
        overlay[dataset_id] = record
        _save(overlay, deleted)
        return copy.deepcopy(record)


def update_dataset(dataset_id, inputs=_UNSET, references=_UNSET):
    with _LOCK:
        overlay, deleted = _load()
        catalog = _catalog(overlay, deleted)
        if dataset_id not in catalog:
            raise StepError('not_found', 'No dataset with this ID exists.')
        try:
            selected = {} if inputs is _UNSET else _inputs(inputs, complete=False)
            overrides = {} if references is _UNSET else _reference_paths(references, allow_clear=True)
            if not selected and not overrides:
                raise ValueError('Choose at least one input type or reference to update.')
            record = copy.deepcopy(catalog[dataset_id])
            record['inputs'].update(selected)
            record.pop('selections')
            if overrides:
                current = record.pop('references', {})
                current.update(overrides)
                current = {key: path for key, path in current.items() if path is not None}
                if current:
                    record['references'] = current
            record = _record(record)
        except (ValueError, KeyError, TypeError) as error:
            raise StepError('invalid_request', str(error)) from error
        overlay[dataset_id] = record
        _save(overlay, deleted)
        return copy.deepcopy(record)


def delete_dataset(dataset_id):
    with _LOCK:
        overlay, deleted = _load()
        if dataset_id not in deleted:
            if dataset_id not in _catalog(overlay, deleted):
                raise StepError('not_found', 'No dataset with this ID exists.')
            overlay.pop(dataset_id, None)
            deleted.add(dataset_id)
            _save(overlay, deleted)
        return {'deleted': dataset_id}
