"""Parsers for pipe-delimited Slurm output; stdlib only so HPC3 and CI share them."""

SQUEUE_FIELDS = ('job_id', 'name', 'state', 'reason', 'elapsed', 'time_limit',
                 'cpus', 'mem', 'nodes', 'partition', 'account')
SQUEUE_FORMAT = '%i|%j|%T|%r|%M|%l|%C|%m|%N|%P|%a'

SACCT_COLUMNS = ('JobID', 'JobName', 'Partition', 'Account', 'State', 'ExitCode', 'Submit',
                 'Start', 'End', 'Elapsed', 'Timelimit', 'ReqCPUS', 'AllocCPUS', 'ReqMem',
                 'MaxRSS', 'NodeList')
SSTAT_COLUMNS = ('JobID', 'MaxRSS', 'AveCPU')

ACTIVE_STATES = {'PENDING', 'RUNNING', 'CONFIGURING', 'COMPLETING', 'SUSPENDED',
                 'RESIZING', 'REQUEUED', 'STAGE_OUT', 'SIGNALING'}
TERMINAL_STATES = {'COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'OUT_OF_MEMORY',
                   'NODE_FAIL', 'PREEMPTED', 'BOOT_FAIL', 'DEADLINE', 'REVOKED'}


def squeue_command(job_id=None, user=None):
    argv = ['squeue', '-h', '-o', SQUEUE_FORMAT]
    if job_id:
        argv[1:1] = ['-j', str(job_id)]
    if user:
        argv[1:1] = ['-u', user]
    return argv


def sacct_command(job_id=None, user=None, start=None):
    argv = ['sacct', '--parsable2', '-n', '-o', ','.join(SACCT_COLUMNS)]
    if job_id:
        argv[1:1] = ['-j', str(job_id)]
    if user:
        argv[1:1] = ['-u', user]
    if start:
        argv[1:1] = ['-S', start]
    return argv


def sstat_command(job_id):
    return ['sstat', '-j', '%s.batch' % job_id, '--parsable2', '-n', '-o', ','.join(SSTAT_COLUMNS)]


def parse_rows(text, fields):
    """Split '|'-delimited lines into dicts; a wrong field count is an error, never a guess."""
    rows = []
    for line in text.splitlines():
        if not line.strip():
            continue
        cells = line.split('|')
        if len(cells) != len(fields):
            raise ValueError('Expected %d fields, got %d: %r' % (len(fields), len(cells), line))
        rows.append(dict(zip(fields, cells)))
    return rows


def parse_squeue(text):
    return parse_rows(text, SQUEUE_FIELDS)


def parse_sacct(text):
    return parse_rows(text, SACCT_COLUMNS)


def parse_sstat(text):
    return parse_rows(text, SSTAT_COLUMNS)


def base_state(state):
    """'CANCELLED by 1234' and 'RUNNING+' both reduce to the bare state name."""
    return state.split()[0].rstrip('+') if state.strip() else ''


def is_terminal(state):
    return base_state(state) in TERMINAL_STATES


def primary_row(rows, job_id):
    """The allocation row (JobID == id), not its .batch / .extern / .N steps."""
    for row in rows:
        if row['JobID'] == str(job_id):
            return row
    return None
