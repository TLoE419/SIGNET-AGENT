"""Freeze reviewed inputs and prepare references inside the owned Stage 1 Slurm job."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys


class StagingError(Exception):
    """A fixed safe explanation, without file contents or private identifiers."""


def identity(info):
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


def digest(path):
    value = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def stage(plan):
    print('SIGNET_DATASET_PHASE freezing-inputs', flush=True)
    directory = Path(plan['directory'])
    base = directory / 'inputs'
    frozen = base / 'frozen'
    prepared = base / 'prepared'
    if base.exists():
        raise StagingError('This run already contains staged inputs; they will not be replaced.')
    frozen.mkdir(parents=True, mode=0o700)
    records = []
    paths = {}
    for item in plan['source_files']:
        source = Path(item['path'])
        before = source.stat()
        if identity(before) != item['identity']:
            raise StagingError('A reviewed source file changed before execution.')
        if item['role'] in ('reference', 'genetic_map'):
            paths[item['role']] = str(source)
            continue
        target = frozen / item['role']
        with source.open('rb') as reader, target.open('xb') as writer:
            shutil.copyfileobj(reader, writer, 1024 * 1024)
        if identity(source.stat()) != item['identity']:
            raise StagingError('A source file changed while freezing it.')
        fingerprint = digest(target)
        if item['sha256'] is not None and fingerprint != item['sha256']:
            raise StagingError('A copied input does not match the reviewed file digest.')
        os.chmod(target, 0o400)
        paths[item['role']] = str(target)
        records.append({**item, 'frozen_path': str(target), 'frozen_sha256': fingerprint})
    namespace = {'__name__': 'signet_reference_preparation'}
    exec(PREPARE_SOURCE, namespace)
    print('SIGNET_DATASET_PHASE preparing-study-reference', flush=True)
    try:
        summary = namespace['prepare'](paths['ped'], paths['map'], paths['reference'], paths['genetic_map'], str(prepared))
    except namespace['PreparationError'] as error:
        # This trusted helper reports fixed problems or the already reviewed chromosome names.
        raise StagingError(str(error))
    for item in plan['source_files']:
        if item['role'] in ('reference', 'genetic_map') and identity(os.stat(item['path'])) != item['identity']:
            raise StagingError('A raw reference resource changed during preparation.')
    destination = directory / 'work/res/resg'
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'workspace-reference-preparation.json').write_text(json.dumps(summary, indent=2) + '\n')
    outputs = []
    for path in sorted(prepared.rglob('*')):
        if path.is_file():
            outputs.append({'path': str(path), 'size': path.stat().st_size, 'sha256': digest(path)})
            os.chmod(path, 0o400)
    manifest = {'run_id': plan['run_id'], 'dataset_id': plan['dataset_id'], 'source_files': records,
                'reference_sources': [item for item in plan['source_files'] if item['role'] in ('reference', 'genetic_map')],
                'prepared_outputs': outputs, 'preparation': summary}
    temporary = destination / 'workspace-inputs.json.tmp'
    temporary.write_text(json.dumps(manifest, indent=2) + '\n')
    temporary.replace(destination / 'workspace-inputs.json')
    print('SIGNET_DATASET_INPUTS_FROZEN', flush=True)


if __name__ == '__main__':
    try:
        stage(json.loads(sys.argv[1]))
    except StagingError as error:
        print('Dataset input preparation failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('Dataset input freezing or study-specific reference preparation failed; reviewed sources were not silently replaced.', file=sys.stderr)
        sys.exit(1)
