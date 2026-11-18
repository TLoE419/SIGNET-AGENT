"""Bounded, metadata-only chat context; never infer source from a bare run ID."""
import re


def validate(value, history_loader):
    if value is None:
        return None
    fields = {'version', 'dataset_id', 'history_id', 'stage', 'selected_genes'}
    if not isinstance(value, dict) or set(value) != fields or type(value['version']) is not int or value['version'] != 1:
        raise ValueError('Invalid workspace context version or fields.')
    dataset, identity, stage, genes = (value[key] for key in ('dataset_id', 'history_id', 'stage', 'selected_genes'))
    identifier = lambda item: isinstance(item, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,95}', item)
    if dataset is not None and not identifier(dataset) or identity is not None and not identifier(identity):
        raise ValueError('Invalid workspace identity.')
    if type(stage) is not int or not 1 <= stage <= 6:
        raise ValueError('Invalid workspace stage.')
    if not isinstance(genes, list) or len(genes) > 32 or any(not isinstance(gene, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}', gene) for gene in genes) or len(set(genes)) != len(genes):
        raise ValueError('Invalid selected genes.')
    catalog = history_loader()
    if dataset is not None and not any(row['id'] == dataset for row in catalog['datasets']):
        raise ValueError('Unknown workspace dataset.')
    result = dict(value, selected_genes=list(genes))
    if identity is not None:
        row = next((row for row in catalog['runs'] if row.get('history_id') == identity), None)
        if row is None or row.get('dataset_id') != dataset:
            raise ValueError('Workspace history does not belong to this dataset.')
        result.update(source=row['source'], run_id=row['run_id'])
    elif genes:
        raise ValueError('Selected genes require an identified run.')
    return result
