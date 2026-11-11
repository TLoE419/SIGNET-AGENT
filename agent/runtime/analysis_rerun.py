"""Prepare a new HPC3 run from a completed stage in the same conversation."""
import json
import secrets
import shlex
import shutil
import subprocess
from pathlib import Path

from agent.runtime import signet_jobs as jobs, ssh_transport, step_proposal
from agent.tools import signet


CHROMOSOME_SETTINGS = {'genotype': 'restrict.tcga.geno', 'expression': 'restrict.tcga'}


def _paired_step(name):
    return {'genotype': 'expression', 'expression': 'genotype'}.get(name)


def _impact(name, records, *, paired=None):
    affected = {name}
    if paired:
        affected.add(paired)
    for stage in jobs.ANALYSIS_STEPS:
        if affected.intersection(jobs.STEPS[stage].requires):
            affected.add(stage)
    return {'affected_steps': [stage for stage in jobs.ANALYSIS_STEPS if stage in affected and stage != name],
            'reused_steps': [stage for stage in jobs.ANALYSIS_STEPS if stage not in affected
                             and records.get(stage, {}).get('state') == 'completed']}


def _completed(root, name):
    records = jobs.run_records(root)
    if records.get(name, {}).get('state') != 'completed':
        raise jobs.StepError('conflict', 'Choose a completed stage to rerun.')
    if (root / '.active').exists() or jobs._active_step(root):
        raise jobs.StepError('conflict', 'Wait for the source analysis to finish its active stage.')
    return records


@jobs._one_at_a_time
def prepare(run_id, session, name):
    root = jobs._root(run_id)
    step_proposal.require_owner(root, session)
    step = jobs._step(name)
    records = _completed(root, name)
    settings = signet._settings(root)
    attempt = records[name]
    key = name + '-rerun'
    baseline = step_proposal._baseline(settings, attempt)
    impact = _impact(name, records)
    existing = step_proposal._read(root, key)
    if (existing and existing['state'] == 'pending' and existing['baseline'] == baseline
            and existing['impact'] == impact):
        proposal = existing
    else:
        parameters = step_proposal._parameters(name, step, settings, attempt, 'custom')
        parameters['settings'].update(attempt.get('settings', {}))
        proposal = {'id': secrets.token_hex(16), 'state': 'pending', 'baseline': baseline,
                    'parameters': parameters, 'impact': impact}
        step_proposal._write(root, key, proposal)
    response = {'id': proposal['id'], 'parameters': proposal['parameters'], 'resource_limits': step.limits,
                **impact}
    if (paired := _paired_step(name)) and paired in impact['reused_steps']:
        response['chromosome_pair'] = {'setting': CHROMOSOME_SETTINGS[name], 'stage': paired}
    return response


def _copy_remote(source, source_token, destination, token, files, *, genotype):
    quote = shlex.quote
    copies = ''.join(f'copy_output {quote(file)} {"required" if required else "optional"} || exit 4\n'
                     for file, required in files.items())
    if genotype:
        copies += '''copy_output work/tmp/tmpg/impute/impute_Genotype.sizes required || exit 4
for map in "$src"/work/tmp/tmpg/impute/clean_Genotype_chr*.map; do
  [ -e "$map" ] || continue
  copy_output "work/tmp/tmpg/impute/${map##*/}" optional || exit 4
done
'''
    command = f'''umask 077
src={quote(source)}
dst={quote(destination)}
[ "$(cat "$src/.owner" 2>/dev/null)" = {quote(source_token)} ] || exit 3
[ "$(cat "$dst/.owner" 2>/dev/null)" = {quote(token)} ] || exit 3
physical="$(cd "$src" && pwd -P)" || exit 3
copy_output() {{
  local relative="$1" file="$src/$1"
  [ "$(readlink -f -- "$file")" = "$physical/$relative" ] && [ -f "$file" ] &&
    {{ [ "$2" = optional ] || [ -s "$file" ]; }} &&
    mkdir -p "$(dirname "$dst/$relative")" && cp -p -- "$file" "$dst/$relative"
}}
{copies}true
'''
    result = ssh_transport.remote('bash -s', input=command.encode(), capture_output=True, timeout=300)
    if result.returncode:
        raise jobs.StepError('remote_failed', 'Could not copy the original analysis outputs on HPC3.')


