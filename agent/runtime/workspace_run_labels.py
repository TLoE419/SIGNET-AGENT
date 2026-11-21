"""Derive rerun-family labels from explicit live dataset provenance, without changing records."""
from collections import Counter, defaultdict
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import re

STEPS = ('genotype', 'expression', 'adjust', 'cis', 'network', 'visualize')
_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}')
_NUMBER = re.compile(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?')


def _created(row):
    value = row.get('rerun', {}).get('created_at')
    if not isinstance(value, str):
        return None
    try:
        date = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return date.replace(tzinfo=timezone.utc).timestamp() if date.tzinfo is None else date.timestamp()
    except (ValueError, OverflowError):
        return None


def _equal(before, after):
    if isinstance(before, bool) or isinstance(after, bool):
        return type(before) is type(after) and before == after
    if all(isinstance(value, (int, float, str)) and _NUMBER.fullmatch(str(value)) for value in (before, after)):
        try:
            return Decimal(str(before)) == Decimal(str(after))
        except InvalidOperation:
            pass
    return before == after


def _groups(row, step):
    records = row.get('jobs')
    job = records.get(step) if isinstance(records, dict) else None
    plan = row.get('rerun')
    if not isinstance(plan, dict):
        plan = {}
    reviewed = plan.get('parameters') if plan.get('step') == step else None

    def known(value):
        if not isinstance(value, dict):
            return {}
        # Empty placeholder groups cannot prove that a research parameter was removed.
        result = {group: value[group] for group in ('settings', 'resources', 'options')
                  if isinstance(value.get(group), dict) and value[group]}
        clinical = value.get('clinical')
        if isinstance(clinical, dict) and isinstance(clinical.get('choices'), dict):
            result['clinical_choices'] = clinical['choices']
        return result

    result = known(job)
    if not result or isinstance(job, dict) and job.get('state') == 'not_submitted':
        for group, values in known(reviewed).items():
            result.setdefault(group, values)
    return result or None


def _changes(parent, child, step):
    before, after = _groups(parent, step), _groups(child, step)
    if before is None or after is None:
        return [], False
    result = []
    for group in ('settings', 'resources', 'options', 'clinical_choices'):
        if group not in before or group not in after:
            continue
        old, new = before[group], after[group]
        for key in sorted(old.keys() | new.keys()):
            if key not in old or key not in new or not _equal(old[key], new[key]):
                result.append({'group': group, 'key': key, 'before': deepcopy(old.get(key)),
                               'after': deepcopy(new.get(key))})
    return result, True


def enrich_rows(rows):
    """Add family metadata only when the full origin chain stays in one unambiguous live dataset.

    Numbers follow ancestor order, then creation time and run ID. Tied/unknown sibling creation
    times do not establish a unique latest fork. No conversation binding or directory-name guess
    participates in family membership.
    """
    result = [dict(row) for row in rows]
    for row in result:
        row.pop('rerun_family', None)
    candidates = [row for row in result if row.get('source') == 'live'
                  and isinstance(row.get('dataset_id'), str) and row['dataset_id']
                  and isinstance(row.get('run_id'), str) and _NAME.fullmatch(row['run_id'])]
    key_for = lambda row: (row['dataset_id'], row['run_id'])
    occurrences = Counter(key_for(row) for row in candidates)
    indexed = {key_for(row): row for row in candidates if occurrences[key_for(row)] == 1}
    parents = {}
    invalid = set()
    for key, row in indexed.items():
        origin = row.get('rerun')
        if origin is None:
            parents[key] = None
        elif (isinstance(origin, dict) and isinstance(origin.get('source_run_id'), str)
              and _NAME.fullmatch(origin['source_run_id']) and origin.get('step') in STEPS):
            parent = (key[0], origin['source_run_id'])
            if parent in indexed:
                parents[key] = parent
            else:
                invalid.add(key)
        else:
            invalid.add(key)
    families = defaultdict(list)
    for key in indexed:
        visited, current = set(), key
        while current is not None and current not in visited and current not in invalid:
            visited.add(current)
            parent = parents.get(current)
            if parent is None:
                families[current].append(key)
                break
            current = parent
    for root, members in families.items():
        ordered, pending = [root], set(members) - {root}
        while pending:
            ready = [key for key in pending if parents[key] in ordered]
            key = min(ready, key=lambda key: (_created(indexed[key]) or 0, key[1]))
            ordered.append(key)
            pending.remove(key)
        ancestors = {parents[key] for key in members if parents[key] is not None}
        leaves = [key for key in members if key not in ancestors]
        latest = leaves[0] if len(leaves) == 1 else None
        if len(leaves) > 1 and all(_created(indexed[key]) is not None for key in leaves):
            maximum = max(_created(indexed[key]) for key in leaves)
            newest = [key for key in leaves if _created(indexed[key]) == maximum]
            latest = newest[0] if len(newest) == 1 else None
        for number, key in enumerate(ordered):
            row, parent = indexed[key], parents[key]
            step = row['rerun']['step'] if parent else None
            changes, available = _changes(indexed[parent], row, step) if parent else ([], True)
            row['rerun_family'] = {'root_run': root[1], 'number': number, 'latest': key == latest,
                                   'source_run': parent[1] if parent else None, 'from_step': step,
                                   'changes': changes, 'changes_available': available}
    return result
