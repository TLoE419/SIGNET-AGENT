"""Browse HPC3 folders and choose reference files for the desktop's file window.

Only the window's HTTP routes call this module. It is deliberately not a model
tool: file names and paths can reveal research details, so they never reach the
assistant, which sees only whether a reference is ready. Browsing reads names,
types and sizes. Selecting reads a few leading lines to check the format and
returns a verdict, never file contents. Files stay where they are: a selection
records the path in refdata/selected.tsv and is never copied.
"""
import posixpath
import re
import json
import shlex

from agent.runtime import hpc, ssh_transport

KEYS = tuple(hpc.REFERENCES)
ACCESS_RESOURCES = ('--partition=free', '--cpus-per-task=1', '--mem=512M', '--time=00:10:00')
_SAFE = r'/[A-Za-z0-9_./-]+'
_UNREADABLE_ON_COMPUTE = ('/tmp', '/var/tmp', '/dev/shm', '/run')
UNSUPPORTED_NAME = 'Paths may use only letters, numbers, _, -, . and /, because SIGNET scripts cannot handle others.'
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


_FORMAT_CHECKS = r'''
FORMATS = {'__name__': 'prepare_reference'}
exec(sys.argv[3], FORMATS)
def _gtf_problem(path):
    with open(path, 'rb') as stream:
        if stream.read(2) == b'\x1f\x8b':
            return 'SIGNET needs an uncompressed GTF. Decompress this file first.'
    with open(path, errors='replace') as stream:
        for number, line in enumerate(stream):
            if number >= 5000:
                break
            if line.startswith('#') or not line.strip():
                continue
            fields = line.rstrip('\n').split('\t')
            if len(fields) != 9:
                return 'This is not a GTF file: rows need 9 tab-separated columns.'
            if fields[2] == 'gene':
                if 'transcript_type' in fields[8]:
                    return None
                return 'This GTF is not collapsed: gene rows have no transcript_type, so signet -t would find 0 genes.'
    return 'This GTF has no gene rows near its start.'
def _clinical_problem(path):
    with open(path, errors='replace', newline='') as stream:
        header = stream.readline()
    if header.endswith('\r\n'):
        return 'This file has Windows line endings, which R would keep in the last column. Convert it first.'
    columns = header.rstrip('\n').split('\t')
    missing = [name for name in ('submitter_id', 'race') if name not in columns]
    return ('This clinical file needs tab-separated columns: ' + ', '.join(missing) + '.') if missing else None
def format_problem(key, path):
    try:
        if key == 'ref':
            return None if FORMATS['reference_format'](path) else 'Unsupported reference format. Use VCF (.vcf or .vcf.gz) or IMPUTE2 .gen.'
        if key == 'gmap':
            return None if FORMATS['genetic_map_format'](path) else 'Unsupported genetic map. Use "pos chr cM" or IMPUTE2 "position rate cM".'
        return _gtf_problem(path) if key == 'gtf' else _clinical_problem(path)
    except (OSError, UnicodeError, EOFError):
        return 'This file could not be read as text.'
'''

_SELECTIONS = r'''
import shutil, subprocess, time, uuid
TABLE = os.path.join(os.environ['W'], 'refdata', 'selected.tsv')
STATE = os.environ['D']
def read_table():
    table = {}
    if os.path.isfile(TABLE):
        with open(TABLE) as stream:
            for line in stream:
                key, _, path = line.rstrip('\n').partition('\t')
                if SAFE.fullmatch(path):
                    table[key] = path
    return table
def write_table(table):
    os.makedirs(os.path.dirname(TABLE), exist_ok=True)
    with open(TABLE + '.partial', 'w') as stream:
        stream.writelines(key + '\t' + path + '\n' for key, path in sorted(table.items()))
    os.replace(TABLE + '.partial', TABLE)
def forget_access(key):
    marker = os.path.join(STATE, 'selected-' + key + '.check')
    try:
        with open(marker) as stream:
            identifier = stream.read().partition('\t')[0]
        os.unlink(marker)
        if re.fullmatch(r'[a-f0-9]{32}', identifier):
            shutil.rmtree(os.path.join(STATE, 'selected-' + key + '-' + identifier), ignore_errors=True)
    except FileNotFoundError:
        pass
    for suffix in ('status', 'job', 'log'):
        try:
            os.unlink(os.path.join(STATE, 'selected-' + key + '.' + suffix))
        except FileNotFoundError:
            pass
def conversion_running():
    try:
        with open(os.path.join(STATE, 'prepare.job')) as stream:
            job = stream.read().strip()
        return bool(job and subprocess.run(['squeue', '-h', '-j', job, '-o', '%T'], capture_output=True, text=True).stdout.strip())
    except OSError:
        return False
def retire_conversion(key):
    # Output built from the previous ref or gmap no longer matches; keep it, under another name.
    out = os.path.join(os.environ['W'], PREPARED)
    if key in ('ref', 'gmap') and os.path.isdir(out):
        os.rename(out, out + '.replaced-' + str(int(time.time())))
'''


