"""Structured model reports: counts and execution metadata, never person-level rows or raw logs."""
import re
from agent.runtime import signet_jobs as jobs

INPUT_ISSUE_CODES = frozenset({
    'unsupported_path', 'unavailable_file', 'file_limit', 'file_changed', 'time_limit',
    'scan_limit', 'text_encoding', 'binary_input', 'genotype_layout', 'inconsistent_columns',
    'map_coordinates', 'ped_metadata', 'empty_table', 'genotype_roles', 'expression_header',
    'expression_columns', 'expression_values', 'duplicate_gene', 'expression_rows',
    'duplicate_sample', 'clinical_columns', 'clinical_width', 'clinical_identifier',
    'clinical_rows', 'file_count', 'absolute_remote_path', 'unreadable_table',
    'ped_map_markers', 'genotype_compatibility', 'expression_scale',
    'duplicate_clinical_patient', 'sample_identifier', 'no_overlap', 'clinical_coverage',
    'unmatched_samples', 'ambiguous_patient', 'missing_covariates', 'adjustment_groups',
    'blocked_by_paths', 'clinical_pairing_empty', 'clinical_race_choice_required',
    'clinical_missing_race', 'clinical_missing_gender', 'clinical_race_groups',
    'clinical_gender_groups', 'clinical_choices', 'input_freeze',
    'stage_input_review_required', 'unclassified_input_issue',
})

FAILURE_CODES = frozenset({
    'scheduler_out_of_memory', 'scheduler_timeout', 'scheduler_node_fail',
    'scheduler_preempted', 'scheduler_failed', 'scheduler_cancelled',
    'exports_incomplete', 'missing_or_unreadable_file', 'missing_file', 'missing_command',
    'classification_count_mismatch', 'insufficient_covariate_groups', 'invalid_numeric_values',
    'matrix_shape_mismatch', 'resource_memory_limit', 'scientific_script_failed',
    'scientific_runtime_error', 'nonzero_exit', 'missing_outputs', 'scheduler_state_unknown',
    'submission_unconfirmed', 'cancelled', 'unclassified_failure',
})


def _counts(value, allowed):
    if not isinstance(value, dict):
        return {}
    return {key: value[key] for key in allowed
            if type(value.get(key)) is int and 0 <= value[key] <= 2 ** 53 - 1}


def _input_issues(values, stage):
    result = []
    for value in values[:64] if isinstance(values, list) else []:
        if not isinstance(value, dict):
            continue
        code = value.get('code')
        result.append({'code': code if isinstance(code, str) and code in INPUT_ISSUE_CODES else 'unclassified_input_issue',
                       'stage': stage,
                       'severity': value.get('severity') if value.get('severity') in
                       ('warning', 'needs_review', 'error') else 'error',
                       **_counts(value, ('count',))})
    return result


def safe_input_validation(report):
    """Project the private dataset review into fixed labels and numeric statistics."""
    if not isinstance(report, dict):
        return {'available': False}
    statuses = ('passed', 'warning', 'failed', 'incomplete', 'unchecked')
    result = {'available': True, 'scope': 'preliminary_before_qc',
              'status': report.get('status') if report.get('status') in statuses else 'unchecked',
              'checks': [], 'stage_readiness': {}}
    metrics = ('rows', 'columns', 'samples', 'genes', 'markers', 'patients', 'ped_markers',
               'duplicate_sample_ids', 'duplicate_patients', 'fid_iid_mismatches',
               'missing_race', 'missing_gender')
    for check in report.get('checks', []) if isinstance(report.get('checks'), list) else []:
        if not isinstance(check, dict) or check.get('kind') not in ('genotype', 'expression', 'clinical'):
            continue
        stage = ('genotype', 'expression', 'clinical').index(check['kind']) + 1
        result['checks'].append({'kind': check['kind'],
            'status': check.get('status') if check.get('status') in statuses else 'unchecked',
            'metrics': _counts(check.get('metrics'), metrics),
            'issues': _input_issues(check.get('issues'), stage)})
    pairing = report.get('pairing')
    if isinstance(pairing, dict):
        result['pairing'] = {**_counts(pairing, ('genotype_patients', 'expression_patients',
            'matched_patients', 'clinical_matched', 'unmatched_genotype', 'unmatched_expression',
            'missing_race', 'missing_gender', 'race_groups', 'gender_groups')),
            'status': pairing.get('status') if pairing.get('status') in statuses else 'unchecked',
            'issues': _input_issues(pairing.get('issues'), 3)}
    readiness = report.get('stage_readiness')
    for stage in ('1', '2', '3'):
        value = readiness.get(stage) if isinstance(readiness, dict) else None
        if isinstance(value, dict):
            result['stage_readiness'][stage] = {
                'status': value.get('status') if value.get('status') in
                ('ready', 'needs_review', 'blocked', 'incomplete') else 'incomplete',
                'issues': _input_issues(value.get('issues'), int(stage))}
    return result


