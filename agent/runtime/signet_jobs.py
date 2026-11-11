"""Run single SIGNET steps on HPC3 as Slurm jobs, over the app's SSH connection.

Steps so far, all TCGA: "expression" (`signet -t`), "genotype" (`signet -g`),
"adjust" (`signet -a`) and "cis" (`signet -c`, cis-eQTL mapping).

One run is one analysis and one HPC3 folder. SIGNET knows nothing about runs: a
later step reads earlier results from its own work/ folder (partly through
config.ini paths, partly through fixed temporary folders such as tmp/tmpg). So
"adjust" may only start once "expression" and "genotype" completed in the same
run (Step.requires), and their files are checked on HPC3 first (Step.needs).
Some output names depend on settings (the -c results carry alpha.cis in their
name); they are fixed in the step record at submit time.
SIGNET questions that a person would type an answer to (Step.prompts, e.g. the
number of genotype PCs in -a) are answered from validated options instead.

This is the one place that decides what a step may do. The local HTTP API
(agent/app) and any future AI tool call these functions; neither builds shell
text itself. Callers pick a step from STEPS and pass validated values only.

Inputs are HPC3 paths below a few allowed folders. Most are single files. Some
(the genotype step's ref and gmap) are per-chromosome prefixes: SIGNET reads
<prefix><N>.gen / <prefix><N>.map for each chromosome N it processes, so
submit() checks each of those files before anything is queued.

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
the container in the Slurm job.

A step that failed or was cancelled may be submitted again in the same run, so
the earlier steps' results stay usable (one analysis = one run). Each earlier
attempt is kept, never overwritten: locally as steps/<step>.attempt<N>.json and
on HPC3 as steps/<step>.attempt<N>.{job,done,out,err,sbatch}. A completed step
is not rerun in place, since later steps may already have read its results.

The HTTP server is multi-threaded, so settings/submit/status/cancel of the same
run execute one at a time (see _one_at_a_time); settings must not change while
submission reads them, and simultaneous status checks must not download twice.
"""
from dataclasses import dataclass, field
import functools
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import subprocess
import tarfile
import threading
import time

from agent.runtime import ssh_transport
import agent.runtime.remote as vm
import agent.tools.signet as signet

