"""What the assistant may know about one SIGNET step: its state, and on failure the end of its logs.

Reads the step record kept by signet_jobs (refreshing it from Slurm at most every 15 s, as the
chat card does). Paths are cut to file names and TCGA barcodes are masked, so neither the
researcher's folders nor case identifiers reach the model. It never submits, cancels or
changes anything.
"""
import re

from agent.runtime import signet_jobs as jobs

FLAGS = {step.flag: name for name, step in jobs.STEPS.items()}
LOG_LINES = 40
_BARCODE = re.compile(r'TCGA-[A-Za-z0-9]{2}-[A-Za-z0-9]{4}(?:-[A-Za-z0-9]{2,5})*')
_PATH = re.compile(r'(?<![\w.~])/(?:[\w.+@-]+/)+([\w.+@-]*)')
_FIELDS = ('state', 'attempt', 'job_id', 'slurm_state', 'exit_code', 'submitted_at', 'finished_at', 'reason',
           'failure_hints', 'missing_outputs', 'progress', 'settings', 'options', 'resources', 'reused_from',
           'clinical')
_NEEDS_LOGS = ('failed', 'cancelled', 'unknown')


# What the rows and columns of each output mean, from the SIGNET scripts that write them
# (geno_prep/combine_geno.sh, gexp_prep/gpos.R, adj/adj_filter.sh, cis-eQTL/combine.sh, network.sh).
_MEANING = {
    'signet_Genotype.sampleID': ('samples', None),
    'signet_Geno': ('samples', 'SNPs'),
    'signet_gexpID': ('samples', None),
    'signet_gexp': ('samples', 'genes'),
    'signet_gene_name': ('genes', None),
    'signet_gene_pos': ('genes', None),
    'signet_new.Geno.map': ('SNPs', None),
    'signet_new.Geno.maf': ('SNPs', None),
    'signet_all.sig.pValue': ('significant gene-SNP pairs', None),
    'signet_net.genename': ('genes', None),
    'signet_net.genepos': ('genes', None),
    'signet_Afreq': ('genes', 'genes'),
    'signet_CoeffMat0': ('genes', 'genes'),
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
    if key == 'gexp.file':
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
        labeled['location'] = 'Person-level results stay on HPC3; nothing of this step was copied to this computer.'
    if record.get('progress'):
        labeled['work_units'] = record['progress']
    return labeled


def redact(value):
    """Mask case IDs and cut absolute paths to their last part, in strings, lists and dicts."""
    if isinstance(value, str):
        return _PATH.sub(lambda match: '…/' + match.group(1), _BARCODE.sub('TCGA-[masked]', value))
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        return {key: redact(item) for key, item in value.items()}
    return value


def report(run_id, step, session=None):
    name = FLAGS.get(step, step)
    jobs._step(name)
    root = jobs._root(run_id)
    owner = jobs.analysis_session(root)
    if session is not None and owner is not None and owner != session:
        raise jobs.StepError('not_found', 'This analysis belongs to another conversation.')
    flag = jobs.STEPS[name].flag
    if name not in jobs.run_records(root):
        return {'status': 'ok', 'run_id': run_id, 'step': name, 'flag': flag, 'state': 'not_started',
                'note': 'This step has not been submitted in this analysis.'}
    record = jobs.status(run_id, name)
    result = {'status': 'ok', 'run_id': run_id, 'step': name, 'flag': flag,
              **{key: record[key] for key in _FIELDS if record.get(key) not in (None, '', [], {})}}
    if record.get('inputs'):
        result['inputs'] = {key: path.rsplit('/', 1)[-1] for key, path in record['inputs'].items()}
    if record.get('connection') == 'interrupted':
        result['connection'] = 'interrupted'
    if record['state'] in _NEEDS_LOGS:
        logs = {}
        for stream in ('err', 'out'):
            try:
                logs[stream] = jobs.read_log(run_id, name, stream=stream, lines=LOG_LINES)['lines']
            except jobs.StepError as error:
                logs[stream] = [f'(log unavailable: {error})']
        result['log_tail'] = logs
    elif record['state'] == 'completed':
        result['summary'] = label_summary(name, record, record.get('summary') or jobs.ensure_summary(run_id, name))
    result['privacy'] = 'Paths are cut to file names and TCGA barcodes are masked.'
    return redact(result)
