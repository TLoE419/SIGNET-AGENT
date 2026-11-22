"""One conversation holds one analysis: the run it started, plus the reruns made from it.

Reruns keep the original untouched and get their own run folder, so a conversation can compare
settings or input files. This module numbers them in the order they were made, says what each one
changed, and names the latest run, for the chat cards, the Workflow panel and the assistant.
"""
from agent.runtime import signet_jobs as jobs
from agent.tools import signet

_GROUPS = ('settings', 'options', 'inputs')


def _runs_of(session):
    folder = signet.PROJECT / 'runs'
    for path in sorted(folder.iterdir() if folder.is_dir() else (), key=lambda item: item.name):
        if path.is_dir() and not path.is_symlink() and jobs.analysis_session(path) == session:
            yield path


def original(session, ignore=None):
    """The run this conversation started, if any (reruns do not count)."""
    for root in _runs_of(session):
        if root.name != ignore and not (root / 'rerun.json').is_file():
            return root.name
    return None


def _shown(value, other):
    """Input paths are shown by file name, with the folder only when the names alone are equal."""
    if not isinstance(value, str) or '/' not in value:
        return value
    parts = value.split('/')
    if isinstance(other, str) and other.split('/')[-1] == parts[-1]:
        return '/'.join(parts[-2:])
    return parts[-1]


def changes(root):
    """What the rerun's first stage changed compared with the run it was made from."""
    origin = jobs._rerun_origin(root)
    if not origin:
        return []
    step = origin['from_step']
    after = jobs.run_records(root).get(step) or {}
    try:
        before = jobs.run_records(root.parent / origin['source_run']).get(step) or {}
    except OSError:
        return []
    found = []
    old_clinical, new_clinical = before.get('clinical') or {}, after.get('clinical') or {}
    for group in _GROUPS:
        old, new = dict(before.get(group) or {}), dict(after.get(group) or {})
        if group == 'inputs' and (old_clinical or new_clinical):
            # -a reads a copy kept in each run's own folder; compare the researcher's table instead.
            old['cli.file'], new['cli.file'] = old_clinical.get('source'), new_clinical.get('source')
        for key in sorted(set(old) | set(new)):
            if str(old.get(key)) != str(new.get(key)):
                found.append({'group': group, 'key': key, 'before': _shown(old.get(key), new.get(key)),
                              'after': _shown(new.get(key), old.get(key))})
    if (old_clinical.get('choices') or {}) != (new_clinical.get('choices') or {}):
        found.append({'group': 'clinical', 'key': 'choices', 'before': old_clinical.get('choices') or {},
                      'after': new_clinical.get('choices') or {}})
    return found


def labels(session):
    """{run_id: {'number': 0 for the original, then 1, 2, ... in the order the reruns were made,
    'from_step', 'changes', 'latest'}} for every run of this conversation."""
    runs = list(_runs_of(session))
    reruns = sorted((root for root in runs if (root / 'rerun.json').is_file()),
                    key=lambda root: ((root / 'rerun.json').stat().st_mtime, root.name))
    result = {}
    for root in runs:
        if root not in reruns:
            result[root.name] = {'number': 0}
    for number, root in enumerate(reruns, 1):
        origin = jobs._rerun_origin(root)
        result[root.name] = {'number': number, 'source_run': origin.get('source_run'),
                             'from_step': origin.get('from_step'), 'changes': changes(root)}
    latest = reruns[-1].name if reruns else original(session)
    if latest in result:
        result[latest]['latest'] = True
    return result


def describe(session):
    """A short note for the assistant: this conversation's runs and which one to use by default."""
    found = labels(session)
    if not found:
        return ''
    lines = []
    for run_id, label in sorted(found.items(), key=lambda item: item[1]['number']):
        if label['number'] == 0:
            text = f'{run_id}: original analysis'
        else:
            flag = jobs.STEPS[label['from_step']].flag if label.get('from_step') in jobs.STEPS else '?'
            changed = '; '.join(f"{item['key']} {item['before']} -> {item['after']}" for item in label['changes'])
            text = (f"{run_id}: rerun {label['number']} of {label['source_run']} from {flag}"
                    + (f' (changed {changed})' if changed else ''))
        lines.append(text + (' [latest]' if label.get('latest') else ''))
    return ('This conversation holds one analysis and its reruns: ' + ' | '.join(lines)
            + '. When the researcher does not name a run, use the [latest] one and say which run you used. '
            'A new, separate analysis belongs in a new conversation.')
