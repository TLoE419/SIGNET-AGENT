"""HPC3 workspace layout, read-only readiness checks and one-step-at-a-time setup over the app's SSH connection.

The desktop EnvironmentService owns the verified workspace, pinned source,
container executor and scheduler partition. Readiness reports only shared
runtime prerequisites and the app's own installation state.

Each setup step returns as soon as it has started: light steps run as a
detached process on the login node; downloads run as Slurm jobs, because login
nodes must not download large files and compute nodes can reach the internet. Step state and logs live under the configured workspace, isolated by installation root. Setup only adds what is
missing and never overwrites existing files.
"""
from contextvars import ContextVar
import json
import hashlib
import os
from pathlib import Path
import re
import shlex
import subprocess
import threading
import time

from agent.runtime import ssh_transport
from agent.paths import PROJECT_ROOT

_CONFIG = ContextVar('hpc_config', default=None)
SOURCE_INVENTORY = json.loads((PROJECT_ROOT / 'signet_inventory.json').read_text())

SIGNET_DIRECTORY = 'signet'
CONTAINER = 'images/signet-0.0.6.sif'
# The Sylabs library is gone; this is the image file provided by Prof. Zhang.
CONTAINER_URL = ('https://drive.usercontent.google.com/download'
                 '?id=1ZiNC3jwu9g2vHuRBLTjpz6i02xZl1ELE&export=download&confirm=t')
CONTAINER_BYTES = 6383458834
CONTAINER_SHA256 = 'de28f224f3da41b17ff08a03d0f04b1d5c033b2afbad18ed448b646b2feda277'
CONTAINER_RESOURCES = ('--partition=free', '--cpus-per-task=1', '--mem=2G', '--time=02:00:00')
WORKSPACE_FOLDERS = ('refdata', 'runs')
# Historical example paths still resolve in Data and earlier runs. They are
# inputs to individual analyses, not environment prerequisites.
REFERENCE_FILES = {
    'ref': 'refdata/ref/ALL.chr1.GRCh38.phased.vcf.gz',
    'gmap': 'refdata/gmap/chr1.b38.gmap.gz',
    'gtf': 'refdata/gencode.v22.genes.gtf',
    'clinical': 'refdata/clinical.tsv',
}
PREPARED = 'refdata/prepared/example'
JOB_STEPS = ('container',)
STEPS = ('workspace', 'signet', *JOB_STEPS)
STATE_DIRECTORY = '$HOME/.signet-agent/steps'
LOG_LINES = 20
_SEGMENT = r'(?:[A-Za-z0-9._-]+|\$USER)'
_MARKER = '@@'


def workspace():
    """Use only the current Electron-verified environment, never a separate override."""
    return (_CONFIG.get() or ssh_transport.environment())['root']


def _prelude(root):
    # The path is validated, so double quotes only expand $USER. state_of reads
    # the app's own step file with shell builtins and keeps its last state line.
    config = _CONFIG.get()
    state = f"{root}/.signet-agent/steps" if config else STATE_DIRECTORY
    source = config['source'] if config else f'{root}/{SIGNET_DIRECTORY}'
    image = config['image'] if config else f'{root}/{CONTAINER}'
    executor = config['executor'] if config else 'apptainer'
    return f'''
S="{source}"
I="{image}"
E="{executor}"
W="{root}"
D="{state}"
export W D S I E
umask 077
say() {{ printf '{_MARKER}%s\\t%s\\n' "$1" "$2"; }}
state_of() {{
  local line value=""
  [ -f "$D/$1.status" ] || return 0
  while IFS= read -r line; do case "$line" in state=*) value="${{line#state=}}";; esac; done < "$D/$1.status"
  printf %s "$value"
}}
field_of() {{
  local line value=""
  [ -f "$D/$1.status" ] || return 0
  while IFS= read -r line; do case "$line" in "$2"=*) value="${{line#$2=}}";; esac; done < "$D/$1.status"
  printf %s "$value"
}}
say workspace_path "$W"
'''


