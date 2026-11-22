"""Read current workspace aggregates on HPC3 without downloading individual results."""
import ast
import base64
import json
import math
from pathlib import Path
import re
import shlex

from agent.runtime import signet_jobs as jobs, ssh_transport
import agent.tools.signet as signet

STEPS = {1: 'genotype', 2: 'expression', 3: 'adjust', 4: 'cis'}
MAX_BYTES = 32 * 1024 * 1024


def _reader(stage):
    if stage in (1, 2):
        path = Path(__file__).with_name('workspace_genotype.py')
        entry = 'genotype_summary' if stage == 1 else 'expression_summary'
        wanted = [entry]
    elif stage == 3:
        path = Path(__file__).with_name('workspace_adjustment.py')
        entry = '_local_completed_result'
        wanted = ['_lines', '_matrix', '_clinical', '_pca', '_median_sd', '_genotype_width', entry]
    else:
        path = Path(__file__).with_name('workspace_cis.py')
        entry = 'summary'
        wanted = ['_matrix_shape', entry]
    source = path.read_text(encoding='utf-8')
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


def completed_result(run_id, stage):
    if str(stage) not in ('1', '2', '3', '4') or type(stage) is bool:
        raise ValueError('Choose a completed workspace stage from 1 to 4.')
    stage = int(stage)
    root = signet._run(run_id)
    snapshot_names = ['workspace-genotype.json']
    if stage > 1:
        snapshot_names.append({2: 'workspace-expression.json', 3: 'workspace-adjust.json', 4: 'workspace-cis.json'}[stage])
    snapshots = {}
    for name in snapshot_names:
        path = signet._no_links(root / name)
        content = path.read_bytes()
        value = json.loads(content)
        if value.get('run_id') != run_id or value.get('dataset_id') != 'example-chr1':
            raise ValueError('The saved workspace selection does not identify this run.')
        snapshots[path] = content
    record_path = signet._no_links(root / 'steps' / (STEPS[stage] + '.json'))
    before = record_path.read_bytes()
    record = json.loads(before)
    if (record.get('state') != 'completed' or record.get('run_id') != run_id
            or record.get('step') != STEPS[stage]
            or not isinstance(record.get('job_id'), str) or not re.fullmatch(r'[0-9]+', record['job_id'])
            or type(record.get('attempt', 1)) is not int or record.get('attempt', 1) < 1):
        raise ValueError('Select the exact completed workspace job.')
    config = dict(jobs._environment())
    owner_path = signet._no_links(root / 'steps/remote.owner')
    owner_before = owner_path.read_bytes()
    owner = json.loads(owner_before)
    directory = jobs._remote_dir(config, root, run_id)
    if (record.get('remote_dir') != directory or owner.get('remote_dir') != directory
            or not isinstance(owner.get('token'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', owner['token'])):
        raise ValueError('Select the original remote environment and owned workspace run.')
    reader, entry = _reader(stage)
    request = {'run_id': run_id, 'stage': stage, 'remote_dir': directory, 'work_root': config['workRoot'], 'job': record,
               'owner_token': owner['token'], 'reader_source': reader, 'reader_entry': entry}
    helper = Path(__file__).with_name('jobs') / 'project_workspace.py'
    script = 'python3 - ' + shlex.quote(json.dumps(request)) + " <<'SIGNET_WORKSPACE_PROJECTION'\n" + helper.read_text(encoding='utf-8') + '\nSIGNET_WORKSPACE_PROJECTION\n'
    response = ssh_transport.remote('bash -s', input=script.encode(), capture_output=True, timeout=180)
    if response.returncode or len(response.stdout) > MAX_BYTES:
        raise ValueError('The remote results could not be summarized safely.')
    replies = [line.split('\t', 1)[1] for line in response.stdout.decode('utf-8').splitlines()
               if line.startswith('@@workspace_projection\t')]
    if len(replies) != 1:
        raise ValueError('The remote result did not return a single aggregate.')
    result = json.loads(replies[0])
    _validate(result, run_id, stage, record)
    if (record_path.read_bytes() != before or owner_path.read_bytes() != owner_before
            or any(path.read_bytes() != content for path, content in snapshots.items())
            or jobs._environment() != config):
        raise ValueError('The selected job or remote environment changed while reading.')
    if stage == 3:
        return {'run_id': run_id, 'job': record, **{key: result[key] for key in ('npc', 'matching', 'comparison', 'pca')}}
    return {'run_id': run_id, 'stage': stage, 'job': record, 'summary': result['summary']}
