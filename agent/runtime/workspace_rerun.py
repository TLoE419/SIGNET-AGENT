"""Completed-stage forks. Review/create are local; remote reuse happens only at submission."""
import hashlib
import json
from pathlib import Path
import re
import shlex
import shutil

from agent.runtime import signet_jobs as jobs
from agent.runtime.workspace_genotype import guard_run_dataset
import agent.tools.signet as signet

ORDER = ('genotype', 'expression', 'adjust', 'cis', 'network', 'visualize')


def source_owner(root):
    try:
        owner = json.loads(signet._no_links(root / 'steps/remote.owner').read_text())
        if not isinstance(owner['remote_dir'], str) or not isinstance(owner['token'], str):
            raise ValueError('Invalid owner')
        return owner
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise jobs.StepError('conflict', 'Original remote ownership evidence is missing; reuse is refused.') from error


def ancestors(name):
    found = set()
    def visit(key):
        for parent in jobs.STEPS[key].requires:
            if parent not in found:
                found.add(parent)
                visit(parent)
    visit(name)
    return [key for key in ORDER if key in found]


@jobs._one_at_a_time
def review(run_id, name):
    step = jobs._step(name)
    root = jobs._root(run_id)
    guard_run_dataset(root)
    record = jobs._load(root, name)
    if record.get('state') != 'completed' or record.get('run_id') != run_id:
        raise jobs.StepError('conflict', 'Select a completed stage of this live run.')
    if jobs._active_step(root) or (root / '.active').exists():
        raise jobs.StepError('conflict', 'Wait for all source run operations to finish.')
    invalidated = [key for key in ORDER if key == name or name in ancestors(key)]
    reuse = [key for key in ORDER if key not in invalidated and (root / 'steps' / f'{key}.json').is_file() and jobs._load(root, key).get('state') == 'completed']
    if not set(ancestors(name)).issubset(reuse):
        raise jobs.StepError('conflict', 'Required upstream stages are not completed.')
    for key in reuse:
        saved = jobs._load(root, key)
        if saved.get('state') != 'completed' or saved.get('run_id') != run_id:
            raise jobs.StepError('conflict', f'Upstream {key} is not completed in this source run.')
    settings = signet._settings(root)
    for key in reuse:
        saved = jobs._load(root, key)
        if any(str(saved.get('settings', {}).get(setting)) != settings.get(setting) for setting in jobs.STEPS[key].settings):
            raise jobs.StepError('conflict', f'Settings for upstream {key} changed since completion; reuse is unsafe.')
    files = set()
    for key in reuse:
        saved = jobs._load(root, key)
        files.update(saved.get('required_outputs', [jobs._resolve(p, settings) for p in jobs.STEPS[key].required]))
    files.update(jobs._resolve(p, settings) for p in step.needs)
    if name == 'expression' and 'genotype' in reuse:
        files.update(p for p in jobs.STEPS['adjust'].needs if p.startswith('tmp/'))
    params = {'inputs': record.get('inputs', {}), 'settings': {key: (value if rule == 'hms' or value == 'no' else float(value) if rule in ('fraction', 'frequency', 'alpha') else int(value)) for key, rule in step.settings.items() for value in [record.get('settings', {}).get(key, settings[key])]},
              'resources': {key: record.get('resources', step.resources)[key] for key in step.resources}, 'options': record.get('options', {})}
    result = {'source_run_id': run_id, 'step': name, 'parameters': params, 'reuse': reuse,
              'required_files': sorted(files),
              'invalidated': [key for key in ORDER if key == name or name in ancestors(key)],
              'notice': 'Creates a separate run. Remote files and ownership are checked only after explicit submission confirmation.'}
    evidence = [result, settings, [jobs._load(root, key) for key in [name, *reuse]]]
    result['revision'] = hashlib.sha256(json.dumps(evidence, sort_keys=True).encode()).hexdigest()
    return result