# Lines that mean a SIGNET/R step failed even though `signet` exited 0.
FAILURE_PATTERNS = ('Execution halted', 'Error in ', 'cannot open', 'No such file or directory', 'command not found')
ACTIVE = ('submitting', 'submitted', 'pending', 'running', 'cancelling', 'validating', 'unknown')
TERMINAL = ('completed', 'failed', 'cancelled')
RETRYABLE = ('failed', 'cancelled')   # may be submitted again in the same run
# Files a job leaves in <run>/steps on HPC3; renamed to <step>.attempt<N>.<suffix> before a retry.
_JOB_FILES = ('job', 'done', 'out', 'err', 'sbatch', 'sbatch.err')
CACHE_SECONDS = 15
VISUALIZE_OUTPUT_GRACE_SECONDS = 120
MISSING_OUTPUTS_REASON = 'Required outputs are missing.'
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
    # Inputs that are per-chromosome prefixes, not files: key -> suffix. SIGNET reads
    # <prefix><N><suffix> for each chromosome N it processes (see _chromosomes).
    prefixes: dict = field(default_factory=dict)
    failures: tuple = ()  # extra log lines, specific to this step, that mean it failed
    # Steps that must have completed in THIS run first. SIGNET has no notion of runs: it
    # reads earlier results from its own work/ folder, which is this run's HPC3 folder.
    requires: tuple = ()
    # Files (relative to work/) that those earlier steps left in this run's HPC3 folder
    # and that this step reads; checked on HPC3 before anything is queued.
    needs: tuple = ()
    # Answers to SIGNET's interactive questions, fed to its stdin in this order:
    # key -> (rule, default). A batch job has no keyboard, so without them `read` gets nothing.
    prompts: dict = field(default_factory=dict)
    # Environment variables set inside the container (fixed values, never from the caller).
    env: dict = field(default_factory=dict)
    # config.ini keys pointed at earlier results of this run (path relative to work/) at submit.
    # configure_signet sets every input path to a work/missing/<key> placeholder, so a step that
    # reads earlier results through such keys must set them itself.
    links: dict = field(default_factory=dict)
    # config.ini keys set at submit from the HPC3 environment: '{image}', '{partition}' or a literal.
    fixed: dict = field(default_factory=dict)
    # True: run `signet` on the compute node itself, not inside the container. Needed when
    # SIGNET starts containers and submits its own Slurm jobs (signet -n).
    host: bool = False
    # For a host step: the config.ini key holding the memory (GB) of SIGNET's own jobs; the job
    # adds `#SBATCH --mem=<value>G` to SIGNET's job template, which has no memory line.
    child_memory: str = ''
    # Logs (relative to work/) in which SIGNET records the Slurm jobs it submitted; those jobs
    # are cancelled with the step, but only if they run inside this run's folder.
    children: tuple = ()


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
    'genotype': Step(
        flag='-g', cohort='TCGA', inputs=('ped.file', 'map.file', 'ref', 'gmap'),
        # script/geno_prep/imputation.sh runs IMPUTE2 with -g_ref <ref><N>.gen and -m <gmap><N>.map.
        prefixes={'ref': '.gen', 'gmap': '.map'},
        settings={'restrict.tcga.geno': 'chromosome', 'mind': 'fraction', 'geno': 'fraction',
                  'hwe': 'fraction', 'int': 'interval'},
        # Written by script/geno_prep/combine_geno.sh with the resg.tcga prefix res/resg/signet.
        required=('res/resg/signet_Geno', 'res/resg/signet_Genotype.sampleID'),
        download='work/res/resg',
        # IMPUTE2 runs one chunk per core (ParaFly -CPU ncore_local); each chunk needs a few GB.
        resources={'cpus': 8, 'mem_gb': 32, 'hours': 4},
        limits={'cpus': (1, 32), 'mem_gb': (1, 128), 'hours': (0.25, 24)},
        # check_ped.sh and imputation.sh print these, then stop with kill -10; signet still exits 0.
        failures=('No SNP listed in your chromosome input', 'Some of the jobs are incomplete'),
        description='TCGA genotype preprocessing (signet -g): PLINK quality control, then IMPUTE2 imputation.'),
    'adjust': Step(
        flag='-a', cohort='TCGA', inputs=('cli.file',),
        settings={},
        requires=('expression', 'genotype'),
        # script/adj_portal.sh reads the -t and -g results through rest.tcga / resg.tcga
        # (res/rest/signet, res/resg/signet); script/adj/adj_filter.sh also reads -g's
        # temporary files in tmp/tmpg/impute, a folder no setting can move.
        needs=('res/rest/signet_gexp', 'res/rest/signet_gexpID',
               'res/resg/signet_Geno', 'res/resg/signet_Genotype.sampleID',
               'tmp/tmpg/impute/impute_Genotype.sizes'),
        # script/adj/adj.sh asks "Enter the number of PCs for population structures";
        # adj_adjust.R uses that many of the 10 genotype PCs as covariates (0 = none).
        prompts={'npc': ('pcs', 3)},
        # Written with the resa.tcga prefix res/resa/signet; the -c step reads these.
        required=('res/resa/signet_matched.gexp', 'res/resa/signet_new.Geno',
                  'res/resa/signet_new.Geno.map', 'res/resa/signet_new.Geno.maf',
                  'res/resa/signet_gexp.data', 'res/resa/signet_gexp_rmpc.data',
                  'res/resa/signet_geno.data'),
        download='work/res/resa',
        # Light: one R job per chromosome (ParaFly -CPU ncore_local), smartpca, then R regressions.
        resources={'cpus': 4, 'mem_gb': 16, 'hours': 2},
        limits={'cpus': (1, 16), 'mem_gb': (1, 64), 'hours': (0.25, 12)},
        description='TCGA adjustment (signet -a): match expression and genotype samples, filter rare SNPs, '
                    'compute genotype PCs, and regress out race, gender and PCs.'),
    'cis': Step(
        flag='-c', cohort='TCGA', inputs=(),
        # script/cis_portal.sh reads everything from earlier steps of this run through the
        # [ciseqtl] paths in config.ini (res/resa/... and res/rest/signet_gene_pos).
        requires=('expression', 'adjust'),
        # The same pairs as the [ciseqtl] defaults of SIGNET's config.ini.default.
        links={'snps.map': 'res/resa/signet_new.Geno.map', 'snps.maf': 'res/resa/signet_new.Geno.maf',
               'matched.gexp': 'res/resa/signet_gexp_rmpc.data', 'matched.gexp.withpc': 'res/resa/signet_gexp.data',
               'matched.geno': 'res/resa/signet_geno.data', 'gene.pos': 'res/rest/signet_gene_pos'},
        needs=('res/resa/signet_new.Geno.map', 'res/resa/signet_new.Geno.maf',
               'res/resa/signet_gexp_rmpc.data', 'res/resa/signet_gexp.data',
               'res/resa/signet_geno.data', 'res/rest/signet_gene_pos'),
        # script/file_manage.sh file_check prints "The file <path> doesn't exist" and stops; signet exits 0.
        failures=("doesn't exist",),
        settings={'alpha.cis': 'alpha', 'nperms': 'count', 'upstream': 'flank', 'downstream': 'flank'},
        # Written by script/cis-eQTL/combine.sigcis.r and combine.sh with the resc prefix
        # res/resc/signet. {alpha.cis} is filled in from the run's settings at submit.
        required=('res/resc/signet_all.sig.pValue_{alpha.cis}', 'res/resc/signet_all.eQTL.data',
                  'res/resc/signet_net.gexp.data', 'res/resc/signet_net.genepos',
                  'res/resc/signet_net.genename'),
        download='work/res/resc',
        # Low-frequency and rare variants are tested by permutation, one R job per core
        # (ParaFly -CPU ncore_local); the R jobs must not each start a full BLAS thread pool.
        resources={'cpus': 8, 'mem_gb': 32, 'hours': 4},
        limits={'cpus': (1, 32), 'mem_gb': (1, 128), 'hours': (0.25, 24)},
        env={'OPENBLAS_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'},
        description='TCGA cis-eQTL mapping (signet -c): find each gene\'s significant nearby SNPs '
                    '(common, low-frequency and rare variants) to use as instrumental variables.'),
    'network': Step(
        flag='-n', cohort='TCGA', inputs=(),
        requires=('cis',),
        # The same pairs as the [network] defaults of SIGNET's config.ini.default.
        links={'net.gexp.data': 'res/resc/signet_net.gexp.data', 'net.geno.data': 'res/resc/signet_all.eQTL.data',
               'sig.pair': 'res/resc/signet_all.sig.pValue_{alpha.cis}',
               'net.genename': 'res/resc/signet_net.genename', 'net.genepos': 'res/resc/signet_net.genepos'},
        needs=('res/resc/signet_net.gexp.data', 'res/resc/signet_all.eQTL.data',
               'res/resc/signet_all.sig.pValue_{alpha.cis}', 'res/resc/signet_net.genename',
               'res/resc/signet_net.genepos'),
        fixed={'sif': '{image}', 'queue': '{partition}', 'computing': 'slurm', 'interactive': 'F', 'email': 'F'},
        # nboots, ncis and cor are statistical; ncores, memory and walltime size each of SIGNET's
        # own Slurm jobs (script/network/template.sub.ori), not this step's control job.
        settings={'nboots': 'boots', 'ncis': 'ncis', 'cor': 'alpha',
                  'ncores': 'cores', 'memory': 'gigabytes', 'walltime': 'hms'},
        host=True, child_memory='memory',
        children=('tmp/tmpn/stage1/submit1_log', 'tmp/tmpn/stage2/submit2_log'),
        # script/network/network.sh: summarize.r writes <resn>_Afreq; the last lines copy
        # CoeffMat0 and net.genepos next to it (resn = res/resn/signet).
        required=('res/resn/signet_Afreq', 'res/resn/signet_CoeffMat0', 'res/resn/signet_net.genepos'),
        download='work/res/resn',
        # This job only drives SIGNET (and runs its data preparation and summary in R); the
        # 2SPLS work runs in the Slurm jobs SIGNET submits. It must outlive both stages.
        resources={'cpus': 2, 'mem_gb': 16, 'hours': 24},
        limits={'cpus': (1, 8), 'mem_gb': (1, 128), 'hours': (0.25, 72)},
        env={'OPENBLAS_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'},
        # stage1.sh / bts2gensub.sh print the first and then `kill -10` the driver;
        # network_portal.sh prints the second when it finds no singularity.
        failures=('Some jobs are incomplete', 'Cannot find the container', "doesn't exist", 'Please reset'),
        description='TCGA network construction (signet -n): two-stage penalized least squares on bootstrap '
                    'data; SIGNET submits its own Slurm jobs, this step drives and follows them.'),
    'visualize': Step(
        flag='-v', cohort='TCGA', inputs=(),
        settings={'freq': 'alpha', 'ntop': 'subnetworks'},
        requires=('network',),
        links={'Afreq': 'res/resn/signet_Afreq', 'coef': 'res/resn/signet_CoeffMat0',
               'vis.genepos': 'res/resn/signet_net.genepos'},
        needs=('res/resn/signet_Afreq', 'res/resn/signet_CoeffMat0', 'res/resn/signet_net.genepos'),
        required=('res/resv/signet-edges.csv', 'res/resv/signet_count_vs_freq.pdf'),
        download='work/res/resv',
        resources={'cpus': 2, 'mem_gb': 16, 'hours': 2},
        limits={'cpus': (1, 8), 'mem_gb': (1, 64), 'hours': (0.25, 12)},
        env={'cloud': 'T', 'OPENBLAS_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1'},
        description='Export SIGNET network graphs and tables from this run’s network results.'),
}


ANALYSIS_STEPS = ('genotype', 'expression', 'adjust', 'cis', 'network', 'visualize')

