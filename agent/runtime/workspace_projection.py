"""Display aggregates of completed HPC3 results without downloading person-level files."""

import ast
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shlex
import tempfile

from agent.runtime import signet_jobs as jobs, ssh_transport
from agent.runtime.workspace_history import _json
import agent.tools.signet as signet

STEPS = {1: 'genotype', 2: 'expression', 3: 'adjust', 4: 'cis'}
MAX_BYTES = 32 * 1024 * 1024
_SOURCE = Path(__file__).with_name('jobs') / 'project_workspace.py'


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _reader(stage):
    directory = Path(__file__).parent
    if stage in (1, 2):
        path = directory / 'workspace_genotype.py'
        entry = 'genotype_summary' if stage == 1 else 'expression_summary'
        wanted = [entry]
    elif stage == 3:
        path = directory / 'workspace_adjustment.py'
        names = {node.name for node in ast.parse(path.read_text()).body if isinstance(node, ast.FunctionDef)}
        # The public adapter can dispatch here; only the original pure reader runs remotely.
        entry = '_local_completed_result' if '_local_completed_result' in names else 'completed_result'
        wanted = ['_lines', '_matrix', '_clinical', '_pca', '_median_sd', '_genotype_width', entry]
    else:
        path, entry = directory / 'workspace_cis.py', 'summary'
        wanted = ['_matrix_shape', entry]
    source = path.read_text()
    nodes = {node.name: node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef)}
    lines = source.splitlines(keepends=True)
    return '\n\n'.join(''.join(lines[nodes[name].lineno - 1:nodes[name].end_lineno]) for name in wanted), entry


def _number(value, integer=False):
    return (type(value) is int if integer else type(value) in (int, float)) and math.isfinite(value) and value >= 0