def _select_script(root, key, path):
    """Check one file, record it, and submit a small job that proves compute nodes and the container can read it."""
    prelude = ssh_transport.runtime_module_prelude(hpc._CONFIG.get() or {})
    job = f'''#!/bin/bash
check="$SIGNET_SELECTED_CHECK"
[ -d "$check" ] || exit 0
result=failed
{hpc._IMAGE_SIGNATURE}
signature="$(image_signature)"
if [ -n "$signature" ] && [ -n "$E" ] && [ -r "$SIGNET_SELECTED" ] &&
   head -c 1 "$SIGNET_SELECTED" > /dev/null; then
  {prelude}
  folder="$(dirname "$SIGNET_SELECTED")"
  if "$E" exec --cleanenv --no-home --bind "$folder:$folder:ro" "$I" test -r "$SIGNET_SELECTED" &&
     [ "$(image_signature)" = "$signature" ]; then result=ok; fi
fi
printf '%s\\t%s\\n' "$result" "$signature" > "$check/status.partial" && mv "$check/status.partial" "$check/status"
'''
    body = _FORMAT_CHECKS + _SELECTIONS + f'''
PREPARED = {hpc.PREPARED!r}
key, requested = sys.argv[1], sys.argv[2]
real = os.path.realpath(requested)
result = None
if not SAFE.fullmatch(real):
    result = {{'status': 'invalid', 'error': {UNSUPPORTED_NAME!r}}}
elif real == os.path.sep or any(real == top or real.startswith(top + '/') for top in {_UNREADABLE_ON_COMPUTE!r}):
    result = {{'status': 'invalid', 'error': 'Compute nodes cannot read this location. Choose a file in home, /pub, /dfs or CRSP.'}}
elif not os.path.isfile(real):
    result = {{'status': 'invalid', 'error': 'Select a file, not a folder.'}}
elif not os.access(real, os.R_OK):
    result = {{'status': 'invalid', 'error': 'Your account cannot read this file.'}}
elif os.path.getsize(real) == 0:
    result = {{'status': 'invalid', 'error': 'This file is empty.'}}
elif conversion_running():
    result = {{'status': 'blocked', 'error': 'A reference conversion is running. Wait for it to finish before changing files.'}}
else:
    problem = format_problem(key, real)
    if problem:
        result = {{'status': 'invalid', 'error': problem}}
if result is None:
    table = read_table()
    if table.get(key) != real:
        retire_conversion(key)
    table[key] = real
    write_table(table)
    forget_access(key)
    started = False
    image = os.environ['I']
    if os.environ['E'] and os.path.isfile(image) and os.path.getsize(image) > 0:
        identifier = uuid.uuid4().hex
        check = os.path.join(STATE, 'selected-' + key + '-' + identifier)
        os.mkdir(check, 0o700)
        marker = os.path.join(STATE, 'selected-' + key + '.check')
        with open(marker + '.partial', 'w') as stream:
            stream.write(identifier + '\\t' + real + '\\n')
        os.replace(marker + '.partial', marker)
        done = subprocess.run(['sbatch', '--parsable', '--job-name=signet-file-check', {', '.join(repr(item) for item in ACCESS_RESOURCES)},
                               '--output=' + os.path.join(check, 'slurm.log'), os.path.join(STATE, 'selected.sbatch')],
                              capture_output=True, text=True, env={{**os.environ, 'SIGNET_SELECTED': real, 'SIGNET_SELECTED_CHECK': check}})
        job = done.stdout.strip().split(';')[0]
        started = done.returncode == 0 and job.isdigit()
        if started:
            with open(os.path.join(check, 'job'), 'w') as stream:
                stream.write(job + '\\n')
    result = {{'status': 'ok', 'path': real, 'size': os.path.getsize(real), 'access_check_started': started}}
'''
    return hpc._prelude(root) + hpc._step_lock('selected') + f'''cat > "$D/selected.sbatch" <<'SIGNET_JOB'
{job}SIGNET_JOB
''' + _python(body, key, path, hpc._PREPARE_SOURCE)


def _clear_script(root, key):
    body = _SELECTIONS + f'''
PREPARED = {hpc.PREPARED!r}
key = sys.argv[1]
if conversion_running():
    result = {{'status': 'blocked', 'error': 'A reference conversion is running. Wait for it to finish before changing files.'}}
else:
    table = read_table()
    if table.pop(key, None):
        retire_conversion(key)
        write_table(table)
    forget_access(key)
    result = {{'status': 'ok'}}
'''
    return hpc._prelude(root) + hpc._step_lock('selected') + _python(body, key)


def _selected_script(root):
    return hpc._prelude(root) + _python(_SELECTIONS + "result = {'status': 'ok', 'selected': read_table()}\n")


def _call(script, timeout):
    values, error = hpc._run(script, timeout=timeout)
    if error:
        return error
    if values.get('selected') == 'in_progress':
        return {'status': 'blocked', 'error': 'Another file selection is in progress. Try again in a moment.'}
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


def select(key, path):
    if key not in KEYS:
        return {'status': 'invalid', 'error': f'file must be one of {", ".join(KEYS)}.'}
    try:
        path = _safe_path(path)
    except ValueError as error:
        return {'status': 'invalid', 'error': str(error)}
    return _call(lambda root: _select_script(root, key, path), 60)


def clear(key):
    if key not in KEYS:
        return {'status': 'invalid', 'error': f'file must be one of {", ".join(KEYS)}.'}
    return _call(lambda root: _clear_script(root, key), 30)


def selected():
    return _call(_selected_script, 30)