def _report_steps():
    """Shell that reports each step's recorded state, and whether a login-node process is still alive."""
    return f'''
for step in {' '.join(JOB_STEPS)}; do
  [ -s "$D/$step.job" ] || continue
  read -r job < "$D/$step.job"
  say "job_$step" "$job"
  say "job_${{step}}_state" "$(squeue -h -j "$job" -o %T 2>/dev/null)"
  terminal_job="$(field_of "$step" job)"; terminal="$(state_of "$step")"
  if [[ "$job" =~ ^[0-9]+$ ]] && [ "$terminal_job" = "$job" ] && {{ [ "$terminal" = done ] || [ "$terminal" = failed ]; }}; then
    say "job_${{step}}_terminal" "$terminal"
    say "job_${{step}}_terminal_job" "$terminal_job"
  fi
done
for step in workspace signet; do
  st="$(state_of $step)"
  [ -n "$st" ] || continue
  host="$(field_of $step host)"; pid="$(field_of $step pid)"
  if [ "$st" = running ] && [ "$host" = "$(hostname)" ] && [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then st=stopped; fi
  say "step_$step" "$st"; say "step_${{step}}_host" "$host"
done
'''


_SETUP_WATCH_SOURCE = (Path(__file__).with_name('jobs') / 'watch_setup.py').read_text()
_SETUP_WATCHERS = threading.BoundedSemaphore(2)
# Closing the local broker socket does not cancel a remote exec. Retain its
# admission slot through the bounded SSH command plus its preceding health check.
_SETUP_WATCH_LEASE_SECONDS = 90


