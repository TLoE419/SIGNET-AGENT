"""Run official Stage 6 exports headlessly in the existing local SIGNET VM."""
import csv
import io
import json
import math
import re
from pathlib import Path
import subprocess
import tarfile

import signet_runtime as vm

INPUT_KEYS = ('Afreq', 'coef', 'vis.genepos')
PACKAGES = ('igraph', 'dnet', 'visNetwork', 'STRINGdb', 'TFutils', 'shiny',
            'shinyfullscreen', 'shinycustomloader', 'shinydashboard', 'plotly',
            'DT', 'circlize', 'ggthemes', 'fmsb')


def validate_inputs(settings):
    matrices = []
    for key in INPUT_KEYS[:2]:
        rows = []
        for line in Path(settings[key]).read_text().splitlines():
            if line.strip():
                row = [float(value) for value in line.replace(',', ' ').split()]
                if not all(math.isfinite(value) for value in row):
                    raise ValueError('Visualization matrices must contain finite numbers.')
                if key == 'Afreq' and not all(0 <= value <= 1 for value in row):
                    raise ValueError('Bootstrap frequencies must be between zero and one.')
                rows.append(row)
        matrices.append(rows)
    positions = [line.split() for line in Path(settings['vis.genepos']).read_text().splitlines() if line.strip()]
    n = len(positions)
    if not n or any(len(row) != 4 for row in positions):
        raise ValueError('Gene positions require name, chromosome, start and end.')
    if len({row[0] for row in positions}) != n:
        raise ValueError('Gene names must be unique and ordered as in the matrices.')
    for row in positions:
        if int(row[2]) < 0 or int(row[3]) < int(row[2]):
            raise ValueError('Invalid gene coordinates.')
    # Official examples are rectangular: rows are targets; columns index source genes.
    width = len(matrices[0][0]) if matrices[0] else 0
    if not 0 < width <= n or any(len(matrix) != n or any(len(row) != width for row in matrix) for matrix in matrices):
        raise ValueError('Matrix shapes must match, with one target row per gene and source columns covered by gene positions.')
    threshold = float(settings['freq'])
    edges = [(i, j) for i, row in enumerate(matrices[0]) for j, value in enumerate(row)
             if value > threshold - 2.220446049250313e-16]
    if not edges:
        raise ValueError('No edges pass the frequency threshold; select a supported threshold.')
    neighbors = {}
    for i, j in edges:
        neighbors.setdefault(i, set()).add(j)
        neighbors.setdefault(j, set()).add(i)
    seen, components = set(), 0
    for node in neighbors:
        if node in seen:
            continue
        components += 1
        stack = [node]
        while stack:
            current = stack.pop()
            if current not in seen:
                seen.add(current)
                stack.extend(neighbors[current] - seen)
    if int(settings['ntop']) > components:
        raise ValueError(f'Only {components} connected subnetworks pass the threshold; reduce top_networks.')
    return {'genes': n, 'edges_at_threshold': len(edges), 'connected_subnetworks': components,
            'limitation': 'Dimensions and coordinate checks do not establish biological identity.'}


def preflight():
    packages = ','.join(json.dumps(p) for p in PACKAGES)
    cmd = (f'test -s {vm.image_path()} && command -v timeout >/dev/null && '
           f'singularity exec --cleanenv --no-home --env OPENBLAS_NUM_THREADS=1,OMP_NUM_THREADS=1 '
           f'{vm.image_path()} Rscript -e \'stopifnot(all(c({packages}) %in% rownames(installed.packages())))\'')
    try:
        result = vm.remote(cmd, capture_output=True, timeout=30)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def bundle(root, settings, remote_root):
    keys = INPUT_KEYS + (('tf',) if settings['id'] != '9606' else ())
    original = vm.bundle(root, settings, remote_root, input_keys=keys)
    result = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(original), mode='r:gz') as src, \
            tarfile.open(fileobj=result, mode='w:gz') as dst:
        for item in src.getmembers():
            content = src.extractfile(item).read() if item.isfile() else None
            if item.name == 'work/script/netvis/netshiny.R':
                # Deployment only: cloud=T skips the blocking Shiny server; official exports still run.
                content = b'Sys.setenv(freq=trimws(Sys.getenv("freq")))\n' + content
                content += b'\ncat("SIGNET_STAGE6_EXPORTS_COMPLETED\\n")\n'
                item.size = len(content)
            dst.addfile(item, io.BytesIO(content) if content is not None else None)
    return result.getvalue()


