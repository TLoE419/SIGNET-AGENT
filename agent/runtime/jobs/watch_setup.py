"""Wait for fixed setup metadata changes on shared login/compute storage.

Shared filesystems do not reliably deliver cross-node inotify notifications.
Only stat metadata is sampled here; no logs, research data or scheduler queries.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import sys
import time

STEPS = ('workspace', 'signet', 'container')


def path(value):
    if (not isinstance(value, str) or not re.fullmatch(r'/[A-Za-z0-9_./-]+', value)
            or '..' in value.split('/') or value == '/'):
        raise ValueError('Invalid configured setup path.')
    return Path(value)


def signature(root, source, image, scope):
    root, source, image = path(root), path(source), path(image)
    if not re.fullmatch(r'[a-f0-9]{64}', scope):
        raise ValueError('Invalid setup scope.')
    steps = root / '.signet-agent/steps'
    watched = [root, source, source / 'example', image]
    watched += [steps / (step + suffix) for step in STEPS for suffix in ('.job', '.status')]
    records = []
    for item in watched:
        try:
            info = item.lstat()
            value = (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        except FileNotFoundError:
            value = None
        records.append((str(item), value))
    payload = [scope, socket.gethostname(), os.getuid(), records]
    return hashlib.sha256(json.dumps(payload, separators=(',', ':')).encode()).hexdigest()


def wait(root, source, image, scope, previous, seconds=45, clock=time.monotonic, sleep=time.sleep):
    if not re.fullmatch(r'[a-f0-9]{64}', previous) or not 0 <= seconds <= 45:
        raise ValueError('Invalid setup watch request.')
    deadline = clock() + seconds
    while True:
        current = signature(root, source, image, scope)
        if current != previous or clock() >= deadline:
            return current, current != previous
        sleep(min(1, max(0, deadline - clock())))


if __name__ == '__main__':
    root, source, image, scope, previous, seconds = sys.argv[1:]
    current, changed = wait(root, source, image, scope, previous, int(seconds))
    print('@@setup_cursor\t' + current)
    print('@@setup_changed\t' + ('yes' if changed else 'no'))
