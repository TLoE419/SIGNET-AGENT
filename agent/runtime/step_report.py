"""Structured model reports: counts and execution metadata, never person-level rows or raw logs."""
import re
from agent.runtime import signet_jobs as jobs

_MEANING = {
    'signet_Genotype.sampleID': ('samples', None),
    'signet_Geno': ('samples', 'SNPs'),
    'signet_gexpID': ('samples', None),
    'signet_gexp': ('samples', 'genes'),
    'signet_gene_name': ('genes', None),
    'signet_gene_pos': ('genes', None),
    'signet_matched.gexp': ('matched samples', 'genes'),
    'signet_new.Geno': ('matched samples', 'SNPs'),
    'signet_gexp.data': ('retained samples', 'genes'),
    'signet_gexp_rmpc.data': ('retained samples', 'genes'),
    'signet_geno.data': ('retained samples', 'SNPs'),
    'signet_all.eQTL.data': ('samples', 'instrument columns'),
    'signet_net.gexp.data': ('samples', 'genes'),
    'signet_new.Geno.map': ('SNPs', None),
    'signet_new.Geno.maf': ('SNPs', None),
    'signet_all.sig.pValue': ('significant gene-SNP pairs', None),
    'signet_net.genename': ('genes', None),
    'signet_net.genepos': ('genes', None),
    'signet_Afreq': ('genes', 'genes with cis-eQTL'),
    'signet_CoeffMat0': ('genes', 'genes with cis-eQTL'),
}


# What the counted inputs hold (agent/runtime/signet_jobs.py _COUNTED_INPUTS). The PED file has
# one row per sample; the expression matrix has a gene-ID column, one column per sample, a header
# row, and the 5 HTSeq summary rows that script/gexp_prep/gexp_prep.R drops before filtering genes.
def _input_facts(key, counts):
    rows, columns = counts['rows'], counts['columns']
    if key == 'ped.file':
        return {'samples': rows}
    if key == 'map.file':
        return {'snps': rows}
    if key == 'gexp.file' and rows >= 6 and columns >= 2:
        return {'samples': columns - 1, 'genes_after_dropping_the_last_5_rows': rows - 1 - 5}
    return {}


def label_summary(name, record, summary):
    """Add what rows and columns mean to the counts computed on HPC3."""
    if not summary:
        return {'available': False, 'note': 'Counts could not be computed on HPC3 right now; ask again later.'}
    outputs = []
    for entry in summary.get('outputs', []):
        entry = dict(entry)
        if entry.get('columns') == 1:
            del entry['columns']
        meaning = next((value for key, value in _MEANING.items()
                        if entry['file'] == key or entry['file'].startswith(key + '_')), None)
        if meaning and 'rows' in entry:
            entry['rows_are'] = meaning[0]
            if meaning[1]:
                entry['columns_are'] = meaning[1]
        outputs.append(entry)
    labeled = {'outputs': outputs,
               'inputs': {key: {'file': counts['file'], **_input_facts(key, counts)}
                          for key, counts in summary.get('inputs', {}).items()},
               'scope': 'Counts only, computed on HPC3, where the results stay. Compare inputs with outputs before '
                        'saying anything was removed; files without rows_are are counted but not labeled.'}
    if name not in jobs.DOWNLOADED_STEPS:
        labeled['location'] = 'Counts computed on HPC3; person-level rows are never shared with the model. Existing local archives are preserved.'
    if record.get('progress'):
        labeled['work_units'] = record['progress']
    return labeled


def public_progress(record):
    result = {}
    progress = record.get('progress')
    if not isinstance(progress, dict):
        return result
    for key, value in progress.items():
        if (key in {'imputation', 'expression_outputs', 'variant_filter', 'low_frequency',
                    'rare_variants', 'stage1', 'stage2', 'subnetworks'}
                and isinstance(value, str) and re.fullmatch(r'[0-9]+ [0-9]+', value)):
            done, total = map(int, value.split())
            if 0 <= done <= total and total > 0:
                result[key] = value
    return result