# Each manifest is paired with the completion file(s) written by ParaFly.
COMMAND_PROGRESS = {
    'genotype': (('imputation', 'tmp/tmpg/impute_params.txt', 'impute_params.txt.completed'),),
    'adjust': (('variant_filter', 'tmp/tmpg/qsub.sh', 'qsub.sh.completed'),),
    'cis': (('low_frequency', 'tmp/tmpc/low.qsub.sh', 'low.qsub.sh.completed'),
            ('rare_variants', 'tmp/tmpc/rare.qsub.sh', 'rare.qsub.sh.completed')),
    'network': (('stage1', 'tmp/tmpn/stage1/params.txt', 'params[0-9]*.txt.completed'),
                ('stage2', 'tmp/tmpn/stage2/params.txt', 'params[0-9]*.txt.completed')),
}


def catalog():
    """Describe every step so a form can be built without hard-coding: inputs, settings, resources, outputs."""
    return {'steps': [{'name': name, 'flag': step.flag, 'cohort': step.cohort, 'description': step.description,
                       'inputs': list(step.inputs), 'prefix_inputs': step.prefixes, 'settings': step.settings,
                       'resources': step.resources, 'limits': {k: list(v) for k, v in step.limits.items()},
                       'requires': list(step.requires),
                       'options': {k: {'rule': rule, 'default': default} for k, (rule, default) in step.prompts.items()},
                       'required_outputs': list(step.required)} for name, step in STEPS.items()],
            'input_roots': ['<workspace>/refdata', '<signet source>/example', '<this run on HPC3>'],
            'states': ['submitted', 'pending', 'running', 'cancelling', 'validating', *TERMINAL, 'unknown']}


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


def _attempt_path(root, name, number):
    """Where an earlier attempt of a step is kept once it is retried: steps/<step>.attempt<N>.json."""
    return root / 'steps' / f'{name}.attempt{number}.json'


def _resolve(path, settings):
    """Fill {setting} placeholders in an output path from the run's settings (e.g. {alpha.cis} -> 0.05)."""
    return re.sub(r'\{([A-Za-z0-9_.]+)\}', lambda m: settings[m.group(1)], path)


def _required(step, record):
    """The outputs this attempt must produce: fixed at submit time, so a later settings change cannot alter them."""
    return record.get('required_outputs') or list(step.required)


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
    """Serialize settings and step operations for one run in this process.

    Without this, a UI timer and a manual refresh arriving together could both
    see a finished job, both download its results, and the slower one would save
    a stale record. Reentrant, because cancel() ends by calling status().
    """
    @functools.wraps(function)
    def wrapper(run_id, *args, **kwargs):
        with _LOCKS_GUARD:
            lock = _LOCKS.setdefault(run_id, threading.RLock())
        with lock:
            return function(run_id, *args, **kwargs)
    return wrapper


def _current_records(root):
    """Paths of each step's current record (steps/<step>.json), leaving out archived attempts."""
    folder = root / 'steps'
    if not folder.is_dir():
        return []
    return [path for path in sorted(folder.glob('*.json')) if '.' not in path.stem]


def _legacy_visualize_output_failure(record):
    return (record.get('step') == 'visualize' and record.get('state') == 'failed'
            and record.get('exit_code') == '0' and not record.get('failure_hints')
            and record.get('reason') == MISSING_OUTPUTS_REASON and 'missing_outputs_since' not in record)


def _active_step(root):
    for path in _current_records(root):
        record = json.loads(path.read_text())
        if record.get('state') in ACTIVE or _legacy_visualize_output_failure(record):
            return record['step']
    return None


def run_records(root):
    """Read the current step records from disk without checking HPC3."""
    records = {}
    for path in _current_records(root):
        try:
            records[path.stem] = json.loads(path.read_text())
        except FileNotFoundError:
            continue
    return records


def run_steps(run_id):
    """State of every step recorded for one run, e.g. {'expression': 'running'}."""
    return {name: record.get('state') for name, record in run_records(_root(run_id)).items()}


def analysis_session(root):
    """An older run without an explicit link is not assigned to any conversation."""
    path = root / 'conversation.json'
    try:
        return json.loads(path.read_text())['session']
    except FileNotFoundError:
        return None


@_one_at_a_time
def link_conversation(run_id, session):
    root = _root(run_id)
    previous = analysis_session(root)
    if previous is not None and previous != session:
        raise StepError('conflict', 'This analysis already belongs to another conversation.')
    if previous is None:
        path = root / 'conversation.json'
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps({'session': session}) + '\n')
        temporary.replace(path)
    return {'run_id': run_id, 'session': session}


def analysis_view(root, cohort, records, *, include_attempts=True):
    """Project stored records for chat without polling, downloading or starting a job."""
    stages = []
    if cohort == 'TCGA':
        for name in ANALYSIS_STEPS:
            record = records.get(name)
            phase = 'not_started'
            attempts = []
            if record is not None:
                if include_attempts:
                    current = record.get('attempt', 1)
                    # A retry archives its predecessor before publishing the new current
                    # record. Only read archives older than the snapshot's current attempt.
                    for number in range(1, current):
                        path = _attempt_path(root, name, number)
                        try:
                            attempts.append({**json.loads(path.read_text()), 'attempt': number})
                        except FileNotFoundError:
                            continue
                    attempts.append({**record, 'attempt': current})
                phase = record['state']
                if phase == 'pending':
                    phase = 'queued'
                elif phase == 'validating' and record.get('download_pending'):
                    phase = 'downloading'
                elif _legacy_visualize_output_failure(record):
                    phase = 'validating'
            flag = STEPS[name].flag if name in STEPS else '-v'
            stage = {'step': name, 'flag': flag, 'phase': phase}
            if record and record.get('reused_from'):
                stage['reused_from'] = record['reused_from']
            if include_attempts:
                stage['attempts'] = attempts
            elif record:
                parameters = {key: record[key] for key in ('inputs', 'settings', 'resources', 'options')
                              if record.get(key)}
                if parameters:
                    stage['parameters'] = parameters
                progress = dict(record.get('progress', {}))
                if phase == 'completed' and name == 'expression':
                    progress['expression_outputs'] = '2 2'
                if phase == 'completed' and name == 'visualize':
                    count = record.get('settings', {}).get('ntop')
                    if count:
                        progress['subnetworks'] = f'{count} {count}'
                if progress:
                    stage['progress'] = progress
            stages.append(stage)
    view = {'session': analysis_session(root), 'steps': stages,
            'completed_steps': sum(step['phase'] == 'completed' for step in stages),
            'total_steps': len(stages)}
    if origin := _rerun_origin(root):
        view['rerun'] = {key: origin[key] for key in ('source_run', 'from_step')}
    return view


@_one_at_a_time
def update_settings(run_id, values):
    """Change whitelisted config.ini settings of a local run (signet -s). Refused while a step is active."""
    root = _root(run_id)
    if not isinstance(values, dict) or not values:
        raise StepError('invalid_request', 'values must be a non-empty object.')
    rules = {key: rule for step in STEPS.values() for key, rule in step.settings.items()}
    checked = validate_settings(rules, values)
    if _active_step(root) or (root / '.active').exists():
        raise StepError('conflict', 'A step of this run is still active; wait for it to finish.')
    signet._update(root, checked)
    return signet._settings(root)


def validate_settings(rules, values):
    if not isinstance(values, dict) or set(values) - set(rules):
        raise StepError('invalid_request', 'Allowed settings: ' + ', '.join(rules) + '.')
    return {key: _setting(key, rules[key], value) for key, value in values.items()}


