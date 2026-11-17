"""Persist current dataset choices separately from immutable scientific run records."""
import copy
import json
import os
from pathlib import Path
import tempfile
import threading
import uuid

import agent.tools.signet as signet
from agent.runtime.signet_jobs import StepError

KINDS = ('genotype', 'expression', 'clinical')
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


def _record(value):
    allowed = {'id', 'name', 'folder', 'inputs', 'default_inputs', 'alternative_inputs', 'selections'}
    if not isinstance(value, dict) or set(value) - allowed:
        raise ValueError('Invalid saved dataset fields.')
    dataset_id = signet._name(value['id'])
    name = value['name']
    if not isinstance(name, list) or len(name) != 2:
        raise ValueError('Provide both the Chinese and English dataset labels.')
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
    return {'id': dataset_id, 'name': [_text(label, 240) for label in name],
            'folder': _text(value.get('folder', ''), empty=True), 'inputs': current,
            'default_inputs': defaults, 'alternative_inputs': alternatives, 'selections': selections}


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
            return {}
        if not path.is_file() or path.stat().st_size > MAX_STORE_BYTES:
            raise ValueError('Invalid dataset state file.')
        saved = json.loads(path.read_text(encoding='utf-8'))
        if (not isinstance(saved, dict) or set(saved) != {'version', 'datasets'}
                or type(saved['version']) is not int or saved['version'] != 1
                or not isinstance(saved['datasets'], list) or len(saved['datasets']) > MAX_DATASETS):
            raise ValueError('Invalid dataset state format.')
        records = {}
        for item in saved['datasets']:
            record = _record(item)
            if record != item or record['id'] in records:
                raise ValueError('Invalid or duplicate saved dataset.')
            records[record['id']] = record
        return records
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise StepError('conflict', 'The saved dataset catalog is unreadable. It has not been overwritten.') from error


def _save(records):
    data = (json.dumps({'version': 1, 'datasets': list(records.values())}, ensure_ascii=False, indent=2) + '\n').encode()
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


def list_datasets():
    with _LOCK:
        return copy.deepcopy(list({**_seeds(), **_load()}.values()))


def create_dataset(name, folder='', inputs=None, alternative_inputs=None):
    with _LOCK:
        overlay = _load()
        catalog = {**_seeds(), **overlay}
        try:
            dataset_id = 'dataset-' + str(uuid.uuid4())
            record = _record({'id': dataset_id, 'name': name, 'folder': folder,
                              'inputs': {} if inputs is None else inputs,
                              'alternative_inputs': {} if alternative_inputs is None else alternative_inputs})
        except (ValueError, KeyError, TypeError) as error:
            raise StepError('invalid_request', str(error)) from error
        labels = {label.casefold() for label in record['name']}
        if dataset_id in catalog or any(labels.intersection(label.casefold() for label in item['name'])
                                       for item in catalog.values()):
            raise StepError('conflict', 'A dataset with this name already exists.')
        overlay[dataset_id] = record
        _save(overlay)
        return copy.deepcopy(record)


def update_dataset(dataset_id, inputs):
    with _LOCK:
        overlay = _load()
        catalog = {**_seeds(), **overlay}
        if dataset_id not in catalog:
            raise StepError('not_found', 'No dataset with this ID exists.')
        try:
            selected = _inputs(inputs, complete=False)
            if not selected:
                raise ValueError('Choose at least one input type to update.')
            record = copy.deepcopy(catalog[dataset_id])
            record['inputs'].update(selected)
            record.pop('selections')
            record = _record(record)
        except (ValueError, KeyError, TypeError) as error:
            raise StepError('invalid_request', str(error)) from error
        overlay[dataset_id] = record
        _save(overlay)
        return copy.deepcopy(record)
