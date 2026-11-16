"""Stage 1 workspace flow for the prepared chromosome 1 example."""

from collections import Counter
import json
import shlex

from agent.runtime import signet_jobs as jobs
from agent.runtime.hpc import PREPARED
import agent.tools.signet as signet

DATASET_ID = 'example-chr1'
SNAPSHOT = 'workspace-genotype.json'
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
    return {
        'run_id': run_id, 'dataset_id': DATASET_ID, 'source': 'live',
        'name': ['第 1 號染色體 · 基因型準備', 'Chromosome 1 · Genotype preparation'],
        'inputs': {'genotype': [inputs['ped.file'], inputs['map.file'],
                                inputs['ref'] + chromosome + '.gen', inputs['gmap'] + chromosome + '.map'],
                   'expression': [], 'clinical': []},
        'jobs': {'genotype': job}, 'status': job['state'], 'graph': None,
    }


def completed_result(run_id):
    root = signet._run(run_id)
    job = run_history(root)['jobs']['genotype']
    if job['state'] != 'completed':
        raise ValueError('The genotype step is not complete.')
    return {'run_id': run_id, 'stage': 1, 'job': job, 'summary': genotype_summary(root)}


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
