"""Manual workspace steps for the prepared chromosome 1 example."""

from bisect import bisect_right
from collections import Counter
import json
import math
import shlex
from statistics import median

from agent.runtime import signet_jobs as jobs
from agent.runtime.hpc import PREPARED, REFERENCE_FILES
import agent.tools.signet as signet

DATASET_ID = 'example-chr1'
SNAPSHOT = 'workspace-genotype.json'
EXPRESSION_SNAPSHOT = 'workspace-expression.json'
DEFAULT_SETTINGS = {'restrict.tcga.geno': 1, 'mind': 0.1, 'geno': 0.1, 'hwe': 0.0001, 'int': 5000000}


def _example_inputs(config):
    directory = config['root'] + '/' + PREPARED
    return {'ped.file': directory + '/study.ped', 'map.file': directory + '/study.map',
            'ref': directory + '/ref/chr', 'gmap': directory + '/gmap/chr'}


def review_example():
    """Review the exact prepared example files without creating a run or a job."""
    try:
        signet._verify_source()
    except (ValueError, OSError) as error:
        raise jobs.StepError('not_ready', str(error)) from error
    config = jobs._environment()
    inputs = _example_inputs(config)
    step = jobs.STEPS['genotype']
    checked = jobs._inputs(step, inputs, (config['root'] + '/refdata',))
    files = jobs._files(step, checked, {'restrict.tcga.geno': '1'})
    script = (jobs._say() + jobs._input_checks(files)
              + f'if [ ! -s {shlex.quote(config["image"])} ]; then say not_ready container; exit 5; fi\n'
              + 'if ! command -v sbatch >/dev/null 2>&1; then say not_ready sbatch; exit 5; fi\n')
    try:
        code, markers, _ = jobs._shell(script)
    except OSError as error:
        raise jobs.StepError('remote_failed', 'Could not verify the prepared example files on HPC3.') from error
    if 'missing_input' in markers:
        raise jobs.StepError(
            'not_ready', f'Prepare the chromosome 1 example in the remote environment. '
            f'{markers["missing_input"]} is unavailable ({markers["missing_file"]}).')
    if 'not_ready' in markers:
        raise jobs.StepError('not_ready', 'The remote environment is missing ' + markers['not_ready'] + '.')
    if code:
        raise jobs.StepError('remote_failed', 'The prepared example file check failed on HPC3.')
    return {'inputs': inputs, 'settings': DEFAULT_SETTINGS.copy(),
            'resources': step.resources.copy(), 'limits': step.limits.copy()}


def submit_example(run_id, inputs, settings, resources):
    try:
        run_id = signet._name(run_id)
    except ValueError as error:
        raise jobs.StepError('invalid_request', str(error)) from error
    return _submit_example(run_id, inputs, settings, resources)


@jobs._one_at_a_time
def _submit_example(run_id, inputs, settings, resources):
    existing = signet.PROJECT / 'runs' / run_id
    archived = signet.PROJECT / 'data/stage6-results' / run_id
    if existing.exists() or archived.exists() or existing.is_symlink() or archived.is_symlink():
        raise jobs.StepError('conflict', f'A run named {run_id} already exists. Check its saved status.')
    if run_id in jobs.RESERVED_RUN_IDS:
        raise jobs.StepError('invalid_request', f'Run name {run_id} is reserved.')
    config = jobs._environment()
    accepted_inputs = _example_inputs(config)
    if inputs != accepted_inputs:
        raise jobs.StepError('invalid_request', 'The example inputs changed. Review the current files again.')
    if not isinstance(settings, dict) or set(settings) != set(DEFAULT_SETTINGS) or settings['restrict.tcga.geno'] != 1:
        raise jobs.StepError('invalid_request', 'Confirm all genotype settings for chromosome 1.')
    step = jobs.STEPS['genotype']
    checked = {key: jobs._setting(key, rule, settings[key]) for key, rule in step.settings.items()}
    accepted_resources = jobs._resources(step, resources)

    created = signet.configure_signet(run_id, 'TCGA')
    if created['status'] != 'created':
        raise jobs.StepError('invalid_request', created['error'])
    root = signet._run(run_id)
    jobs.update_settings(run_id, settings)
    snapshot = {
        'run_id': run_id, 'dataset_id': DATASET_ID, 'submitted_at': jobs._now(),
        'inputs': accepted_inputs, 'settings': checked, 'resources': accepted_resources,
    }
    # Save the confirmed inputs before submitting so a lost connection cannot detach the job from history.
    temporary = root / (SNAPSHOT + '.tmp')
    temporary.write_text(json.dumps(snapshot, indent=2) + '\n')
    temporary.replace(root / SNAPSHOT)
    return jobs.submit(run_id, 'genotype', accepted_inputs, resources)


