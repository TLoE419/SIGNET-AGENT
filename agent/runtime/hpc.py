"""HPC3 workspace layout, read-only readiness checks and one-step-at-a-time setup over the app's SSH connection.

Everything the app keeps on HPC3 lives under one workspace in /pub, which
persists across logins and login nodes (unlike /tmp). Checks report only
existence, file sizes, the SIGNET git version and the app's own step states;
no workspace file contents are read.

Each setup step returns as soon as it has started: light steps run as a
detached process on the login node; downloads run as Slurm jobs, because login
nodes must not download large files and compute nodes can reach the internet. Step state and logs live in ~/.signet-agent/steps, because home is
fast and always exists while /pub can be slow. Setup only adds what is
missing and never overwrites existing files.
"""
import os
from pathlib import Path
import re
import subprocess

from agent.runtime import ssh_transport

DEFAULT_WORKSPACE = '/pub/$USER/signet-agent'
SIGNET_DIRECTORY = 'signet'
CONTAINER = 'containers/signet.sif'
WORKSPACE_FOLDERS = ('containers', 'refdata', 'runs')
# Public Phase 2 (TCGA, GRCh38) inputs shared by every analysis. Only the raw
# files are prepared here; matching ref and gmap to a study's markers happens in
# data preprocessing. The example data covers chromosome 1 of TCGA-LUAD.
_KG = ('https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/data_collections/1000_genomes_project/release/'
       '20181203_biallelic_SNV/ALL.chr1.shapeit2_integrated_v1a.GRCh38.20181129.phased.vcf.gz')
_GDC_LUAD = ('https://api.gdc.cancer.gov/cases?filters=%7B%22op%22%3A%22%3D%22%2C%22content%22%3A%7B%22field%22'
             '%3A%22project.project_id%22%2C%22value%22%3A%22TCGA-LUAD%22%7D%7D'
             '&fields=submitter_id,demographic.race&format=TSV&size=5000')
REFERENCES = {
    'ref': {'path': 'refdata/ref/ALL.chr1.GRCh38.phased.vcf.gz', 'url': _KG,
            'source': '1000 Genomes GRCh38 chromosome 1 phased genotypes (about 950 MB)'},
    'gmap': {'path': 'refdata/gmap/chr1.b38.gmap.gz',
             'url': 'https://github.com/odelaneau/shapeit4/raw/master/maps/genetic_maps.b38.tar.gz',
             'source': 'SHAPEIT4 GRCh38 genetic map, chromosome 1'},
    'gtf': {'path': 'refdata/gencode.v22.annotation.gtf',
            'url': 'https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_human/release_22/gencode.v22.annotation.gtf.gz',
            'source': 'GENCODE release 22 gene annotation (TCGA expression uses v22 gene IDs)'},
    'clinical': {'path': 'refdata/clinical.tsv', 'url': _GDC_LUAD,
                 'source': 'TCGA-LUAD case IDs and race from the GDC API (open access)'},
}
REFERENCE_FILES = {key: spec['path'] for key, spec in REFERENCES.items()}
REFERENCE_RESOURCES = ('--partition=free', '--cpus-per-task=1', '--mem=2G', '--time=02:00:00')
# IMPUTE2 inputs matched to the SIGNET example study (TCGA-LUAD, chromosome 1). The
# converter runs on a compute node; summary.json is written last, so it marks completion.
EXAMPLE_STUDY = f'{SIGNET_DIRECTORY}/example/geno/example'
PREPARED = 'refdata/prepared/example'
PREPARE_RESOURCES = ('--partition=free', '--cpus-per-task=1', '--mem=4G', '--time=02:00:00')
_PREPARE_SOURCE = (Path(__file__).with_name('jobs') / 'prepare_reference.py').read_text()
# Every Slurm step records its job ID as <step>.job in the state directory.
JOB_STEPS = ('container', *REFERENCES, 'prepare')
# The official image named in the SIGNET README. Apptainer has no default
# library, so pull names it explicitly instead of editing the user's remotes.
CONTAINER_URI = 'library://jiang548/signet/signet:0.0.6'
CONTAINER_LIBRARY = 'https://library.sylabs.io'
PULL_RESOURCES = ('--partition=free', '--cpus-per-task=1', '--mem=4G', '--time=02:00:00')
STEPS = ('workspace', 'signet', *JOB_STEPS)
STATE_DIRECTORY = '$HOME/.signet-agent/steps'
LOG_LINES = 20
_SEGMENT = r'(?:[A-Za-z0-9._-]+|\$USER)'
_MARKER = '@@'