def _setup_watch_script(root, cursor=None, seconds=0):
    config = _CONFIG.get() or {'root': root, 'source': root + '/signet', 'image': root + '/' + CONTAINER}
    scope = hashlib.sha256(json.dumps(config, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    args = [root, config['source'], config['image'], scope, cursor or '0' * 64, str(seconds)]
    return ("python3 - " + ' '.join(shlex.quote(value) for value in args)
            + " <<'SIGNET_SETUP_WATCH'\n" + _SETUP_WATCH_SOURCE + "\nSIGNET_SETUP_WATCH\n")


def watch_setup(cursor, cancel_event=None):
    """Wait for fixed setup metadata changes; no full checks, scheduler calls or writes."""
    if not isinstance(cursor, str) or not re.fullmatch(r'[a-f0-9]{64}', cursor):
        return {'status': 'invalid', 'executed': False, 'error': 'Invalid setup cursor.'}
    if not _SETUP_WATCHERS.acquire(blocking=False):
        return {'status': 'unavailable', 'executed': False, 'reason': 'A setup status wait is already active. Retry shortly.'}
    semaphore = _SETUP_WATCHERS
    started = None
    confirmed = False
    def command(root):
        nonlocal started
        script = _prelude(root) + _setup_watch_script(root, cursor, 45)
        started = time.monotonic()
        return script
    try:
        values, error = _run(command,
                             timeout=55, required='setup_cursor',
                             **({'cancel_event': cancel_event} if cancel_event is not None else {}))
        confirmed = error is None
    finally:
        remaining = max(0, _SETUP_WATCH_LEASE_SECONDS - (time.monotonic() - started)) if started is not None else 0
        if remaining and (not confirmed or cancel_event is not None and cancel_event.is_set()):
            release = threading.Timer(remaining, semaphore.release)
            release.daemon = True
            release.start()
        else:
            semaphore.release()
    if error:
        return error
    current = values.get('setup_cursor', '')
    if (not re.fullmatch(r'[a-f0-9]{64}', current) or values.get('setup_changed') not in ('yes', 'no')
            or (values['setup_changed'] == 'yes') != (current != cursor)):
        return {'status': 'failed', 'executed': False, 'reason': 'Invalid remote setup notification.'}
    return {'status': 'ok', 'executed': False, 'read_only': True, 'workspace': values.get('workspace_path'),
            'setup_cursor': current, 'changed': values['setup_changed'] == 'yes'}


def _setup_status_hook(step):
    if step not in STEPS:
        raise ValueError('Invalid setup step.')
    return f'''mkdir -p "$D"
printf 'job=%s\\nstate=running\\n' "${{SLURM_JOB_ID:-}}" > "$D/{step}.status"
signet_setup_exit() {{
  result=$?
  trap - EXIT
  state=failed; [ "$result" -ne 0 ] || state=done
  printf 'state=%s\\n' "$state" >> "$D/{step}.status"
  exit "$result"
}}
trap signet_setup_exit EXIT
'''


def _check_script(root):
    config = _CONFIG.get()
    if config is not None and config.get('revision') != SOURCE_INVENTORY['revision']:
        raise ValueError('Desktop source revision does not match the audited inventory; recheck the remote environment.')
    # Match EnvironmentService.sourceCheck: the installed archive has no Git metadata.
    return _prelude(root) + '''
say user "$(id -un)"
say host "$(hostname)"
if command -v sbatch >/dev/null 2>&1; then say sbatch yes; else say sbatch no; fi
if "$E" --version >/dev/null 2>&1; then
  say apptainer "$("$E" --version 2>/dev/null | head -n 1)"
else say apptainer no; fi
if command -v timeout >/dev/null 2>&1; then
  workspace_status=0
  timeout -k 1s 8s stat -- "$W" >/dev/null 2>&1 || workspace_status=$?
  case "$workspace_status" in 124|137) say workspace_timeout yes; exit 0;; esac
fi
''' + _setup_watch_script(root) + f'''
if [ -d "$W" ]; then say workspace yes; if [ -w "$W" ]; then say workspace_writable yes; else say workspace_writable no; fi
else say workspace no; fi
if [ ! -e "$S" ]; then say signet no
elif [ ! -d "$S" ] || [ -L "$S" ]; then say signet invalid
else
  say signet yes
  if [ -d "$S/example" ]; then say signet_example present; else say signet_example missing; fi
fi
if [ -s "$I" ]; then say file_container "$(stat -c %s "$I" 2>/dev/null || stat -f %z "$I")"
elif [ -e "$I" ]; then say file_container empty
else say file_container no; fi
''' + _report_steps()


def _ensure_workspace():
    """Shell that creates the workspace (owner-only) and its folders if missing.

    $W is unquoted so the same text works inside a single-quoted detached
    command and inside sbatch --wrap "..."; workspace() allows no spaces or quotes.
    """
    folders = ' '.join(f'$W/{folder}' for folder in WORKSPACE_FOLDERS)
    return f'umask 077; if [ ! -d $W ]; then mkdir -p $W && chmod 700 $W; fi && mkdir -p {folders}'


# Clone and download create a missing workspace first, so the user never has to.
_NOTE_MISSING_WORKSPACE = 'if [ ! -d "$W" ]; then say creates_workspace yes; fi\n'


def _step_lock(step):
    """Serialize concurrent panel/model requests without replacing another job's state."""
    return f'''mkdir -p "$D"
if ! mkdir "$D/{step}.lock" 2>/dev/null; then say {step} in_progress; exit 0; fi
trap 'rmdir "$D/{step}.lock"' EXIT
'''


def _container_job():
    """Batch script that downloads the image on a compute node and publishes it only after verification."""
    return f'''#!/bin/bash
set -euo pipefail
{_setup_status_hook('container')}PARTIAL="$I.partial"
mkdir -p "$(dirname "$I")"
rm -f "$PARTIAL"
curl -fL --retry 3 -o "$PARTIAL" '{CONTAINER_URL}'
size="$(stat -c %s "$PARTIAL")"
if [ "$size" != "{CONTAINER_BYTES}" ]; then
  rm -f "$PARTIAL"
  echo "Downloaded $size bytes, expected {CONTAINER_BYTES}; the source may have returned a page instead of the file." >&2
  exit 1
fi
digest="$(sha256sum "$PARTIAL" | cut -d " " -f 1)"
if [ "$digest" != "{CONTAINER_SHA256}" ]; then
  rm -f "$PARTIAL"
  echo "Checksum mismatch: got $digest, expected {CONTAINER_SHA256}." >&2
  exit 1
fi
# A hard link refuses to replace an image that appeared during the download.
ln "$PARTIAL" "$I"
rm -f "$PARTIAL"
echo "Saved $I ($size bytes, sha256 $digest)"
'''


def _container_script(root):
    """Submit the image download as a Slurm job unless the image exists or is already downloading."""
    return _prelude(root) + _step_lock('container') + f'''
running=""
if [ -s "$D/container.job" ]; then read -r job < "$D/container.job"; running="$(squeue -h -j "$job" -o %T 2>/dev/null)"; fi
if [ -n "$running" ]; then say container in_progress; say container_job "$job"
elif [ -s "$I" ]; then say container existing
else
''' + _NOTE_MISSING_WORKSPACE + f'''  mkdir -p "$D" && chmod 700 "$D"
  cat > "$D/container.sbatch" <<'SIGNET_JOB'
{_container_job()}SIGNET_JOB
  job="$(sbatch --parsable --job-name=signet-container {' '.join(CONTAINER_RESOURCES)} --output="$D/container.log" "$D/container.sbatch" 2>/dev/null)"
  job="${{job%%;*}}"
  if [ -n "$job" ]; then printf '%s\\n' "$job" > "$D/container.job"; say container started; say container_job "$job"
  else say container failed; fi
fi
'''


def _source_install(config):
    """Shell that fetches the pinned SIGNET commit and publishes only its audited, hash-verified files.

    A fresh installation also includes the official example data. An installation made
    before the example data was added gains only the example folder; nothing that already
    exists is replaced. Files are staged beside the destination and moved in only after
    every hash matches.
    """
    inventory = SOURCE_INVENTORY
    q = shlex.quote
    root, source, revision, repository = config['root'], config['source'], inventory['revision'], inventory['repository']
    sums = lambda items: ''.join(f"{item['sha256']}  {item['path']}\n" for item in items)
    source_sums = sums(inventory['scripts'] + inventory['support_files'])
    example_sums = sums(inventory.get('example_files', []))
    source_files = [item['path'] for item in inventory['scripts'] + inventory['support_files'] + inventory.get('example_files', [])]
    source_files += ['LICENSE.txt', 'LICENSE_THIRD_PARTY.md']
    example_files = [item['path'] for item in inventory.get('example_files', [])]

    def fetch(files):
        return f"""git -C "$stage/repository" init -q
git -C "$stage/repository" fetch -q --depth=1 {q(repository)} {q(revision)}
git -C "$stage/repository" archive {q(revision)} -- {' '.join(q(name) for name in files)} | tar -xf - -C "$stage/source"
"""

    return f"""set -euo pipefail
umask 077
S={q(source)}
mkdir -p {q(root + '/software')}
if [ ! -e "$S" ]; then
  echo "Installing SIGNET {revision} with its example data into $S"
  stage=$(mktemp -d {q(root + '/software/.install-XXXXXX')})
  trap 'rm -rf -- "$stage"' EXIT
  mkdir "$stage/repository" "$stage/source"
{fetch(source_files)}  (cd "$stage/source" && sha256sum --check --status <<'SIGNET_HASHES'
{source_sums}{example_sums}SIGNET_HASHES
  )
  # -T refuses replacement if a directory appeared while downloading.
  mv -T -n "$stage/source" "$S"
elif [ ! -e "$S/example" ]; then
  echo "Adding the SIGNET example data to $S"
  stage=$(mktemp -d {q(root + '/software/.example-XXXXXX')})
  trap 'rm -rf -- "$stage"' EXIT
  mkdir "$stage/repository" "$stage/source"
{fetch(example_files)}  (cd "$stage/source" && sha256sum --check --status <<'SIGNET_EXAMPLE_HASHES'
{example_sums}SIGNET_EXAMPLE_HASHES
  )
  mv -T -n "$stage/source/example" "$S/example"
else
  echo "SIGNET and its example data are already installed; nothing was changed."
  exit 0
fi
(cd "$S" && sha256sum --check --status <<'SIGNET_HASHES'
{source_sums}SIGNET_HASHES
)
(cd "$S" && sha256sum --check --status <<'SIGNET_EXAMPLE_HASHES'
{example_sums}SIGNET_EXAMPLE_HASHES
)
echo "Installed and verified SIGNET {revision}."
"""



def _signet_script(root):
    """Start the source installation as a detached login-node process unless it is present or running.

    It is light (one shallow fetch of the pinned commit), so it does not wait in the Slurm queue.
    Its state (running, done, failed), host and process ID go to $D/signet.status for the check.
    """
    config = _CONFIG.get() or {'root': root, 'source': f'{root}/{SIGNET_DIRECTORY}'}
    if config.get('revision', SOURCE_INVENTORY['revision']) != SOURCE_INVENTORY['revision']:
        raise ValueError('Desktop source revision does not match the audited inventory; recheck the remote environment.')
    return _prelude(root) + _step_lock('signet') + f"""
st="$(state_of signet)"; host="$(field_of signet host)"; pid="$(field_of signet pid)"
if [ "$st" = running ] && {{ [ "$host" != "$(hostname)" ] || kill -0 "$pid" 2>/dev/null; }}; then say signet in_progress
elif [ -L "$S" ] || {{ [ -e "$S" ] && [ ! -d "$S" ]; }}; then say signet failed
elif [ -d "$S" ] && [ -d "$S/example" ]; then say signet existing
elif ! command -v git >/dev/null 2>&1; then say signet needs_git
else
{_NOTE_MISSING_WORKSPACE}  {_ensure_workspace()}
  mkdir -p "$D" && chmod 700 "$D"
  cat > "$D/signet.install" <<'SIGNET_INSTALL'
{_source_install(config)}SIGNET_INSTALL
  printf 'state=running\\nhost=%s\\n' "$(hostname)" > "$D/signet.status"
  # Output goes to the log; only the final state line goes to the status file.
  nohup setsid bash -c 'if bash "$1/signet.install"; then s=done; else s=failed; fi; printf "state=%s\\n" "$s" >> "$1/signet.status"' _ "$D" > "$D/signet.log" 2>&1 < /dev/null &
  printf 'pid=%s\\n' "$!" >> "$D/signet.status"
  say signet started
fi
"""



def _log_script(step, root='/'):
    return _prelude(root) + f'''
if [ -f "$D/{step}.log" ]; then say log_exists yes; tail -n {LOG_LINES} "$D/{step}.log" | sed 's/^/{_MARKER}line\\t/'
else say log_exists no; fi
'''


def _parse(stdout):
    values, lines = {}, []
    for line in stdout.decode('utf-8', 'replace').splitlines():
        if line.startswith(_MARKER) and '\t' in line:
            key, value = line[len(_MARKER):].split('\t', 1)
            if key == 'line':
                lines.append(value)
            else:
                values[key] = value.strip()
    if lines:
        values['lines'] = lines
    return values


def _size(value):
    size = int(value)
    for unit in ('B', 'KB', 'MB', 'GB'):
        if size < 1024 or unit == 'GB':
            return f'{size:.0f} {unit}' if unit == 'B' else f'{size:.1f} {unit}'
        size /= 1024


def _step_status(values, step):
    """A missing item may be explained by a running, stopped or failed setup step."""
    state, host = values.get(f'step_{step}'), values.get(f'step_{step}_host')
    if state == 'running':
        return 'in_progress', f'Setup is running in the background on {host}; check again later.'
    if state in ('failed', 'stopped'):
        task = 'SIGNET installation' if step == 'signet' else 'workspace setup'
        return 'problem', f'The last {task} {state}.'
    return None


def _workspace_pending(values):
    """Clone and download create the workspace themselves; say so while they are queued or running."""
    if values.get('step_signet') == 'running':
        return 'in_progress', 'Being created by the running SIGNET installation.'
    for step in JOB_STEPS:
        if values.get(f'job_{step}_state'):
            return 'in_progress', f"Will be created by download job {values.get(f'job_{step}')} when it starts."
    return None


def _checks(values, revision):
    checks = []
    add = lambda item, status, detail: checks.append({'item': item, 'status': status, 'detail': detail})
    add('connection', 'ok', f"{values.get('user', '?')} on {values.get('host', '?')}")
    workspace_timeout = values.get('workspace_timeout') == 'yes'
    if workspace_timeout:
        add('workspace', 'problem', 'Reading the HPC3 workspace directory timed out.')
    elif values.get('workspace') != 'yes':
        add('workspace', *(_step_status(values, 'workspace') or _workspace_pending(values)
                           or ('missing', f"Folder {values.get('workspace_path')} does not exist yet.")))
    elif values.get('workspace_writable') != 'yes':
        add('workspace', 'problem', f"Folder {values.get('workspace_path')} exists but is not writable.")
    else:
        add('workspace', 'ok', values.get('workspace_path'))
    add('slurm', 'ok' if values.get('sbatch') == 'yes' else 'problem',
        'sbatch available.' if values.get('sbatch') == 'yes' else 'sbatch is unavailable; jobs cannot be submitted.')
    apptainer = values.get('apptainer', 'no')
    add('apptainer', 'problem' if apptainer == 'no' else 'ok',
        'Singularity or Apptainer was not found.' if apptainer == 'no' else apptainer)
    if workspace_timeout:
        for item in ('signet_source', 'container'):
            add(item, 'unknown', 'Waiting for the remote workspace directory to respond.')
        return checks
    signet = values.get('signet', 'no')
    if signet == 'no':
        add('signet_source', *(_step_status(values, 'signet') or ('missing', 'SIGNET has not been installed in the remote environment.')))
    elif signet != 'yes':
        add('signet_source', 'problem', f'Audited source verification failed for revision {revision[:12]}; files may be missing or modified. Recheck HPC3 settings.')
    elif values.get('signet_example') == 'missing':
        add('signet_source', *(_step_status(values, 'signet') or
                               ('missing', 'The SIGNET example data has not been installed; press Install to add it.')))
    elif values.get('signet_example') == 'mismatch':
        add('signet_source', 'problem', 'The SIGNET example data differs from the pinned revision; move the example folder aside, then install again.')
    else:
        add('signet_source', 'ok', f'Installed at pinned revision {revision[:12]}. Its files are verified by the HPC3 settings check.')
    value = values.get('file_container', 'no')
    job, state = values.get('job_container'), values.get('job_container_state')
    terminal = values.get('job_container_terminal')
    current_terminal = bool(job and values.get('job_container_terminal_job') == job)
    if current_terminal and terminal == 'failed':
        add('container', 'problem', f'Setup job {job} failed.')
    elif current_terminal and terminal == 'done' and value == 'no':
        add('container', 'problem', f'Setup job {job} finished without producing {CONTAINER}.')
    elif value == 'no' and state:
        add('container', 'in_progress', f'Download job {job} is {state.lower()}. Check again later.')
    elif value == 'no' and job:
        add('container', 'problem', f'Download job {job} ended without producing {CONTAINER}.')
    elif value == 'no':
        add('container', 'missing', f'{CONTAINER} is missing.')
    elif value == 'empty':
        add('container', 'problem', f'{CONTAINER} is empty.')
    else:
        add('container', 'ok', f'{CONTAINER} ({_size(value)})')
    return checks


def _transport_failure(error):
    failure = {'status': 'unavailable', 'executed': False}
    if isinstance(error, ssh_transport.LocalRuntimeHelperError):
        return {**failure, 'code': 'local_runtime_missing',
                'reason': 'A required SIGNET app file is missing or unreadable. Repair the installation and try again.',
                'detail': 'Local application file: runtime_modules.sh.'}
    if ssh_transport.is_timeout(error):
        return {**failure, 'code': 'remote_timeout',
                'reason': 'HPC3 did not respond in time. Check the environment again.'}
    if isinstance(error, ssh_transport.SshRemoteError) and error.code in ('SESSION_CLOSED', 'STALE_CONNECTION'):
        return {**failure, 'code': 'remote_disconnected',
                'reason': 'The connection to HPC3 ended. Reconnect and check the environment again.'}
    return {**failure, 'reason': 'Could not reach HPC3. Check the SSH panel and try again.'}


def _run(script, timeout, required='workspace_path', cancel_event=None):
    """Run a fixed script in a login shell (so `module` exists); return markers or an error result."""
    if not ssh_transport.available():
        return None, {'status': 'unavailable', 'executed': False,
                      'reason': 'Not running in the desktop app, so there is no HPC3 connection to use.'}
    try:
        config = ssh_transport.setup_environment(**({'cancel_event': cancel_event} if cancel_event is not None else {}))
    except ssh_transport.SshRemoteError as error:
        # SSH works; the desktop has no configured environment yet, and its message says why.
        return None, {'status': 'not_ready', 'executed': False, 'reason': str(error)}
    except OSError as error:
        return None, _transport_failure(error)
    try:
        context = _CONFIG.set(config)
        try:
            command = script(workspace())
            if config.get('partition'):
                command = command.replace('--partition=free', '--partition=' + config['partition'])
            command = ssh_transport.runtime_module_prelude(config) + '\n' + command
        finally:
            _CONFIG.reset(context)
        result = ssh_transport.remote('bash -s', input=command.encode(),
                                      capture_output=True, timeout=timeout,
                                      **({'cancel_event': cancel_event} if cancel_event is not None else {}))
    except ValueError as error:
        return None, {'status': 'invalid', 'executed': False, 'error': str(error)}
    except (OSError, subprocess.SubprocessError) as error:
        return None, _transport_failure(error)
    values = _parse(result.stdout)
    if result.returncode != 0 or required not in values:
        return None, {'status': 'failed', 'executed': False,
                      'reason': 'The HPC3 command did not complete. Run check_hpc_environment to see the current state.'}
    return values, None


def check_environment(revision):
    """Run one read-only check over the Electron-owned SSH connection and summarize it."""
    values, error = _run(_check_script, timeout=90)
    if error:
        return error
    checks = _checks(values, revision)
    missing = [check['item'] for check in checks if check['status'] != 'ok']
    return {'status': 'ok', 'executed': False, 'read_only': True, 'ready': not missing,
            'workspace': values.get('workspace_path'), 'checks': checks, 'not_ready': missing,
            **({'setup_cursor': values['setup_cursor']} if re.fullmatch(r'[a-f0-9]{64}', values.get('setup_cursor', '')) else {}),
            'evidence_scope': 'Shared environment only: connection, workspace, scheduler, runtime, pinned source and container. '
                              'Source integrity is verified by the desktop settings check. No study files were inspected or changed.'}


_OUTCOMES = {
    'started': 'Started in the background; call check_hpc_environment later to see when it finishes.',
    'in_progress': 'Already running in the background; nothing new was started.',
    'existing': 'Already present; left unchanged.',
    'needs_git': 'git is not available on the HPC3 login node, so SIGNET cannot be downloaded.',
    'failed': 'Could not start this step; nothing was changed.',
}


def start_step(step, repository=None, revision=None):
    """Start one setup step and return immediately with its outcome."""
    if step == 'signet' and (not re.fullmatch(r'https://[A-Za-z0-9./_-]+\.git', repository or '')
                             or not re.fullmatch(r'[0-9a-f]{40}', revision or '')):
        return {'status': 'invalid', 'executed': False, 'error': 'Invalid pinned SIGNET repository or revision.'}
    if step == 'signet' and (repository != SOURCE_INVENTORY['repository'] or revision != SOURCE_INVENTORY['revision']):
        return {'status': 'invalid', 'executed': False, 'error': 'SIGNET installation must match the audited repository and revision.'}
    if step not in STEPS:
        return {'status': 'invalid', 'executed': False, 'error': f'step must be one of {", ".join(STEPS)}.'}
    if step == 'workspace':
        return {'status': 'blocked', 'executed': False, 'step': step,
                'reason': 'Installing SIGNET creates the workspace; no separate step is needed.'}
    if step == 'container' and not CONTAINER_SHA256:
        return {'status': 'blocked', 'executed': False, 'step': step,
                'reason': 'The container checksum has not been pinned in this version of the app, so nothing was downloaded.'}
    script = {'container': _container_script, 'signet': _signet_script}[step]
    values, error = _run(script, timeout=120, required=step)
    if error:
        return error
    outcome = values[step] if values[step] in _OUTCOMES else 'failed'
    result = {'status': 'failed' if outcome == 'failed' else 'ok', 'executed': outcome == 'started',
              'step': step, 'outcome': outcome, 'detail': _OUTCOMES[outcome], 'workspace': values.get('workspace_path')}
    if values.get('creates_workspace') == 'yes' and outcome == 'started':
        result['creates_workspace'] = True
        result['detail'] += ' The workspace folder did not exist, so this step creates it first.'
    if values.get(f'{step}_job'):
        result['job_id'] = values[f'{step}_job']
    return result


def read_log(step):
    """Return the last lines of the app's own log for one setup step."""
    if step not in STEPS:
        return {'status': 'invalid', 'executed': False, 'error': f'step must be one of {", ".join(STEPS)}.'}
    values, error = _run(lambda root: _log_script(step, root), timeout=60, required='log_exists')
    if error:
        return error
    if values['log_exists'] != 'yes':
        return {'status': 'ok', 'executed': False, 'step': step, 'lines': [], 'detail': 'This step has not run yet.'}
    lines = values.get('lines', [])
    return {'status': 'ok', 'executed': False, 'step': step, 'lines': lines,
            'evidence_scope': f'Last {LOG_LINES} lines of the app-generated setup log only; never research data.'}
