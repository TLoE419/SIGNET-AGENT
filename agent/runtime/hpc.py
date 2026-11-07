"""HPC3 workspace layout, read-only readiness checks and one-step-at-a-time setup over the app's SSH connection.

The desktop EnvironmentService owns the verified workspace, pinned source,
container executor and scheduler partition. Reference jobs reuse that configuration. Checks report only
existence, file sizes, hashes of the pinned source files and the app's own step states.
Source contents are hashed without being returned; research data is not read.

Each setup step returns as soon as it has started: light steps run as a
detached process on the login node; downloads run as Slurm jobs, because login
nodes must not download large files and compute nodes can reach the internet. Step state and logs live under the configured workspace, isolated by installation root. Setup only adds what is
missing and never overwrites existing files.
"""
from contextvars import ContextVar
import json
import os
from pathlib import Path
import re
import subprocess

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
    # signet -t keeps gene rows whose transcript_type is protein_coding. Only a collapsed GTF has that
    # field on gene rows; the full GENCODE file silently yields 0 genes.
    'gtf': {'path': 'refdata/gencode.v22.genes.gtf',
            'url': 'https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_human/release_22/gencode.v22.annotation.gtf.gz',
            'source': 'GENCODE release 22 gene annotation, collapsed with the GTEx pipeline (TCGA expression uses v22 gene IDs)',
            'needs_container': True,
            'resources': ('--partition=free', '--cpus-per-task=1', '--mem=16G', '--time=04:00:00')},
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
STEPS = ('workspace', 'signet', *JOB_STEPS)
STATE_DIRECTORY = '$HOME/.signet-agent/steps'
LOG_LINES = 20
_SEGMENT = r'(?:[A-Za-z0-9._-]+|\$USER)'
_MARKER = '@@'
_IMAGE_SIGNATURE = '''
image_signature() {
  [ -s "$I" ] || return 1
  python3 - "$I" <<'SIGNET_IMAGE_STAT'
import os
import sys

try:
    image = os.stat(sys.argv[1])
except OSError:
    sys.exit(1)
print(image.st_ino, image.st_size, image.st_mtime_ns, image.st_ctime_ns, sep=':')
SIGNET_IMAGE_STAT
}
'''


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
selected_of() {{
  local key path found=""
  [ -f "$W/refdata/selected.tsv" ] || return 0
  while IFS=$'\t' read -r key path; do if [ "$key" = "$1" ]; then found="$path"; fi; done < "$W/refdata/selected.tsv"
  printf %s "$found"
}}
{_IMAGE_SIGNATURE}
selected_access() {{
  local key="$1" path="$2" id checked_path signature access
  [ -n "$E" ] && signature="$(image_signature)" || {{ printf needs_container; return; }}
  if ! IFS=$'\t' read -r id checked_path 2>/dev/null < "$D/selected-$key.check" ||
     [[ ! "$id" =~ ^[a-f0-9]{{32}}$ ]] || [ "$checked_path" != "$path" ]; then
    printf unverified
    return
  fi
  local check="$D/selected-$key-$id" checked_image job
  if IFS=$'\t' read -r access checked_image 2>/dev/null < "$check/status"; then
    if [ "$signature" = "$checked_image" ]; then printf '%s' "$access"; else printf unverified; fi
  elif read -r job 2>/dev/null < "$check/job" && [ -n "$(squeue -h -j "$job" -o %T 2>/dev/null)" ]; then
    printf pending
  else
    printf unknown
  fi
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
    config = _CONFIG.get()
    if config is not None and config.get('revision') != SOURCE_INVENTORY['revision']:
        raise ValueError('Desktop source revision does not match the audited inventory; recheck the remote environment.')
    # Match EnvironmentService.sourceCheck: the installed archive has no Git metadata.
    source_hashes = ''.join(f"{item['sha256']}  {item['path']}\n"
                            for item in SOURCE_INVENTORY['scripts'] + SOURCE_INVENTORY['support_files'])
    files = ' '.join(f'{key}:{path}' for key, path in _checked_files().items())
    return _prelude(root) + f'''
say user "$(id -un)"
say host "$(hostname)"
if [ -d "$W" ]; then say workspace yes; if [ -w "$W" ]; then say workspace_writable yes; else say workspace_writable no; fi
else say workspace no; fi
if command -v sbatch >/dev/null 2>&1; then say sbatch yes; else say sbatch no; fi
if "$E" --version >/dev/null 2>&1; then
  say apptainer "$("$E" --version 2>/dev/null | head -n 1)"
else say apptainer no; fi
if [ ! -e "$S" ]; then say signet no
elif [ ! -d "$S" ] || [ -L "$S" ]; then say signet invalid
else
  say signet yes
  if (cd "$S" && sha256sum -c - >/dev/null 2>&1 <<'SIGNET_SOURCE_HASHES'
{source_hashes}SIGNET_SOURCE_HASHES
  ); then
    say signet_integrity verified
    say signet_revision {SOURCE_INVENTORY['revision']}
  else say signet_integrity mismatch; fi
fi
for item in {files}; do
  key="${{item%%:*}}"; rel="${{item#*:}}"
  if [ "$key" = container ]; then rel="$I"; else rel="$W/$rel"; fi
  chosen="$(selected_of "$key")"
  if [ -n "$chosen" ]; then
    rel="$chosen"; say "selected_$key" yes
    say "access_$key" "$(selected_access "$key" "$chosen")"
  fi
  if [ -s "$rel" ]; then say "file_$key" "$(stat -c %s "$rel" 2>/dev/null || stat -f %z "$rel")"
  elif [ -e "$rel" ]; then say "file_$key" empty
  else say "file_$key" no; fi
done
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


# How each raw file is fetched into "$TARGET.partial" on the compute node.
FULL_GTF = 'refdata/gencode.v22.annotation.gtf'
COLLAPSE_COMMIT = '3218db7cba2980ffdf3bca2decddfcae0b2835fe'
COLLAPSE_URL = f'https://raw.githubusercontent.com/broadinstitute/gtex-pipeline/{COLLAPSE_COMMIT}/gene_model/collapse_annotation.py'
COLLAPSE_SHA256 = 'a543e9084d95e58d56813263484a01c9708253da998811069ccea9acd14d58b5'

_FETCH = {
    'ref': 'curl -fsSL --retry 3 -o "$TARGET.partial" "$URL"',
    'gmap': ('curl -fsSL --retry 3 -o "$TARGET.tar.gz.partial" "$URL"\n'
             'tar -xzf "$TARGET.tar.gz.partial" -O chr1.b38.gmap.gz > "$TARGET.partial"\n'
             'rm -f "$TARGET.tar.gz.partial"'),
    # An already downloaded full GTF is reused. The official tool runs unmodified inside the container;
    # it needs bx-python, which is added beside the workspace only if the image lacks it.
    'gtf': f'''FULL="$W/{FULL_GTF}"
if [ ! -s "$FULL" ]; then
  curl -fsSL --retry 3 -o "$FULL.gz.partial" "$URL"
  gunzip -c "$FULL.gz.partial" > "$FULL.partial"
  mv "$FULL.partial" "$FULL"
  rm -f "$FULL.gz.partial"
fi
TOOLS="$W/refdata/.tools"
mkdir -p "$TOOLS"
curl -fsSL --retry 3 -o "$TOOLS/collapse_annotation.py.partial" '{COLLAPSE_URL}'
digest="$(sha256sum "$TOOLS/collapse_annotation.py.partial" | cut -d " " -f 1)"
if [ "$digest" != "{COLLAPSE_SHA256}" ]; then
  echo "collapse_annotation.py checksum mismatch: got $digest." >&2
  exit 1
fi
mv "$TOOLS/collapse_annotation.py.partial" "$TOOLS/collapse_annotation.py"
in_container() {{ "$E" exec --cleanenv --no-home --bind "$W:$W" --env PYTHONPATH="$TOOLS/python" "$I" "$@"; }}
if ! in_container python3 -c 'import numpy, pandas, bx.intervals.intersection'; then
  in_container python3 -m pip install --quiet --no-deps --target "$TOOLS/python" bx-python
fi
in_container python3 "$TOOLS/collapse_annotation.py" "$FULL" "$TARGET.partial"
# Never publish a GTF that signet -t would silently read as 0 genes.
awk -F '\t' '$3 == "gene" {{ found = 1; exit !($9 ~ /transcript_type/) }} END {{ if (!found) exit 1 }}' "$TARGET.partial" || {{
  rm -f "$TARGET.partial"
  echo "The collapsed GTF has no gene rows with transcript_type." >&2
  exit 1
}}''',
    # GDC sends CRLF lines, and R would keep the \r on submitter_id; SIGNET reads a "race" column.
    'clinical': 'curl -fsSL --retry 3 "$URL" | tr -d "\\r" | sed "1s/demographic\\.race/race/" > "$TARGET.partial"',
}


def _reference_job(key):
    """Batch script that downloads one raw reference file and records where it came from."""
    spec = REFERENCES[key]
    assert "'" not in spec['url']
    prelude = ssh_transport.runtime_module_prelude(_CONFIG.get() or {}) if spec.get('needs_container') else ''
    return f'''#!/bin/bash
set -euo pipefail
{_ensure_workspace()}
{prelude}
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


def _step_lock(step, busy_step=None):
    """Serialize concurrent panel/model requests without replacing another job's state."""
    return f'''mkdir -p "$D"
if ! mkdir "$D/{step}.lock" 2>/dev/null; then say {busy_step or step} in_progress; exit 0; fi
trap 'rmdir "$D/{step}.lock"' EXIT
'''


def _reference_script(root, key):
    """Submit one reference download as a Slurm job unless the file exists or is already downloading."""
    path = REFERENCES[key]['path']
    return _prelude(root) + _step_lock(key) + f'''
running=""
if [ -s "$D/{key}.job" ]; then read -r job < "$D/{key}.job"; running="$(squeue -h -j "$job" -o %T 2>/dev/null)"; fi
if [ -n "$running" ]; then say {key} in_progress; say {key}_job "$job"
elif [ -n "$(selected_of {key})" ] || [ -s "$W/{path}" ]; then say {key} existing
{'elif [ -z "$E" ] || [ ! -s "$I" ]; then say ' + key + ' needs_container' if REFERENCES[key].get('needs_container') else ''}
else
''' + _NOTE_MISSING_WORKSPACE + f'''  mkdir -p "$D" && chmod 700 "$D"
  cat > "$D/{key}.sbatch" <<'SIGNET_JOB'
{_reference_job(key)}SIGNET_JOB
  job="$(sbatch --parsable --job-name=signet-{key} {' '.join(REFERENCES[key].get('resources', REFERENCE_RESOURCES))} --output="$D/{key}.log" "$D/{key}.sbatch" 2>/dev/null)"
  job="${{job%%;*}}"
  if [ -n "$job" ]; then printf '%s\\n' "$job" > "$D/{key}.job"; say {key} started; say {key}_job "$job"
  else say {key} failed; fi
fi
'''


def _container_job():
    """Batch script that downloads the image on a compute node and publishes it only after verification."""
    return f'''#!/bin/bash
set -euo pipefail
PARTIAL="$I.partial"
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


def _prepare_script(root):
    """Submit the converter as a Slurm job once SIGNET (for the example study), ref and gmap exist."""
    study = '$S/example/geno/example'
    job = f'''#!/bin/bash
set -euo pipefail
python3 "$D/prepare_reference.py" --study-ped "{study}.ped" --study-map "{study}.map" \\
  --reference "$SIGNET_REF" --genetic-map "$SIGNET_GMAP" --out "$W/{PREPARED}"
'''
    return _prelude(root) + _step_lock('selected', busy_step='prepare') + f'''
# A file chosen on HPC3 takes the place of the downloaded one; sbatch passes these on to the job.
chosen_ref="$(selected_of ref)"; SIGNET_REF="${{chosen_ref:-$W/{REFERENCE_FILES['ref']}}}"
chosen_gmap="$(selected_of gmap)"; SIGNET_GMAP="${{chosen_gmap:-$W/{REFERENCE_FILES['gmap']}}}"
export SIGNET_REF SIGNET_GMAP
running=""
if [ -s "$D/prepare.job" ]; then read -r job < "$D/prepare.job"; running="$(squeue -h -j "$job" -o %T 2>/dev/null)"; fi
if [ -n "$running" ]; then say prepare in_progress; say prepare_job "$job"
elif [ -s "$W/{PREPARED}/summary.json" ]; then say prepare existing
elif [ ! -s "{study}.ped" ] || [ ! -s "{study}.map" ]; then say prepare needs_signet
elif [ ! -s "$SIGNET_REF" ]; then say prepare needs_ref
elif [ ! -s "$SIGNET_GMAP" ]; then say prepare needs_gmap
elif {{ [ -n "$chosen_ref" ] && [ "$(selected_access ref "$chosen_ref")" != ok ]; }} ||
     {{ [ -n "$chosen_gmap" ] && [ "$(selected_access gmap "$chosen_gmap")" != ok ]; }}; then
  say prepare needs_verified_selection
else
  mkdir -p "$D" && chmod 700 "$D"
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


def _selected_status(size, access):
    """State of a file the user chose on HPC3. Its path stays out: this result also reaches the assistant."""
    if size in ('no', 'empty'):
        return 'problem', 'The selected file is missing or empty; choose it again.'
    if access == 'ok':
        return 'ok', f'Selected file ({_size(size)}); readable from compute nodes and the container.'
    if access == 'pending':
        return 'in_progress', f'Selected file ({_size(size)}); checking that compute nodes can read it.'
    if access == 'failed':
        return 'problem', 'Compute nodes or the container could not read the selected file; choose another location.'
    if access == 'needs_container':
        return 'problem', 'Install the container, then select this file again to verify access.'
    if access == 'unverified':
        return 'problem', 'Select this file again to verify access with the current container.'
    return 'problem', 'The compute-node check for the selected file did not finish; choose the file again.'


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
        'Singularity or Apptainer was not found.' if apptainer == 'no' else apptainer)
    signet = values.get('signet', 'no')
    if signet == 'no':
        add('signet_source', *(_step_status(values, 'signet') or ('missing', 'SIGNET has not been installed in the remote environment.')))
    elif signet != 'yes' or values.get('signet_integrity') != 'verified' or values.get('signet_revision') != revision:
        add('signet_source', 'problem', f'Audited source verification failed for revision {revision[:12]}; files may be missing or modified. Recheck HPC3 settings.')
    else:
        add('signet_source', 'ok', f'Audited script and support-file hashes match pinned revision {revision[:12]}.')
    for key, path in _checked_files().items():
        value = values.get(f'file_{key}', 'no')
        item = {'container': 'container', 'prepare': 'imputation_reference'}.get(key, f'reference_{key}')
        if values.get(f'selected_{key}') == 'yes':
            add(item, *_selected_status(value, values.get(f'access_{key}')))
            continue
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


def _unreachable(error):
    return {'status': 'unavailable', 'executed': False,
            'reason': f'HPC3 is not reachable or too slow: {error}. Connect with the SSH panel, '
                      'then run check_hpc_environment to see the current state.'}


def _run(script, timeout, required='workspace_path'):
    """Run a fixed script in a login shell (so `module` exists); return markers or an error result."""
    if not ssh_transport.available():
        return None, {'status': 'unavailable', 'executed': False,
                      'reason': 'Not running in the desktop app, so there is no HPC3 connection to use.'}
    try:
        config = ssh_transport.setup_environment()
    except ssh_transport.SshRemoteError as error:
        # SSH works; the desktop has no configured environment yet, and its message says why.
        return None, {'status': 'not_ready', 'executed': False, 'reason': str(error)}
    except OSError as error:
        return None, _unreachable(error)
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
                                      capture_output=True, timeout=timeout)
    except ValueError as error:
        return None, {'status': 'invalid', 'executed': False, 'error': str(error)}
    except (OSError, subprocess.SubprocessError) as error:
        return None, _unreachable(error)
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
            'evidence_scope': 'Existence, file sizes, audited source hashes and the app\'s own setup states only. '
                              'Only pinned source files were read for hashing; no contents or research data were returned and nothing on HPC3 was changed. '
                              'Readiness here does not establish scientific validity.'}