def workspace():
    """Workspace path as the remote shell should expand it; only $USER is substituted."""
    value = os.environ.get('SIGNET_HPC_WORKSPACE') or DEFAULT_WORKSPACE
    if not re.fullmatch(rf'(?:/{_SEGMENT})+', value) or '/../' in value + '/' or '/./' in value + '/':
        raise ValueError('SIGNET_HPC_WORKSPACE must be an absolute path of letters, digits, ., _, - or $USER.')
    return value


def _prelude(root):
    # The path is validated, so double quotes only expand $USER. state_of reads
    # the app's own step file with shell builtins and keeps its last state line.
    return f'''
W="{root}"
D="{STATE_DIRECTORY}"
export W D  # detached steps run in a child bash
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
done
for step in workspace signet; do
  st="$(state_of $step)"
  [ -n "$st" ] || continue
  host="$(field_of $step host)"; pid="$(field_of $step pid)"
  if [ "$st" = running ] && [ "$host" = "$(hostname)" ] && [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then st=stopped; fi
  say "step_$step" "$st"; say "step_${{step}}_host" "$host"
done
'''


def _checked_files():
    return {'container': CONTAINER, **REFERENCE_FILES, 'prepare': f'{PREPARED}/summary.json'}


def _check_script(root):
    files = ' '.join(f'{key}:{path}' for key, path in _checked_files().items())
    return _prelude(root) + f'''
say user "$(id -un)"
say host "$(hostname)"
if [ -d "$W" ]; then say workspace yes; if [ -w "$W" ]; then say workspace_writable yes; else say workspace_writable no; fi
else say workspace no; fi
if command -v sbatch >/dev/null 2>&1; then say sbatch yes; else say sbatch no; fi
if module load apptainer >/dev/null 2>&1 && command -v apptainer >/dev/null 2>&1; then
  say apptainer "$(apptainer --version 2>/dev/null | head -n 1)"
else say apptainer no; fi
S="$W/{SIGNET_DIRECTORY}"
if [ -d "$S/.git" ]; then
  say signet yes
  say signet_head "$(git -C "$S" rev-parse HEAD 2>/dev/null)"
  say signet_modified "$(git -C "$S" status --porcelain --untracked-files=no 2>/dev/null | wc -l | tr -d ' ')"
elif [ -e "$S" ]; then say signet not_git
else say signet no; fi
for item in {files}; do
  key="${{item%%:*}}"; rel="${{item#*:}}"
  if [ -s "$W/$rel" ]; then say "file_$key" "$(stat -c %s "$W/$rel" 2>/dev/null || stat -f %z "$W/$rel")"
  elif [ -e "$W/$rel" ]; then say "file_$key" empty
  else say "file_$key" no; fi
done
''' + _report_steps()


def _launch(name, work):
    """Shell that records a running step, then runs `work` detached so the SSH command returns now.

    `work` runs in a child bash inside single quotes, so it must not contain a
    single quote; it sees the exported $W and $D.
    """
    assert "'" not in work
    done = f'printf "state=done\\nfinished=%s\\n" "$(date +%s)" >> "$D/{name}.status"'
    failed = f'printf "state=failed\\nfinished=%s\\n" "$(date +%s)" >> "$D/{name}.status"'
    return f'''
mkdir -p "$D" && chmod 700 "$HOME/.signet-agent" "$D"
printf 'state=running\\nhost=%s\\nstarted=%s\\n' "$(hostname)" "$(date +%s)" > "$D/{name}.status"
if command -v setsid >/dev/null 2>&1; then detach="setsid nohup"; else detach="nohup"; fi
$detach bash -c '( {work} ) && {done} || {failed}' > "$D/{name}.log" 2>&1 < /dev/null &
printf 'pid=%s\\n' "$!" >> "$D/{name}.status"
say {name} started
'''


def _ensure_workspace():
    """Shell that creates the workspace (owner-only) and its folders if missing.

    $W is unquoted so the same text works inside a single-quoted detached
    command and inside sbatch --wrap "..."; workspace() allows no spaces or quotes.
    """
    folders = ' '.join(f'$W/{folder}' for folder in WORKSPACE_FOLDERS)
    return f'umask 077; if [ ! -d $W ]; then mkdir -p $W && chmod 700 $W; fi && mkdir -p {folders}'


