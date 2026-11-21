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
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import socket
import stat
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
    # Folders (relative to work/) where SIGNET's ParaFly batches run, to report progress.
    stages: tuple = ()


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
               'tmp/tmpg/impute/impute_Genotype.sizes', 'tmp/tmpg/clean_Genotype.fam'),
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
        stages=('tmp/tmpn/stage1', 'tmp/tmpn/stage2'),
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
        flag='-v', cohort='TCGA', inputs=(), requires=('network',),
        links={'Afreq': 'res/resn/signet_Afreq', 'coef': 'res/resn/signet_CoeffMat0',
               'vis.genepos': 'res/resn/signet_net.genepos'},
        needs=('res/resn/signet_Afreq', 'res/resn/signet_CoeffMat0', 'res/resn/signet_net.genepos'),
        settings={'freq': 'frequency', 'ntop': 'subnetworks'},
        required=('res/resv/signet_edgelist_{freq}.txt', 'res/resv/signet_count_vs_freq.pdf',
                  'res/resv/signet_count_vs_freq.eps'),
        download='work/res/resv',
        resources={'cpus': 2, 'mem_gb': 16, 'hours': 1},
        limits={'cpus': (1, 8), 'mem_gb': (1, 64), 'hours': (0.25, 12)},
        env={'cloud': 'T', 'OPENBLAS_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'},
        failures=("doesn't exist",),
        description='TCGA network visualization (signet -v): export the selected subnetworks, '
                    'directed edge list and original interactive graphs without starting a Shiny server.'),
}


DOWNLOADED_STEPS = ('network', 'visualize')
# Raised when the counting changes, so summaries saved by an older version are counted again.
SUMMARY_VERSION = 3
# Inputs whose size the summary reports, so "before" and "after" both come from HPC3.
_COUNTED_INPUTS = {'genotype': ('ped.file', 'map.file'), 'expression': ('gexp.file',)}

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


def _release_submission_claim(root, descriptor):
    """A finishing operation must never unlink a replacement owner's marker."""
    try:
        path = root / '.active'
        owned = os.fstat(descriptor)
        try:
            current = path.lstat()
        except FileNotFoundError:
            return
        if (current.st_dev, current.st_ino) == (owned.st_dev, owned.st_ino):
            path.unlink()
    finally:
        os.close(descriptor)