_OUTCOMES = {
    'started': 'Started in the background; call check_hpc_environment later to see when it finishes.',
    'in_progress': 'Already running in the background; nothing new was started.',
    'existing': 'Already present; left unchanged.',
    'needs_signet': 'Install SIGNET first; the example study data comes with it.',
    'needs_container': 'Download the SIGNET container first; this step runs inside it.',
    'needs_ref': 'Download the ref file first.',
    'needs_verified_selection': 'Verify the selected reference files with the current container before converting.',
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
    if step in ('workspace', 'signet'):
        return {'status': 'blocked', 'executed': False, 'step': step,
                'reason': 'Use the Install button on the SIGNET row of the Workflow panel. No second installation was started.'}
    if step == 'container' and not CONTAINER_SHA256:
        return {'status': 'blocked', 'executed': False, 'step': step,
                'reason': 'The container checksum has not been pinned in this version of the app, so nothing was downloaded.'}
    script = {'prepare': _prepare_script, 'container': _container_script,
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
    values, error = _run(lambda root: _log_script(step, root), timeout=60, required='log_exists')
    if error:
        return error
    if values['log_exists'] != 'yes':
        return {'status': 'ok', 'executed': False, 'step': step, 'lines': [], 'detail': 'This step has not run yet.'}
    lines = values.get('lines', [])
    if step == 'prepare':
        # Old and new error logs can contain selected paths or input data in exceptions.
        lines = _preparation_log_summary(lines)
    return {'status': 'ok', 'executed': False, 'step': step, 'lines': lines,
            'evidence_scope': f'Last {LOG_LINES} lines of the app-generated setup log only; never research data.'}


def _preparation_log_summary(lines):
    last_line = next((line for line in reversed(lines) if line.strip()), '')
    if not last_line:
        return []
    try:
        summary = json.loads(last_line)
    except ValueError:
        summary = None
    if (isinstance(summary, dict) and summary.get('status') == 'ok' and
            summary.get('scope') == 'Counts only. The original study files were not changed.'):
        return [last_line]
    return ['Reference preparation did not report success. Check the selected inputs and the remote job log.']
