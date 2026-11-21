"""Read a completed workspace adjustment from the files collected with that job."""

import csv
import math
from statistics import median, stdev

from agent.runtime import workspace_genotype
import agent.tools.signet as signet


def _lines(path):
    with signet._no_links(path).open(encoding='utf-8') as stream:
        return [line.strip() for line in stream if line.strip()]


def _matrix(path):
    rows = [[float(value) for value in line.split()] for line in _lines(path)]
    if (not rows or not rows[0] or any(len(row) != len(rows[0]) for row in rows)
            or any(not math.isfinite(value) for row in rows for value in row)):
        raise ValueError('The adjustment output has invalid matrix values or dimensions.')
    return rows


def _clinical(path):
    with signet._no_links(path).open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream, delimiter='\t')
        if not reader.fieldnames or any(reader.fieldnames.count(key) != 1 for key in ('submitter_id', 'race', 'gender')):
            raise ValueError('The saved clinical file does not identify the adjustment covariates.')
        patients = {}
        for row in reader:
            parts = (row.get('submitter_id') or '').split('-')
            if len(parts) >= 3:
                patients.setdefault(parts[2], row)
    return patients


def _pca(directory):
    scores = {}
    for line in _lines(directory / 'workspace-pca.evec'):
        if line.startswith('#'):
            continue
        row = line.split()
        if len(row) < 3 or row[0] in scores:
            raise ValueError('The saved principal component scores do not uniquely identify samples.')
        point = [float(value) for value in row[1:3]]
        if not all(map(math.isfinite, point)):
            raise ValueError('The saved principal component scores are not finite.')
        scores[row[0]] = point
    eigenvalues = [float(line) for line in _lines(directory / 'workspace-pca.eval')]
    total = sum(eigenvalues)
    if (len(eigenvalues) < 2 or not all(math.isfinite(value) and value >= 0 for value in eigenvalues)
            or not math.isfinite(total) or total <= 0):
        raise ValueError('The saved principal component eigenvalues are invalid.')
    return scores, [100 * (value / total) for value in eigenvalues[:2]]


def _median_sd(rows):
    return median(stdev(column) for column in zip(*rows))


def _genotype_width(directory, retained, matched):
    """Verify the final genotype rows against the matched rows without loading both matrices."""
    expected = iter(retained)
    next_index = next(expected, None)
    rows, width = 0, None
    with signet._no_links(directory / 'signet_new.Geno').open(encoding='utf-8') as before, \
            signet._no_links(directory / 'signet_geno.data').open(encoding='utf-8') as after:
        final_rows = (line for line in after if line.strip())
        for line in before:
            if not line.strip():
                continue
            row = [float(value) for value in line.split()]
            if width is None:
                width = len(row)
            if not width or len(row) != width or not all(map(math.isfinite, row)):
                raise ValueError('The saved genotype matrix has invalid values or dimensions.')
            if rows == next_index:
                final = next(final_rows, '').split()
                if row != [float(value) for value in final]:
                    raise ValueError('The final genotype rows do not match the retained individuals.')
                next_index = next(expected, None)
            rows += 1
        if rows != matched or next_index is not None or next(final_rows, None) is not None:
            raise ValueError('The saved genotype rows do not match the adjustment sample counts.')
    return width


def _local_completed_result(run_id):
    root = signet._run(run_id)
    history = workspace_genotype.run_history(root)
    job = history['jobs']['adjust']
    npc = job.get('options', {}).get('npc')
    if job['state'] != 'completed' or type(npc) is not int or not 0 <= npc <= 10:
        raise ValueError('Select a completed adjustment with its recorded principal component count.')

    directory = root / 'work/res/resa'
    matched_ids = _lines(directory / 'workspace-genotype-ids.txt')
    shortened = [sample[:12] for sample in matched_ids]
    if (not matched_ids or len(set(shortened)) != len(shortened)
            or any(len(sample.split('-')) < 3 or len(sample.split()) != 1 for sample in matched_ids)):
        raise ValueError('Matched adjustment samples are not uniquely identified.')
    scores, variance = _pca(directory)
    clinical = _clinical(directory / 'workspace-clinical.tsv')
    retained = []
    for index, sample in enumerate(matched_ids):
        if sample[:12] not in scores:
            continue
        parts = sample.split('-')
        if len(parts) < 3 or parts[2] not in clinical:
            raise ValueError('A retained adjustment sample has no saved clinical row.')
        row = clinical[parts[2]]
        if row['race'] != 'american indian or alaska native':
            if not row['race'] or not row['gender']:
                raise ValueError('A retained adjustment sample has incomplete clinical covariates.')
            retained.append(index)

    before = _matrix(directory / 'signet_matched.gexp')
    covariates = _matrix(directory / 'signet_gexp.data')
    after = _matrix(directory / 'signet_gexp_rmpc.data')
    if (len(before) != len(matched_ids) or any(len(matrix) != len(retained) for matrix in (covariates, after))
            or len(before[0]) != len(covariates[0]) or len(before[0]) != len(after[0])):
        raise ValueError('Saved adjustment rows do not match the retained individuals.')
    variants = _genotype_width(directory, retained, len(matched_ids))
    if (len(_lines(directory / 'signet_new.Geno.map')) != variants
            or len(_lines(root / 'work/res/rest/signet_gene_name')) != len(after[0])):
        raise ValueError('The adjustment matrices do not match their variant or gene identifiers.')

    initial_genotype = _lines(root / 'work/res/resg/signet_Genotype.sampleID')
    initial_expression = _lines(root / 'work/res/rest/signet_gexpID')
    if len(matched_ids) > min(len(initial_genotype), len(initial_expression)):
        raise ValueError('The matched sample count exceeds the recorded inputs.')
    initial_ids = set(initial_genotype)
    expression_patients = {sample.split('-')[2] for sample in initial_expression if len(sample.split('-')) >= 3}
    if any(sample not in initial_ids or sample.split('-')[2] not in expression_patients for sample in matched_ids):
        raise ValueError('Matched samples do not belong to the original genotype results.')

    comparison = None
    if len(retained) > 1:
        comparison = {'before_sd': _median_sd([before[index] for index in retained]),
                      'covariates_sd': _median_sd(covariates), 'after_sd': _median_sd(after)}
    return {'run_id': run_id, 'npc': npc, 'job': job,
            'matching': {'genotype': len(initial_genotype), 'expression': len(initial_expression),
                         'matched': len(matched_ids), 'retained': len(retained),
                         'excluded': len(matched_ids) - len(retained),
                         'variants': variants, 'genes': len(after[0])},
            'pca': {'points': [scores[shortened[index]] for index in retained],
                    'variance_explained': variance, 'source': 'signet_smartpca'},
            'comparison': comparison}


def completed_result(run_id):
    root = signet._run(run_id)
    if workspace_genotype.run_history(root)['jobs']['adjust'].get('remote_outputs'):
        from agent.runtime import workspace_projection
        return workspace_projection.completed_result(run_id, '3')
    return _local_completed_result(run_id)
