"""Read saved cis-eQTL associations using the indices written by SIGNET."""

import math

import agent.tools.signet as signet


def _matrix_shape(path):
    rows, width = 0, None
    with signet._no_links(path).open(encoding='utf-8') as stream:
        for line in stream:
            values = line.split()
            if not values:
                continue
            if width is None:
                width = len(values)
            if len(values) != width or any(not math.isfinite(float(value)) for value in values):
                raise ValueError('The saved cis-eQTL matrix has invalid values or dimensions.')
            rows += 1
    return rows, width or 0


def summary(root, job):
    """Read local outputs, retaining every association and category-local IV index."""
    if job.get('state') != 'completed' or job.get('step') != 'cis' or job.get('run_id') != root.name:
        raise ValueError('Select a completed cis-eQTL job belonging to this run.')
    alpha_text = job['settings']['alpha.cis']
    alpha = float(alpha_text)
    if isinstance(alpha_text, bool) or not math.isfinite(alpha) or not 0 < alpha <= 1:
        raise ValueError('The saved cis-eQTL threshold is invalid.')
    relative = f'res/resc/signet_all.sig.pValue_{alpha_text}'
    if 'required_outputs' in job and relative not in job['required_outputs']:
        raise ValueError('The saved cis-eQTL output does not match its submitted threshold.')
    directory = root / 'work/res/resc'
    with signet._no_links(directory / 'signet_net.genename').open(encoding='utf-8') as stream:
        names = [line.strip() for line in stream if line.strip()]
    if not names or any(len(name) > 240 for name in names):
        raise ValueError('The saved cis-eQTL gene names are missing or invalid.')
    samples, genes = _matrix_shape(directory / 'signet_net.gexp.data')
    if not samples or genes != len(names):
        raise ValueError('The saved cis-eQTL expression matrix does not match its gene names.')

    categories, total = [], 0
    for category in ('common', 'low', 'rare'):
        rows, width = _matrix_shape(directory / f'signet_{category}.eQTL.data')
        if width and rows != samples:
            raise ValueError('The saved cis-eQTL matrices have different sample counts.')
        categories.append((category, total, total + width))
        total += width
    rows, width = _matrix_shape(directory / 'signet_all.eQTL.data')
    if width != total or width and rows != samples:
        raise ValueError('The saved cis-eQTL category matrices do not match the combined matrix.')

    counts = dict.fromkeys(('common', 'low', 'rare'), 0)
    pairs, associated_genes, used_columns, seen = [], set(), set(), set()
    with signet._no_links(root / 'work' / relative).open(encoding='utf-8') as stream:
        for line in stream:
            fields = line.split()
            if not fields:
                continue
            if len(fields) != 3:
                raise ValueError('The saved cis-eQTL association must contain gene, variant and p-value.')
            gene, variant = int(fields[0]), int(fields[1])
            p_value = float(fields[2])
            if (not 1 <= gene <= len(names) or not 1 <= variant <= total
                    or not math.isfinite(p_value) or not 0 <= p_value < alpha
                    or (gene, variant) in seen):
                raise ValueError('The saved cis-eQTL association has invalid indices or significance.')
            category, start, _ = next(entry for entry in categories if entry[1] < variant <= entry[2])
            counts[category] += 1
            pairs.append({'gene': names[gene - 1], 'variant': str(variant - start),
                          'category': category, 'p_value': p_value})
            associated_genes.add(gene)
            used_columns.add(variant)
            seen.add((gene, variant))
    if len(used_columns) != total:
        raise ValueError('The saved cis-eQTL association list does not cover its instrument matrix.')
    return {'genes': len(associated_genes), 'counts': counts, 'pairs': pairs}