def safe_clinical_review(review):
    """Keep patient identities, source category labels and private issue text in the UI."""
    if not isinstance(review, dict):
        return {'available': False}
    result = {'available': True, **_counts(review, ('rows', 'matched', 'clinical_matched',
              'missing_gender', 'missing_race', 'retained', 'excluded')), 'diagnostics': []}
    columns = review.get('columns')
    if review.get('schema_valid') is False or (
            isinstance(columns, list) and any(columns.count(key) != 1 for key in ('submitter_id', 'race', 'gender'))):
        # The checker returns before measuring coverage or covariates when columns are invalid.
        return {'available': True, **_counts(review, ('rows', 'matched')),
                'diagnostics': [{'code': 'clinical_columns', 'stage': 3, 'severity': 'error'}]}
    counts = review.get('unrecognized_race')
    counts = counts if isinstance(counts, dict) else {}
    numeric = _counts(counts, counts)
    needed = review.get('needs_choice')
    needed = needed if isinstance(needed, list) else []
    result.update(unknown_race_count=sum(numeric.values()), needs_choice_count=len(needed),
                  unhandled_race_count=sum(count for label, count in numeric.items() if label in needed))
    groups = _counts(review, ('gender_groups',))
    if groups:
        result['gender_group_count'] = groups['gender_groups']

    def add(code, count=None, severity='error'):
        result['diagnostics'].append({'code': code, 'stage': 3, 'severity': severity,
                                      **({'count': count} if count is not None else {})})

    if result.get('matched') == 0:
        add('clinical_pairing_empty', 0)
    if ('matched' in result and 'clinical_matched' in result
            and result['clinical_matched'] < result['matched']):
        add('clinical_coverage', result['matched'] - result['clinical_matched'])
    if needed:
        add('clinical_race_choice_required', result['unhandled_race_count'], 'needs_review')
    for field in ('missing_race', 'missing_gender'):
        if result.get(field):
            add('clinical_' + field, result[field])
    after = review.get('races_after')
    if (not needed and isinstance(after, dict) and columns is not None
            and set(after) != {'asian', 'black or african american', 'white'}):
        add('clinical_race_groups')
    if result.get('gender_group_count', 2) < 2:
        add('clinical_gender_groups')
    if review.get('issues') and not result['diagnostics']:
        add('stage_input_review_required')
    return result

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
        if 'rows_are' in entry:
            outputs.append(entry)
            continue
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
        if (key in {'preparation', 'imputation', 'expression_outputs', 'variant_filter', 'low_frequency',
                    'rare_variants', 'stage1', 'stage2', 'subnetworks'}
                and isinstance(value, str) and re.fullmatch(r'[0-9]+ [0-9]+', value)):
            done, total = map(int, value.split())
            if 0 <= done <= total and total > 0:
                result[key] = value
    return result


def _visualize_output(entry):
    """Stage 6 line counts mean something only for its tables; figures are just present."""
    file, rows = entry['file'], entry.get('rows')
    if type(rows) is not int or rows < 0:
        return {}
    if file == 'signet-edges.csv' or file.startswith('signet_edgelist_'):
        return {'rows': max(rows - 1, 0), 'rows_are': 'regulatory edges'}   # minus the header row
    if file.endswith('_name.txt'):
        return {'rows': rows, 'rows_are': 'genes in the subnetwork'}
    return {'available': True}


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
        if name == 'visualize':
            row.update(_visualize_output(entry))
            clean['outputs'].append(row)
            continue
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


_SAMPLE_ID = re.compile(r'\b(?:TCGA-[A-Za-z0-9]{2}-[A-Za-z0-9]{4}|GTEX-[A-Za-z0-9]{4,6})[A-Za-z0-9-]*', re.IGNORECASE)
_PATH = re.compile(r'(?:/[^\s/:\'"()]+){2,}/?')


def mask_log_line(line):
    """A log line for the model: sample IDs and folder paths removed, length bounded."""
    line = _SAMPLE_ID.sub('[sample ID]', line)
    line = _PATH.sub(lambda match: '.../' + match.group(0).rstrip('/').rsplit('/', 1)[-1], line)
    return ''.join(char if char.isprintable() else ' ' for char in line).strip()[:240]


