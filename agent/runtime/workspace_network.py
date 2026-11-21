"""Read the candidate connections and bootstrap frequencies saved by SIGNET."""

from collections import Counter
from itertools import zip_longest
import math

import agent.tools.signet as signet


def _rows(path):
    with signet._no_links(path).open(encoding='utf-8') as stream:
        for line in stream:
            if not line.strip():
                continue
            values = line.strip().split(',') if ',' in line else line.split()
            row = [float(value) for value in values]
            if not row or not all(map(math.isfinite, row)):
                raise ValueError('The saved network matrix contains invalid values.')
            yield row


def _genes(path):
    genes = []
    with signet._no_links(path).open(encoding='utf-8') as stream:
        for line in stream:
            if not line.strip():
                continue
            row = line.split()
            if (len(row) != 4 or not row[0] or len(row[0]) > 240
                    or int(row[2]) < 0 or int(row[3]) < int(row[2])):
                raise ValueError('The saved network gene positions are invalid.')
            genes.append(row[0])
    if not genes or len(set(genes)) != len(genes):
        raise ValueError('The saved network genes must be present and uniquely identified.')
    return genes


def summary(root, job):
    """Use the official target-row/source-column order without recomputing frequencies."""
    if job.get('state') != 'completed' or job.get('step') != 'network' or job.get('run_id') != root.name:
        raise ValueError('Select a completed network job belonging to this run.')
    directory = root / 'work/res/resn'
    genes = _genes(directory / 'signet_net.genepos')
    matrices = (_rows(directory / 'signet_Afreq'), _rows(directory / 'signet_CoeffMat0'))
    edges, frequencies = [], Counter()
    width, targets = None, 0
    for target, (frequency_row, coefficient_row) in enumerate(zip_longest(*matrices)):
        if frequency_row is None or coefficient_row is None or target >= len(genes):
            raise ValueError('The saved network matrices do not match their gene positions.')
        if width is None:
            width = len(frequency_row)
        if not 0 < width <= len(genes) or len(frequency_row) != width or len(coefficient_row) != width:
            raise ValueError('The saved network matrix dimensions do not agree.')
        for source, frequency in enumerate(frequency_row):
            if not 0 <= frequency <= 1:
                raise ValueError('The saved bootstrap frequencies must be between zero and one.')
            if frequency > 0:
                edges.append({'source': genes[source], 'target': genes[target], 'frequency': frequency})
                frequencies[frequency] += 1
        targets += 1
    if targets != len(genes):
        raise ValueError('The saved network matrices do not contain one target row per gene.')
    return {'genes': len(genes),
            'frequencies': [{'frequency': frequency, 'count': frequencies[frequency]}
                            for frequency in sorted(frequencies)],
            'edges': edges}
