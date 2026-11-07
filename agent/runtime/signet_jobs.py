"""Run single SIGNET steps (e.g. `signet -t`) on HPC3 as Slurm jobs, over the app's SSH connection.

This is the one place that decides what a step may do. The local HTTP API
(agent/app) and any future AI tool call these functions; neither builds shell
text itself. Callers pick a step from STEPS and pass validated values only.

Flow for one step of one local run (runs/<run_id>):
  submit()  upload the run's audited scripts and config.ini to
            <workRoot>/<run_id>, write steps/<step>.sbatch and sbatch it;
            returns at once with the Slurm job ID.
  status()  ask squeue/sacct (cached 15 s); when the job ends, check its
            outputs and logs, then download the results into the local run.
  cancel()  scancel the recorded job, after checking its job name.
  read_log() last lines of the job's stdout or stderr.

`signet` exits 0 even when a step fails, so "completed" needs all of: the job's
.done file says exit 0, every required output exists and is non-empty, and the
logs contain no known failure line. The login node only runs light commands
(mkdir, tar, sbatch, squeue, sacct, scancel, tail); SIGNET itself runs inside
the container in the Slurm job. Each step may be attempted once per run; a
retry uses a new run, as for local steps.

The HTTP server is multi-threaded, so submit/status/cancel of the same run and
step run one at a time (see _one_at_a_time); otherwise two status checks of a
finished job could both download the results and leave the record stuck.
"""
from dataclasses import dataclass
import functools
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import subprocess
import threading
import time

from agent.runtime import ssh_transport
import agent.runtime.remote as vm
import agent.tools.signet as signet

# Lines that mean a SIGNET/R step failed even though `signet` exited 0.
FAILURE_PATTERNS = ('Execution halted', 'Error in ', 'cannot open', 'No such file or directory', 'command not found')
ACTIVE = ('submitting', 'submitted', 'pending', 'running', 'validating', 'unknown')
TERMINAL = ('completed', 'failed', 'cancelled')
CACHE_SECONDS = 15
MAX_LOG_LINES = 200
_MARKER = '@@'
_PATH = re.compile(r'/[A-Za-z0-9_./-]+')
_SLURM_RUNNING = ('RUNNING', 'COMPLETING', 'CONFIGURING', 'SUSPENDED', 'STAGE_OUT')
_SLURM_FAILED = ('FAILED', 'OUT_OF_MEMORY', 'TIMEOUT', 'NODE_FAIL', 'PREEMPTED', 'BOOT_FAIL', 'DEADLINE')


