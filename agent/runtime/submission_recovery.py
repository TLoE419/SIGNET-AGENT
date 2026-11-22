"""Reviewed remote reconciliation and confirmed marker repair; never submits or cancels work."""
import re
import shlex
from agent.runtime import signet_jobs as jobs


def _probe(root, record):
    evidence = {'remote_dir': record.get('remote_dir'), 'scheduler_checked': False}
    token = record.get('submission_token', '')
    if not isinstance(token, str) or not re.fullmatch(r'[a-f0-9]{32}', token):
        return 'unresolved', 'This legacy attempt has no unique submission receipt; retain the block and inspect it manually.', evidence
    # Reuse the environment/run ownership validation, without requiring an unknown job ID.
    try:
        guard = jobs._output_guard(root, record, ownership_only=True)
    except jobs.StepError as error:
        return 'unresolved', str(error), evidence
    q = shlex.quote
    receipt = record['remote_dir'] + '/steps/' + record['step'] + '.submission.' + token
    script = jobs._say() + guard + f'''
R={q(receipt)}
[ "$(readlink -f -- "$R")" = "$R" ] && [ -f "$R" ] && [ ! -L "$R" ] || exit 93
say receipt "$(cat "$R")"
[ ! -L "$J" ] || exit 94
if [ -e "$J" ]; then [ "$(readlink -f -- "$J")" = "$J" ] && [ -f "$J" ] || exit 94; fi
say marker "$(cat "$J" 2>/dev/null)"
queue=$(squeue -h -u "$(id -un)" -o '%i|%k') || exit 95
account=$(sacct -n -X -P -u "$(id -un)" -S {q(record['submitted_at'][:10])} -o JobIDRaw,Comment) || exit 96
candidates=$(printf '%s\\n%s\\n' "$queue" "$account" | while IFS='|' read -r id comment rest; do
  [ "$comment" != {q(token)} ] || printf '%s\\n' "$id"
done)
say candidates "$(printf '%s' "$candidates" | tr '\\n' ' ')"
'''
    try:
        code, values, _ = jobs._shell(script)
    except OSError:
        return 'unresolved', 'The remote query failed; submission remains blocked.', evidence
    if code or not {'receipt', 'marker', 'candidates'}.issubset(values):
        return 'unresolved', 'Ownership, receipt or scheduler query could not be verified; submission remains blocked.', evidence
    candidates = set(values.get('candidates', '').split())
    evidence.update(scheduler_checked=True, receipt=values.get('receipt', '')[:128],
                    job_marker=values.get('marker', '')[:128], candidates=sorted(candidates)[:20],
                    candidate_count=len(candidates))
    receipt_value = values.get('receipt', '')
    marker = values.get('marker', '')
    match = re.fullmatch(r'accepted ([0-9]+)', receipt_value)
    candidate = next(iter(candidates)) if len(candidates) == 1 else ''
    if (re.fullmatch(r'[0-9]+', candidate) and candidate != record.get('previous_job_id')
            and record.get('job_id') in (None, candidate) and marker in ('', candidate)
            and (receipt_value in ('prepared', 'dispatching') or match and match[1] == candidate)):
        return 'adopt', candidate, evidence
    if receipt_value == 'not_dispatched' and not marker and not candidates and not record.get('job_id'):
        return 'unsubmitted', 'The owned attempt receipt confirms this script stopped before invoking sbatch; no matching job was found.', evidence
    return 'unresolved', 'The receipt, job marker and scheduler do not uniquely agree. Do not resubmit.', evidence