def _expression_run(run_id):
    try:
        root = signet._run(run_id)
        history = run_history(root)
    except (ValueError, OSError, KeyError, TypeError) as error:
        raise jobs.StepError('not_found', 'Select the chromosome 1 workspace run created in Stage 1.') from error
    genotype = history['jobs']['genotype']
    if genotype['state'] != 'completed':
        raise jobs.StepError('not_ready', 'Wait for Stage 1 of this run to complete before submitting Stage 2.')
    return root, history


def _expression_inputs(config):
    q = shlex.quote
    annotation = config['root'] + '/' + REFERENCE_FILES['gtf']
    table = config['root'] + '/refdata/selected.tsv'
    script = (jobs._say() + f'annotation={q(annotation)}\n'
              + f'if [ -f {q(table)} ]; then\n'
              + f'  while IFS=$\'\\t\' read -r key path; do [ "$key" != gtf ] || annotation="$path"; done < {q(table)}\n'
              + 'fi\nsay annotation "$annotation"\n')
    try:
        code, values, _ = jobs._shell(script)
    except OSError as error:
        raise jobs.StepError('remote_failed', 'Could not read the configured gene annotation on HPC3.') from error
    if code or not values.get('annotation'):
        raise jobs.StepError('remote_failed', 'Could not read the configured gene annotation on HPC3.')
    # The pinned example inventory uses gexp; upstream config.ini.default still says gexp-prep.
    return {'gexp.file': config['source'] + '/example/gexp/example_gexp',
            'pmap.file': values['annotation']}


def _review_expression(run_id):
    root, history = _expression_run(run_id)
    config = jobs._environment()
    if history['jobs']['genotype']['remote_dir'] != jobs._remote_dir(config, root, run_id):
        raise jobs.StepError('not_ready', 'Select the remote environment used by Stage 1 of this run.')
    inputs = _expression_inputs(config)
    step = jobs.STEPS['expression']
    checked = jobs._inputs(step, inputs, (config['root'] + '/refdata', config['source'] + '/example'))
    files = jobs._files(step, checked, {'restrict.tcga': '1'})
    script = (jobs._say() + jobs._input_checks(files)
              + f'if [ ! -s {shlex.quote(config["image"])} ]; then say not_ready container; exit 5; fi\n'
              + 'if ! command -v sbatch >/dev/null 2>&1; then say not_ready sbatch; exit 5; fi\n')
    try:
        code, values, _ = jobs._shell(script)
    except OSError as error:
        raise jobs.StepError('remote_failed', 'Could not verify the expression inputs on HPC3.') from error
    if 'missing_input' in values:
        raise jobs.StepError('not_ready', 'The Stage 2 input is unavailable: ' + values['missing_file'])
    if code or 'not_ready' in values:
        raise jobs.StepError('not_ready', 'The Stage 2 environment is not ready. Check remote settings.')
    return {'run_id': run_id, 'inputs': inputs, 'settings': {'restrict.tcga': 1},
            'resources': step.resources.copy(), 'limits': step.limits.copy()}


@jobs._one_at_a_time
def review_expression(run_id):
    """Confirm this run's Stage 2 files without modifying it or submitting a job."""
    return _review_expression(run_id)