class StepError(Exception):
    """A refused or failed request; `code` is one of the API error codes in spec §10."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Step:
    flag: str            # the signet option this step runs
    cohort: str          # the run's cohort must match
    inputs: tuple        # config.ini keys the caller sets to HPC3 file paths
    settings: dict       # config.ini keys the caller may change with update_settings, and their rule
    required: tuple      # outputs (relative to work/) that must exist and be non-empty
    download: str        # folder (relative to the run) copied back to this computer on success
    resources: dict      # default Slurm request
    limits: dict         # allowed range for each resource override
    description: str


STEPS = {
    'expression': Step(
        flag='-t', cohort='TCGA', inputs=('gexp.file', 'pmap.file'),
        settings={'restrict.tcga': 'chromosome'},
        # Written by script/gexp_prep/gpos.R with the rest.tcga prefix res/rest/signet.
        required=('res/rest/signet_gexp', 'res/rest/signet_gexpID',
                  'res/rest/signet_gene_pos', 'res/rest/signet_gene_name'),
        download='work/res/rest',
        resources={'cpus': 4, 'mem_gb': 16, 'hours': 2},
        limits={'cpus': (1, 16), 'mem_gb': (1, 64), 'hours': (0.25, 12)},
        description='TCGA expression preprocessing (signet -t): normalize read counts and find gene positions.'),
}


def catalog():
    """Describe every step so a form can be built without hard-coding: inputs, settings, resources, outputs."""
    return {'steps': [{'name': name, 'flag': step.flag, 'cohort': step.cohort, 'description': step.description,
                       'inputs': list(step.inputs), 'settings': step.settings,
                       'resources': step.resources, 'limits': {k: list(v) for k, v in step.limits.items()},
                       'required_outputs': list(step.required)} for name, step in STEPS.items()],
            'input_roots': ['<workspace>/refdata', '<signet source>/example', '<this run on HPC3>'],
            'states': ['submitted', 'pending', 'running', 'validating', *TERMINAL, 'unknown']}


# ---------- local run records ----------

def _step(name):
    if name not in STEPS:
        raise StepError('not_found', f'Unknown step: {name}.')
    return STEPS[name]


def _root(run_id):
    try:
        return signet._run(run_id)
    except ValueError as error:
        raise StepError('not_found', str(error)) from error


def _record_path(root, name):
    return root / 'steps' / f'{name}.json'


def _load(root, name):
    path = _record_path(root, name)
    if not path.is_file():
        raise StepError('not_found', f'Step {name} has not been submitted for this run.')
    return json.loads(path.read_text())


def _save(root, record):
    folder = root / 'steps'
    folder.mkdir(exist_ok=True)
    temporary = folder / f'{record["step"]}.json.tmp'
    temporary.write_text(json.dumps(record, indent=2) + '\n')
    temporary.replace(_record_path(root, record['step']))
    return record


def _change(record, state, **values):
    if record.get('state') != state:
        record.setdefault('history', []).append({'state': state, 'at': _now()})
    record.update(state=state, **values)


def _now():
    return time.strftime('%Y-%m-%dT%H:%M:%S%z')


_LOCKS = {}
_LOCKS_GUARD = threading.Lock()


def _one_at_a_time(function):
    """Run submit/status/cancel for one (run, step) one call at a time in this process.

    Without this, a UI timer and a manual refresh arriving together could both
    see a finished job, both download its results, and the slower one would save
    a stale record. Reentrant, because cancel() ends by calling status().
    """
    @functools.wraps(function)
    def wrapper(run_id, name, *args, **kwargs):
        with _LOCKS_GUARD:
            lock = _LOCKS.setdefault((run_id, name), threading.RLock())
        with lock:
            return function(run_id, name, *args, **kwargs)
    return wrapper


def _active_step(root):
    for path in sorted((root / 'steps').glob('*.json')) if (root / 'steps').is_dir() else ():
        record = json.loads(path.read_text())
        if record.get('state') in ACTIVE:
            return record['step']
    return None


def run_steps(run_id):
    """State of every step recorded for one run, e.g. {'expression': 'running'}."""
    root = _root(run_id)
    folder = root / 'steps'
    if not folder.is_dir():
        return {}
    return {path.stem: json.loads(path.read_text()).get('state') for path in sorted(folder.glob('*.json'))}


def update_settings(run_id, values):
    """Change whitelisted config.ini settings of a local run (signet -s). Refused while a step is active."""
    root = _root(run_id)
    if not isinstance(values, dict) or not values:
        raise StepError('invalid_request', 'values must be a non-empty object.')
    rules = {key: rule for step in STEPS.values() for key, rule in step.settings.items()}
    checked = {}
    for key, value in values.items():
        if key not in rules:
            raise StepError('invalid_request', f'{key} cannot be changed here.')
        checked[key] = _setting(key, rules[key], value)
    if _active_step(root) or (root / '.active').exists():
        raise StepError('conflict', 'A step of this run is still active; wait for it to finish.')
    signet._update(root, checked)
    return signet._settings(root)


def _setting(key, rule, value):
    if rule == 'chromosome':
        if value == 'no':
            return 'no'
        if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 22:
            return str(value)
        raise StepError('invalid_request', f'{key} must be "no" or a chromosome from 1 to 22.')
    raise StepError('invalid_request', f'No rule for {key}.')


# ---------- validation of caller values ----------

def _resources(step, overrides):
    if overrides is None:
        overrides = {}
    if not isinstance(overrides, dict) or set(overrides) - set(step.resources):
        raise StepError('invalid_request', 'resources may only set ' + ', '.join(step.resources) + '.')
    values = {**step.resources, **overrides}
    for key, (low, high) in step.limits.items():
        value = values[key]
        integer = key != 'hours'
        if (isinstance(value, bool) or not isinstance(value, (int, float)) or (integer and not isinstance(value, int))
                or not low <= value <= high):
            raise StepError('invalid_request', f'{key} must be between {low} and {high}.')
    minutes = round(values['hours'] * 60)
    return {**values, 'time': f'{minutes // 60:02d}:{minutes % 60:02d}:00'}


def _inputs(step, values, allowed):
    """Each input must be an HPC3 file path below one of the allowed roots; returns {key: (path, root)}."""
    if not isinstance(values, dict) or set(values) != set(step.inputs):
        raise StepError('invalid_request', 'inputs must set exactly: ' + ', '.join(step.inputs) + '.')
    checked = {}
    for key, value in values.items():
        if (not isinstance(value, str) or not _PATH.fullmatch(value) or '//' in value
                or any(part in ('.', '..') for part in value.split('/'))):
            raise StepError('invalid_request', f'{key} must be an absolute HPC3 path of letters, digits, _, ., / or -.')
        root = next((r for r in allowed if value.startswith(r + '/') and len(value) > len(r) + 1), None)
        if root is None:
            raise StepError('invalid_request', f'{key} must be inside ' + ', '.join(allowed) + '.')
        checked[key] = (value, root)
    return checked


# ---------- HPC3 access ----------

def _environment():
    if not ssh_transport.available():
        raise StepError('not_ready', 'Not running in the desktop app, so there is no HPC3 connection.')
    try:
        return ssh_transport.environment()
    except OSError as error:
        raise StepError('not_ready', 'Connect to HPC3 with the SSH panel first.') from error


def _shell(script, timeout=60):
    """Run a fixed script on the login node; returns (returncode, markers, lines). Raises OSError on connection loss."""
    result = ssh_transport.remote('bash -s', input=script.encode(), capture_output=True, timeout=timeout)
    values, lines = {}, []
    for line in result.stdout.decode('utf-8', 'replace').splitlines():
        if line.startswith(_MARKER) and '\t' in line:
            key, value = line[len(_MARKER):].split('\t', 1)
            if key == 'line':
                lines.append(value[:300])
            else:
                values[key] = value.strip()
    return result.returncode, values, lines


def _say():
    return f"umask 077\nsay() {{ printf '{_MARKER}%s\\t%s\\n' \"$1\" \"$2\"; }}\n"


# Other features keep their own folders directly under workRoot (remote.py: cis/, network/);
# runs/ holds the runs uploaded before 2026-11-07.
RESERVED_RUN_IDS = ('cis', 'network', 'runs')


def _remote_dir(config, root, run_id):
    """The run's HPC3 folder: <workRoot>/<run_id>.

    Runs uploaded before 2026-11-07 live in <workRoot>/runs/<run_id>; such a run keeps
    using that folder, so its later steps sit next to its earlier ones.
    """
    if run_id in RESERVED_RUN_IDS:
        raise StepError('invalid_request', f'run_id {run_id!r} is reserved on HPC3; choose another name.')
    legacy = config['workRoot'] + '/runs/' + run_id
    owner = root / 'steps' / 'remote.owner'
    if owner.is_file() and json.loads(owner.read_text()).get('remote_dir') == legacy:
        return legacy
    return config['workRoot'] + '/' + run_id


def _job_script(config, run_id, name, step, directory, binds):
    """The Slurm batch script. Every value in it was validated; nothing comes from the caller as text."""
    q = shlex.quote
    bind = ','.join([f'{directory}:{directory}'] + [f'{path}:{path}:ro' for path in binds])
    return f'''#!/bin/bash
#SBATCH --job-name=signet-{name}-{run_id}
#SBATCH --output={directory}/steps/{name}.out
#SBATCH --error={directory}/steps/{name}.err
{ssh_transport.runtime_module_prelude(config)}
cd {q(directory + '/work')} || exit 1
echo "[SIGNET-AGENT] START step={name} job=$SLURM_JOB_ID ts=$(date -Iseconds)"
# Batch jobs cannot answer prompts: flush old temporary files and use the cores Slurm gave this job.
sed -i -e 's/^forcerm *=.*/forcerm = T/' -e "s/^ncore_local *=.*/ncore_local = ${{SLURM_CPUS_PER_TASK:-1}}/" config.ini
{q(config['executor'])} exec --cleanenv --no-home --bind {q(bind)} {q(config['image'])} bash ./signet {step.flag} < /dev/null
rc=$?
echo "[SIGNET-AGENT] END step={name} exit=$rc ts=$(date -Iseconds)"
printf '%s %s\\n' "$rc" "$(date -Iseconds)" > {q(directory + '/steps/' + name + '.done')}
'''


def _owner(root, directory):
    """A random token that marks the HPC3 run folder as this local run's, so another run never writes into it."""
    path = root / 'steps' / 'remote.owner'
    if path.is_file():
        value = json.loads(path.read_text())
        if value.get('remote_dir') != directory:
            raise StepError('conflict', 'This run was uploaded to a different HPC3 folder: ' + value.get('remote_dir', '?'))
        return value['token']
    (root / 'steps').mkdir(exist_ok=True)
    token = secrets.token_hex(16)
    path.write_text(json.dumps({'remote_dir': directory, 'token': token}) + '\n')
    return token