def _validate(value, run_id, stage, record):
    keys = {'version', 'run_id', 'stage', 'job_id', 'attempt', 'source_fingerprint'}
    keys |= {'npc', 'matching', 'comparison', 'pca'} if stage == 3 else {'summary'}
    if (not isinstance(value, dict) or set(value) != keys or value.get('version') != 1
            or value.get('run_id') != run_id or value.get('stage') != stage
            or value.get('job_id') != record['job_id'] or value.get('attempt') != record.get('attempt', 1)
            or not re.fullmatch(r'[a-f0-9]{64}', value.get('source_fingerprint', ''))):
        raise ValueError('The remote aggregate does not identify this completed job.')
    if stage == 3:
        matching, pca, comparison = value['matching'], value['pca'], value['comparison']
        if (type(value['npc']) is not int or value['npc'] != record.get('options', {}).get('npc')
                or not 0 <= value['npc'] <= 10 or not isinstance(matching, dict)
                or set(matching) != {'genotype', 'expression', 'matched', 'retained', 'excluded', 'variants', 'genes'}
                or not all(_number(count, True) for count in matching.values())
                or matching['retained'] + matching['excluded'] != matching['matched']
                or not isinstance(pca, dict)
                or set(pca) != {'png_base64', 'width', 'height', 'point_count', 'variance_explained', 'source'}
                or (pca['width'], pca['height'], pca['point_count'], pca['source']) !=
                   (640, 420, matching['retained'], 'signet_smartpca')
                or not isinstance(pca['variance_explained'], list) or len(pca['variance_explained']) != 2
                or not all(_number(number) and number <= 100 for number in pca['variance_explained'])
                or not isinstance(pca['png_base64'], str) or len(pca['png_base64']) > 2 * 1024 * 1024):
            raise ValueError('The remote adjustment aggregate has an invalid shape.')
        picture = base64.b64decode(pca['png_base64'], validate=True)
        if not picture.startswith(b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x02\x80\x00\x00\x01\xa4'):
            raise ValueError('The remote PCA is not the expected raster image.')
        if comparison is not None and (not isinstance(comparison, dict)
                or set(comparison) != {'before_sd', 'covariates_sd', 'after_sd'}
                or not all(_number(number) for number in comparison.values())):
            raise ValueError('The remote adjustment comparison is invalid.')
        return
    summary = value['summary']
    if not isinstance(summary, dict):
        raise ValueError('The remote result summary is invalid.')
    if stage == 1:
        if (set(summary) != {'samples', 'variants', 'nonzero_bins', 'genotype_codes'}
                or not _number(summary['samples'], True) or not _number(summary['variants'], True)
                or not isinstance(summary['nonzero_bins'], list) or len(summary['nonzero_bins']) != 6
                or not isinstance(summary['genotype_codes'], list) or len(summary['genotype_codes']) != 3
                or not all(_number(number, True) for number in summary['nonzero_bins'] + summary['genotype_codes'])
                or sum(summary['nonzero_bins']) != summary['variants']
                or sum(summary['genotype_codes']) != summary['samples'] * summary['variants']):
            raise ValueError('The remote genotype summary is invalid.')
    elif stage == 2:
        if (set(summary) != {'samples', 'genes', 'histogram', 'gene_summary'}
                or not _number(summary['samples'], True) or not _number(summary['genes'], True)
                or not isinstance(summary['histogram'], list) or not 1 <= len(summary['histogram']) <= 10
                or not isinstance(summary['gene_summary'], list) or len(summary['gene_summary']) > 5):
            raise ValueError('The remote expression summary is invalid.')
        for item in summary['histogram']:
            if (not isinstance(item, dict) or set(item) != {'lower', 'upper', 'count'}
                    or type(item['lower']) not in (int, float) or not math.isfinite(item['lower'])
                    or type(item['upper']) not in (int, float) or not math.isfinite(item['upper'])
                    or item['lower'] >= item['upper'] or not _number(item['count'], True)):
                raise ValueError('The remote expression histogram is invalid.')
        for item in summary['gene_summary']:
            if (not isinstance(item, dict) or set(item) != {'gene', 'min', 'median', 'max'}
                    or not isinstance(item['gene'], str) or not 1 <= len(item['gene']) <= 240
                    or any(type(item[key]) not in (int, float) or not math.isfinite(item[key]) for key in ('min', 'median', 'max'))
                    or not item['min'] <= item['median'] <= item['max']):
                raise ValueError('The remote expression gene aggregate is invalid.')
        if sum(item['count'] for item in summary['histogram']) != summary['samples'] * summary['genes']:
            raise ValueError('The remote histogram does not account for the expression values.')
    else:
        categories = {'common', 'low', 'rare'}
        if (set(summary) != {'genes', 'counts', 'pairs'} or not _number(summary['genes'], True)
                or not isinstance(summary['counts'], dict) or set(summary['counts']) != categories
                or not all(_number(number, True) for number in summary['counts'].values())
                or not isinstance(summary['pairs'], list)):
            raise ValueError('The remote cis-eQTL summary is invalid.')
        counts = dict.fromkeys(categories, 0)
        for item in summary['pairs']:
            if (not isinstance(item, dict) or set(item) != {'gene', 'variant', 'category', 'p_value'}
                    or not isinstance(item['gene'], str) or not 1 <= len(item['gene']) <= 240
                    or not isinstance(item['variant'], str) or not re.fullmatch(r'[0-9]+', item['variant'])
                    or item['category'] not in categories or not _number(item['p_value']) or item['p_value'] > 1):
                raise ValueError('The remote cis-eQTL association is invalid.')
            counts[item['category']] += 1
        if counts != summary['counts']:
            raise ValueError('The remote cis-eQTL counts do not match the associations.')


def completed_result(run_id, stage='1', *, refresh=False):
    """Project one exact completed job; cached aggregates remain readable while disconnected."""
    if str(stage) not in {'1', '2', '3', '4'} or type(stage) is bool or type(refresh) is not bool:
        raise ValueError('Choose a completed workspace stage from 1 to 4.')
    stage = int(stage)
    root = signet._run(run_id)
    record_path = root / 'steps' / (STEPS[stage] + '.json')
    record, record_digest = _json(record_path)
    if (record.get('state') != 'completed' or record.get('step') != STEPS[stage] or record.get('run_id') != run_id
            or not isinstance(record.get('job_id'), str) or not re.fullmatch(r'[0-9]{1,128}', record['job_id'])
            or type(record.get('attempt', 1)) is not int or not 1 <= record.get('attempt', 1) <= 1000):
        raise ValueError('Select an exact completed workspace job and attempt.')
    owner, owner_digest = _json(root / 'steps/remote.owner')
    reader, entry = _reader(stage)
    helper = _SOURCE.read_text()
    snapshots = {}
    snapshot_values = {}
    for step in tuple(STEPS.values())[:stage]:
        path = root / ('workspace-' + step + '.json')
        if path.exists() or path.is_symlink():
            value, digest = _json(path)
            if value.get('run_id') != run_id:
                raise ValueError('The saved workspace inputs belong to a different run.')
            snapshots[step], snapshot_values[step] = digest, value
    source_version = _digest([1, helper, reader, entry])
    cache_id = _digest([run_id, stage, record_digest, owner_digest, snapshots, source_version])
    cache_dir = signet._no_links(root / 'workspace-projections')
    cache = signet._no_links(cache_dir / (cache_id + '.json'))
    if not refresh and cache.is_file():
        if cache.stat().st_size > MAX_BYTES:
            raise ValueError('The cached workspace projection is too large.')
        saved = json.loads(cache.read_text())
        value = saved['projection']
        if (saved.get('cache_id') != cache_id or saved.get('source_version') != source_version
                or saved.get('cache_key') != _digest([cache_id, value['source_fingerprint']])):
            raise ValueError('The cached projection belongs to a different source.')
        _validate(value, run_id, stage, record)
    else:
        config = jobs._environment()
        if record.get('image') != config['image'] or record.get('partition') != config['partition']:
            raise jobs.StepError('conflict', 'Select the original container and partition before reading these remote results.')
        original_environment = snapshot_values.get('genotype', {}).get('environment')
        if original_environment and any(original_environment.get(key) != config.get(key) for key in
                ('root', 'source', 'image', 'executor', 'workRoot', 'partition', 'runtimeModule')):
            raise jobs.StepError('conflict', 'Select the original remote environment before reading these results.')
        guard = jobs._output_guard(root, record)
        request = {'run_id': run_id, 'stage': stage, 'remote_dir': record['remote_dir'], 'job': record,
                   'owner_token': owner['token'], 'reader_source': reader, 'reader_entry': entry}
        script = (jobs._say() + guard + 'python3 - ' + shlex.quote(json.dumps(request))
                  + " <<'SIGNET_PROJECT_WORKSPACE'\n" + helper + '\nSIGNET_PROJECT_WORKSPACE\n'
                  + 'projection_status=$?\n[ "$projection_status" = 0 ] || exit "$projection_status"\n' + guard)
        try:
            response = ssh_transport.remote('bash -s', input=script.encode(), capture_output=True, timeout=180)
        except OSError as error:
            raise jobs.StepError('remote_failed', 'Could not read the completed remote result aggregates.') from error
        if response.returncode or len(response.stdout) > MAX_BYTES:
            raise jobs.StepError('remote_failed', 'The completed remote results could not be projected safely.')
        replies = [line.split('\t', 1)[1] for line in response.stdout.decode('utf-8').splitlines()
                   if line.startswith('@@workspace_projection\t')]
        if len(replies) != 1:
            raise jobs.StepError('remote_failed', 'HPC3 did not return a verified workspace projection.')
        value = json.loads(replies[0])
        _validate(value, run_id, stage, record)
        # A switch or retry while the request ran must not publish a projection under its new identity.
        if (_json(record_path)[1] != record_digest or _json(root / 'steps/remote.owner')[1] != owner_digest
                or jobs._environment() != config):
            raise jobs.StepError('conflict', 'The selected job or environment changed while its results were read.')
        for step, digest in snapshots.items():
            if _json(root / ('workspace-' + step + '.json'))[1] != digest:
                raise jobs.StepError('conflict', 'The saved source choices changed while the results were read.')
        cache_dir.mkdir(mode=0o700, exist_ok=True)
        saved = {'cache_id': cache_id, 'cache_key': _digest([cache_id, value['source_fingerprint']]),
                 'source_version': source_version, 'projection': value}
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', dir=cache_dir, prefix='.projection-', delete=False) as stream:
                temporary = Path(stream.name)
                json.dump(saved, stream, separators=(',', ':'), allow_nan=False)
            os.replace(temporary, cache)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    if stage == 3:
        return {'run_id': run_id, 'job': record, **{key: value[key] for key in ('npc', 'matching', 'comparison', 'pca')}}
    return {'run_id': run_id, 'stage': stage, 'job': record, 'summary': value['summary']}