def _setting(key, rule, value):
    """Check one setting value against its rule and return it as config.ini text."""
    number = isinstance(value, (int, float)) and not isinstance(value, bool)
    if rule == 'chromosome':
        if value == 'no':
            return 'no'
        if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 22:
            return str(value)
        raise StepError('invalid_request', f'{key} must be "no" or a chromosome from 1 to 22.')
    if rule == 'fraction':   # PLINK cutoffs: --mind, --geno, --hwe
        if number and 0 <= value <= 1:
            return str(value)
        raise StepError('invalid_request', f'{key} must be a number from 0 to 1.')
    if rule == 'interval':   # IMPUTE2 chunk length in base pairs
        if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 100_000_000:
            return str(value)
        raise StepError('invalid_request', f'{key} must be a whole number of base pairs from 1 to 100000000.')
    if rule == 'alpha':      # significance level; also part of the -c result file name
        if number and 0 < value <= 1:
            return str(value)
        raise StepError('invalid_request', f'{key} must be a number above 0 and at most 1.')
    if rule == 'subnetworks':
        if type(value) is int and 1 <= value <= 20:
            return str(value)
        raise StepError('invalid_request', 'ntop must be a whole number from 1 to 20.')
    if rule == 'count':      # number of permutations
        if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 100_000:
            return str(value)
        raise StepError('invalid_request', f'{key} must be a whole number from 1 to 100000.')
    if rule == 'boots':      # number of bootstrap data sets
        if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 1000:
            return str(value)
        raise StepError('invalid_request', f'{key} must be a whole number from 1 to 1000.')
    if rule == 'ncis':       # most instrumental variables per gene
        if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 10:
            return str(value)
        raise StepError('invalid_request', f'{key} must be a whole number from 1 to 10.')
    if rule == 'cores':      # CPUs of each of SIGNET's own jobs
        if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 64:
            return str(value)
        raise StepError('invalid_request', f'{key} must be a whole number from 1 to 64.')
    if rule == 'gigabytes':  # memory of each of SIGNET's own jobs
        if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 128:
            return str(value)
        raise StepError('invalid_request', f'{key} must be a whole number of GB from 1 to 128.')
    if rule == 'hms':        # wall time of each of SIGNET's own jobs, H:MM:SS
        match = re.fullmatch(r'([0-9]{1,2}):([0-5][0-9]):([0-5][0-9])', value) if isinstance(value, str) else None
        if match and 300 <= int(match[1]) * 3600 + int(match[2]) * 60 + int(match[3]) <= 48 * 3600:
            return value
        raise StepError('invalid_request', f'{key} must be H:MM:SS from 0:05:00 to 48:00:00.')
    if rule == 'flank':      # base pairs added up- or downstream of a gene
        if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 10_000_000:
            return str(value)
        raise StepError('invalid_request', f'{key} must be a whole number of base pairs from 0 to 10000000.')
    raise StepError('invalid_request', f'No rule for {key}.')


def _check_current(step, settings):
    """Re-check the run's current values of this step's settings, which may still be SIGNET's or
    configure_signet's defaults (e.g. memory = 256 for -n), before anything reaches HPC3."""
    for key, rule in step.settings.items():
        text = settings.get(key, '')
        value = int(text) if re.fullmatch(r'-?[0-9]+', text) else (
            float(text) if re.fullmatch(r'-?[0-9]*\.?[0-9]+(e-?[0-9]+)?', text) else text)
        try:
            _setting(key, rule, value)
        except StepError as error:
            raise StepError('invalid_request', f'This run\'s {key} is {text!r}: {error} '
                            'Change it with the settings route first.') from error


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


def _options(step, values):
    """Answers for the step's SIGNET prompts: the caller's values checked by rule, the rest defaults."""
    if values is None:
        values = {}
    if not isinstance(values, dict) or set(values) - set(step.prompts):
        allowed = ', '.join(step.prompts) or 'nothing'
        raise StepError('invalid_request', f'options may only set {allowed} for this step.')
    checked = {}
    for key, (rule, default) in step.prompts.items():
        value = values.get(key, default)
        if rule == 'pcs':   # adj_adjust.R takes the first npc of 10 genotype PCs
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 10:
                raise StepError('invalid_request', f'{key} must be a whole number from 0 to 10.')
        else:
            raise StepError('invalid_request', f'No rule for {key}.')
        checked[key] = value
    return checked


def _other_runs_with(root, name):
    """Other local runs in which step `name` completed, to point the user at them."""
    found = []
    for path in sorted(root.parent.glob(f'*/steps/{name}.json')):
        if path.parent.parent != root:
            try:
                if json.loads(path.read_text()).get('state') == 'completed':
                    found.append(path.parent.parent.name)
            except (OSError, ValueError):
                continue
    return found


def _prerequisites(root, step):
    """Refuse unless every step this one builds on has completed in this same run."""
    missing = []
    for name in step.requires:
        path = _record_path(root, name)
        state = json.loads(path.read_text()).get('state') if path.is_file() else 'not submitted'
        if state != 'completed':
            missing.append((name, state))
    if not missing:
        return
    parts = []
    for name, state in missing:
        elsewhere = _other_runs_with(root, name)
        note = f' (completed in other runs: {", ".join(elsewhere)})' if elsewhere else ''
        parts.append(f'{name} is {state}{note}')
    raise StepError('invalid_request',
                    f'This step needs {" and ".join(step.requires)} completed in this same run first: '
                    + '; '.join(parts) + '. Results from other runs are not used, because SIGNET reads them '
                    'from this run\'s own HPC3 folder.')


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


def _rerun_origin(root):
    try:
        return json.loads((root / 'rerun.json').read_text())
    except FileNotFoundError:
        return {}


def _input_roots(config, root, directory):
    return (config['root'] + '/refdata', config['source'] + '/example', directory,
            *_rerun_origin(root).get('input_roots', ()))


def _chromosome_key(step):
    return next((key for key, rule in step.settings.items() if rule == 'chromosome'), 'the chromosome setting')


def _chromosomes(step, settings):
    """Chromosomes the step will read: the one its chromosome setting names, else 1..nchr."""
    for key, rule in step.settings.items():
        if rule == 'chromosome' and settings.get(key, 'no') != 'no':
            return [int(settings[key])]
    return list(range(1, int(settings.get('nchr', '22')) + 1))


def _files(step, checked, settings):
    """Every HPC3 file the step reads, as (key, path, root); a prefix input expands to one file per chromosome."""
    files = []
    for key, (path, root) in checked.items():
        if key in step.prefixes:
            files += [(key, f'{path}{n}{step.prefixes[key]}', root) for n in _chromosomes(step, settings)]
        else:
            files.append((key, path, root))
    return files


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


