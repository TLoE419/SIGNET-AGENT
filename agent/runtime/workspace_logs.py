"""Read bounded logs from the exact saved analysis source and attempt."""
import os
from pathlib import Path
import re
import shlex
import stat

import agent.tools.signet as signet
from agent.runtime import signet_jobs as jobs, ssh_transport, workspace_history

MAX_BYTES = 65536
_SOURCES = {'workspace': 'live', 'recorded': 'recorded', 'archive': 'archive'}


def _options(stream, lines):
    if stream not in ('out', 'err', 'submission'):
        raise jobs.StepError('invalid_request', 'stream must be out, err, or submission.')
    if type(lines) is not int or not 1 <= lines <= jobs.MAX_LOG_LINES:
        raise jobs.StepError('invalid_request', 'lines must be an integer from 1 to 200.')


def _tail(raw, lines):
    truncated = len(raw) > MAX_BYTES
    text = raw[-MAX_BYTES:].decode('utf-8', 'replace').splitlines()
    return {'status': 'ready' if raw else 'empty', 'lines': text[-lines:],
            'truncated': truncated or len(text) > lines, 'max_bytes': MAX_BYTES}


def _local(root, relative, lines):
    try:
        path = signet._no_links(root / relative)
        before = path.stat()
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as error:
        raise jobs.StepError('conflict', 'The saved log path is unavailable or reached through a link.') from error
    if not stat.S_ISREG(before.st_mode):
        raise jobs.StepError('remote_failed', 'The saved log is not a readable regular file.')
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode) or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
                raise jobs.StepError('conflict', 'The saved log changed while it was being opened.')
            stream.seek(max(0, opened.st_size - MAX_BYTES - 1))
            raw = stream.read(MAX_BYTES + 1)
    except OSError as error:
        raise jobs.StepError('remote_failed', 'The saved log exists but could not be read.') from error
    return {**_tail(raw, lines), 'origin': 'local'}