def _seed(root, child, name, config, records, reused, settings, proposal_id, paired_setting):
    source = jobs._remote_dir(config, root, root.name)
    try:
        owner = json.loads((root / 'steps/remote.owner').read_text())
    except FileNotFoundError as error:
        raise jobs.StepError('not_ready', 'The original analysis workspace is unavailable on HPC3.') from error
    if owner.get('remote_dir') != source or not owner.get('token'):
        raise jobs.StepError('not_ready', 'Connect to the original analysis workspace on HPC3.')
    destination = config['workRoot'] + '/' + child.name
    origin = {'source_run': root.name, 'from_step': name, 'proposal_id': proposal_id,
              'input_roots': list(dict.fromkeys(jobs._input_roots(config, root, source)[2:]))}
    if not child.exists():
        result = signet.configure_signet(child.name, nchr=int(settings['nchr']))
        if result['status'] != 'created':
            raise jobs.StepError('invalid_request', result['error'])
        (child / 'rerun.json').write_text(json.dumps(origin) + '\n')
    elif (not (child / 'rerun.json').is_file()
          or json.loads((child / 'rerun.json').read_text()) != origin
          or jobs.analysis_session(child) is not None):
        raise jobs.StepError('conflict', 'The new analysis folder already exists.')
    jobs._root(child.name)

    # Preserve the settings that produced the carried-forward files, including the cis threshold.
    for stage, record in records.items():
        if record['state'] == 'completed':
            signet._update(child, record.get('settings', {}))
    if paired_setting:
        signet._update(child, paired_setting)

    all_files = {}
    for stage in reused:
        record = records[stage]
        step = jobs.STEPS[stage]
        required = {'work/' + path for path in jobs._required(step, record)}
        files = record.get('outputs') or sorted(required)
        if not required.issubset(files):
            raise jobs.StepError('conflict', 'The original analysis is missing required local results.')
        for relative in files:
            path = Path(relative)
            original = root / path
            if (not path.is_relative_to(step.download) or '..' in path.parts or not original.is_file()
                    or (relative in required and original.stat().st_size == 0)):
                raise jobs.StepError('conflict', 'The original analysis is missing required local results.')
            target = child / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(original, target)
            all_files[relative] = relative in required
        copied = {key: record[key] for key in ('step', 'flag', 'settings', 'inputs', 'resources', 'options',
                                               'required_outputs', 'progress', 'finished_at') if key in record}
        jobs._save(child, {**copied, 'state': 'completed', 'run_id': child.name, 'remote_dir': destination,
                          'outputs': files, 'reused_from': root.name})

    token = jobs._owner(child, destination)
    jobs._upload(child, destination, token)
    _copy_remote(source, owner['token'], destination, token, all_files, genotype='genotype' in reused)


@jobs._one_at_a_time
def confirm(run_id, session, name, proposal_id, inputs, settings, resources, options=None):
    root = jobs._root(run_id)
    key = name + '-rerun'
    proposal = step_proposal._pending(root, session, key, proposal_id)
    records = _completed(root, name)
    source_settings = signet._settings(root)
    impact = _impact(name, records)
    if (proposal['baseline'] != step_proposal._baseline(source_settings, records[name])
            or proposal['impact'] != impact):
        raise jobs.StepError('conflict', 'Analysis settings changed. Open a fresh confirmation card.')
    step = jobs._step(name)
    parameters = step_proposal.reviewed_parameters(step, inputs, settings, resources, options)
    jobs._check_current(step, {**source_settings, **parameters['settings']})
    paired_setting = {}
    if paired := _paired_step(name):
        setting = CHROMOSOME_SETTINGS[name]
        chromosome = parameters['settings'][setting]
        original_chromosome = records[name].get('settings', {}).get(setting, source_settings.get(setting))
        if chromosome != original_chromosome:
            paired_setting = {CHROMOSOME_SETTINGS[paired]: chromosome}
            impact = _impact(name, records, paired=paired)
    config = jobs._environment()
    source = jobs._remote_dir(config, root, run_id)
    jobs._inputs(step, inputs, jobs._input_roots(config, root, source))
    child = root.parent / f'{run_id[:42]}-rerun-{proposal_id[:12]}'
    try:
        _seed(root, child, name, config, records, impact['reused_steps'], source_settings, proposal_id, paired_setting)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise jobs.StepError('remote_failed', 'Could not prepare the new analysis. Nothing was submitted.') from error
    proposal['state'] = 'confirmed'
    step_proposal._write(root, key, proposal)
    jobs.link_conversation(child.name, session)
    return jobs.submit(child.name, name, inputs, resources, parameters.get('options'), settings_override=settings)