def execute(root, settings, seconds=600):
    validation = validate_inputs(settings)
    remote_root = '/tmp/signet-agent-visualization/' + root.name
    plan = {'operation': 'visualization', 'runtime': 'existing-docker-vm',
            'remote_directory': remote_root, 'container_image': vm.image_path(),
            'settings_file': str(root / 'work/config.ini'), 'input_validation': validation,
            'mode': 'official headless exports; no persistent Shiny server'}
    if not preflight():
        return {'status': 'unavailable', 'executed': False, **plan,
                'reason': 'Existing VM or Stage 6 R packages unavailable; no visualization started.'}
    record = root / 'visualization.json'
    outpath, errpath = root / 'logs/visualization.stdout', root / 'logs/visualization.stderr'
    try:
        uploaded = vm.remote('umask 077; mkdir -p /tmp/signet-agent-visualization && mkdir ' + remote_root +
                             ' && tar xzf - -C ' + remote_root,
                             input=bundle(root, settings, remote_root), capture_output=True, timeout=60)
        if uploaded.returncode:
            return {'status': 'blocked', 'executed': False, **plan,
                    'reason': 'Could not create a fresh remote run; no visualization started.'}
        record.write_text(json.dumps({'status': 'starting', 'executed': 'unknown', **plan}) + '\n')
        cmd = (f'cd {remote_root}/work && mkdir -p tmp data res/resv && '
               f'timeout -k 5 {seconds}s singularity exec --cleanenv --no-home '
               '--env cloud=T,OPENBLAS_NUM_THREADS=1,OMP_NUM_THREADS=1,MKL_NUM_THREADS=1 '
               f'--bind {remote_root}:{remote_root} {vm.image_path()} bash ./signet -v')
        with outpath.open('xb') as stdout, errpath.open('xb') as stderr:
            result = vm.remote(cmd, stdout=stdout, stderr=stderr, timeout=seconds + 30)
        fetched = vm.remote(f'cd {remote_root} && tar czf - work/res work/tmp work/data',
                            capture_output=True, timeout=120)
        if fetched.returncode:
            raise OSError('Unable to collect visualization outputs.')
        outputs = vm.restore_outputs(root, fetched.stdout)
        value = {'executed': True, **plan, 'returncode': result.returncode,
                 'output_files': outputs, 'stdout_log': str(outpath), 'stderr_log': str(errpath)}
        value.update(verify_exports(root, settings, validation, result.returncode))
    except (OSError, ValueError, subprocess.TimeoutExpired, KeyboardInterrupt) as exc:
        value = {'status': 'unknown', 'executed': 'unknown', **plan,
                 'reason': 'Connection or collection interrupted. Do not replay this run; remote timeout bounds execution.',
                 'error_type': type(exc).__name__}
    record.write_text(json.dumps(value, indent=2) + '\n')
    return value


def verify_exports(root, settings, validation, returncode):
    prefix = Path(settings['resv'])
    label = format(float(settings['freq']), '.15g')
    renamed = []
    # The upstream portal leaves a leading newline in freq; only normalize known output names.
    for i in range(1, int(settings['ntop']) + 1):
        expected = Path(f'{prefix}_circular_top{i}_freq{label}.pdf')
        for candidate in prefix.parent.glob(f'{prefix.name}_circular_top{i}_freq*.pdf'):
            suffix = candidate.name.split(f'_circular_top{i}_freq', 1)[1][:-4]
            if suffix.strip() == label and candidate != expected:
                if expected.exists():
                    raise ValueError('Refusing to overwrite an existing circular plot.')
                candidate.rename(expected)
                renamed.append({'from':str(candidate.relative_to(root)), 'to':str(expected.relative_to(root))})
    required = [Path(f'{prefix}_edgelist_{label}.txt'), Path(f'{prefix}_count_vs_freq.pdf'),
                Path(f'{prefix}_count_vs_freq.eps')]
    for i in range(1, int(settings['ntop']) + 1):
        required += [Path(f'{prefix}_top{i}_freq{label}.html'), Path(f'{prefix}_top{i}_freq{label}_name.txt'),
                     Path(f'{prefix}_circular_top{i}_freq{label}.pdf')]
        required += [Path(f'{prefix}_enrich_{cat}_info_top{i}_freq{label}.txt') for cat in ('KEGG','Process')]
    missing = [str(p.relative_to(root)) for p in required if not p.is_file() or not p.stat().st_size]
    invalid = []
    for p in required:
        if not p.is_file():
            continue
        if p.suffix == '.pdf' and not p.read_bytes().startswith(b'%PDF-'):
            invalid.append(str(p.relative_to(root)))
        if p.suffix == '.html':
            source = p.read_text()
            if 'visNetwork' not in source:
                invalid.append(str(p.relative_to(root)))
            for asset in re.findall(r'(?:src|href)=["\']([^"\']+)["\']', source):
                if asset.startswith(('http:', 'https:', '//', '#', 'data:')):
                    continue
                target = p.parent / asset
                if not target.is_file() or not target.resolve().is_relative_to(prefix.parent.resolve()):
                    invalid.append(asset)
    out = (root/'logs/visualization.stdout').read_text(errors='replace')
    err = (root/'logs/visualization.stderr').read_text(errors='replace')
    marker = 'SIGNET_STAGE6_EXPORTS_COMPLETED' in out
    with required[0].open() if required[0].is_file() else io.StringIO('') as stream:
        rows = list(csv.DictReader(stream))
    verified = (returncode == 0 and marker and not missing and not invalid and
                len(rows) == validation['edges_at_threshold'] and
                'Execution halted' not in err and 'Error in ' not in err)
    return {'status': 'verified_completed' if verified else 'failed',
            'output_files': sorted(str(p.relative_to(root)) for p in (root/'work/res').rglob('*') if p.is_file()),
            'missing_required_outputs': missing, 'invalid_outputs': invalid,
            'normalized_output_filenames': renamed,
            'verification': {'completion_marker': marker, 'exported_edges': len(rows),
                             'pdf_and_html_assets_checked': not missing and not invalid},
            'notes': ['Some enrichment plots are omitted when too few enriched terms are available.']
                     if 'no enough pathways' in out else [],
            'summary': 'Checked technical exports only; not biological validation.'}