def _remote(root, run_id, record, relative, lines):
    if not record.get('job_id') and (record.get('state') in jobs.ACTIVE or
            not str(record.get('reason', '')).startswith('Submission failed before a job ID was returned:')):
        raise jobs.StepError('conflict', 'No confirmed job or refused-submission record identifies this attempt; its remote log cannot be attributed safely.')
    try:
        config = jobs._environment()
    except jobs.StepError as error:
        raise jobs.StepError('not_ready', 'No attributable local log is available. Connect to the recorded remote environment to read it.') from error
    directory = record.get('remote_dir')
    allowed = {config['workRoot'] + '/' + run_id, config['workRoot'] + '/runs/' + run_id}
    try:
        owner, _ = workspace_history._json(root / 'steps/remote.owner')
    except (OSError, ValueError) as error:
        raise jobs.StepError('conflict', 'The original remote log folder ownership was not recorded reliably.') from error
    if (directory not in allowed or owner.get('remote_dir') != directory
            or not isinstance(owner.get('token'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', owner['token'])):
        raise jobs.StepError('conflict', 'The recorded log belongs to a different or unverified remote folder.')
    filename = str(Path(directory) / relative)
    marker = str(Path(filename).with_suffix('.job')) if not relative.endswith('.sbatch.err') else filename[:-11] + '.job'
    expected = record.get('job_id') or 'none'
    q = shlex.quote
    # Pin the open file before reading, so a remote retry cannot replace it
    # between the job-marker check and the bounded tail.
    script = f'''D={q(directory)}
F={q(filename)}
J={q(marker)}
T={q(owner['token'])}
E={q(expected)}
[ "$(readlink -f -- "$D")" = "$D" ] && [ -f "$D/.owner" ] && [ ! -L "$D/.owner" ] && [ "$(head -c 129 -- "$D/.owner" 2>/dev/null)" = "$T" ] || exit 45
[ ! -L "$F" ] || exit 45
[ -e "$F" ] || exit 44
[ "$(readlink -f -- "$F")" = "$F" ] || exit 45
[ -f "$F" ] && [ -r "$F" ] || exit 46
check_job() {{
  if [ "$E" = none ]; then [ ! -e "$J" ] && [ ! -L "$J" ];
  else [ "$(readlink -f -- "$J")" = "$J" ] && [ -f "$J" ] && [ "$(head -c 128 -- "$J" 2>/dev/null)" = "$E" ]; fi
}}
check_job || exit 47
exec 3<"$F" || exit 46
check_job || exit 47
tail -c {MAX_BYTES + 1} <&3 || exit 46
'''
    try:
        response = ssh_transport.remote('bash -s', input=script.encode(), capture_output=True, timeout=30)
    except OSError as error:
        raise jobs.StepError('remote_failed', 'The remote log could not be read because the connection was interrupted.') from error
    if response.returncode == 44:
        raise jobs.StepError('not_found', 'The requested log file has not been saved for this attempt.')
    if response.returncode in (45, 47):
        raise jobs.StepError('conflict', 'The remote log folder or job identity no longer matches this saved attempt.')
    if response.returncode or len(response.stdout) > MAX_BYTES + 1:
        raise jobs.StepError('remote_failed', 'The remote log exists but could not be read safely.')
    return {**_tail(response.stdout, lines), 'origin': 'remote'}


def _local_step(root, relative, record, current, source, lines):
    if source == 'archive' or not current:
        return _local(root, relative, lines)
    expected = record.get('job_id')
    if not expected:
        return None
    marker = relative[:-11] + '.job' if relative.endswith('.sbatch.err') else str(Path(relative).with_suffix('.job'))
    def matching_marker():
        saved = _local(root, marker, 1)
        return saved is not None and not saved['truncated'] and saved['lines'] == [expected]
    # Loose current logs are not archived by retry submission. Only a matching
    # saved job marker can attribute them to the displayed current attempt.
    if not matching_marker():
        return None
    value = _local(root, relative, lines)
    if value is not None and not matching_marker():
        raise jobs.StepError('conflict', 'The local log job identity changed while it was being read.')
    return value


def _scope(history_id):
    if not isinstance(history_id, str):
        raise jobs.StepError('invalid_request', 'Provide a source-scoped history ID.')
    match = re.fullmatch(r'(workspace|recorded|archive)--([A-Za-z0-9][A-Za-z0-9_-]{0,63})', history_id)
    if not match:
        raise jobs.StepError('invalid_request', 'Provide a source-scoped history ID.')
    return match[2], _SOURCES[match[1]]


def _row(history_id, identity, history_loader):
    if not isinstance(identity, str) or not re.fullmatch(r'[a-f0-9]{64}', identity):
        raise jobs.StepError('invalid_request', 'Provide the displayed history record identity.')
    row = next((row for row in history_loader()['runs'] if row['history_id'] == history_id), None)
    if row is None:
        raise jobs.StepError('not_found', 'This saved analysis source is unavailable.')
    if row['record_identity'] != identity:
        raise jobs.StepError('conflict', 'The saved analysis source changed. Refresh history before opening its log.')
    return row


def _step_target(row, step, attempt, job_id):
    if (attempt is not None and (type(attempt) is not int or not 1 <= attempt <= workspace_history.MAX_ATTEMPTS)
            or not isinstance(job_id, str) or job_id != 'none' and not re.fullmatch(r'[0-9]+', job_id)):
        raise jobs.StepError('invalid_request', 'Provide the displayed attempt number and job ID, or unknown/none.')
    entry = next((entry for entry in row.get('attempts', {}).get(step, [])
                  if entry['number'] == attempt and entry['availability'] == 'recorded'), None)
    if entry is None:
        raise jobs.StepError('not_found', 'The original attempt snapshot is missing or unreadable; its log cannot be attributed safely.')
    actual = entry['record'].get('job_id')
    if (actual is not None and (not isinstance(actual, str) or not re.fullmatch(r'[0-9]+', actual))
            or (actual or 'none') != job_id):
        raise jobs.StepError('conflict', 'The saved attempt job identity changed. Refresh its details before opening the log.')
    return entry


def read_step(history_id, step, attempt, job_id, identity, stream='out', lines=50, *, history_loader):
    run_id, source = _scope(history_id)
    return _read_step(run_id, source, history_id, step, attempt, job_id, identity, stream, lines, history_loader)


@jobs._one_at_a_time
def _read_step(run_id, source, history_id, step, attempt, job_id, identity, stream, lines, history_loader):
    jobs._step(step)
    _options(stream, lines)
    row = _row(history_id, identity, history_loader)
    entry = _step_target(row, step, attempt, job_id)
    root = signet.PROJECT / ('data/stage6-results' if source == 'archive' else 'runs') / run_id
    base = step if entry['current'] else f'{step}.attempt{attempt}'
    suffix = 'sbatch.err' if stream == 'submission' else stream
    relative = 'steps/' + base + '.' + suffix
    value = _local_step(root, relative, entry['record'], entry['current'], source, lines)
    if value is None:
        if source == 'archive':
            raise jobs.StepError('not_found', 'This log was not included in the saved archive; no other analysis source was read.')
        value = _remote(root, run_id, entry['record'], relative, lines)
    _step_target(_row(history_id, identity, history_loader), step, attempt, job_id)
    return {**value, 'history_id': history_id, 'identity': identity, 'run_id': run_id, 'source': source,
            'step': step, 'attempt': attempt, 'job_id': None if job_id == 'none' else job_id, 'stream': stream}


def read_operation(history_id, operation, identity, record_revision, stream='out', lines=50, *, history_loader):
    run_id, source = _scope(history_id)
    signet._name(operation)
    return _read_operation(run_id, source, history_id, operation, identity, record_revision, stream, lines, history_loader)


@jobs._one_at_a_time
def _read_operation(run_id, source, history_id, operation, identity, record_revision, stream, lines, history_loader):
    _options(stream, lines)
    if stream == 'submission' or not isinstance(record_revision, str) or not re.fullmatch(r'[a-f0-9]{64}', record_revision):
        raise jobs.StepError('invalid_request', 'Provide the saved operation revision and an out or err stream.')
    def target():
        row = _row(history_id, identity, history_loader)
        record = next((record for record in row.get('operations', [])
                       if record['operation'] == operation and record['record_file'] == operation + '.json'), None)
        if record is None or record.get('executed') is False:
            raise jobs.StepError('not_found', 'No executed operation snapshot was recorded; a prepared plan has no execution log.')
        if record.get('record_revision') != record_revision:
            raise jobs.StepError('conflict', 'The saved operation changed. Refresh its details before opening the log.')
    target()
    root = signet.PROJECT / ('data/stage6-results' if source == 'archive' else 'runs') / run_id
    value = _local(root, 'logs/' + operation + ('.stdout' if stream == 'out' else '.stderr'), lines)
    if value is None:
        raise jobs.StepError('not_found', 'This operation log was not saved locally; recorded failure hints are not a log file.')
    target()
    return {**value, 'history_id': history_id, 'identity': identity, 'run_id': run_id, 'source': source,
            'operation': operation, 'record_revision': record_revision, 'stream': stream}


@jobs._one_at_a_time
def read_legacy(run_id, step, stream='out', lines=50):
    jobs._step(step)
    _options(stream, lines)
    root = jobs._root(run_id)
    try:
        record, _ = workspace_history._json(root / 'steps' / (step + '.json'))
        record = workspace_history._attempt_record(record, run_id, step)
    except (OSError, ValueError) as error:
        raise jobs.StepError('not_found', 'The current step record is unavailable or unreadable.') from error
    relative = 'steps/' + step + ('.sbatch.err' if stream == 'submission' else '.' + stream)
    value = _local_step(root, relative, record, True, 'live', lines)
    if value is None:
        value = _remote(root, run_id, record, relative, lines)
    return {key: value[key] for key in ('lines', 'truncated')}