# Clone and download create a missing workspace first, so the user never has to.
_NOTE_MISSING_WORKSPACE = 'if [ ! -d "$W" ]; then say creates_workspace yes; fi\n'


def _workspace_script(root):
    complete = ' && '.join(f'[ -d "$W/{folder}" ]' for folder in WORKSPACE_FOLDERS)
    return _prelude(root) + f'''
if [ "$(state_of workspace)" = running ]; then say workspace in_progress
elif {complete}; then say workspace existing
else
''' + _launch('workspace', _ensure_workspace()) + 'fi\n'


def _signet_script(root, repository, revision):
    partial = '$W/signet.partial'
    work = (f'{_ensure_workspace()} && rm -rf {partial} && git clone --quiet --no-checkout {repository} {partial} && '
            f'git -C {partial} checkout --quiet --detach {revision} && mv {partial} $W/{SIGNET_DIRECTORY} || '
            f'{{ rm -rf {partial}; false; }}')
    return _prelude(root) + f'''
if [ "$(state_of signet)" = running ]; then say signet in_progress
elif [ -e "$W/{SIGNET_DIRECTORY}" ]; then say signet existing
else
''' + _NOTE_MISSING_WORKSPACE + _launch('signet', work) + 'fi\n'


def _container_script(root):
    pulled = f'$W/{CONTAINER}'
    partial = '$W/containers/signet.partial.sif'
    # Download to a partial name, so an interrupted pull never looks complete.
    # Keep the cache out of the small home quota.
    download = (f'{_ensure_workspace()} && module load apptainer && mkdir -p $W/containers/.cache $W/containers/.tmp && '
                f'export APPTAINER_CACHEDIR=$W/containers/.cache APPTAINER_TMPDIR=$W/containers/.tmp && '
                f'rm -f {partial} && apptainer pull --library {CONTAINER_LIBRARY} {partial} {CONTAINER_URI} && '
                f'mv {partial} {pulled}')
    return _prelude(root) + f'''
running=""
if [ -s "$D/container.job" ]; then read -r job < "$D/container.job"; running="$(squeue -h -j "$job" -o %T 2>/dev/null)"; fi
if [ -n "$running" ]; then say container in_progress; say container_job "$job"
elif [ -s "{pulled}" ]; then say container existing
else
''' + _NOTE_MISSING_WORKSPACE + f'''  mkdir -p "$D" && chmod 700 "$HOME/.signet-agent" "$D"
  job="$(sbatch --parsable --job-name=signet-pull {' '.join(PULL_RESOURCES)} --output="$D/container.log" --wrap "{download}" 2>/dev/null)"
  job="${{job%%;*}}"
  if [ -n "$job" ]; then printf '%s\\n' "$job" > "$D/container.job"; say container started; say container_job "$job"
  else say container failed; fi
fi
'''


# How each raw file is fetched into "$TARGET.partial" on the compute node.
_FETCH = {
    'ref': 'curl -fsSL --retry 3 -o "$TARGET.partial" "$URL"',
    'gmap': ('curl -fsSL --retry 3 -o "$TARGET.tar.gz.partial" "$URL"\n'
             'tar -xzf "$TARGET.tar.gz.partial" -O chr1.b38.gmap.gz > "$TARGET.partial"\n'
             'rm -f "$TARGET.tar.gz.partial"'),
    'gtf': ('curl -fsSL --retry 3 -o "$TARGET.gz.partial" "$URL"\n'
            'gunzip -c "$TARGET.gz.partial" > "$TARGET.partial"\n'
            'rm -f "$TARGET.gz.partial"'),
    # GDC sends CRLF lines, and R would keep the \r on submitter_id; SIGNET reads a "race" column.
    'clinical': 'curl -fsSL --retry 3 "$URL" | tr -d "\\r" | sed "1s/demographic\\.race/race/" > "$TARGET.partial"',
}


