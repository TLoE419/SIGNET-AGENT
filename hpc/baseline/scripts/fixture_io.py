"""Shared helpers for writing fixtures: command capture, timestamps, log tails, JSON files."""
import datetime
import json
import os
from pathlib import Path
import subprocess

MIN_INTERVAL = 15
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
    return datetime.datetime.now().astimezone().isoformat(timespec='seconds')


def iso_from_timestamp(value):
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
    with Path(path).open('a') as handle:
        handle.write(json.dumps(record, sort_keys=True) + '\n')


def write_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')
    os.replace(str(temporary), str(path))


def check_interval(interval):
    if interval < MIN_INTERVAL:
        raise ValueError('Polling interval must be at least %d seconds.' % MIN_INTERVAL)
    return interval
