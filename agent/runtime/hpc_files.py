"""Browse HPC3 folders and inspect file metadata for the desktop Data view.

Only these local routes see paths. The assistant receives neither file names
nor contents. Selection is saved separately in the chosen dataset.
"""
import posixpath
import re
import json
import shlex

from agent.runtime import hpc

_SAFE = r'/[A-Za-z0-9_./-]+'
_UNREADABLE_ON_COMPUTE = ('/tmp', '/var/tmp', '/dev/shm', '/run')
UNSUPPORTED_NAME = 'Paths may use only letters, numbers, _, -, . and /, because SIGNET scripts cannot handle others.'
MAX_INSPECT_PATHS = 128
MAX_INSPECT_BODY = 32768
_RESULT = "print('@@result\\t' + json.dumps(result))\n"


def _safe_path(path):
    if not isinstance(path, str) or len(path) > 2048 or not re.fullmatch(_SAFE, path):
        raise ValueError(UNSUPPORTED_NAME)
    clean = posixpath.normpath(path)
    if '..' in path.split('/'):
        raise ValueError('Use a full path without "..".')
    return clean.replace('//', '/', 1) if clean.startswith('//') else clean


def _python(body, *args):
    quoted = ' '.join(shlex.quote(arg) for arg in args)
    return f"python3 - {quoted} <<'SIGNET_PY'\nimport json, os, re, sys\nSAFE = re.compile(r'{_SAFE}')\n{body}{_RESULT}SIGNET_PY\n"


def _list_script(path):
    return _python('''
path = sys.argv[1]
if os.path.isfile(path):
    result = {'status': 'ok', 'path': path, 'kind': 'file', 'entries': []}
elif not os.path.isdir(path):
    result = {'status': 'failed', 'error': 'This path does not exist or your account cannot see it.'}
else:
    try:
        names = sorted((n for n in os.listdir(path) if not n.startswith('.')), key=str.lower)
    except OSError:
        names = None
    if names is None:
        result = {'status': 'failed', 'error': 'Your account does not have permission to open this folder.'}
    else:
        entries = []
        for name in names[:2000]:
            full = os.path.join(path, name)
            try:
                info = os.stat(full)
            except OSError:
                continue
            folder = os.path.isdir(full)
            if folder or os.path.isfile(full):
                entries.append({'name': name, 'path': full, 'kind': 'folder' if folder else 'file',
                                'size': 0 if folder else info.st_size, 'supported': bool(SAFE.fullmatch(full))})
        result = {'status': 'ok', 'path': path, 'kind': 'folder', 'entries': entries, 'truncated': len(names) > 2000}
''', path)


def _inspect_script(paths):
    return _python(f'''
import stat
files, seen = [], set()
result = None
for requested in sys.argv[1:]:
    real = os.path.realpath(requested)
    if len(real) > 2048 or not SAFE.fullmatch(real):
        result = {{'status': 'invalid', 'error': {UNSUPPORTED_NAME!r}}}
        break
    if real == os.path.sep or any(real == top or real.startswith(top + '/') for top in {_UNREADABLE_ON_COMPUTE!r}):
        result = {{'status': 'invalid', 'error': 'Compute nodes cannot read this location. Choose a file in home, /pub, /dfs or CRSP.'}}
        break
    try:
        info = os.stat(real)
    except OSError:
        result = {{'status': 'invalid', 'error': 'A selected file is missing or your account cannot access it.'}}
        break
    if not stat.S_ISREG(info.st_mode):
        result = {{'status': 'invalid', 'error': 'Select regular files, not folders or special files.'}}
    elif not os.access(real, os.R_OK):
        result = {{'status': 'invalid', 'error': 'Your account cannot read a selected file.'}}
    elif info.st_size == 0:
        result = {{'status': 'invalid', 'error': 'A selected file is empty.'}}
    elif real in seen:
        result = {{'status': 'invalid', 'error': 'Select each file only once.'}}
    if result:
        break
    seen.add(real)
    files.append({{'path': real, 'size': info.st_size}})
if result is None:
    result = {{'status': 'ok', 'executed': False, 'read_only': True, 'files': files}}
''', *paths)


def _shortcuts_script(dfs='/dfs[0-9]*', crsp='/share/crsp'):
    return _python('''
import glob, pwd, time
account = pwd.getpwuid(os.getuid())
groups = set(os.getgroups()) | {os.getgid()}
deadline = time.time() + 10
found, seen = [], set()
def add(label, path):
    if path not in seen and os.path.isdir(path) and os.access(path, os.R_OK | os.X_OK):
        seen.add(path)
        found.append({'label': label, 'path': path})
def labs(parent, label):
    try:
        names = sorted(os.listdir(parent))
    except OSError:
        return
    for name in names:
        if time.time() > deadline or name == 'pub':
            return
        full = os.path.join(parent, name)
        try:
            if os.stat(full).st_gid in groups:
                add(label + ': ' + name, full)
        except OSError:
            pass
add('Home', os.path.expanduser('~'))
add('Personal (/pub)', '/pub/' + account.pw_name)
for parent in sorted(glob.glob(sys.argv[1])):
    labs(parent, 'Lab')
labs(sys.argv[2] + '/lab', 'CRSP lab')
add('CRSP home', sys.argv[2] + '/home/' + account.pw_name)
result = {'status': 'ok', 'shortcuts': found}
''', dfs, crsp)


def _call(script, timeout):
    values, error = hpc._run(script, timeout=timeout)
    if error:
        return error
    if 'result' not in values:
        return {'status': 'failed', 'error': 'The HPC3 command did not complete.'}
    return json.loads(values['result'])


def shortcuts():
    return _call(lambda root: hpc._prelude(root) + _shortcuts_script(), 30)


def list_folder(path):
    try:
        path = _safe_path(path)
    except ValueError as error:
        return {'status': 'invalid', 'error': str(error)}
    return _call(lambda root: hpc._prelude(root) + _list_script(path), 30)


def inspect(paths):
    """Inspect dataset-file metadata and readability without opening file contents."""
    try:
        if not isinstance(paths, list) or not 1 <= len(paths) <= MAX_INSPECT_PATHS:
            raise ValueError(f'Select between 1 and {MAX_INSPECT_PATHS} files.')
        checked = [_safe_path(path) for path in paths]
        if len(set(checked)) != len(checked):
            raise ValueError('Select each file only once.')
        if len(json.dumps({'paths': checked}).encode()) > MAX_INSPECT_BODY:
            raise ValueError('The selected file paths are too long.')
    except ValueError as error:
        return {'status': 'invalid', 'executed': False, 'error': str(error)}
    return _call(lambda root: hpc._prelude(root) + _inspect_script(checked), 30)