def _reference_job(key):
    """Batch script that downloads one raw reference file and records where it came from."""
    spec = REFERENCES[key]
    assert "'" not in spec['url']
    return f'''#!/bin/bash
set -euo pipefail
{_ensure_workspace()}
URL='{spec["url"]}'
TARGET="$W/{spec["path"]}"
mkdir -p "$(dirname "$TARGET")"
rm -f "$TARGET.partial"
{_FETCH[key]}
[ -s "$TARGET.partial" ] || {{ echo "The downloaded file is empty." >&2; exit 1; }}
mv "$TARGET.partial" "$TARGET"
size="$(stat -c %s "$TARGET" 2>/dev/null || stat -f %z "$TARGET")"
digest="$( (sha256sum "$TARGET" 2>/dev/null || shasum -a 256 "$TARGET") | cut -d " " -f 1)"
printf "%s\\t%s\\t%s\\t%s\\t%s\\n" {key} "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$size" "$digest" "$URL" >> "$W/refdata/SOURCES.tsv"
echo "Saved $TARGET ($size bytes, sha256 $digest)"
'''


def _reference_script(root, key):
    """Submit one reference download as a Slurm job unless the file exists or is already downloading."""
    path = REFERENCES[key]['path']
    return _prelude(root) + f'''
running=""
if [ -s "$D/{key}.job" ]; then read -r job < "$D/{key}.job"; running="$(squeue -h -j "$job" -o %T 2>/dev/null)"; fi
if [ -n "$running" ]; then say {key} in_progress; say {key}_job "$job"
elif [ -s "$W/{path}" ]; then say {key} existing
else
''' + _NOTE_MISSING_WORKSPACE + f'''  mkdir -p "$D" && chmod 700 "$HOME/.signet-agent" "$D"
  cat > "$D/{key}.sbatch" <<'SIGNET_JOB'
{_reference_job(key)}SIGNET_JOB
  job="$(sbatch --parsable --job-name=signet-{key} {' '.join(REFERENCE_RESOURCES)} --output="$D/{key}.log" "$D/{key}.sbatch" 2>/dev/null)"
  job="${{job%%;*}}"
  if [ -n "$job" ]; then printf '%s\\n' "$job" > "$D/{key}.job"; say {key} started; say {key}_job "$job"
  else say {key} failed; fi
fi
'''


def _prepare_script(root):
    """Submit the converter as a Slurm job once SIGNET (for the example study), ref and gmap exist."""
    study = f'$W/{EXAMPLE_STUDY}'
    job = f'''#!/bin/bash
set -euo pipefail
python3 "$D/prepare_reference.py" --study-ped "{study}.ped" --study-map "{study}.map" \\
  --reference "$W/{REFERENCE_FILES['ref']}" --genetic-map "$W/{REFERENCE_FILES['gmap']}" --out "$W/{PREPARED}"
'''
    return _prelude(root) + f'''
running=""
if [ -s "$D/prepare.job" ]; then read -r job < "$D/prepare.job"; running="$(squeue -h -j "$job" -o %T 2>/dev/null)"; fi
if [ -n "$running" ]; then say prepare in_progress; say prepare_job "$job"
elif [ -s "$W/{PREPARED}/summary.json" ]; then say prepare existing
elif [ ! -s "{study}.ped" ] || [ ! -s "{study}.map" ]; then say prepare needs_signet
elif [ ! -s "$W/{REFERENCE_FILES['ref']}" ]; then say prepare needs_ref
elif [ ! -s "$W/{REFERENCE_FILES['gmap']}" ]; then say prepare needs_gmap
else
  mkdir -p "$D" && chmod 700 "$HOME/.signet-agent" "$D"
  cat > "$D/prepare_reference.py" <<'SIGNET_PY'
{_PREPARE_SOURCE}SIGNET_PY
  cat > "$D/prepare.sbatch" <<'SIGNET_JOB'
{job}SIGNET_JOB
  job="$(sbatch --parsable --job-name=signet-prepare {' '.join(PREPARE_RESOURCES)} --output="$D/prepare.log" "$D/prepare.sbatch" 2>/dev/null)"
  job="${{job%%;*}}"
  if [ -n "$job" ]; then printf '%s\\n' "$job" > "$D/prepare.job"; say prepare started; say prepare_job "$job"
  else say prepare failed; fi
fi
'''