@jobs._one_at_a_time
def create(run_id, name, new_run_id, revision, parameters):
    original = review(run_id, name)
    if revision != original['revision']:
        raise jobs.StepError('conflict', 'Source changed; review the completed stage again.')
    try:
        new_run_id = signet._name(new_run_id)
    except (ValueError, TypeError) as error:
        raise jobs.StepError('invalid_request', 'Choose a valid new run name.') from error
    source = jobs._root(run_id)
    destination = signet.PROJECT / 'runs' / new_run_id
    if destination.exists() or destination.is_symlink() or new_run_id in jobs.RESERVED_RUN_IDS:
        raise jobs.StepError('conflict', 'Choose an unused new run name.')
    if not isinstance(parameters, dict) or set(parameters) != {'inputs', 'settings', 'resources', 'options'}:
        raise jobs.StepError('invalid_request', 'Review inputs, settings, resources and options.')
    if any(not isinstance(parameters.get(key), dict) for key in ('inputs', 'settings', 'resources', 'options')):
        raise jobs.StepError('invalid_request', 'Parameter groups must be objects.')
    step = jobs.STEPS[name]
    if set(parameters['settings']) != set(step.settings) or parameters['inputs'] != original['parameters']['inputs']:
        raise jobs.StepError('invalid_request', 'Keep source inputs; edit only this stage settings/options/resources.')
    checked = {key: jobs._setting(key, step.settings[key], value) for key, value in parameters['settings'].items()}
    chromosome_key = {'genotype': 'restrict.tcga.geno', 'expression': 'restrict.tcga'}.get(name)
    if chromosome_key:
        paired = 'expression' if name == 'genotype' else 'genotype'
        other_key = 'restrict.tcga' if name == 'genotype' else 'restrict.tcga.geno'
        other = signet._settings(source).get(other_key)
        if paired in original['reuse'] and checked[chromosome_key] != other and 'no' not in (checked[chromosome_key], other):
            raise jobs.StepError('invalid_request', 'The chromosome must remain compatible with the retained paired stage.')
    jobs._resources(step, parameters['resources'])
    jobs._options(step, parameters['options'])
    # Copy scripts/config and compatible result folders, never source ownership or downstream records.
    for path in source.rglob('*'):
        if path.is_symlink():
            raise jobs.StepError('conflict', 'Source contains symbolic links; reuse is refused.')
    owner = source_owner(source)
    old_remote = owner['remote_dir']
    parent = Path(old_remote).parent
    new_remote = str((parent.parent if parent.name == 'runs' else parent) / new_run_id)
    frozen_source = 'inputs'
    initial = source / 'workspace-genotype.json'
    if name == 'genotype' and initial.is_file() and json.loads(initial.read_text()).get('mode') == 'dataset':
        attempt = jobs._load(source, 'genotype').get('attempt', 1)
        if attempt > 1:
            frozen_source = f'inputs/attempt{attempt}'
    def remap(value):
        if isinstance(value, dict):
            return {key: remap(item) for key, item in value.items()}
        if isinstance(value, list):
            return [remap(item) for item in value]
        if isinstance(value, str) and frozen_source != 'inputs' and value.startswith(old_remote + '/' + frozen_source + '/'):
            return new_remote + '/inputs' + value[len(old_remote + '/' + frozen_source):]
        if isinstance(value, str) and (value == old_remote or value.startswith(old_remote + '/')):
            return new_remote + value[len(old_remote):]
        return value
    result = signet.configure_signet(new_run_id, signet._settings(source)['cohort'])
    if result.get('status') != 'created':
        raise jobs.StepError('invalid_request', result.get('error', 'Could not create run.'))
    try:
        (destination / 'work/config.ini').write_text((source / 'work/config.ini').read_text().replace(str(source), str(destination)))
        (destination / 'steps').mkdir(exist_ok=True)
        for key in original['reuse']:
            record = remap(jobs._load(source, key))
            record.update(run_id=new_run_id, reused_from={'run_id': run_id, 'step': key, 'attempt': record.get('attempt', 1), 'job_id': record.get('job_id')})
            jobs._save(destination, record)
            folder = Path(jobs.STEPS[key].download)
            if (source / folder).exists():
                shutil.copytree(source / folder, destination / folder, dirs_exist_ok=True)
        # Initial snapshot is also the dataset identity for a not-yet-submitted Stage 1 fork.
        for key in set(original['reuse']) | {'genotype', name}:
            path = source / f'workspace-{key}.json'
            if path.is_file():
                original_snapshot = json.loads(path.read_text())
                snapshot = remap(original_snapshot)
                if key == 'genotype':
                    # Raw-source fingerprints belong to their original paths, not copied run inputs.
                    for field in ('source_files', 'source_inputs', 'reference_sources', 'reference_choices',
                                  'selected_inputs', 'reference_compatibility'):
                        if field in original_snapshot:
                            snapshot[field] = original_snapshot[field]
                snapshot['run_id'] = new_run_id
                if key == name:
                    snapshot.update(remap(parameters))
                (destination / path.name).write_text(json.dumps(snapshot, indent=2) + '\n')
        signet._update(destination, checked)
        plan = {**original, 'new_run_id': new_run_id, 'parameters': remap(parameters), 'remote_dir': new_remote, 'frozen_source': frozen_source, 'created_at': jobs._now()}
        if name == 'genotype' and 'expression' in original['reuse']:
            plan['inherited_expression'] = {str(path.relative_to(destination)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in (destination / 'steps/expression.json', destination / 'workspace-expression.json') if path.is_file()}
        (destination / 'rerun.json').write_text(json.dumps(plan, indent=2) + '\n')
    except Exception:
        shutil.rmtree(destination)
        raise
    return plan


def retry_preserved_paths(root):
    """Only unchanged inherited expression evidence is independent of a genotype fork retry."""
    path = signet._no_links(root / 'rerun.json')
    if not path.is_file():
        return set()
    plan = json.loads(path.read_text())
    if plan.get('new_run_id') != root.name or plan.get('step') != 'genotype' or 'expression' not in plan.get('reuse', []):
        return set()
    saved = plan.get('inherited_expression', {})
    if not isinstance(saved, dict) or 'steps/expression.json' not in saved or set(saved) - {'steps/expression.json', 'workspace-expression.json'}:
        return set()
    for relative, digest in saved.items():
        item = signet._no_links(root / relative)
        if not item.is_file() or hashlib.sha256(item.read_bytes()).hexdigest() != digest:
            return set()
    record = jobs._load(root, 'expression')
    source = record.get('reused_from', {})
    if record.get('run_id') != root.name or record.get('state') != 'completed' or source.get('run_id') != plan['source_run_id'] or source.get('step') != 'expression':
        return set()
    return {root / relative for relative in saved}


def stage_remote(root, directory, token):
    """Copy owned, compatible upstream data; no scheduler call and never write to source."""
    path = root / 'rerun.json'
    if not path.exists():
        return
    plan = json.loads(path.read_text())
    return _stage_remote_source(plan['source_run_id'], root, directory, token, plan)


def _reused_control_evidence(source, root, plan, config):
    """Only real completed source jobs can contribute inherited control files.

    Resolve through an already reused parent to the physical job's owned folder.
    The child's saved reused_from relation remains the attribution; copying these
    files authorizes later input checks, never a scheduler submission claim.
    """
    from agent.runtime.workspace_projection import resolve_source
    from agent.runtime.workspace_history import _json
    evidence, checks = [], []
    for key in plan['reuse']:
        inherited, digest = _json(root / 'steps' / (key + '.json'))
        parent = jobs._load(source, key)
        job_id = parent.get('job_id')
        if job_id is None:
            # Old records without an attributable job can retain their files,
            # but no .job/.done evidence is fabricated on their behalf.
            continue
        if (not isinstance(job_id, str) or not re.fullmatch(r'[0-9]{1,128}', job_id)
                or inherited.get('run_id') != root.name or inherited.get('step') != key
                or inherited.get('state') != 'completed' or type(inherited.get('attempt', 1)) is not int
                or inherited.get('job_id') != job_id
                or inherited.get('attempt', 1) != parent.get('attempt', 1)
                or any(inherited.get(field) != parent.get(field) for field in ('settings', 'options', 'image', 'partition'))
                or not isinstance(inherited.get('reused_from'), dict)
                or type(inherited['reused_from'].get('attempt')) is not int
                or inherited.get('reused_from') != {'run_id': source.name, 'step': key,
                    'job_id': job_id, 'attempt': parent.get('attempt', 1)}):
            raise jobs.StepError('conflict', 'The inherited job identity changed; create a new reviewed fork.')
        physical_root, record, metadata = resolve_source(source.name, key)
        origin = jobs._remote_dir(config, physical_root, physical_root.name)
        owner, owner_digest = _json(physical_root / 'steps/remote.owner')
        if (record.get('remote_dir') != origin or owner.get('remote_dir') != origin
                or not isinstance(owner.get('token'), str)
                or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', owner['token'])):
            raise jobs.StepError('conflict', 'The original completed job belongs to a different remote environment.')
        evidence.append((key, origin, owner['token'], job_id))
        checks.append((root / 'steps' / (key + '.json'), digest))
        checks.append((physical_root / 'steps/remote.owner', owner_digest))
        checks.extend(metadata)
    return evidence, checks


def _control_checks(evidence, directory, *, destination=False):
    """Shell preflight for exact regular markers; existing different files are refused."""
    q = shlex.quote
    script = ''
    for key, origin, token, job_id in evidence:
        script += (f'[ "$(readlink -f -- {q(origin)})" = {q(origin)} ]\n'
                   f'[ ! -L {q(origin + "/.owner")} ] && [ -f {q(origin + "/.owner")} ] || exit 7\n'
                   f'[ "$(cat {q(origin + "/.owner")})" = {q(token)} ]\n')
        for suffix, limit in (('job', 129), ('done', 4096)):
            marker, copied = origin + '/steps/' + key + '.' + suffix, directory + '/steps/' + key + '.' + suffix
            script += (f'P={q(marker)}\nC={q(copied)}\n'
                       '[ ! -L "$P" ] && [ -f "$P" ] && [ -s "$P" ] && [ "$(readlink -f -- "$P")" = "$P" ] || exit 7\n'
                       f'[ "$(wc -c < "$P")" -le {limit} ]\n')
            if suffix == 'job':
                script += f'[ "$(cat "$P")" = {q(job_id)} ]\n'
            else:
                script += 'IFS=" " read -r code finished < "$P"\n[ "$code" = 0 ]\n'
            if destination:
                script += '[ -f "$C" ] && [ ! -L "$C" ] && [ "$(readlink -f -- "$C")" = "$C" ] && cmp -s -- "$P" "$C" || exit 7\n'
            else:
                script += ('if [ -e "$C" ] || [ -L "$C" ]; then\n'
                           ' [ -f "$C" ] && [ ! -L "$C" ] && [ "$(readlink -f -- "$C")" = "$C" ] && cmp -s -- "$P" "$C" || exit 7\nfi\n')
    return script


@jobs._one_at_a_time
def _stage_remote_source(source_run_id, root, directory, token, plan):
    # Keep source revision/attempt checks authoritative until its files are copied.
    source = jobs._root(source_run_id)
    settings = signet._settings(root)
    for key in plan['reuse']:
        saved = jobs._load(root, key)
        if any(str(saved['settings'][setting]) != settings.get(setting) for setting in jobs.STEPS[key].settings):
            raise jobs.StepError('conflict', 'Upstream settings changed; create a new reviewed fork.')
    if (root / 'steps/reuse-ready').exists():
        return
    current = review(source.name, plan['step'])
    if current['revision'] != plan['revision']:
        raise jobs.StepError('conflict', 'Source changed since rerun review.')
    config = jobs._environment()
    if plan['remote_dir'] != directory:
        raise jobs.StepError('conflict', 'Rerun belongs to a different remote environment.')
    origin = jobs._remote_dir(config, source, source.name)
    owner = source_owner(source)
    if owner.get('remote_dir') != origin:
        raise jobs.StepError('conflict', 'Source remote ownership does not match.')
    evidence, metadata_checks = _reused_control_evidence(source, root, plan, config)
    q = shlex.quote
    script = 'set -eu\n' + f'S={q(origin)}\nD={q(directory)}\n'
    for folder, expected in ((origin, owner['token']), (directory, token)):
        script += f'[ "$(readlink -f -- {q(folder)})" = {q(folder)} ]\n[ ! -L {q(folder + "/.owner")} ]\n[ "$(cat {q(folder + "/.owner")})" = {q(expected)} ]\n'
    files = [(p, origin + '/work/' + p, origin) for p in plan['required_files']]
    script += jobs._say() + jobs._input_checks(files)
    script += f'[ "$(readlink -f -- {q(directory + "/steps")})" = {q(directory + "/steps")} ]\n'
    script += _control_checks(evidence, directory)
    # Include full genotype temporary tree: adjustment uses additional imputation files.
    folders = [jobs.STEPS[key].download for key in plan['reuse']]
    if 'genotype' in plan['reuse'] and plan['step'] in ('expression', 'adjust'):
        folders.append('work/tmp/tmpg')
    if any(str(value).startswith(directory + '/inputs/') for value in plan['parameters']['inputs'].values()) or any(json.loads(p.read_text()).get('mode') == 'dataset' for p in root.glob('workspace-genotype.json')):
        folders.append(plan['frozen_source'])
    for folder in folders:
        script += f'[ -d "$S"/{q(folder)} ]\n[ -z "$(find "$S"/{q(folder)} -type l -print -quit)" ]\n'
    for folder in folders:
        if folder == plan['frozen_source'] and folder != 'inputs':
            script += f'mkdir -p "$D/inputs"\ncp -a -- "$S"/{q(folder)}/. "$D/inputs/"\n'
            continue
        script += f'mkdir -p "$D"/{q(str(Path(folder).parent))}\ncp -a -- "$S"/{q(folder)} "$D"/{q(str(Path(folder).parent))}/\n'
    if plan['step'] == 'genotype' and plan['frozen_source'] in folders:
        from agent.runtime.workspace_inputs import REQUIRED
        for relative in REQUIRED:
            script += jobs._input_checks([(relative, origin + '/work/' + relative, origin)])
            script += f'mkdir -p {q(directory + "/work/" + str(Path(relative).parent))}\ncp -- {q(origin + "/work/" + relative)} {q(directory + "/work/" + relative)}\n'
    for key, physical, _, _ in evidence:
        for suffix in ('job', 'done'):
            relative = '/steps/' + key + '.' + suffix
            script += f'cp -n -- {q(physical + relative)} {q(directory + relative)}\n'
    script += _control_checks(evidence, directory, destination=True)
    code, _, _ = jobs._shell(script, timeout=300)
    if code:
        raise jobs.StepError('not_ready', 'Compatible upstream files or ownership could not be verified; nothing submitted.')
    from agent.runtime.workspace_projection import verify_source
    verify_source(metadata_checks)
    (root / 'steps/reuse-ready').write_text(jobs._now())


def guard_submission(root, name):
    guard_run_dataset(root)
    path = root / 'rerun.json'
    if not path.exists():
        return
    plan = json.loads(path.read_text())
    target = plan['step']
    if name != target and jobs.run_steps(root.name).get(target) != 'completed':
        raise jobs.StepError('conflict', 'Complete the reviewed rerun stage before submitting downstream stages.')


@jobs._one_at_a_time
def submit(run_id, confirmed):
    if confirmed is not True:
        raise jobs.StepError('invalid_request', 'Explicit manual confirmation is required.')
    root = jobs._root(run_id)
    guard_run_dataset(root)
    try:
        plan = json.loads(signet._no_links(root / 'rerun.json').read_text())
        if plan.get('new_run_id') != run_id or plan.get('step') not in jobs.STEPS:
            raise ValueError('Mismatched rerun identity')
    except (OSError, ValueError, TypeError) as error:
        raise jobs.StepError('not_found', 'Select an existing linked run with its review snapshot.') from error
    params = plan['parameters']
    settings = signet._settings(root)
    if any(jobs._setting(key, jobs.STEPS[plan['step']].settings[key], value) != settings.get(key) for key, value in params['settings'].items()):
        raise jobs.StepError('conflict', 'Settings changed after review; create a new reviewed fork.')
    return jobs.submit(run_id, plan['step'], params['inputs'], params['resources'], params['options'])