def _confirm_job_marker(root, record, job_id, evidence):
    """Keep the normal output guard usable without overwriting an existing marker."""
    receipt_value = evidence.get('receipt')
    if receipt_value not in ('prepared', 'dispatching', 'accepted ' + job_id):
        return False
    try:
        guard = jobs._output_guard(root, record, ownership_only=True)
    except jobs.StepError:
        return False
    q = shlex.quote
    receipt = record['remote_dir'] + '/steps/' + record['step'] + '.submission.' + record['submission_token']
    receipt_guard = (f'R={q(receipt)}\n'
                     '[ "$(readlink -f -- "$R")" = "$R" ] && [ -f "$R" ] && [ ! -L "$R" ] '
                     f'&& [ "$(cat -- "$R")" = {q(receipt_value)} ] || exit 93\n')
    # A hard link installs the complete marker atomically and refuses every existing destination.
    script = jobs._say() + guard + receipt_guard + f'''E={q(job_id)}
[ ! -L "$J" ] || exit 94
if [ ! -e "$J" ]; then
  M=$(mktemp "$D/steps/.{record['step']}.adopt.XXXXXXXX") || exit 94
  trap 'rm -f -- "$M"' EXIT
  printf '%s\\n' "$E" > "$M" || exit 94
  link "$M" "$J" || exit 94
fi
''' + guard + receipt_guard + '''[ "$(readlink -f -- "$J")" = "$J" ] && [ -f "$J" ] && [ ! -L "$J" ] \\
  && [ "$(cat -- "$J")" = "$E" ] || exit 94
say adopted_marker "$E"
'''
    try:
        code, values, _ = jobs._shell(script)
    except OSError:
        return False
    return code == 0 and values.get('adopted_marker') == job_id


@jobs._one_at_a_time
def reconcile(run_id, name, *, expected_attempt, expected_job_id, action, confirmed=False):
    root = jobs._root(run_id)
    jobs._step(name)
    record = jobs._load(root, name)
    if (record.get('run_id') != run_id or record.get('step') != name
            or type(expected_attempt) is not int or expected_attempt < 1 or expected_attempt != record.get('attempt', 1)
            or expected_job_id != record.get('job_id') or record['state'] not in ('unknown', 'submitting')):
        raise jobs.StepError('conflict', 'The displayed source, attempt or job changed; refresh before reviewing recovery.')
    if action not in ('review', 'adopt', 'unsubmitted') or (action != 'review' and confirmed is not True):
        raise jobs.StepError('invalid_request', 'Review the evidence and explicitly confirm the recovery action.')
    outcome, detail, evidence = _probe(root, record)
    local_claim = jobs._recovery_active_claim(root, record)
    evidence['local_operation'] = local_claim
    if outcome != 'unresolved' and local_claim['status'] not in ('absent', 'dead_submitter'):
        outcome, detail = 'unresolved', local_claim['detail']
    entry = {'at': jobs._now(), 'action': action, 'outcome': outcome, 'detail': detail,
             'attempt': expected_attempt, 'job_id': expected_job_id, 'run_id': run_id,
             'step': name, 'evidence': evidence}
    checks = record.setdefault('submission_checks', [])
    reviewed = bool(checks and checks[-1]['action'] == 'review' and
                    checks[-1]['outcome'] == action and checks[-1]['detail'] == detail
                    and checks[-1].get('evidence') == evidence)
    checks.append(entry)
    applied = action != 'review' and action == outcome and reviewed
    if applied and outcome == 'adopt' and not _confirm_job_marker(root, record, detail, evidence):
        applied = False
        entry['outcome'] = 'unresolved'
        entry['detail'] = 'The original owner, receipt or job marker changed or could not be verified; submission remains blocked.'
    if applied and jobs._recovery_active_claim(root, record, expected=local_claim, release=True)['status'] not in ('absent', 'released'):
        applied = False
        entry['outcome'] = 'unresolved'
        entry['detail'] = 'The local operation ownership changed or could not be verified; its marker was not removed.'
    entry['applied'] = applied
    if applied:
        if outcome == 'adopt':
            jobs._change(record, 'submitted', job_id=detail, checked_at=0,
                         reason='Manually adopted the uniquely confirmed job; completion is not yet verified.')
        else:
            jobs._change(record, 'failed', reason=detail + ' Review the normal retry form; nothing has been submitted.')
    jobs._save(root, record)
    return {'record': record, 'recovery': entry, 'applied': applied}