def _upload(root, directory, token):
    """Create (or reuse, if ours) the HPC3 run folder and unpack the run's scripts and config.ini there."""
    q = shlex.quote
    command = (f'umask 077; D={q(directory)}; T={q(token)}; '
               'if [ -d "$D" ]; then [ "$(cat "$D/.owner" 2>/dev/null)" = "$T" ] || exit 3; '
               'else mkdir -p "$(dirname "$D")" && mkdir "$D" && printf \'%s\\n\' "$T" > "$D/.owner" || exit 4; fi; '
               'mkdir -p "$D/steps" && tar xzf - -C "$D"')
    result = ssh_transport.remote(command, input=vm.bundle(root, signet._settings(root), directory, input_keys=()),
                                  capture_output=True, timeout=120)
    if result.returncode == 3:
        raise StepError('conflict', f'{directory} already exists on HPC3 and belongs to another run; use a new run_id.')
    if result.returncode:
        raise StepError('remote_failed', 'Could not upload the run to HPC3; nothing was submitted.')


def _submit_script(config, run_id, name, step, directory, inputs, resources):
    q = shlex.quote
    binds = sorted({root for _, root in inputs.values() if root != directory})
    checks = ''.join(
        f'r="$(readlink -f -- {q(root)})"; f="$(readlink -f -- {q(path)})"\n'
        f'if [ "$f" != "$r/{path[len(root) + 1:]}" ] || [ ! -f "$f" ] || [ ! -s "$f" ]; then say missing_input {q(key)}; exit 4; fi\n'
        for key, (path, root) in inputs.items())
    job = _job_script(config, run_id, name, step, directory, binds)
    sbatch = (f'sbatch --parsable --partition={config["partition"]} --cpus-per-task={resources["cpus"]} '
              f'--mem={resources["mem_gb"]}G --time={resources["time"]} "$D/steps/{name}.sbatch"')
    return _say() + f'''D={q(directory)}
{checks}if [ ! -s {q(config['image'])} ]; then say not_ready container; exit 5; fi
if ! command -v sbatch >/dev/null 2>&1; then say not_ready sbatch; exit 5; fi
if [ -e "$D/steps/{name}.job" ]; then say conflict submitted; exit 6; fi
cat > "$D/steps/{name}.sbatch" <<'SIGNET_JOB'
{job}SIGNET_JOB
job="$({sbatch} 2>"$D/steps/{name}.sbatch.err")" || {{ say sbatch_failed "$(head -c 300 "$D/steps/{name}.sbatch.err")"; exit 7; }}
job="${{job%%;*}}"   # --parsable prints "<id>;<cluster>" on multi-cluster setups
printf '%s\\n' "$job" > "$D/steps/{name}.job"
say job "$job"
'''