def _job_script(config, run_id, name, step, directory, binds, options=None, settings=None):
    """The Slurm batch script. Every value in it was validated; nothing comes from the caller as text.

    SIGNET's stdin is /dev/null, or, for a step with prompts, one line per answer in
    step.prompts order (validated whole numbers only).

    Most steps run `signet` inside the container. A host step (signet -n) runs it on the
    compute node, because SIGNET then calls `singularity exec` itself and submits its own
    Slurm jobs: the script makes `singularity` available (HPC3 may only have apptainer),
    binds the run folder for every container SIGNET starts, and adds a memory line to
    SIGNET's job template.
    """
    q = shlex.quote
    bind = ','.join([f'{directory}:{directory}'] + [f'{path}:{path}:ro' for path in binds])
    answers = [str(options[key]) for key in step.prompts] if options else []
    stdin = f"< <(printf '%s\\n' {' '.join(q(a) for a in answers)})" if answers else '< /dev/null'
    if step.host:
        exports = ''.join(f'export {key}={q(value)}\n' for key, value in step.env.items())
        memory = ''
        if step.child_memory:
            gigabytes = int((settings or {})[step.child_memory])   # validated by _check_current
            memory = (f"sed -i '/^#SBATCH --mem=/d; /^#SBATCH -N 1$/a #SBATCH --mem={gigabytes}G' "
                      'script/network/template.sub.ori\n')
        run = f'''# SIGNET starts containers and Slurm jobs itself; its jobs inherit this environment.
if ! command -v singularity >/dev/null 2>&1; then
  mkdir -p {q(directory + '/steps/bin')} && ln -sf {q(config['executor'])} {q(directory + '/steps/bin/singularity')}
  export PATH={q(directory + '/steps/bin')}:"$PATH"
fi
export SINGULARITY_BIND={q(bind)} APPTAINER_BIND={q(bind)}
{exports}{memory}bash ./signet {step.flag} {stdin}'''
    else:
        env = f"--env {q(','.join(f'{k}={v}' for k, v in step.env.items()))} " if step.env else ''
        run = (f"{q(config['executor'])} exec --cleanenv --no-home {env}--bind {q(bind)} {q(config['image'])} "
               f"bash ./signet {step.flag} {stdin}")
    if name == 'expression':
        # Write each marker only after the corresponding audited R script ends.
        run = """printf '\nfile.create(file.path(Sys.getenv("SIGNET_TMP_ROOT"), "tmpt", ".signet-normalized"))\n' >> script/gexp_prep/gexp_prep.R
printf '\nfile.create(file.path(Sys.getenv("SIGNET_TMP_ROOT"), "tmpt", ".signet-annotated"))\n' >> script/gexp_prep/gpos.R
""" + run
    if name == 'visualize':
        # Change only the uploaded script. Use R's own frequency formatting for
        # upstream filenames, and publish the graph CSV only after exports exist.
        run = r"""sed -i '1i Sys.setenv(freq=trimws(Sys.getenv("freq")))' script/netvis/netshiny.R
sed -i '/^[[:space:]]*dev.off()$/a\   file.create(file.path(Sys.getenv("SIGNET_TMP_ROOT"), "tmpv", paste0(".signet-network-", i)))' script/netvis/circular.R
cat >> script/netvis/netshiny.R <<'SIGNET_EXPORT_CHECK'
frequency <- as.numeric(Sys.getenv("freq"))
prefix <- Sys.getenv("resv")
indices <- seq_len(as.integer(Sys.getenv("ntop")))
expected <- c(paste0(prefix, "_top", indices, "_freq", frequency, ".html"),
              paste0(prefix, "_circular_top", indices, "_freq", Sys.getenv("freq"), ".pdf"))
stopifnot(all(file.exists(expected)), all(file.info(expected)$size > 0))
edges <- paste0(prefix, "_edgelist_", frequency, ".txt")
stopifnot(file.exists(edges), file.info(edges)$size > 0)
stopifnot(file.copy(edges, file.path(dirname(prefix), "signet-edges.csv")))
SIGNET_EXPORT_CHECK
""" + run
    return f'''#!/bin/bash
#SBATCH --job-name=signet-{name}-{run_id}
#SBATCH --output={directory}/steps/{name}.out
#SBATCH --error={directory}/steps/{name}.err
{ssh_transport.runtime_module_prelude(config)}
cd {q(directory + '/work')} || exit 1
echo "[SIGNET-AGENT] START step={name} job=$SLURM_JOB_ID ts=$(date -Iseconds)"
# Batch jobs cannot answer prompts: flush old temporary files and use the cores Slurm gave this job.
sed -i -e 's/^forcerm *=.*/forcerm = T/' -e "s/^ncore_local *=.*/ncore_local = ${{SLURM_CPUS_PER_TASK:-1}}/" config.ini
{run}
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


def _submit_script(config, run_id, name, step, directory, files, resources, options=None, archive=None,
                   needs=None, settings=None):
    """Login-node script: check every input file and earlier result, write the job script, sbatch it, record the job ID.

    archive=N (a retry): once every check passed, the previous attempt's files are renamed
    to <step>.attemptN.* so the new job starts clean and the old logs stay readable.
    """
    q = shlex.quote
    keep = ''
    if archive:
        pairs = [(f'steps/{name}.{suffix}', f'steps/{name}.attempt{archive}.{suffix}') for suffix in _JOB_FILES]
        pairs.append((step.download, f'steps/{name}.attempt{archive}.results'))
        # Check every destination before moving anything; an archive is immutable.
        keep = ''.join(f'if [ -e "$D/"{q(dst)} ]; then say conflict archive; exit 6; fi\n'
                       for _, dst in pairs)
        keep += 'say attempt_started yes\n'
        keep += ''.join(f'if [ -e "$D/"{q(src)} ]; then mv -- "$D/"{q(src)} "$D/"{q(dst)} || '
                        '{ say archive_failed yes; exit 8; }; fi\n' for src, dst in pairs)
    binds = sorted({root for _, _, root in files if root != directory})
    # Results of earlier steps must still be in this run's folder (nobody cleaned it up).
    needs = ''.join(f'if [ ! -s "$D/work/"{q(path)} ]; then say missing_prior {q(path)}; exit 4; fi\n'
                    for path in (step.needs if needs is None else needs))
    # A file must be a real, non-empty file at exactly this path: no link may lead elsewhere.
    checks = ''.join(
        f'r="$(readlink -f -- {q(root)})"; f="$(readlink -f -- {q(path)})"\n'
        f'if [ "$f" != "$r/{path[len(root) + 1:]}" ] || [ ! -f "$f" ] || [ ! -s "$f" ]; then '
        f'say missing_input {q(key)}; say missing_file {q(path)}; exit 4; fi\n'
        for key, path, root in files)
    job = _job_script(config, run_id, name, step, directory, binds, options, settings)
    sbatch = (f'sbatch --parsable --partition={config["partition"]} --cpus-per-task={resources["cpus"]} '
              f'--mem={resources["mem_gb"]}G --time={resources["time"]} "$D/steps/{name}.sbatch"')
    return _say() + f'''D={q(directory)}
{checks}{needs}if [ ! -s {q(config['image'])} ]; then say not_ready container; exit 5; fi
if ! command -v sbatch >/dev/null 2>&1; then say not_ready sbatch; exit 5; fi
{keep}if [ -e "$D/steps/{name}.job" ]; then say conflict submitted; exit 6; fi
say attempt_started yes
cat > "$D/steps/{name}.sbatch" <<'SIGNET_JOB'
{job}SIGNET_JOB
job="$({sbatch} 2>"$D/steps/{name}.sbatch.err")" || {{ say sbatch_failed "$(head -c 300 "$D/steps/{name}.sbatch.err")"; exit 7; }}
job="${{job%%;*}}"   # --parsable prints "<id>;<cluster>" on multi-cluster setups
printf '%s\\n' "$job" > "$D/steps/{name}.job"
say job "$job"
'''


def _queue_check(record):
    """List active jobs of this run, including SIGNET's children, with a checked scheduler query."""
    q = shlex.quote
    return (f'jobs="$(squeue -h -u "$(id -un)" -o "%i %j %Z" 2>/dev/null)" && {{\n'
            '  say queue_checked yes\n'
            f'  say active_jobs "$(printf \'%s\\n\' "$jobs" | awk -v j={q(record.get("job_id") or "-")} '
            f'-v n={q("signet-" + record["step"] + "-" + record["run_id"])} '
            f'-v d={q(record["remote_dir"] + "/")} '
            "'$1 == j || $2 == n || index($3, d) == 1 {print $1}')\"\n}\n")


def _ensure_stopped(record):
    """A terminal local record (especially an old 'cancelled') is insufficient to overwrite a run."""
    script = _say() + _queue_check(record)
    if record.get('job_id'):
        script += (f'say ended "$(sacct -n -X -P -j {shlex.quote(record["job_id"])} '
                   '-o State 2>/dev/null | head -n 1)"\n')
    try:
        code, values, _ = _shell(script + 'true\n')
    except OSError as error:
        raise StepError('remote_failed', 'Could not confirm the previous job has stopped; do not retry yet.') from error
    ended = values.get('ended', '').split(' ')[0]
    terminal = ended == 'COMPLETED' or ended.startswith('CANCELLED') or ended in _SLURM_FAILED
    if code or values.get('queue_checked') != 'yes' or values.get('active_jobs') or (record.get('job_id') and not terminal):
        raise StepError('conflict', 'The previous job or its children have not been confirmed stopped on HPC3; check status before retrying.')


# ---------- the four operations ----------

@_one_at_a_time
def submit(run_id, name, inputs, resources=None, options=None, *, settings_override=None):
    """Submit one step of a run as a Slurm job and return its record (state "submitted" with job_id).

    options answers the step's SIGNET prompts (see Step.prompts); missing ones take their default.
    """
    step = _step(name)
    root = _root(run_id)
    current = signet._settings(root)
    if current.get('cohort') != step.cohort:
        raise StepError('invalid_request', f'Step {name} needs a {step.cohort} run.')
    request = _resources(step, resources)
    answers = _options(step, options)
    previous = _load(root, name) if _record_path(root, name).exists() else None
    if previous is not None and previous.get('state') not in RETRYABLE:
        if previous.get('state') == 'completed':
            raise StepError('conflict', f'Step {name} already completed in this run; use a new run to compute it again.')
        raise StepError('conflict', f'Step {name} of this run is {previous.get("state")}; check its status first.')
    attempt = previous.get('attempt', 1) + 1 if previous else 1
    active = _active_step(root)
    if active:
        raise StepError('conflict', f'Step {active} of this run is still active.')
    _prerequisites(root, step)
    overrides = validate_settings(step.settings, {} if settings_override is None else settings_override)
    _check_current(step, {**current, **overrides})
    config = _environment()
    directory = _remote_dir(config, root, run_id)
    checked = _inputs(step, inputs, _input_roots(config, root, directory))
    if previous:
        _ensure_stopped(previous)  # before uploading config.ini or touching any old result
        archived = _attempt_path(root, name, attempt - 1)
        local_results = root / 'steps' / f'{name}.attempt{attempt - 1}.results'
        if archived.exists() or local_results.exists():
            raise StepError('conflict', 'The previous attempt archive already exists; it will not be overwritten.')
    try:
        fd = os.open(root / '.active', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise StepError('conflict', 'Another operation on this run is in progress.') from error
    os.close(fd)
    try:
        # Inputs, plus the keys this step reads from earlier results of the run (as local work/
        # paths; the upload rewrites them to the run's HPC3 folder).
        fixed = {key: value.replace('{image}', config['image']).replace('{partition}', config['partition'])
                 for key, value in step.fixed.items()}
        signet._update(root, {**overrides, **{key: path for key, (path, _) in checked.items()},
                              **{key: str(root / 'work' / _resolve(rel, current)) for key, rel in step.links.items()},
                              **fixed})
        token = _owner(root, directory)
        record = {'step': name, 'run_id': run_id, 'flag': step.flag, 'remote_dir': directory,
                  'inputs': {key: path for key, (path, _) in checked.items()}, 'resources': request,
                  'partition': config['partition'], 'image': config['image'], 'submitted_at': _now(),
                  'attempt': attempt}
        if answers:
            record['options'] = answers   # kept for reproducibility: the answers SIGNET was given
        settings = signet._settings(root)
        if any('{' in path for path in step.required):
            record['required_outputs'] = [_resolve(path, settings) for path in step.required]
        record['settings'] = {key: settings[key] for key in step.settings}
        if previous:
            # A refused submission has no job of its own; retain the last real ID across it.
            record['previous_job_id'] = previous.get('job_id') or previous.get('previous_job_id')
        archived = _attempt_path(root, name, attempt - 1) if previous else None
        try:
            _upload(root, directory, token)
            if previous:   # keep the failed attempt's record before the new one replaces it
                with archived.open('x') as stream:
                    stream.write(json.dumps(previous, indent=2) + '\n')
                if (root / step.download).exists():
                    (root / step.download).rename(local_results)
            # Record intent before sbatch: a lost connection from here on may have started a job.
            _change(record, 'submitting')
            _save(root, record)
            files = _files(step, checked, signet._settings(root))
            settings = signet._settings(root)
            code, values, _ = _shell(_submit_script(config, run_id, name, step, directory, files, request, answers,
                                                    archive=attempt - 1 if previous else None,
                                                    needs=[_resolve(path, settings) for path in step.needs],
                                                    settings=settings))
        except OSError as error:
            if record.get('state') != 'submitting':
                raise StepError('remote_failed', 'HPC3 connection failed before anything was submitted.') from error
            _change(record, 'unknown', reason='Connection lost while submitting; check status before doing anything else.')
            return _save(root, record)
        if code == 0 and re.fullmatch(r'[0-9]+', values.get('job', '')):
            _change(record, 'submitted', job_id=values['job'], checked_at=0)
            return _save(root, record)
        if code == 0:
            _change(record, 'unknown', reason='Submission returned no valid job ID; check status. Do not resubmit.')
            return _save(root, record)
        # Once remote files moved, consume this attempt even if sbatch refused it.
        # Reusing its number would archive the new script over the previous one.
        if values.get('attempt_started') == 'yes':
            _change(record, 'failed', finished_at=_now(),
                    reason='Submission failed before a job ID was returned: ' + values.get('sbatch_failed', 'remote preparation failed.'))
            _save(root, record)
        elif previous:
            _save(root, previous)
            archived.unlink(missing_ok=True)
            if local_results.exists():
                local_results.rename(root / step.download)
        else:
            _record_path(root, name).unlink(missing_ok=True)
        if 'missing_input' in values:
            key = values['missing_input']
            hint = (f' (looked for {values.get("missing_file")}; set {_chromosome_key(step)} to the chromosome you have'
                    ' files for)') if key in step.prefixes else ''
            raise StepError('invalid_request', f'{key} is missing, empty, or reached through a link on HPC3{hint}.')
        if 'missing_prior' in values:
            raise StepError('invalid_request', f'{values["missing_prior"]} from an earlier step is missing in this '
                            'run\'s HPC3 folder; compute that step again in a new run.')
        if 'not_ready' in values:
            raise StepError('not_ready', f'HPC3 is not ready: {values["not_ready"]} is missing. Check the remote environment.')
        if 'conflict' in values:
            raise StepError('conflict', f'Step {name} was already submitted for this run on HPC3.')
        raise StepError('remote_failed', 'sbatch refused the job: ' + values.get('sbatch_failed', 'no reason given.'))
    finally:
        (root / '.active').unlink(missing_ok=True)


def _children_script(step):
    """Cancel jobs SIGNET submitted for this step (IDs from its submit logs), but only those whose
    working directory is inside this run's HPC3 folder ($D), so no other job can be touched."""
    q = shlex.quote
    return ''.join(
        f'for c in $(grep -Eo "[0-9]+$" "$D/work/"{q(log)} 2>/dev/null | sort -u); do\n'
        '  w="$(squeue -h -j "$c" -o %Z 2>/dev/null)"\n'
        '  case "$w" in "$D"/*) scancel "$c" && say child_cancelled "$c";; esac\n'
        'done\n' for log in step.children)


def _progress_script(record):
    """Count only current-attempt evidence from the official scripts."""
    name = record['step']
    commands = []
    for label, manifest, completed in COMMAND_PROGRESS.get(name, ()):
        directory, basename = manifest.rsplit('/', 1)
        commands.append(f'count_commands {label} "$D/work/"{shlex.quote(directory)} '
                        f'{shlex.quote(basename)} {shlex.quote(completed)}')
    if name == 'expression':
        commands.append('count_markers expression_outputs 2 "$D/work/tmp/tmpt/" .signet-normalized .signet-annotated')
    if name == 'visualize':
        count = record.get('settings', {}).get('ntop')
        if isinstance(count, str) and re.fullmatch(r'(?:[1-9]|1[0-9]|20)', count):
            names = ' '.join(f'.signet-network-{index}' for index in range(1, int(count) + 1))
            commands.append(f'count_markers subnetworks {count} "$D/work/tmp/tmpv/" {names}')
    if not commands:
        return ''
    # Retry counters can remain in temporary folders until the new job starts.
    # Compare to the script written immediately before this attempt was submitted.
    freshness = f' && [ "$1" -nt "$D/steps/{name}.sbatch" ]' if record.get('attempt', 1) > 1 else ''
    return f'''
