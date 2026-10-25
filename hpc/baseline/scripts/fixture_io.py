"""Shared helpers for the baseline observers (Monitor Spec 01).

  - run_command / capture: run a fixed argv and keep its raw output, parsed rows and any
    error, so a failing Slurm command is recorded in the fixture instead of crashing.
  - now_iso / iso_from_timestamp: local timestamps with UTC offset, as in the spec examples.
  - log_state: the tail, mtime and size of a job log, read cheaply from the end.
  - append_jsonl / write_json: fixture writers; write_json replaces files atomically.
  - check_interval: enforces the 15-second minimum between polls.

Stdlib only; no shell is ever involved (argv lists, never strings).
"""
import datetime
import json
import os
from pathlib import Path
import subprocess

# Spec 01 section 9: no script may poll Slurm more often than every 15 seconds.
MIN_INTERVAL = 15
# Lines of the job log stored with each snapshot.
TAIL_LINES = 20


def run_command(argv, timeout=60):
    """Return (returncode, stdout, stderr); a missing binary or timeout is a result, not a crash."""
    try:
        result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                universal_newlines=True, timeout=timeout)
        return result.returncode, result.stdout, result.stderr
    except (OSError, subprocess.TimeoutExpired) as error:
        return None, '', '%s: %s' % (type(error).__name__, error)


def capture(source, argv, parser):
    """One command's raw output plus parsed rows; failures become an error field, not an exception."""
    code, out, err = run_command(argv)
    record = {'source': source, 'command': argv, 'returncode': code, 'raw': out, 'stderr': err}
    try:
        record['parsed'] = parser(out) if code == 0 else []
    except ValueError as error:
        record['parsed'], record['error'] = [], str(error)
    if code != 0:
        record['error'] = err.strip() or 'exit %s' % code
    return record


def now_iso():
    """Current local time, e.g. 2026-10-25T14:03:30-07:00."""
    return datetime.datetime.now().astimezone().isoformat(timespec='seconds')


def iso_from_timestamp(value):
    """A file mtime (seconds since the epoch) in the same format as now_iso."""
    return datetime.datetime.fromtimestamp(value).astimezone().isoformat(timespec='seconds')


def log_state(path, lines=TAIL_LINES):
    """Last lines, mtime and size of a log; reads at most 64 KiB from the end."""
    path = Path(path) if path else None
    if not path or not path.is_file():
        return {'log_tail': [], 'log_mtime': None, 'log_size': None}
    info = path.stat()
    with path.open('rb') as handle:
        handle.seek(max(0, info.st_size - 65536))
        text = handle.read().decode('utf-8', errors='replace')
    return {'log_tail': text.splitlines()[-lines:], 'log_mtime': iso_from_timestamp(info.st_mtime),
            'log_size': info.st_size}


def append_jsonl(path, record):
    """Append one record as a single JSON line (snapshots.jsonl)."""
    with Path(path).open('a') as handle:
        handle.write(json.dumps(record, sort_keys=True) + '\n')


def write_json(path, value):
    """Write pretty JSON through a temporary file so readers never see a half-written file."""
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')
    os.replace(str(temporary), str(path))


def check_interval(interval):
    """Return interval, or raise ValueError if it is below MIN_INTERVAL."""
    if interval < MIN_INTERVAL:
        raise ValueError('Polling interval must be at least %d seconds.' % MIN_INTERVAL)
    return interval