def _log_script(step):
    return _prelude('/') + f'''
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
        return 'problem', f'The last {step} setup {state}; read_hpc_setup_log("{step}") shows why.'
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
    if values.get('workspace') != 'yes':
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
        'module load apptainer failed.' if apptainer == 'no' else apptainer)
    signet = values.get('signet', 'no')
    if signet == 'no':
        add('signet_source', *(_step_status(values, 'signet') or ('missing', 'SIGNET has not been cloned into the workspace.')))
    elif signet == 'not_git':
        add('signet_source', 'problem', 'The signet folder exists but is not a git checkout; its version cannot be verified.')
    elif values.get('signet_head') != revision:
        add('signet_source', 'problem', f"SIGNET is at commit {values.get('signet_head') or 'unknown'}, not the pinned {revision}.")
    elif values.get('signet_modified') != '0':
        add('signet_source', 'problem', f"{values.get('signet_modified')} SIGNET files were modified after checkout; results would not match the pinned version.")
    else:
        add('signet_source', 'ok', f'Pinned commit {revision[:12]}, unmodified.')
    for key, path in _checked_files().items():
        value = values.get(f'file_{key}', 'no')
        item = {'container': 'container', 'prepare': 'imputation_reference'}.get(key, f'reference_{key}')
        job, state = values.get(f'job_{key}'), values.get(f'job_{key}_state')
        if value == 'no' and state:
            add(item, 'in_progress', f'Download job {job} is {state.lower()}; check again later.')
        elif value == 'no' and job:
            add(item, 'problem', f'Download job {job} ended without producing {path}; '
                                 f'read_hpc_setup_log("{key}") shows why.')
        elif value == 'no':
            add(item, 'missing', f'{path} is missing.')
        elif value == 'empty':
            add(item, 'problem', f'{path} is empty.')
        else:
            add(item, 'ok', f'{path} ({_size(value)})')
    return checks


def _run(script, timeout, required='workspace_path'):
    """Run a fixed script in a login shell (so `module` exists); return markers or an error result."""
    if not ssh_transport.available():
        return None, {'status': 'unavailable', 'executed': False,
                      'reason': 'Not running in the desktop app, so there is no HPC3 connection to use.'}
    try:
        result = ssh_transport.remote('bash -l -s', input=script(workspace()).encode(),
                                      capture_output=True, timeout=timeout)
    except ValueError as error:
        return None, {'status': 'invalid', 'executed': False, 'error': str(error)}
    except (OSError, subprocess.SubprocessError) as error:
        return None, {'status': 'unavailable', 'executed': False,
                      'reason': f'HPC3 is not reachable or too slow: {error}. Connect with the SSH panel, '
                                'then run check_hpc_environment to see the current state.'}
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
            'evidence_scope': 'Existence, file sizes, the SIGNET git version and the app\'s own setup states only. '
                              'No file contents were read and nothing on HPC3 was changed. '
                              'Readiness here does not establish scientific validity.'}


_OUTCOMES = {
    'started': 'Started in the background; call check_hpc_environment later to see when it finishes.',
    'in_progress': 'Already running in the background; nothing new was started.',
    'existing': 'Already present; left unchanged.',
    'needs_signet': 'Install SIGNET first; the example study data comes with it.',
    'needs_ref': 'Download the ref file first.',
    'needs_gmap': 'Download the gmap file first.',
    'failed': 'Could not start this step; nothing was changed.',
}


def start_step(step, repository=None, revision=None):
    """Start one setup step and return immediately with its outcome."""
    if step == 'signet' and (not re.fullmatch(r'https://[A-Za-z0-9./_-]+\.git', repository or '')
                             or not re.fullmatch(r'[0-9a-f]{40}', revision or '')):
        return {'status': 'invalid', 'executed': False, 'error': 'Invalid pinned SIGNET repository or revision.'}
    if step not in STEPS:
        return {'status': 'invalid', 'executed': False, 'error': f'step must be one of {", ".join(STEPS)}.'}
    script = {'workspace': _workspace_script, 'container': _container_script,
              'signet': lambda root: _signet_script(root, repository, revision), 'prepare': _prepare_script,
              **{key: (lambda root, key=key: _reference_script(root, key)) for key in REFERENCES}}[step]
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
    values, error = _run(lambda _root: _log_script(step), timeout=60, required='log_exists')
    if error:
        return error
    if values['log_exists'] != 'yes':
        return {'status': 'ok', 'executed': False, 'step': step, 'lines': [], 'detail': 'This step has not run yet.'}
    return {'status': 'ok', 'executed': False, 'step': step, 'lines': values.get('lines', []),
            'evidence_scope': f'Last {LOG_LINES} lines of the app-generated setup log only; never research data.'}