def _create_submission_claim(root, name, attempt, submission_token):
    try:
        descriptor = os.open(root / '.active', os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
    except FileExistsError as error:
        raise StepError('conflict', 'Another operation on this run is in progress.') from error
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        claim = {'version': 1, 'kind': 'workspace_submission', 'pid': os.getpid(),
                 'host': socket.gethostname(), 'root': str(root), 'run_id': root.name,
                 'step': name, 'attempt': attempt, 'submission_token': submission_token}
        with os.fdopen(os.dup(descriptor), 'w') as stream:
            json.dump(claim, stream)
            stream.flush()
            os.fsync(stream.fileno())
        return descriptor
    except BaseException:
        _release_submission_claim(root, descriptor)
        raise


def _recovery_active_claim(root, record, *, expected=None, release=False):
    """Recover only the unchanged, unlocked claim of a demonstrably dead local submitter."""
    descriptor = None
    blocked = {'status': 'unresolved', 'detail': 'A legacy, live or unverifiable local operation marker remains; it was not removed.'}
    try:
        try:
            descriptor = os.open(root / '.active', os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return {'status': 'absent'} if expected in (None, {'status': 'absent'}) else blocked
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        info = os.fstat(descriptor)
        current = (root / '.active').lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 4096 or (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino):
            return blocked
        raw = os.read(descriptor, 4097)
        claim = json.loads(raw)
        identity = {'version': 1, 'kind': 'workspace_submission', 'host': socket.gethostname(),
                    'root': str(root), 'run_id': record['run_id'], 'step': record['step'],
                    'attempt': record.get('attempt', 1), 'submission_token': record.get('submission_token')}
        if (not isinstance(claim, dict) or set(claim) != set(identity) | {'pid'}
                or type(claim.get('pid')) is not int or claim['pid'] <= 0
                or any(type(claim[key]) is not type(value) or claim[key] != value for key, value in identity.items())):
            return blocked
        try:
            os.kill(claim['pid'], 0)
        except ProcessLookupError:
            pass
        else:
            return blocked
        evidence = {'status': 'dead_submitter', 'identity': [info.st_dev, info.st_ino],
                    'digest': hashlib.sha256(raw).hexdigest()}
        if expected is not None and evidence != expected:
            return blocked
        if release:
            current = (root / '.active').lstat()
            if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                return blocked
            (root / '.active').unlink()
            return {'status': 'released'}
        return evidence
    except (OSError, ValueError, KeyError, TypeError, OverflowError):
        return blocked
    finally:
        if descriptor is not None:
            os.close(descriptor)


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


def _active_step(root):
    for path in _current_records(root):
        record = json.loads(path.read_text())
        if record.get('state') in ACTIVE:
            return record['step']
    return None


def run_steps(run_id):
    """State of every step recorded for one run, e.g. {'expression': 'running'}."""
    return {path.stem: json.loads(path.read_text()).get('state') for path in _current_records(_root(run_id))}


@_one_at_a_time
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
    if rule == 'frequency':
        if number and 0 <= value <= 1:
            return format(value, '.15g')
        raise StepError('invalid_request', f'{key} must be a number from 0 to 1.')
    if rule == 'subnetworks':
        if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 100:
            return str(value)
        raise StepError('invalid_request', f'{key} must be a whole number from 1 to 100.')
    if rule == 'interval':   # IMPUTE2 chunk length in base pairs
        if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 100_000_000:
            return str(value)
        raise StepError('invalid_request', f'{key} must be a whole number of base pairs from 1 to 100000000.')
    if rule == 'alpha':      # significance level; also part of the -c result file name
        if number and 0 < value <= 1:
            return str(value)
        raise StepError('invalid_request', f'{key} must be a number above 0 and at most 1.')
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


def _job_script(config, run_id, name, step, directory, binds, options=None, settings=None, dataset_plan=None):
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
    if dataset_plan:
        from agent.runtime.workspace_inputs import stage_command
        run = ('(\n' + stage_command(dataset_plan)
               + 'stage_rc=$?\n[ "$stage_rc" -eq 0 ] || exit "$stage_rc"\n' + run + '\n)')
    if name == 'adjust':
        # Keep the actual clinical input and smartpca outputs with the downloaded results.
        clinical = q((settings or {})['cli.file'])
        frozen = directory + '/work/res/resa/workspace-clinical.tsv'
        replacement = q('s|^cli.file *=.*|cli.file = ' + frozen + '|')
        run = f'''(
mkdir -p res/resa &&
cp -- {clinical} res/resa/workspace-clinical.tsv &&
sed -i {replacement} config.ini &&
{run} || exit $?
cp -- tmp/tmpg/geno_id res/resa/workspace-genotype-ids.txt &&
cp -- tmp/tmpa/Geno.pca.evec res/resa/workspace-pca.evec &&
cp -- tmp/tmpa/Geno.eval res/resa/workspace-pca.eval
)'''
    if name == 'visualize':
        # Record each successfully rendered circular graph for measured work units.
        run = r"""sed -i '/^[[:space:]]*dev.off()$/a\   file.create(file.path(Sys.getenv("SIGNET_TMP_ROOT"), "tmpv", paste0(".signet-network-", i)))' script/netvis/circular.R
""" + run
        # cloud=T leaves the official exports intact and skips only the blocking Shiny app.
        run = f'''(
if ! grep -q SIGNET_STAGE6_EXPORTS_COMPLETED script/netvis/netshiny.R; then
  {{ printf '%s\\n' 'Sys.setenv(freq=trimws(Sys.getenv("freq")))' &&
     cat script/netvis/netshiny.R &&
     printf '\\ncat("SIGNET_STAGE6_EXPORTS_COMPLETED\\\\n")\\n'; }} > script/netvis/netshiny.R.workspace-tmp &&
  mv -- script/netvis/netshiny.R.workspace-tmp script/netvis/netshiny.R
fi &&
{run}
)'''
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


def _input_checks(files):
    q = shlex.quote
    # A file must be a real, non-empty file at exactly this path: no link may lead elsewhere.
    return ''.join(
        f'r="$(readlink -f -- {q(root)})"; f="$(readlink -f -- {q(path)})"\n'
        f'if [ "$f" != "$r/{path[len(root) + 1:]}" ] || [ ! -f "$f" ] || [ ! -s "$f" ]; then '
        f'say missing_input {q(key)}; say missing_file {q(path)}; exit 4; fi\n'
        for key, path, root in files)


def _expression_input_check(name, files):
    if name != 'expression':
        return ''
    source = (Path(__file__).with_name('jobs') / 'step_inputs.py').read_text()
    annotation = next(path for key, path, _ in files if key == 'pmap.file')
    return ("python3 - " + shlex.quote(annotation) + " <<'SIGNET_GTF_CHECK'\n"
            + source + "\nimport sys\nproblem = gtf_problem(sys.argv[1])\n"
            + "if problem:\n    print('@@invalid_input\t' + problem)\n    sys.exit(9)\nSIGNET_GTF_CHECK\n"
            + "[ $? -eq 0 ] || exit 9\n")


def _submit_script(config, run_id, name, step, directory, files, resources, options=None, archive=None,
                   needs=None, settings=None, dataset_plan=None, submission_token=None):
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
    binds = [] if dataset_plan else sorted({root for _, _, root in files if root != directory})
    # Results of earlier steps must still be in this run's folder (nobody cleaned it up).
    needs = ''.join(f'if [ ! -s "$D/work/"{q(path)} ]; then say missing_prior {q(path)}; exit 4; fi\n'
                    for path in (step.needs if needs is None else needs))
    checks = _input_checks(files) + _expression_input_check(name, files)
    job = _job_script(config, run_id, name, step, directory, binds, options, settings, dataset_plan)
    receipt = f"$D/steps/{name}.submission.{submission_token}" if submission_token else "/dev/null"
    receipt_setup = ''
    if submission_token:
        receipt_setup = (f'R="{receipt}"\n'
                         '(set -o noclobber; printf "checking\\n" > "$R") || { say conflict receipt; exit 6; }\n'
                         'dispatched=no\n'
                         'trap \'rc=$?; if [ "$dispatched" = no ] && [ "$rc" -ne 0 ]; then '
                         'printf "not_dispatched\\n" > "$R"; fi\' EXIT\n')
    comment = f" --comment={shlex.quote(submission_token)}" if submission_token else ""
    sbatch = (f'sbatch --parsable --partition={config["partition"]} --cpus-per-task={resources["cpus"]} '
              f'--mem={resources["mem_gb"]}G --time={resources["time"]}{comment} "$D/steps/{name}.sbatch"')
    return _say() + f'''D={q(directory)}
{receipt_setup}{checks}{needs}if [ ! -s {q(config['image'])} ]; then say not_ready container; exit 5; fi
if ! command -v sbatch >/dev/null 2>&1; then say not_ready sbatch; exit 5; fi
{keep}if [ -e "$D/steps/{name}.job" ]; then say conflict submitted; exit 6; fi
say attempt_started yes
cat > "$D/steps/{name}.sbatch" <<'SIGNET_JOB' || exit 8
{job}SIGNET_JOB
printf 'dispatching\\n' > "{receipt}" || exit 8
dispatched=yes
say submission_dispatched yes
job="$({sbatch} 2>"$D/steps/{name}.sbatch.err")" || {{ say sbatch_failed "$(head -c 300 "$D/steps/{name}.sbatch.err")"; exit 7; }}
job="${{job%%;*}}"   # --parsable prints "<id>;<cluster>" on multi-cluster setups
printf '%s\\n' "$job" > "$D/steps/{name}.job"
printf 'accepted %s\\n' "$job" > "{receipt}"
say job "$job"
'''


def _queue_check(record, *, require_stopped=False):
    """List active jobs of this run, including SIGNET's children, with a checked scheduler query."""
    q = shlex.quote
    query = 'jobs="$(squeue -h -u "$(id -un)" -o "%i %j %Z" 2>/dev/null)"'
    active = (f'$(printf \'%s\\n\' "$jobs" | awk -v j={q(record.get("job_id") or "-")} '
            f'-v n={q("signet-" + record["step"] + "-" + record["run_id"])} '
            f'-v d={q(record["remote_dir"] + "/")} '
            "'$1 == j || $2 == n || index($3, d) == 1 {print $1}')")
    if require_stopped:
        return query + f' || exit 93\nactive_jobs="{active}"\n[ -z "$active_jobs" ] || exit 93\n'
    return query + ' && {\n  say queue_checked yes\n' + f'  say active_jobs "{active}"\n}}\n'


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

def output_revalidation(record):
    """Classify saved artifact-only failures without querying or changing them."""
    if not isinstance(record, dict):
        return {'eligible': False, 'active': False, 'reason': 'The original failed job record is unavailable.'}
    active = bool(record.get('output_revalidation_requested_at')) and record.get('state') == 'validating'
    result = {'eligible': False, 'active': active, 'reason': 'Only an artifact-only failed step can be checked again.'}
    if record.get('state') != 'failed' or record.get('cancel_requested_at') or record.get('failure_hints'):
        return result
    if (not isinstance(record.get('job_id'), str) or not re.fullmatch(r'[0-9]+', record['job_id'])
            or type(record.get('attempt', 1)) is not int or record.get('attempt', 1) < 1):
        return {**result, 'reason': 'The original job and attempt identity must be known.'}
    if record.get('slurm_state') not in (None, '', 'COMPLETED'):
        return {**result, 'reason': 'A recorded scheduler failure, cancellation or active state cannot be recovered by checking files.'}
    missing = record.get('missing_outputs')
    missing_only = (record.get('exit_code') == '0' and record.get('reason') == 'Required outputs are missing.'
                    and isinstance(missing, list) and bool(missing) and all(isinstance(path, str) for path in missing))
    marker_only = (record.get('slurm_state') == 'COMPLETED' and record.get('exit_code') is None
                   and record.get('reason') == 'The job did not finish its last line.')
    if missing_only or marker_only:
        return {'eligible': True, 'active': False, 'reason': 'Recheck this same job and attempt without submitting it again.'}
    return result


def _output_observation(record):
    saved = {key: value[:1000] if isinstance(value, str) else value for key in
             ('state', 'job_id', 'attempt', 'reason', 'exit_code', 'slurm_state', 'finished_at')
             if isinstance(value := record.get(key), (str, int)) and not isinstance(value, bool)}
    saved.setdefault('attempt', 1)
    for key, limit in (('missing_outputs', 16), ('failure_hints', 20)):
        values = record.get(key)
        if isinstance(values, list):
            saved[key] = [value[:512] for value in values[:limit] if isinstance(value, str)]
            if len(values) > limit:
                saved[key + '_total'] = len(values)
    return saved


def _output_check(record, response=None):
    if not record.get('output_revalidation_requested_at'):
        return
    checks = record.setdefault('output_checks', [])
    if checks:
        checks[-1].update(checked_at=_now(), after=_output_observation(response or record),
                          outcome='interrupted' if (response or {}).get('connection') else record['state'])
    if record['state'] in TERMINAL:
        record.pop('output_revalidation_requested_at', None)


def _output_guard(root, record, *, ownership_only=False):
    from agent.runtime.workspace_history import _json
    config = _environment()
    directory = record.get('remote_dir')
    try:
        owner, _ = _json(root / 'steps/remote.owner')
    except (OSError, ValueError) as error:
        raise StepError('conflict', 'The original remote output folder ownership is unavailable.') from error
    allowed = {config['workRoot'] + '/' + record['run_id'], config['workRoot'] + '/runs/' + record['run_id']}
    if (directory not in allowed or owner.get('remote_dir') != directory
            or not isinstance(owner.get('token'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', owner['token'])):
        raise StepError('conflict', 'Select the original remote environment and owned run folder before checking outputs.')
    q = shlex.quote
    guard = (f'D={q(directory)}\nJ={q(directory + "/steps/" + record["step"] + ".job")}\n'
            f'T={q(owner["token"])}\n'
            '[ "$(readlink -f -- "$D")" = "$D" ] && [ -f "$D/.owner" ] && [ ! -L "$D/.owner" ] '
            '&& [ "$(head -c 129 -- "$D/.owner" 2>/dev/null)" = "$T" ] || { say output_source_mismatch owner; exit 91; }\n')
    if ownership_only:
        return guard
    guard += (f'E={q(record["job_id"])}\n'
            '[ "$(readlink -f -- "$J")" = "$J" ] && [ -f "$J" ] '
            '&& [ "$(head -c 128 -- "$J" 2>/dev/null)" = "$E" ] || { say output_source_mismatch job; exit 92; }\n')
    paths = [directory + '/steps/' + record['step'] + '.' + suffix for suffix in ('done', 'out', 'err')]
    paths += [directory + '/work/' + path for path in _required(_step(record['step']), record)]
    guard += ('for p in ' + ' '.join(q(path) for path in paths) + '; do\n'
              '  [ ! -L "$p" ] || { say output_source_mismatch artifact; exit 91; }\n'
              '  if [ -e "$p" ]; then [ "$(readlink -f -- "$p")" = "$p" ] && [ -f "$p" ] '
              '|| { say output_source_mismatch artifact; exit 91; }; fi\ndone\n')
    return guard


@_one_at_a_time
def revalidate(run_id, name, *, expected_job_id, expected_attempt):
    """Recheck only this failed attempt's artifacts; never submit or cancel work."""
    from agent.runtime.workspace_history import _json, _attempt_record
    _step(name)
    if (not isinstance(expected_job_id, str) or not re.fullmatch(r'[0-9]+', expected_job_id)
            or type(expected_attempt) is not int or expected_attempt < 1):
        raise StepError('invalid_request', 'Provide the displayed job ID and positive integer attempt number.')
    root = _root(run_id)
    if _load(root, name).get('reused_from'):
        raise StepError('conflict', 'Reused results retain source evidence; revalidate in the source run.')
    try:
        record, _ = _json(root / 'steps' / (name + '.json'))
        record = _attempt_record(record, run_id, name)
    except (OSError, ValueError) as error:
        raise StepError('not_found', 'The original failed step record is unavailable.') from error
    if record.get('job_id') != expected_job_id or record.get('attempt', 1) != expected_attempt:
        raise StepError('conflict', 'The job or attempt changed. Refresh its status before checking outputs.')
    if not output_revalidation(record)['eligible']:
        raise StepError('conflict', output_revalidation(record)['reason'])
    guard = _output_guard(root, record)
    try:
        code, values, _ = _shell(_say() + guard + 'true\n')
    except OSError as error:
        raise StepError('remote_failed', 'Could not confirm the original remote job before checking its outputs.') from error
    if code or values.get('output_source_mismatch'):
        raise StepError('conflict', 'The remote run folder or job no longer matches this failed attempt.')
    before = _output_observation(record)
    record.setdefault('original_failure', before)
    checks = record.get('output_checks', [])
    checks = checks[-24:] if isinstance(checks, list) else []
    total = record.get('output_checks_total', 0)
    total = total if type(total) is int and total >= 0 else 0
    requested_at = _now()
    record.update(output_checks=[*checks, {'at': requested_at, 'before': before, 'outcome': 'validating'}],
                  output_checks_total=total + 1, output_revalidation_requested_at=requested_at, checked_at=0)
    record.pop('finished_at', None)
    _change(record, 'validating')
    _save(root, record)
    return status(run_id, name, refresh=True)

@_one_at_a_time
def submit(run_id, name, inputs, resources=None, options=None):
    """Submit one step of a run as a Slurm job and return its record (state "submitted" with job_id).

    options answers the step's SIGNET prompts (see Step.prompts); missing ones take their default.
    """
    step = _step(name)
    root = _root(run_id)
    from agent.runtime.workspace_rerun import guard_submission
    guard_submission(root, name)
    if signet._settings(root).get('cohort') != step.cohort:
        raise StepError('invalid_request', f'Step {name} needs a {step.cohort} run.')
    request = _resources(step, resources)
    answers = _options(step, options)
    previous = _load(root, name) if _record_path(root, name).exists() else None
    if previous is not None and previous.get('state') not in RETRYABLE:
        if previous.get('state') == 'completed':
            raise StepError('conflict', f'Step {name} already completed in this run; use a new run to compute it again.')
        raise StepError('conflict', f'Step {name} of this run is {previous.get("state")}; check its status first.')
    workspace_retry = None
    workspace_snapshot = root / 'workspace-genotype.json'
    if previous and name == 'genotype' and (workspace_snapshot.exists() or workspace_snapshot.is_symlink()):
        from agent.runtime.workspace_genotype import _retry_context
        _, workspace_retry, _, _, _ = _retry_context(run_id, previous.get('job_id') or 'none', previous.get('attempt', 1))
        if signet._settings(root).get('restrict.tcga.geno') != str(workspace_retry['settings']['restrict.tcga.geno']):
            raise StepError('conflict', 'A workspace retry must retain the original chromosome.')
        if workspace_retry.get('mode') != 'dataset' and inputs != workspace_retry['inputs']:
            raise StepError('conflict', 'A workspace retry must retain the original genotype input files.')
    attempt = previous.get('attempt', 1) + 1 if previous else 1
    active = _active_step(root)
    if active:
        raise StepError('conflict', f'Step {active} of this run is still active.')
    _prerequisites(root, step)
    _check_current(step, signet._settings(root))
    config = _environment()
    if workspace_retry is not None:
        from agent.runtime.workspace_genotype import _retry_environment
        _retry_environment(root, workspace_retry, previous, config)
    directory = _remote_dir(config, root, run_id)
    dataset_plan = None
    if name == 'genotype' and (previous is not None or not (root / 'rerun.json').exists()):
        from agent.runtime.workspace_inputs import staging_plan
        dataset_plan = staging_plan(root, directory, attempt=attempt)
        if dataset_plan and inputs != dataset_plan['inputs']:
            raise StepError('invalid_request', 'Review the input namespace for this genotype attempt before submitting.')
    checked = _inputs(step, inputs, (config['root'] + '/refdata', config['source'] + '/example', directory))
    if previous:
        _ensure_stopped(previous)  # before uploading config.ini or touching any old result
        archived = _attempt_path(root, name, attempt - 1)
        local_results = root / 'steps' / f'{name}.attempt{attempt - 1}.results'
        local_pairs = [(signet._no_links(root / 'steps' / f'{name}.{suffix}'),
                        signet._no_links(root / 'steps' / f'{name}.attempt{attempt - 1}.{suffix}'))
                       for suffix in _JOB_FILES]
        local_pairs.append((signet._no_links(root / step.download), signet._no_links(local_results)))
        if archived.exists() or any(destination.exists() for _, destination in local_pairs):
            raise StepError('conflict', 'The previous attempt archive already exists; it will not be overwritten.')
    submission_token = secrets.token_hex(16)
    descriptor = _create_submission_claim(root, name, attempt, submission_token)
    try:
        # Inputs, plus the keys this step reads from earlier results of the run (as local work/
        # paths; the upload rewrites them to the run's HPC3 folder).
        current = signet._settings(root)
        fixed = {key: value.replace('{image}', config['image']).replace('{partition}', config['partition'])
                 for key, value in step.fixed.items()}
        signet._update(root, {**{key: path for key, (path, _) in checked.items()},
                              **{key: str(root / 'work' / _resolve(rel, current)) for key, rel in step.links.items()},
                              **fixed})
        token = _owner(root, directory)
        record = {'step': name, 'run_id': run_id, 'flag': step.flag, 'remote_dir': directory,
                  'inputs': {key: path for key, (path, _) in checked.items()}, 'resources': request,
                  'submission_token': submission_token,
                  'partition': config['partition'], 'image': config['image'], 'submitted_at': _now()}
        if answers:
            record['options'] = answers   # kept for reproducibility: the answers SIGNET was given
        settings = signet._settings(root)
        record['settings'] = {key: settings[key] for key in step.settings}
        if any('{' in path for path in step.required):
            record['required_outputs'] = [_resolve(path, settings) for path in step.required]
        if name == 'visualize':
            for number in range(1, int(settings['ntop']) + 1):
                prefix = f'res/resv/signet_top{number}_freq{settings["freq"]}'
                record['required_outputs'].extend((prefix + '.html', prefix + '_name.txt',
                    f'res/resv/signet_circular_top{number}_freq{settings["freq"]}.pdf'))
        if dataset_plan:
            from agent.runtime.workspace_inputs import REQUIRED
            record['required_outputs'] = list(step.required) + list(REQUIRED)
        if previous:
            record['attempt'] = attempt
            # A refused submission has no job of its own; retain the last real ID across it.
            record['previous_job_id'] = previous.get('job_id') or previous.get('previous_job_id')
        archived = _attempt_path(root, name, attempt - 1) if previous else None
        moved_local = []
        saved_previous = False
        try:
            _upload(root, directory, token)
            from agent.runtime.workspace_rerun import stage_remote
            stage_remote(root, directory, token)
            if previous:   # keep the failed attempt's record before the new one replaces it
                with archived.open('x') as stream:
                    stream.write(json.dumps(previous, indent=2) + '\n')
                saved_previous = True
                for source, destination in local_pairs:
                    if source.exists():
                        source.rename(destination)
                        moved_local.append((source, destination))
            # Record intent before sbatch: a lost connection from here on may have started a job.
            _change(record, 'submitting')
            _save(root, record)
            files = _files(step, checked, signet._settings(root))
            if dataset_plan:
                files = [(item['role'], item['path'], str(Path(item['path']).parent)) for item in dataset_plan['source_files']]
            settings = signet._settings(root)
            code, values, _ = _shell(_submit_script(config, run_id, name, step, directory, files, request, answers,
                                                    archive=attempt - 1 if previous else None,
                                                    needs=[_resolve(path, settings) for path in step.needs],
                                                    settings=settings, dataset_plan=dataset_plan, submission_token=record['submission_token']))
            if code == 255:
                # OpenSSH can lose the connection after the scheduler accepted the job.
                raise OSError('OpenSSH did not confirm the submission.')
        except OSError as error:
            if record.get('state') != 'submitting':
                for source, destination in reversed(moved_local):
                    destination.rename(source)
                if saved_previous:
                    archived.unlink()
                raise StepError('remote_failed', f'Could not prepare the HPC3 submission; no job was submitted: {error}') from error
            _change(record, 'unknown', reason='Connection lost while submitting; check status before doing anything else.')
            return _save(root, record)
        if code == 0 and re.fullmatch(r'[0-9]+', values.get('job', '')):
            _change(record, 'submitted', job_id=values['job'], checked_at=0)
            return _save(root, record)
        if code == 0:
            _change(record, 'unknown', reason='Submission returned no valid job ID; check status. Do not resubmit.')
            return _save(root, record)
        if values.get('submission_dispatched') == 'yes':
            _change(record, 'unknown', checked_at=0,
                    reason='The submission client failed after contacting Slurm; acceptance is unconfirmed. Review recovery evidence before resubmitting.')
            _save(root, record)
            raise StepError('remote_failed', record['reason'])
        # Once remote files moved, consume this attempt even if sbatch refused it.
        # Reusing its number would archive the new script over the previous one.
        if values.get('attempt_started') == 'yes':
            _change(record, 'failed', finished_at=_now(),
                    reason='Submission failed before a job ID was returned: ' + values.get('sbatch_failed', 'remote preparation failed.'))
            _save(root, record)
        elif previous:
            _save(root, previous)
            archived.unlink(missing_ok=True)
            for source, destination in reversed(moved_local):
                destination.rename(source)
        else:
            _record_path(root, name).unlink(missing_ok=True)
        if 'invalid_input' in values:
            raise StepError('invalid_request', values['invalid_input'])
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
        _release_submission_claim(root, descriptor)


def _children_script(step):
    """Cancel jobs SIGNET submitted for this step (IDs from its submit logs), but only those whose
    working directory is inside this run's HPC3 folder ($D), so no other job can be touched."""
    q = shlex.quote
    return ''.join(
        f'for c in $(grep -Eo "[0-9]+$" "$D/work/"{q(log)} 2>/dev/null | sort -u); do\n'
        '  w="$(squeue -h -j "$c" -o %Z 2>/dev/null)" || { say child_cancel_check_failed "$c"; continue; }\n'
        '  case "$w" in "$D"/*) scancel "$c" && say child_cancelled "$c" || say child_cancel_failed "$c";; esac\n'
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
        if isinstance(count, str) and re.fullmatch(r'(?:[1-9]|[1-9][0-9]|100)', count):
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


def _status_script(record, step, *, read_only=False):
    q = shlex.quote
    directory, name = record['remote_dir'], record['step']
    job = record.get('job_id')
    outputs = ''.join(f'[ -s {q(directory + "/work/" + path)} ] && say output_{i} yes\n'
                      for i, path in enumerate(_required(step, record)))
    pattern = '|'.join(re.escape(p) for p in FAILURE_PATTERNS + step.failures)
    progress = _progress_script(record)
    # When the control job is gone, SIGNET's own jobs still queued for this run are orphans.
    orphans = (f'if [ -n "$j" ] && parent_state="$(squeue -h -j "$j" -o %T 2>/dev/null)" '
               f'&& [ -z "$parent_state" ]; then\n{_children_script(step)}fi\n'
               if step.children and not read_only else '')
    queue_check = _queue_check(record) if read_only or record.get('cancel_requested_at') or step.children else ''
    export_check = ('grep -Fxq SIGNET_STAGE6_EXPORTS_COMPLETED "$D/steps/visualize.out" 2>/dev/null '
                    '&& say exports_completed yes\n') if name == 'visualize' else ''
    return _say() + f'''D={q(directory)}
j={q(job or '')}
say job "$j"
if [ -n "$j" ]; then
  queue_state="$(squeue -h -j "$j" -o %T 2>/dev/null)"
  account_state="$(sacct -n -X -P -j "$j" -o State 2>/dev/null | head -n 1)"
  say squeue "$queue_state"
  say sacct "$account_state"
fi
[ -f "$D/steps/{name}.done" ] && say done "$(head -n 1 "$D/steps/{name}.done")"
{outputs}cat "$D/steps/{name}.out" "$D/steps/{name}.err" 2>/dev/null | grep -E -m 20 {q(pattern)} | while IFS= read -r l; do say line "$l"; done
{progress}{orphans}{queue_check}{export_check}true
'''


@_one_at_a_time
def status(run_id, name, refresh=False):
    """Current state of a submitted step; asks Slurm at most every 15 s unless refresh is true."""
    step = _step(name)
    root = _root(run_id)
    record = _load(root, name)
    # Only reopen unconfirmed artifacts, never an observed nonzero exit or log error.
    retry_marker = refresh and output_revalidation(record)['eligible']
    if retry_marker:
        return revalidate(run_id, name, expected_job_id=record['job_id'], expected_attempt=record.get('attempt', 1))
    if record['state'] in TERMINAL and not retry_marker:
        return record
    if not refresh and time.time() - record.get('checked_at', 0) < CACHE_SECONDS:
        return record
    if not record.get('job_id'):
        return {**record, 'reason': 'Submission is unconfirmed. Use manual reconciliation. Do not resubmit.'}
    checking_outputs = bool(record.get('output_revalidation_requested_at'))
    _environment()
    guarded = checking_outputs or name not in DOWNLOADED_STEPS
    guard = _output_guard(root, record) if guarded else ''
    try:
        code, values, hints = _shell(_say() + guard + _status_script(record, step, read_only=checking_outputs) + guard, timeout=60)
    except OSError:
        reply = {**record, 'connection': 'interrupted', 'reason': 'Could not reach HPC3; the job keeps running. Try again later.'}
        if checking_outputs:
            reply['reason'] = 'Could not reach HPC3 to check the saved outputs. The analysis was not resubmitted.'
            _output_check(record, reply)
            _save(root, record)
        return reply
    if code:
        reply = {**record, 'connection': 'interrupted', 'reason': 'The status check did not complete on HPC3.'}
        if checking_outputs:
            if values.get('output_source_mismatch'):
                reply['reason'] = 'The remote job or artifact path no longer matches the saved attempt; no outputs were accepted.'
            _output_check(record, reply)
            _save(root, record)
        return reply
    record['checked_at'] = time.time()
    queued, accounted = values.get('squeue', ''), values.get('sacct', '').split(' ')[0]
    slurm = queued or accounted
    record['slurm_state'] = slurm or None
    measured = {}
    for key, value in values.items():
        if key.startswith('progress_') and re.fullmatch(r'[0-9]+ [0-9]+', value):
            done_count, total = map(int, value.split())
            if 0 <= done_count <= total and total > 0:
                measured[key.removeprefix('progress_')] = value
    if measured:
        record.setdefault('progress', {}).update(measured)
    missing = [path for i, path in enumerate(_required(step, record)) if values.get(f'output_{i}') != 'yes']
    cancelling = record.get('cancel_requested_at')
    terminal = slurm == 'COMPLETED' or slurm.startswith('CANCELLED') or slurm in _SLURM_FAILED
    finishing = terminal or 'done' in values
    if checking_outputs and (values.get('queue_checked') != 'yes' or values.get('active_jobs')):
        record.pop('finished_at', None)
        _change(record, 'validating', reason='Waiting to confirm that the original job and its children have stopped before checking outputs.')
    elif ((cancelling and not terminal)
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
        if record['step'] == 'visualize':
            record['exports_completed'] = values.get('exports_completed') == 'yes'
        _finish(root, record, step, values.get('done', ''), missing, hints)
    elif not record.get('job_id'):
        # Empty lookups can mean scheduler failure or accounting delay, not an unsubmitted job.
        _change(record, 'unknown',
                reason='No Slurm job ID could be confirmed yet; check status again or inspect the run folder on HPC3. Do not resubmit.')
    elif time.time() - record.get('first_seen_missing', time.time()) > 300:
        _change(record, 'unknown', reason='Slurm has no record of this job; inspect the run folder on HPC3.')
    else:
        record.setdefault('first_seen_missing', time.time())
    _output_check(record)
    return _save(root, record)


def _restore_revalidated_outputs(root, data, step, record):
    """Reuse matching local files only after comparing this job's fetched archive."""
    pending = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as source, tarfile.open(fileobj=pending, mode='w:gz') as target:
        files = set()
        for item in source.getmembers():
            path = Path(item.name)
            if (path.is_absolute() or '..' in path.parts or not path.is_relative_to(Path(step.download))
                    or not (item.isdir() or item.isfile()) or str(path) in files):
                raise ValueError('The downloaded output archive does not match this stage.')
            destination = signet._no_links(root / path)
            if item.isfile():
                files.add(str(path))
                if destination.exists():
                    if not destination.is_file() or destination.stat().st_size != item.size:
                        raise ValueError('Existing local outputs differ from this job; they were preserved without overwriting.')
                    def digest(stream):
                        result = hashlib.sha256()
                        for block in iter(lambda: stream.read(1024 * 1024), b''):
                            result.update(block)
                        return result.digest()
                    with destination.open('rb') as local, source.extractfile(item) as remote:
                        if digest(local) != digest(remote):
                            raise ValueError('Existing local outputs differ from this job; they were preserved without overwriting.')
                    continue
                target.addfile(item, source.extractfile(item))
            else:
                target.addfile(item)
        required = {'work/' + path for path in _required(step, record)}
        if not required.issubset(files):
            raise ValueError('The downloaded archive is missing outputs required by this attempt.')
    vm.restore_outputs(root, pending.getvalue())
    if not all(signet._no_links(root / path).is_file() and (root / path).stat().st_size for path in required):
        raise ValueError('Required local outputs are missing after the checked download.')
    return sorted(files)


def _summary_script(record, step):
    """Login-node shell: row count and first-row field count of each output and counted input. Numbers only."""
    q = shlex.quote
    lines = [_say(), f'D={q(record["remote_dir"])}',
             # Non-empty lines, and the fields of the first one: comma-separated for .csv, and for a first
             # line with commas but no spaces or tabs (signet_Afreq is comma-separated without the suffix).
             'count() { awk -v sep="$2" \'BEGIN { if (sep != "") FS = sep } NF { n++; if (!c) '
             '{ if (sep == "" && $0 ~ /,/ && $0 !~ /[ \\t]/) c = split($0, f, ","); else c = NF } } '
             'END { printf "%d %d", n, c }\' "$1" 2>/dev/null; }']
    for index, path in enumerate(_required(step, record)):
        sep = ',' if path.endswith('.csv') else ''
        lines.append(f'if [ -f "$D/work/"{q(path)} ]; then say out_{index} "$(count "$D/work/"{q(path)} {q(sep)})"; fi')
    for key in _COUNTED_INPUTS.get(record['step'], ()):
        path = record.get('inputs', {}).get(key)
        if path:
            lines.append(f'if [ -f {q(path)} ]; then say in_{key.replace(".", "_")} "$(count {q(path)} \'\')"; fi')
    if record['step'] == 'genotype':
        source = (Path(__file__).with_name('jobs') / 'reference_summary.py').read_text()
        lines.append('P="$D/work/res/resg/workspace-reference-preparation.json"')
        lines.append('if [ -f "$P" ] && [ ! -L "$P" ] && [ "$(readlink -f -- "$P")" = "$P" ]; then')
        lines.append("say reference_preparation \"$(python3 - \"$P\" <<'SIGNET_PREPARATION_SUMMARY'\n"
                     + source + "\nSIGNET_PREPARATION_SUMMARY\n)\"\nfi")
    return '\n'.join(lines) + '\n'


def _output_summary(record, step, root=None):
    """Counts of the step's outputs and inputs, computed on HPC3; never values, IDs or rows."""
    guard = _output_guard(root, record) if root is not None else ''
    if root is not None and record.get('output_revalidation_requested_at'):
        guard += _queue_check(record, require_stopped=True)
    script = _say() + guard + _summary_script(record, step)
    if root is not None:
        script += guard
    code, values, _ = _shell(script, timeout=120)
    if code:
        raise OSError('the summary did not complete on HPC3')
    def counts(value):
        rows, columns = (int(part) for part in value.split())
        return {'rows': rows, 'columns': columns}
    summary = {'outputs': [], 'inputs': {}, 'version': SUMMARY_VERSION}
    for index, path in enumerate(_required(step, record)):
        entry = {'file': path.rsplit('/', 1)[-1]}
        value = values.get(f'out_{index}', '')
        entry.update(counts(value) if re.fullmatch(r'[0-9]+ [0-9]+', value) else {'available': False})
        summary['outputs'].append(entry)
    for key in _COUNTED_INPUTS.get(record['step'], ()):
        value = values.get(f'in_{key.replace(".", "_")}', '')
        if re.fullmatch(r'[0-9]+ [0-9]+', value):
            summary['inputs'][key] = {'file': record['inputs'][key].rsplit('/', 1)[-1], **counts(value)}
    if 'reference_preparation' in values:
        from agent.runtime.jobs.reference_summary import safe_preparation
        try:
            prepared = safe_preparation(json.loads(values['reference_preparation']))
        except (TypeError, ValueError):
            prepared = {}
        if prepared:
            summary['reference_preparation'] = prepared
    return summary


@_one_at_a_time
def ensure_summary(run_id, name):
    """The completed step's counts, computing them on HPC3 once for records made before summaries existed."""
    step = _step(name)
    root = _root(run_id)
    record = _load(root, name)
    if record.get('state') != 'completed' or record.get('summary', {}).get('version') == SUMMARY_VERSION:
        return record.get('summary')
    _environment()
    try:
        record['summary'] = _output_summary(record, step, root)
    except (OSError, ValueError, subprocess.TimeoutExpired, StepError):
        return None
    _save(root, record)
    return record['summary']


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
    if (record['step'] == 'visualize' and exit_code == '0' and missing and not hints
            and not record.get('output_revalidation_requested_at')):
        checked_at = record.get('checked_at', time.time())
        since = record.setdefault('missing_outputs_since', checked_at)
        if checked_at - since < VISUALIZE_OUTPUT_GRACE_SECONDS:
            record.pop('finished_at', None)
            _change(record, 'validating', exit_code='0', missing_outputs=missing, failure_hints=[],
                    reason='Waiting for visualization outputs to appear on HPC3.')
            return
    if record['step'] == 'visualize' and not record.get('exports_completed'):
        hints = [*hints, 'The official Stage 6 export completion marker is missing.']
    if exit_code != '0' or missing or hints:
        reason = (f'signet exited with {exit_code}.' if exit_code != '0' else
                  'Required outputs are missing.' if missing else 'The log reports an error.')
        _change(record, 'failed', finished_at=_now(), exit_code=exit_code, missing_outputs=missing,
                failure_hints=hints, reason=reason)
        return
    record.pop('finished_at', None)
    record.pop('missing_outputs_since', None)
    _change(record, 'validating', exit_code='0')
    try:
        record['summary'] = _output_summary(record, step, root)
    except (OSError, ValueError, subprocess.TimeoutExpired, StepError):
        if record['step'] not in DOWNLOADED_STEPS:
            record['reason'] = 'Could not verify the owned remote results and summary; check status again. No analysis was resubmitted.'
            return
    if record['step'] not in DOWNLOADED_STEPS:
        record['outputs'] = []
        record['remote_outputs'] = ['work/' + path for path in _required(step, record)]
        _change(record, 'completed', finished_at=_now(), exit_code='0', missing_outputs=[], failure_hints=[],
                reason='Outputs present and logs clean; person-level results stay on HPC3. This is not scientific validation.')
        return
    _change(record, 'validating', exit_code='0')
    try:
        q = shlex.quote
        checking_outputs = bool(record.get('output_revalidation_requested_at'))
        if checking_outputs:
            guard = _output_guard(root, record) + _queue_check(record, require_stopped=True)
            command = _say() + guard + f'cd {q(record["remote_dir"])} && tar czf - {q(step.download)} || exit $?\n' + guard
            result = ssh_transport.remote('bash -s', input=command.encode(), capture_output=True, timeout=300)
        else:
            result = ssh_transport.remote(f'cd {q(record["remote_dir"])} && tar czf - {q(step.download)}',
                                          capture_output=True, timeout=300)
        if result.returncode:
            raise OSError('tar failed')
        record['outputs'] = (_restore_revalidated_outputs(root, result.stdout, step, record) if checking_outputs
                             else vm.restore_outputs(root, result.stdout))
    except (OSError, ValueError, tarfile.TarError) as error:
        if record.get('output_revalidation_requested_at'):
            record['reason'] = f'The saved outputs could not be downloaded and verified ({error}); check status again. No analysis was resubmitted.'
            return
        local = [root / 'work' / path for path in _required(step, record)]
        if not all(path.is_file() and path.stat().st_size for path in local):
            record['reason'] = f'Results are ready on HPC3 but could not be downloaded yet ({error}); check status again.'
            return
        # An earlier check already downloaded them (restore_outputs never overwrites).
        folder = root / step.download
        record['outputs'] = sorted(str(p.relative_to(root)) for p in folder.rglob('*') if p.is_file())
    _change(record, 'completed', finished_at=_now(), missing_outputs=[], failure_hints=[],
            reason='Outputs present and logs clean. This is not scientific validation; review the results.')


@_one_at_a_time
def cancel(run_id, name, *, expected_job_id=None, expected_attempt=None):
    """Cancel the step's own Slurm job (checked by job name), and for signet -n the jobs SIGNET
    submitted inside this run's folder. Finished steps cannot be cancelled."""
    step = _step(name)
    root = _root(run_id)
    record = _load(root, name)
    if (not isinstance(record, dict) or record.get('run_id') != run_id or record.get('step') != name
            or type(record.get('attempt', 1)) is not int or record.get('attempt', 1) < 1):
        raise StepError('conflict', 'The saved step does not identify this run, stage, and attempt.')
    if expected_job_id is not None or expected_attempt is not None:
        if (not isinstance(expected_job_id, str) or not re.fullmatch(r'[0-9]+', expected_job_id)
                or type(expected_attempt) is not int or expected_attempt < 1):
            raise StepError('invalid_request', 'Provide the displayed job ID and positive integer attempt number together.')
        if record.get('job_id') != expected_job_id or record.get('attempt', 1) != expected_attempt:
            raise StepError('conflict', 'The job or attempt changed. Refresh its status before cancelling.')
    if record['state'] in TERMINAL:
        raise StepError('conflict', f'Step {name} already ended as {record["state"]}.')
    if not record.get('job_id'):
        raise StepError('conflict', 'No job ID is known yet; check status first.')
    _environment()
    expected = f'signet-{name}-{run_id}'
    script = _say() + (f'D={shlex.quote(record["remote_dir"])}\nj={shlex.quote(record["job_id"])}\n'
                       'parent_name="$(squeue -h -j "$j" -o %j 2>/dev/null)" || { say cancel_check_failed yes; exit 9; }\n'
                       f'if [ "$parent_name" = {shlex.quote(expected)} ]; then '
                       'scancel "$j" && say cancel requested || { say cancel_failed yes; exit 10; }; '
                       'else say cancel not_queued; fi\n'
                       + _children_script(step))
    def unconfirmed(reason):
        record.pop('finished_at', None)
        _change(record, 'cancelling', cancel_requested_at=record.get('cancel_requested_at') or _now(),
                checked_at=0, reason=reason)
        _save(root, record)
    try:
        code, values, _ = _shell(script, timeout=30)
    except OSError as error:
        reason = 'Connection interrupted while requesting cancellation; its effect is unknown. Check status before retrying.'
        unconfirmed(reason)
        raise StepError('remote_failed', reason) from error
    if values.get('cancel_check_failed') == 'yes':
        raise StepError('remote_failed', 'The scheduler could not confirm the job identity; no cancellation command was sent.')
    failed_child = values.get('child_cancel_failed') or values.get('child_cancel_check_failed')
    if code or 'cancel' not in values or failed_child:
        reason = ('Cancellation of an owned child job could not be confirmed; check status before retrying.' if failed_child
                  else 'Cancellation did not complete; its effect is unconfirmed. Check status before retrying.')
        unconfirmed(reason)
        raise StepError('remote_failed', reason)
    if values['cancel'] == 'requested' or step.children:
        # The control job can already be gone while its cancelled children are still draining.
        unconfirmed('Cancellation requested; waiting for HPC3 to confirm termination.')
    return status(run_id, name, refresh=True)   # it already left the queue; report how it ended


def read_log(run_id, name, stream='out', lines=50):
    """Last lines (at most 200) of the job's stdout ("out") or stderr ("err")."""
    from agent.runtime.workspace_logs import read_legacy
    return read_legacy(run_id, name, stream, lines)