@jobs._one_at_a_time
def submit_expression(run_id, inputs, settings, resources):
    root, _ = _expression_run(run_id)
    record_path = jobs._record_path(root, 'expression')
    previous = jobs._load(root, 'expression') if record_path.exists() else None
    if previous and previous.get('state') not in jobs.RETRYABLE:
        raise jobs.StepError('conflict', 'Stage 2 already has a recorded job. Check its status before submitting.')
    if jobs._active_step(root) or (root / '.active').exists():
        raise jobs.StepError('conflict', 'A step of this run is still active. Check its status first.')
    review = _review_expression(run_id)
    if inputs != review['inputs']:
        raise jobs.StepError('invalid_request', 'The Stage 2 input files changed. Review the current files again.')
    if not isinstance(settings, dict) or set(settings) != {'restrict.tcga'}:
        raise jobs.StepError('invalid_request', 'Confirm the chromosome 1 expression setting.')
    chromosome = jobs._setting('restrict.tcga', 'chromosome', settings['restrict.tcga'])
    if chromosome != '1':
        raise jobs.StepError('invalid_request', 'Stage 2 must use chromosome 1 for this run.')
    accepted_resources = jobs._resources(jobs.STEPS['expression'], resources)
    if previous:
        jobs._ensure_stopped(previous)
    path = signet._no_links(root / EXPRESSION_SNAPSHOT)
    review_attempt = 1
    if path.exists():
        saved = json.loads(path.read_text())
        review_attempt = saved['review_attempt'] + 1
        archive = root / f'workspace-expression.review{saved["review_attempt"]}.json'
        if archive.exists() or archive.is_symlink():
            raise jobs.StepError('conflict', 'The previous Stage 2 review archive already exists.')
        with archive.open('x') as stream:
            stream.write(json.dumps(saved, indent=2) + '\n')
    snapshot = {'run_id': run_id, 'dataset_id': DATASET_ID, 'review_attempt': review_attempt,
                'submitted_at': jobs._now(), 'inputs': inputs,
                'settings': {'restrict.tcga': chromosome}, 'resources': accepted_resources}
    jobs.update_settings(run_id, settings)
    temporary = root / (EXPRESSION_SNAPSHOT + '.tmp')
    temporary.write_text(json.dumps(snapshot, indent=2) + '\n')
    temporary.replace(path)
    return jobs.submit(run_id, 'expression', inputs, resources)


def run_history(root):
    """Return the most recent recorded step alongside the immutable review snapshot."""
    run_id = root.name
    snapshot = json.loads(signet._no_links(root / SNAPSHOT).read_text(encoding='utf-8'))
    if snapshot['run_id'] != run_id or snapshot['dataset_id'] != DATASET_ID:
        raise ValueError('The genotype history does not identify this run.')
    job = {key: snapshot[key] for key in ('submitted_at', 'inputs', 'settings', 'resources')}
    job['state'] = 'submitting' if (root / '.active').exists() else 'not_submitted'
    path = signet._no_links(root / 'steps/genotype.json')
    if path.is_file():
        record = jobs._load(root, 'genotype')
        if record['run_id'] != run_id or record['step'] != 'genotype':
            raise ValueError('The genotype step record does not belong to this run.')
        job.update(record)
    inputs = job['inputs']
    chromosome = job['settings']['restrict.tcga.geno']
    result = {
        'run_id': run_id, 'dataset_id': DATASET_ID, 'source': 'live',
        'name': ['第 1 號染色體 · 基因型準備', 'Chromosome 1 · Genotype preparation'],
        'inputs': {'genotype': [inputs['ped.file'], inputs['map.file'],
                                inputs['ref'] + chromosome + '.gen', inputs['gmap'] + chromosome + '.map'],
                   'expression': [], 'clinical': []},
        'jobs': {'genotype': job}, 'status': job['state'], 'graph': None,
    }
    expression_path = signet._no_links(root / EXPRESSION_SNAPSHOT)
    if expression_path.is_file():
        expression = json.loads(expression_path.read_text(encoding='utf-8'))
        if expression['run_id'] != run_id or expression['dataset_id'] != DATASET_ID:
            raise ValueError('The expression history does not identify this run.')
        expression_job = {key: expression[key] for key in ('submitted_at', 'inputs', 'settings', 'resources')}
        expression_job['state'] = 'submitting' if (root / '.active').exists() else 'not_submitted'
        if signet._no_links(root / 'steps/expression.json').is_file():
            record = jobs._load(root, 'expression')
            if record['run_id'] != run_id or record['step'] != 'expression':
                raise ValueError('The expression step record does not belong to this run.')
            expression_job.update(record)
        result['jobs']['expression'] = expression_job
        result['inputs']['expression'] = [expression_job['inputs'][key] for key in ('gexp.file', 'pmap.file')]
        result['status'] = expression_job['state']
        result['name'] = ['第 1 號染色體 · 分析', 'Chromosome 1 · Analysis']
    return result


