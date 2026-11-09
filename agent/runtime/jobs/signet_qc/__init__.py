"""Publish SIGNET QC artifacts from a compute job or an existing run."""

import json
from pathlib import Path
import tempfile

from . import expression, genotype, pairing


COHORTS = ('TCGA', 'GTEx')
CHECKS = {
    'genotype': {'TCGA': genotype.check_tcga, 'GTEx': genotype.check_gtex},
    'expression': {'TCGA': expression.check_tcga, 'GTEx': expression.check_gtex},
    'pairing': {'TCGA': pairing.check_tcga, 'GTEx': pairing.check_gtex},
}
STEPS = ('genotype', 'expression')
MAX_BYTES = 32 * 1024


def qc_path(run_dir, step):
    return run_dir / 'steps' / f'{step}-qc.json'


def read_summary(stream, step):
    data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('QC file is too large.')
    result = json.loads(data)
    if (not isinstance(result, dict) or result.get('schema_version') != 1
            or result.get('step') != step or result.get('cohort') not in COHORTS):
        raise ValueError('Invalid QC file.')
    return result


def publish(run_dir, step, cohort, *, job_id=None, exit_code=None):
    """Publish a draft envelope. Cohort-specific QC rules are not evaluated yet."""
    if step not in (*STEPS, 'pairing') or cohort not in COHORTS:
        raise ValueError('Unsupported step or cohort.')
    target = qc_path(run_dir, step)
    target.parent.mkdir(exist_ok=True)
    result = {
        'schema_version': 1,
        'step': step,
        'cohort': cohort,
        'qc_status': CHECKS[step][cohort](run_dir),
    }
    if step in STEPS:
        result['execution'] = {'job_id': job_id, 'exit_code': exit_code}
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=target.parent,
                                         prefix=f'.{target.name}.', delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(result, stream, indent=2)
            stream.write('\n')
        temporary.replace(target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return target