# ---------- the four operations ----------

@_one_at_a_time
def submit(run_id, name, inputs, resources=None):
    """Submit one step of a run as a Slurm job and return its record (state "submitted" with job_id)."""
    step = _step(name)
    root = _root(run_id)
    if signet._settings(root).get('cohort') != step.cohort:
        raise StepError('invalid_request', f'Step {name} needs a {step.cohort} run.')
    request = _resources(step, resources)
    if _record_path(root, name).exists():
        raise StepError('conflict', f'Step {name} was already attempted in this run; use a new run to retry.')
    active = _active_step(root)
    if active:
        raise StepError('conflict', f'Step {active} of this run is still active.')
    config = _environment()
    directory = _remote_dir(config, root, run_id)
    checked = _inputs(step, inputs, (config['root'] + '/refdata', config['source'] + '/example', directory))
    try:
        fd = os.open(root / '.active', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise StepError('conflict', 'Another operation on this run is in progress.') from error
    os.close(fd)
    try:
        signet._update(root, {key: path for key, (path, _) in checked.items()})
        token = _owner(root, directory)
        record = {'step': name, 'run_id': run_id, 'flag': step.flag, 'remote_dir': directory,
                  'inputs': {key: path for key, (path, _) in checked.items()}, 'resources': request,
                  'partition': config['partition'], 'image': config['image'], 'submitted_at': _now()}
        try:
            _upload(root, directory, token)
            # Record intent before sbatch: a lost connection from here on may have started a job.
            _change(record, 'submitting')
            _save(root, record)
            code, values, _ = _shell(_submit_script(config, run_id, name, step, directory, checked, request))
        except OSError as error:
            if record.get('state') != 'submitting':
                raise StepError('remote_failed', 'HPC3 connection failed before anything was submitted.') from error
            _change(record, 'unknown', reason='Connection lost while submitting; check status before doing anything else.')
            return _save(root, record)
        if code == 0 and re.fullmatch(r'[0-9]+', values.get('job', '')):
            _change(record, 'submitted', job_id=values['job'], checked_at=0)
            return _save(root, record)
        # Nothing was queued, so forget the attempt and let the user fix the cause and retry.
        _record_path(root, name).unlink(missing_ok=True)
        if 'missing_input' in values:
            raise StepError('invalid_request', f'{values["missing_input"]} is missing, empty, or reached through a link on HPC3.')
        if 'not_ready' in values:
            raise StepError('not_ready', f'HPC3 is not ready: {values["not_ready"]} is missing. Check the remote environment.')
        if 'conflict' in values:
            raise StepError('conflict', f'Step {name} was already submitted for this run on HPC3.')
        raise StepError('remote_failed', 'sbatch refused the job: ' + values.get('sbatch_failed', 'no reason given.'))
    finally:
        (root / '.active').unlink(missing_ok=True)


def _status_script(record, step):
    q = shlex.quote
    directory, name = record['remote_dir'], record['step']
    job = record.get('job_id')
    job_name = f'signet-{name}-{record["run_id"]}'
    outputs = ''.join(f'[ -s {q(directory + "/work/" + path)} ] && say output_{i} yes\n'
                      for i, path in enumerate(step.required))
    pattern = '|'.join(re.escape(p) for p in FAILURE_PATTERNS)
    return _say() + f'''D={q(directory)}
j={q(job) if job else '"$(head -n 1 "$D/steps/' + name + '.job" 2>/dev/null)"'}
# No ID recorded (connection lost around sbatch): look for this step's own job name, ours only.
if [ -z "$j" ]; then j="$(squeue -h -u "$(id -un)" -n {q(job_name)} -o %i 2>/dev/null | head -n 1)"; fi
if [ -z "$j" ]; then j="$(sacct -n -X -P --name={q(job_name)} -S now-7days -o JobID 2>/dev/null | tail -n 1)"; fi
say job "$j"
if [ -n "$j" ]; then
  say squeue "$(squeue -h -j "$j" -o %T 2>/dev/null)"
  say sacct "$(sacct -n -X -P -j "$j" -o State 2>/dev/null | head -n 1)"
fi
[ -f "$D/steps/{name}.done" ] && say done "$(head -n 1 "$D/steps/{name}.done")"
{outputs}cat "$D/steps/{name}.out" "$D/steps/{name}.err" 2>/dev/null | grep -E -m 20 {q(pattern)} | while IFS= read -r l; do say line "$l"; done
true
'''


@_one_at_a_time
def status(run_id, name, refresh=False):
    """Current state of a submitted step; asks Slurm at most every 15 s unless refresh is true."""
    step = _step(name)
    root = _root(run_id)
    record = _load(root, name)
    if record['state'] in TERMINAL:
        return record
    if not refresh and time.time() - record.get('checked_at', 0) < CACHE_SECONDS:
        return record
    _environment()
    try:
        code, values, hints = _shell(_status_script(record, step), timeout=60)
    except OSError:
        return {**record, 'connection': 'interrupted', 'reason': 'Could not reach HPC3; the job keeps running. Try again later.'}
    if code:
        return {**record, 'connection': 'interrupted', 'reason': 'The status check did not complete on HPC3.'}
    record['checked_at'] = time.time()
    if not record.get('job_id') and re.fullmatch(r'[0-9]+', values.get('job', '')):
        record['job_id'] = values['job']   # recovered after a lost connection during submit
    queued, accounted = values.get('squeue', ''), values.get('sacct', '').split(' ')[0]
    slurm = queued or accounted
    record['slurm_state'] = slurm or None
    missing = [path for i, path in enumerate(step.required) if values.get(f'output_{i}') != 'yes']
    if slurm == 'PENDING':
        _change(record, 'pending')
    elif slurm in _SLURM_RUNNING:
        _change(record, 'running')
    elif slurm.startswith('CANCELLED'):
        _change(record, 'cancelled', finished_at=_now())
    elif slurm in _SLURM_FAILED:
        _change(record, 'failed', finished_at=_now(), missing_outputs=missing, failure_hints=hints,
                reason=f'Slurm ended the job with {slurm}.')
    elif slurm == 'COMPLETED' or 'done' in values:
        _finish(root, record, step, values.get('done', ''), missing, hints)
    elif not record.get('job_id'):
        # No ID file, and Slurm knows no job with this step's name: sbatch never ran.
        _change(record, 'failed', finished_at=_now(),
                reason='No Slurm job was found for this step on HPC3, so it never started. Create a new run to try again.')
    elif time.time() - record.get('first_seen_missing', time.time()) > 300:
        _change(record, 'unknown', reason='Slurm has no record of this job; inspect the run folder on HPC3.')
    else:
        record.setdefault('first_seen_missing', time.time())
    return _save(root, record)


def _finish(root, record, step, done, missing, hints):
    """The job ended: decide completed or failed (spec §7), and on success copy the results here."""
    exit_code = done.split(' ')[0] if done else None
    if exit_code != '0' or missing or hints:
        reason = ('The job did not finish its last line.' if exit_code is None else
                  f'signet exited with {exit_code}.' if exit_code != '0' else
                  'Required outputs are missing.' if missing else 'The log reports an error.')
        _change(record, 'failed', finished_at=_now(), exit_code=exit_code, missing_outputs=missing,
                failure_hints=hints, reason=reason)
        return
    _change(record, 'validating', exit_code='0')
    try:
        q = shlex.quote
        result = ssh_transport.remote(f'cd {q(record["remote_dir"])} && tar czf - {q(step.download)}',
                                      capture_output=True, timeout=300)
        if result.returncode:
            raise OSError('tar failed')
        record['outputs'] = vm.restore_outputs(root, result.stdout)
    except (OSError, ValueError) as error:
        local = [root / 'work' / path for path in step.required]
        if not all(path.is_file() and path.stat().st_size for path in local):
            record['reason'] = f'Results are ready on HPC3 but could not be downloaded yet ({error}); check status again.'
            return
        # An earlier check already downloaded them (restore_outputs never overwrites).
        folder = root / step.download
        record['outputs'] = sorted(str(p.relative_to(root)) for p in folder.rglob('*') if p.is_file())
    _change(record, 'completed', finished_at=_now(), missing_outputs=[], failure_hints=[],
            reason='Outputs present and logs clean. This is not scientific validation; review the results.')


@_one_at_a_time
def cancel(run_id, name):
    """Cancel the step's own Slurm job (checked by job name). Finished steps cannot be cancelled."""
    _step(name)
    root = _root(run_id)
    record = _load(root, name)
    if record['state'] in TERMINAL:
        raise StepError('conflict', f'Step {name} already ended as {record["state"]}.')
    if not record.get('job_id'):
        raise StepError('conflict', 'No job ID is known yet; check status first.')
    _environment()
    expected = f'signet-{name}-{run_id}'
    script = _say() + (f'j={shlex.quote(record["job_id"])}\n'
                       f'if [ "$(squeue -h -j "$j" -o %j 2>/dev/null)" = {shlex.quote(expected)} ]; then '
                       'scancel "$j" && say cancel requested; else say cancel not_queued; fi\n')
    try:
        code, values, _ = _shell(script, timeout=30)
    except OSError as error:
        raise StepError('remote_failed', 'Could not reach HPC3; the job was not cancelled.') from error
    if code or 'cancel' not in values:
        raise StepError('remote_failed', 'scancel did not complete on HPC3.')
    if values['cancel'] == 'requested':
        _change(record, 'cancelled', finished_at=_now(), reason='Cancelled by the user.')
        return _save(root, record)
    return status(run_id, name, refresh=True)   # it already left the queue; report how it ended


def read_log(run_id, name, stream='out', lines=50):
    """Last lines (at most 200) of the job's stdout ("out") or stderr ("err")."""
    _step(name)
    root = _root(run_id)
    record = _load(root, name)
    if stream not in ('out', 'err'):
        raise StepError('invalid_request', 'stream must be out or err.')
    if isinstance(lines, bool) or not isinstance(lines, int) or not 1 <= lines <= MAX_LOG_LINES:
        raise StepError('invalid_request', f'lines must be between 1 and {MAX_LOG_LINES}.')
    _environment()
    path = shlex.quote(f'{record["remote_dir"]}/steps/{name}.{stream}')
    try:
        result = ssh_transport.remote(f'tail -n {lines + 1} {path} 2>/dev/null', capture_output=True, timeout=30)
    except OSError as error:
        raise StepError('remote_failed', 'Could not reach HPC3.') from error
    text = result.stdout.decode('utf-8', 'replace').splitlines()
    return {'lines': text[-lines:], 'truncated': len(text) > lines}