fresh_progress_file() {{ [ -f "$1" ]{freshness}; }}
count_commands() {{
  local key="$1" directory="$2" manifest="$2/$3" pattern="$4" file counts
  fresh_progress_file "$manifest" || return 0
  set -- "$manifest"
  for file in "$directory"/$pattern; do
    if fresh_progress_file "$file"; then set -- "$@" "$file"; fi
  done
  counts="$(awk 'FILENAME == ARGV[1] {{ if (NF) {{ remaining[$0]++; total++ }}; next }}
    NF && remaining[$0] > 0 {{ remaining[$0]--; done++ }}
    END {{ if (total) printf "%d %d", done, total }}' "$@")" || return 0
  if [ -n "$counts" ]; then say "progress_$key" "$counts"; fi
}}
count_markers() {{
  local key="$1" total="$2" directory="$3" file done=0
  shift 3
  for file in "$@"; do
    if fresh_progress_file "$directory$file"; then done=$((done + 1)); fi
  done
  if [ "$done" -gt 0 ] || [ "$account_state" != COMPLETED ]; then
    say "progress_$key" "$done $total"
  fi
}}
case "$queue_state:$account_state" in
  RUNNING:*|COMPLETING:*|:RUNNING*|:COMPLETING*|:COMPLETED*)
    {chr(10).join(commands)}
    ;;
