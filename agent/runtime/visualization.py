"""Reading SIGNET -v exports for the results card: the network edges and the count-vs-frequency counts."""
import csv
import math
from pathlib import Path


def read_graph(path, top_networks):
    edges = []
    with path.open() as stream:
        for row in csv.DictReader(stream):
            source, target = row['source_gene_symbol'], row['target_gene_symbol']
            freq, coef = float(row['frequency']), float(row['coefficient'])
            if not source or not target or not 0 <= freq <= 1 or not math.isfinite(coef):
                raise ValueError('Invalid exported edge.')
            edges.append({'source': source, 'target': target, 'frequency': freq, 'coefficient': coef})
    if not edges:
        raise ValueError('The exported network has no edges.')
    neighbors = {}
    for edge in edges:
        a, b = edge['source'], edge['target']
        neighbors.setdefault(a, set()).add(b)
        neighbors.setdefault(b, set()).add(a)
    seen, groups = set(), []
    for node in sorted(neighbors):
        if node in seen:
            continue
        stack, group = [node], set()
        while stack:
            current = stack.pop()
            if current not in group:
                group.add(current)
                stack.extend(neighbors[current] - group)
        seen.update(group)
        groups.append(group)
    group_by_node = {node: index for index, group in enumerate(groups) for node in group}
    edge_counts = [0] * len(groups)
    for edge in edges:
        edge_counts[group_by_node[edge['source']]] += 1
    groups = [groups[index] for index in sorted(range(len(groups)),
              key=lambda index: (-edge_counts[index], min(groups[index])))]
    selected = set().union(*groups[:top_networks]) if groups else set()
    return {'nodes': sorted(neighbors), 'edges': edges,
            'display_nodes': sorted(selected),
            'counts': {'connections': len(edges), 'genes': len(neighbors), 'subnetworks': len(groups),
                       'displayed': min(top_networks, len(groups))}}


SIGNET_CUTOFFS = (0.8, 0.85, 0.9, 0.95, 1)   # netvis/extract_edges.R


def threshold_counts(path):
    """Genes and connections kept at each cutoff of SIGNET's signet_count_vs_freq plot, counted
    as netvis/extract_edges.R does: a connection is kept when Afreq > cutoff - eps, and a gene is
    any row or column index of a kept connection."""
    rows = []
    for line in Path(path).read_text().splitlines():
        if line.strip():
            row = [float(value) for value in line.replace(',', ' ').split()]
            if not all(math.isfinite(value) and 0 <= value <= 1 for value in row):
                raise ValueError('Bootstrap frequencies must be between zero and one.')
            rows.append(row)
    if not rows or len({len(row) for row in rows}) != 1:
        raise ValueError('The frequency matrix must be rectangular.')
    eps = 2.220446049250313e-16
    counts = []
    for cutoff in SIGNET_CUTOFFS:
        kept = [(i, j) for i, row in enumerate(rows) for j, value in enumerate(row) if value > cutoff - eps]
        genes = {i for i, _ in kept} | {j for _, j in kept}
        counts.append({'cutoff': cutoff, 'connections': len(kept), 'genes': len(genes)})
    return counts


INPUT_KEYS = ('Afreq', 'coef', 'vis.genepos')


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