def safe_summary(name, record, summary):
    # Do not trust historical JSON to contain only the current counts schema.
    if not isinstance(summary, dict):
        return {'available': False, 'scope': 'No verified counts are available; raw results remain private.'}
    expected = {path.rsplit('/', 1)[-1] for path in jobs._required(jobs.STEPS[name], record)}
    clean = {'outputs': [], 'inputs': {}}
    for entry in summary.get('outputs', []):
        if not isinstance(entry, dict) or entry.get('file') not in expected:
            continue
        row = {'file': entry['file']}
        if entry.get('available') is False:
            row['available'] = False
        for key in ('rows', 'columns'):
            if type(entry.get(key)) is int and entry[key] >= 0:
                row[key] = entry[key]
        clean['outputs'].append(row)
    for key, entry in summary.get('inputs', {}).items():
        if key not in jobs._COUNTED_INPUTS.get(name, ()) or not isinstance(entry, dict):
            continue
        if all(type(entry.get(field)) is int and entry[field] >= 0 for field in ('rows', 'columns')):
            clean['inputs'][key] = {'file': key, 'rows': entry['rows'], 'columns': entry['columns']}
    result = label_summary(name, {**record, 'progress': public_progress(record)}, clean)
    result['available'] = any('rows' in entry for entry in clean['outputs'])
    if name == 'genotype' and summary.get('reference_preparation'):
        from agent.runtime.jobs.reference_summary import safe_preparation
        result['reference_preparation'] = safe_preparation(summary['reference_preparation'])
    return result


def failure_summary(record):
    """Classify known evidence into fixed explanations; never forward arbitrary log text."""
    result, diagnoses = {}, []
    state = record.get('slurm_state')
    scheduler = {'OUT_OF_MEMORY': 'The scheduler stopped the job because it exceeded its memory allocation.',
                 'TIMEOUT': 'The scheduler stopped the job because it reached its time limit.',
                 'NODE_FAIL': 'The scheduler reported a compute-node failure.',
                 'PREEMPTED': 'The scheduler preempted this job.',
                 'FAILED': 'The scheduler reported that the job failed.',
                 'CANCELLED': 'The scheduler confirmed that the job was cancelled.'}
    if isinstance(state, str) and state.split() and state.split()[0] in scheduler:
        key = state.split()[0]
        diagnoses.append(('scheduler_' + key.lower(), scheduler[key]))
        result['slurm_state'] = key
    patterns = (('completion marker is missing', 'exports_incomplete',
                 'The official visualization export did not record successful completion.'),
                ('cannot open', 'missing_or_unreadable_file', 'A required file could not be opened. Check the selected inputs and earlier-stage outputs.'),
                ('No such file or directory', 'missing_file', 'A required file or directory was not found. Check inputs and earlier-stage outputs.'),
                ('command not found', 'missing_command', 'A required scientific command was unavailable in the execution environment.'),
                ('Execution halted', 'scientific_script_failed', 'The scientific script stopped with an error.'),
                ('Error in ', 'scientific_runtime_error', 'The scientific runtime reported an error. Inspect the private logs in the workspace.'))
    hints = record.get('failure_hints', [])
    if not isinstance(hints, list):
        hints = []
    for pattern, code, message in patterns:
        if any(isinstance(hint, str) and pattern in hint for hint in hints):
            diagnoses.append((code, message))
    code = record.get('exit_code')
    if isinstance(code, str) and re.fullmatch(r'[0-9]+', code):
        result['exit_code'] = code
        if int(code):
            diagnoses.append(('nonzero_exit', 'The scientific command ended with a nonzero exit status.'))
    if record.get('missing_outputs'):
        result['missing_output_count'] = len(record['missing_outputs'])
        diagnoses.append(('missing_outputs', 'The job ended without all required nonempty result files.'))
    if hints:
        result['error_evidence_count'] = len(hints)
    if record.get('state') == 'unknown':
        if isinstance(record.get('job_id'), str) and re.fullmatch(r'[0-9]+', record['job_id']):
            diagnoses.insert(0, ('scheduler_state_unknown', 'The scheduler does not provide a definitive status for the recorded job. Inspect the existing job; do not submit again.'))
        else:
            diagnoses.insert(0, ('submission_unconfirmed', 'Scheduler acceptance is unconfirmed. Use manual submission recovery; do not submit again.'))
    elif record.get('state') == 'cancelled' and not diagnoses:
        diagnoses.append(('cancelled', 'The job was cancelled.'))
    if not diagnoses:
        diagnoses.append(('unclassified_failure', 'The saved evidence does not identify a recognized cause. Inspect the private logs in the workspace.'))
    result['classifications'] = [code for code, _ in diagnoses]
    result['reason'] = diagnoses[0][1]
    result['scope'] = 'Execution diagnostics only. Raw logs, patient identifiers and input paths are not shared with the model.'
    return result


def report(run_id, name):
    record = jobs.status(run_id, name)
    result = {'state': record['state'], 'progress': public_progress(record)}
    if record['state'] == 'completed':
        result['summary'] = safe_summary(name, record, jobs.ensure_summary(run_id, name))
    elif record['state'] in ('failed', 'cancelled', 'unknown'):
        result['failure'] = failure_summary(record)
    return result