esac
'''


def _status_script(record, step):
    q = shlex.quote
    directory, name = record['remote_dir'], record['step']
    job = record.get('job_id')
    job_name = f'signet-{name}-{record["run_id"]}'
    outputs = ''.join(f'[ -s {q(directory + "/work/" + path)} ] && say output_{i} yes\n'
                      for i, path in enumerate(_required(step, record)))
    pattern = '|'.join(re.escape(p) for p in FAILURE_PATTERNS + step.failures)
    progress = _progress_script(record)
    # When the control job is gone, SIGNET's own jobs still queued for this run are orphans.
    orphans = (f'if [ -n "$j" ] && [ -z "$(squeue -h -j "$j" -o %T 2>/dev/null)" ]; then\n{_children_script(step)}fi\n'
               if step.children else '')
    queue_check = _queue_check(record) if record.get('cancel_requested_at') or step.children else ''
    return _say() + f'''D={q(directory)}
j={q(job) if job else '"$(head -n 1 "$D/steps/' + name + '.job" 2>/dev/null)"'}
# No ID recorded (connection lost around sbatch): look for this step's own job name, ours only.
if [ -z "$j" ]; then j="$(squeue -h -u "$(id -un)" -n {q(job_name)} -o %i 2>/dev/null | head -n 1)"; fi
if [ -z "$j" ]; then j="$(sacct -n -X -P --name={q(job_name)} -S now-7days -o JobID 2>/dev/null | tail -n 1)"; fi
say job "$j"
if [ -n "$j" ]; then
  queue_state="$(squeue -h -j "$j" -o %T 2>/dev/null)"
  account_state="$(sacct -n -X -P -j "$j" -o State 2>/dev/null | head -n 1)"
  say squeue "$queue_state"
  say sacct "$account_state"