def _megabytes(value):
    match = re.fullmatch(r'([0-9.]+)([KMGT]?)[nc]?', value or '')
    if not match:
        return None
    scale = {'': 1 / 1024 / 1024, 'K': 1 / 1024, 'M': 1, 'G': 1024, 'T': 1024 * 1024}[match[2]]
    return round(float(match[1]) * scale, 1)


def parse_accounting(text):
    """sacct JobID|State|ExitCode|Elapsed|MaxRSS|ReqMem|NodeList rows: the job line and its batch step."""
    rows = [line.split('|') for line in (text or '').split(';') if line.count('|') == 6]
    job = next((row for row in rows if '.' not in row[0]), None)
    if not job:
        return None
    result = {'state': job[1].split(' ')[0], 'exit_code': job[2], 'elapsed': job[3]}
    requested = _megabytes(job[5])
    if requested is not None:
        result['requested_mem_gb'] = round(requested / 1024, 1)
    used = [_megabytes(row[4]) for row in rows if row[4]]
    used = [value for value in used if value is not None]
    if used:
        result['max_memory_mb'] = max(used)
    if re.fullmatch(r'[A-Za-z0-9-]{1,40}', job[6] or ''):
        result['node'] = job[6]
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
                ('number of levels differs', 'classification_count_mismatch',
                 'A categorical variable has an unexpected number of levels. Review the stage inputs; the message alone does not identify the variable or affected patients.'),
                ('contrasts can be applied only to factors with 2 or more levels', 'insufficient_covariate_groups',
                 'A model factor has fewer than two levels. Review covariate groups among the retained samples.'),
                ('NA/NaN/Inf', 'invalid_numeric_values',
                 'The scientific runtime encountered missing or nonfinite numeric values. Inspect the private diagnostic evidence.'),
                ('non-conformable arguments', 'matrix_shape_mismatch',
                 'The scientific runtime reported incompatible matrix dimensions. Review upstream matching and private diagnostics.'),
                ('cannot allocate vector', 'resource_memory_limit',
                 'The scientific runtime could not allocate memory. Review its resource allocation and private diagnostics.'),
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
    result['evidence'] = 'unclassified' if result['classifications'] == ['unclassified_failure'] else 'recognized_execution_evidence'
    result['next_action'] = 'inspect_private_diagnostics'
    if isinstance(record.get('accounting'), dict):
        result['accounting'] = record['accounting']
    if isinstance(record.get('log_tail'), list):
        result['log_tail'] = [mask_log_line(line) for line in record['log_tail'] if isinstance(line, str)][-40:]
    result['reason'] = diagnoses[0][1]
    result['scope'] = ('Execution diagnostics: Slurm accounting and the last log lines with sample IDs and folder paths '
                       'removed. Patient identifiers and input paths are not shared with the model.')
    return result


def report(run_id, step, session=None):
    name = FLAGS.get(step, step)
    jobs._step(name)
    root = jobs._root(run_id)
    owner = jobs.analysis_session(root)
    if session is not None and owner is not None and owner != session:
        raise jobs.StepError('not_found', 'This analysis belongs to another conversation.')
    flag = jobs.STEPS[name].flag
    card = _card(root, name)
    if name not in jobs.run_records(root):
        result = {'status': 'ok', 'run_id': run_id, 'step': name, 'flag': flag, 'state': 'not_started',
                  'note': 'This step has not been submitted in this analysis.'}
        return {**result, 'card': {'state': card['state']}} if card and 'state' in card else result
    record = jobs.status(run_id, name)
    result = {'status': 'ok', 'run_id': run_id, 'step': name, 'flag': flag,
              'state': record['state'], 'progress': public_progress(record)}
    if card:
        result['card'] = {'state': card['state']} if 'state' in card else {}
    if record.get('connection') == 'interrupted':
        result['connection'] = 'interrupted'
    if record['state'] in ('failed', 'cancelled', 'unknown'):
        result['failure'] = failure_summary(record)
    elif record['state'] == 'completed':
        current = record.get('summary') if record.get('summary', {}).get('version') == jobs.SUMMARY_VERSION else None
        result['summary'] = safe_summary(name, record, current or jobs.ensure_summary(run_id, name))
    return result

FLAGS = {step.flag: name for name, step in jobs.STEPS.items()}

def _card(root, name):
    """The step's latest confirmation card: its state and, if sending failed, why."""
    from agent.runtime import step_proposal
    proposal = step_proposal.view(root, name)
    if not proposal:
        return None
    return {key: proposal[key] for key in ('state', 'error') if key in proposal}
