"""Explicit, read-only remote reconciliation; never submits or cancels work."""
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
[ "$(readlink -f -- "$R")" = "$R" ] && [ -f "$R" ] || exit 93
say receipt "$(cat "$R")"
[ ! -L "$J" ] || exit 94
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
    entry = {'at': jobs._now(), 'action': action, 'outcome': outcome, 'detail': detail,
             'attempt': expected_attempt, 'job_id': expected_job_id, 'run_id': run_id,
             'step': name, 'evidence': evidence}
    checks = record.setdefault('submission_checks', [])
    reviewed = bool(checks and checks[-1]['action'] == 'review' and
                    checks[-1]['outcome'] == action and checks[-1]['detail'] == detail
                    and checks[-1].get('evidence') == evidence)
    checks.append(entry)
    applied = action != 'review' and action == outcome and reviewed
    entry['applied'] = applied
    if applied:
        if outcome == 'adopt':
            jobs._change(record, 'submitted', job_id=detail, checked_at=0,
                         reason='Manually adopted the uniquely confirmed job; completion is not yet verified.')
        else:
            jobs._change(record, 'failed', reason=detail + ' Review the normal retry form; nothing has been submitted.')
    jobs._save(root, record)
    return {'record': record, 'recovery': entry, 'applied': applied}