fi
[ -f "$D/steps/{name}.done" ] && say done "$(head -n 1 "$D/steps/{name}.done")"
{outputs}cat "$D/steps/{name}.out" "$D/steps/{name}.err" 2>/dev/null | grep -E -m 20 {q(pattern)} | while IFS= read -r l; do say line "$l"; done
{progress}{orphans}{queue_check}true
'''


@_one_at_a_time
def status(run_id, name, refresh=False):
    """Current state of a submitted step; asks Slurm at most every 15 s unless refresh is true."""
    step = _step(name)
    root = _root(run_id)
    record = _load(root, name)
    # Only reopen unconfirmed artifacts, never an observed nonzero exit or log error.
    recheck_failure = (refresh and record['state'] == 'failed' and not record.get('failure_hints')
                       and ((record.get('slurm_state') == 'COMPLETED' and record.get('exit_code') is None
                             and record.get('reason') == 'The job did not finish its last line.')
                            or (record.get('exit_code') == '0' and record.get('reason') == MISSING_OUTPUTS_REASON)))
    if record['state'] in TERMINAL and not (recheck_failure or _legacy_visualize_output_failure(record)):
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
    record.pop('download_pending', None)
    if (not record.get('job_id') and record.get('previous_job_id')
            and values.get('job') == record['previous_job_id']):
        # A retry lost its connection before the old attempt's files were renamed on HPC3:
        # what was found belongs to the previous attempt, so this attempt has no job yet.
        for key in ('job', 'squeue', 'sacct', 'done'):
            values.pop(key, None)
        hints = []
    if not record.get('job_id') and re.fullmatch(r'[0-9]+', values.get('job', '')):
        record['job_id'] = values['job']   # recovered after a lost connection during submit
    queued, accounted = values.get('squeue', ''), values.get('sacct', '').split(' ')[0]
    slurm = queued or accounted
    record['slurm_state'] = slurm or None
    measured = {}
    for key, value in values.items():
        if not key.startswith('progress_') or not re.fullmatch(r'[0-9]+ [0-9]+', value):
            continue
        done, total = map(int, value.split())
        if 0 <= done <= total and total > 0 and record.get('job_id'):
            measured[key.removeprefix('progress_')] = value
    if measured:
        record.setdefault('progress', {}).update(measured)
    missing = [path for i, path in enumerate(_required(step, record)) if values.get(f'output_{i}') != 'yes']
    cancelling = record.get('cancel_requested_at')
    terminal = slurm == 'COMPLETED' or slurm.startswith('CANCELLED') or slurm in _SLURM_FAILED
    finishing = terminal or 'done' in values
    if ((cancelling and not terminal)
            or ((cancelling or step.children) and finishing
                and (values.get('queue_checked') != 'yes' or values.get('active_jobs')))):
        record.pop('finished_at', None)
        state = 'cancelling' if cancelling or slurm.startswith('CANCELLED') else 'validating'
        _change(record, state, reason='Waiting for HPC3 to confirm the job and its children have stopped.')
    elif slurm == 'PENDING':
        _change(record, 'pending')
    elif slurm in _SLURM_RUNNING:
        _change(record, 'running')
    elif slurm.startswith('CANCELLED'):
        _change(record, 'cancelled', finished_at=_now(), reason='Slurm confirmed the job was cancelled.')
    elif slurm in _SLURM_FAILED:
        _change(record, 'failed', finished_at=_now(), missing_outputs=missing, failure_hints=hints,
                reason=f'Slurm ended the job with {slurm}.')
    elif slurm == 'COMPLETED' or 'done' in values:
        _finish(root, record, step, values.get('done', ''), missing, hints)
    elif not record.get('job_id'):
        # Empty lookups can mean scheduler failure or accounting delay, not an unsubmitted job.
        _change(record, 'unknown',
                reason='No Slurm job ID could be confirmed yet; check status again or inspect the run folder on HPC3. Do not resubmit.')
    elif time.time() - record.get('first_seen_missing', time.time()) > 300:
        _change(record, 'unknown', reason='Slurm has no record of this job; inspect the run folder on HPC3.')
    else:
        record.setdefault('first_seen_missing', time.time())
    return _save(root, record)


def _finish(root, record, step, done, missing, hints):
    """The job ended: decide completed or failed (spec §7), and on success copy the results here."""
    # Slurm completion can be visible before the exit marker is readable in full.
    marker = re.fullmatch(r'([0-9]+) \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?', done)
    if marker is None:
        record.pop('finished_at', None)
        _change(record, 'validating', exit_code=None, missing_outputs=missing, failure_hints=hints,
                reason='Waiting for a complete exit marker on HPC3; check status again. Do not resubmit.')
        return
    exit_code = marker.group(1)
    if record['step'] == 'visualize' and exit_code == '0' and missing and not hints:
        # The login node can see the successful exit before it sees the graph files.
        checked_at = record['checked_at']
        since = record.setdefault('missing_outputs_since', checked_at)
        if checked_at - since < VISUALIZE_OUTPUT_GRACE_SECONDS:
            record.pop('finished_at', None)
            _change(record, 'validating', exit_code=exit_code, missing_outputs=missing, failure_hints=[],
                    reason='Waiting for visualization outputs to appear on HPC3.')
            return
    if exit_code != '0' or missing or hints:
        reason = (f'signet exited with {exit_code}.' if exit_code != '0' else
                  MISSING_OUTPUTS_REASON if missing else 'The log reports an error.')
        _change(record, 'failed', finished_at=_now(), exit_code=exit_code, missing_outputs=missing,
                failure_hints=hints, reason=reason)
        return
    record.pop('finished_at', None)
    record.pop('missing_outputs_since', None)
    _change(record, 'validating', exit_code='0', download_pending=True,
            reason='Results passed the checks on HPC3; downloading them now.')
    _save(root, record)  # The local analysis view can see this while the transfer runs.
    required = tuple('work/' + path for path in _required(step, record))
    # Only recover results that were already present before this transfer.
    already_downloaded = all((root / path).is_file() and (root / path).stat().st_size for path in required)
    try:
        q = shlex.quote
        result = ssh_transport.remote(f'cd {q(record["remote_dir"])} && tar czf - {q(step.download)}',
                                      capture_output=True, timeout=300)
        if result.returncode:
            raise OSError('tar failed')
        record['outputs'] = vm.restore_outputs(root, result.stdout, required=required)
    except (OSError, ValueError, tarfile.TarError, EOFError, subprocess.TimeoutExpired) as error:
        if not already_downloaded:
            record['reason'] = f'Results are ready on HPC3 but could not be downloaded yet ({error}); check status again.'
            return
        record['outputs'] = sorted(str(path.relative_to(root)) for path in
                                   (root / step.download).rglob('*') if path.is_file())
    if record['step'] == 'visualize':
        from agent.runtime.visualization import read_graph
        try:
            read_graph(root / step.download / 'signet-edges.csv', int(record['settings']['ntop']))
        except (OSError, ValueError, KeyError) as error:
            record.pop('download_pending', None)
            _change(record, 'failed', finished_at=_now(), reason=f'Invalid visualization output: {error}')
            return
    record.pop('download_pending', None)
    _change(record, 'completed', finished_at=_now(), missing_outputs=[], failure_hints=[],
            reason='Outputs present and logs clean. This is not scientific validation; review the results.')


@_one_at_a_time
def cancel(run_id, name):
    """Cancel the step's own Slurm job (checked by job name), and for signet -n the jobs SIGNET
    submitted inside this run's folder. Finished steps cannot be cancelled."""
    step = _step(name)
    root = _root(run_id)
    record = _load(root, name)
    if record['state'] in TERMINAL:
        raise StepError('conflict', f'Step {name} already ended as {record["state"]}.')
    if not record.get('job_id'):
        raise StepError('conflict', 'No job ID is known yet; check status first.')
    _environment()
    expected = f'signet-{name}-{run_id}'
    script = _say() + (f'D={shlex.quote(record["remote_dir"])}\nj={shlex.quote(record["job_id"])}\n'
                       f'if [ "$(squeue -h -j "$j" -o %j 2>/dev/null)" = {shlex.quote(expected)} ]; then '
                       'scancel "$j" && say cancel requested; else say cancel not_queued; fi\n'
                       + _children_script(step))
    try:
        code, values, _ = _shell(script, timeout=30)
    except OSError as error:
        raise StepError('remote_failed', 'Could not reach HPC3; the job was not cancelled.') from error
    if code or 'cancel' not in values:
        raise StepError('remote_failed', 'scancel did not complete on HPC3.')
    if values['cancel'] == 'requested' or step.children:
        # The control job can already be gone while its cancelled children are still draining.
        record.pop('finished_at', None)
        _change(record, 'cancelling', cancel_requested_at=_now(), checked_at=0,
                reason='Cancellation requested; waiting for HPC3 to confirm termination.')
        _save(root, record)
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