def completed_result(run_id, stage='1'):
    root = signet._run(run_id)
    name = {'1': 'genotype', '2': 'expression'}[stage]
    job = run_history(root)['jobs'][name]
    if job['state'] != 'completed':
        raise ValueError(f'The {name} step is not complete.')
    summary = genotype_summary(root) if stage == '1' else expression_summary(root)
    return {'run_id': run_id, 'stage': int(stage), 'job': job, 'summary': summary}


def expression_summary(root):
    """Summarize the downloaded matrix with bounded memory and no remote queries."""
    directory = root / 'work/res/rest'
    sample_ids = signet._no_links(directory / 'signet_gexpID')
    names_path = signet._no_links(directory / 'signet_gene_name')
    positions = signet._no_links(directory / 'signet_gene_pos')
    matrix = signet._no_links(directory / 'signet_gexp')
    with sample_ids.open(encoding='utf-8') as stream:
        samples = sum(bool(line.strip()) for line in stream)
    with names_path.open(encoding='utf-8') as stream:
        names = [line.strip() for line in stream if line.strip()]
    genes = len(names)
    with positions.open(encoding='utf-8') as stream:
        position_count = sum(bool(line.strip()) for line in stream)
    if not samples or not genes or position_count != genes:
        raise ValueError('The expression output has inconsistent sample or gene identifiers.')
    if any(not name or len(name) > 240 for name in names):
        raise ValueError('The expression output contains invalid gene names.')
    minimum, maximum, rows = math.inf, -math.inf, 0
    excerpt = [[] for _ in names[:5]]
    with matrix.open(encoding='utf-8') as stream:
        for line in stream:
            if not line.strip():
                continue
            row = [float(value) for value in line.split()]
            if len(row) != genes or not all(map(math.isfinite, row)):
                raise ValueError('The expression matrix contains invalid or inconsistent values.')
            minimum = min(minimum, min(row))
            maximum = max(maximum, max(row))
            rows += 1
            for index, values in enumerate(excerpt):
                values.append(row[index])
    if rows != samples:
        raise ValueError('The expression output does not match its sample identifiers.')
    if minimum == maximum:
        bounds = [minimum - 0.5, maximum + 0.5]
    else:
        bounds = [minimum + (maximum - minimum) * index / 10 for index in range(11)]
    histogram = [{'lower': lower, 'upper': upper, 'count': 0} for lower, upper in zip(bounds, bounds[1:])]
    with matrix.open(encoding='utf-8') as stream:
        for line in stream:
            for text in line.split():
                value = float(text)
                index = min(len(histogram) - 1, bisect_right(bounds, value) - 1)
                histogram[index]['count'] += 1
    return {'samples': samples, 'genes': genes, 'histogram': histogram,
            'gene_summary': [{'gene': name, 'min': min(values), 'median': median(values), 'max': max(values)}
                             for name, values in zip(names[:5], excerpt)]}


def genotype_summary(root):
    """Read only the local Stage 1 outputs already collected by the status operation."""
    directory = root / 'work/res/resg'
    sample_ids = signet._no_links(directory / 'signet_Genotype.sampleID')
    with sample_ids.open(encoding='utf-8') as stream:
        samples = sum(1 for line in stream if line.strip())
    if not samples:
        raise ValueError('The genotype output has no sample identifiers.')

    genotypes = signet._no_links(directory / 'signet_Geno')
    codes = Counter()
    nonzero = []
    sample_rows = 0
    with genotypes.open(encoding='utf-8') as stream:
        for line in stream:
            row = line.split()
            if not row:
                continue
            if not nonzero:
                nonzero = [0] * len(row)
            if len(row) != len(nonzero):
                raise ValueError('The genotype output contains rows of different widths.')
            codes.update(row)
            for index, code in enumerate(row):
                nonzero[index] += code != '0'
            sample_rows += 1
    if sample_rows != samples or not nonzero or set(codes) - {'0', '1', '2'}:
        raise ValueError('The genotype output does not match its sample identifiers or encoding.')
    bins = [0] * 6
    for count in nonzero:
        percent = count * 100
        index = sum(percent >= threshold * samples for threshold in (1, 5, 10, 25, 50))
        bins[index] += 1
    return {'samples': samples, 'variants': len(nonzero), 'nonzero_bins': bins,
            'genotype_codes': [codes[str(code)] for code in range(3)]}
