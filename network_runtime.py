"""Controlled asynchronous Stage 5 transport over the existing Stage 4 VM."""
import json
import math
import os
from pathlib import Path
import re
import subprocess
import time

import signet_runtime as vm

INPUT_KEYS = ('net.gexp.data', 'net.geno.data', 'sig.pair', 'net.genename', 'net.genepos')
TERMINAL = {'process_completed', 'failed', 'blocked', 'cancelled', 'timed_out'}


def rows(path, numeric=False):
    data = [line.replace(',', ' ').split() for line in Path(path).read_text().splitlines() if line.strip()]
    if not data or any(len(row) != len(data[0]) for row in data):
        raise ValueError('Empty or ragged matrix: ' + str(path))
    if numeric:
        data = [[float(cell) for cell in row] for row in data]
        if any(not math.isfinite(v) for row in data for v in row):
            raise ValueError('Non-finite matrix cell: ' + str(path))
    return data


def validate_inputs(settings):
    y, x, pairs = [rows(settings[key], True) for key in INPUT_KEYS[:3]]
    names, positions = [rows(settings[key]) for key in INPUT_KEYS[3:]]
    n, p, q = len(y), len(y[0]), len(x[0])
    if len(x) != n or len(names) != p or len(positions) != p:
        raise ValueError('Sample counts or gene metadata dimensions do not align.')
    if any(len(row) != 1 for row in names) or len({r[0] for r in names}) != p:
        raise ValueError('Gene names must be unique, one per expression column.')
    for name, pos in zip(names, positions):
        if (len(pos) != 4 or name[0] != pos[0] or not pos[2].isdigit()
                or not pos[3].isdigit() or int(pos[2]) > int(pos[3])):
            raise ValueError('Gene names, position order or coordinates do not align.')
    for pair in pairs:
        if (len(pair) != 3 or not pair[0].is_integer() or not pair[1].is_integer()
                or not 1 <= pair[0] <= p or not 1 <= pair[1] <= q or not 0 <= pair[2] <= 1):
            raise ValueError('Pair indices must match the expression and merged genotype columns.')
    return {'samples': n, 'genes': p, 'markers_or_regions': q, 'pairs': len(pairs),
            'limitation': 'Dimension and index checks do not establish biological sample identity.'}


def preflight():
    command = (f'scontrol ping | grep -q UP && sinfo -h -p {vm.partition()} -o "%t %c %m" && '
               'command -v python3 >/dev/null && command -v setsid >/dev/null && '
               f'test -s {vm.image_path()} && {vm.container_command()} exec --cleanenv --no-home {vm.image_path()} '
               'Rscript -e \'stopifnot(all(vapply(c("MASS","data.table","dataPreparation",'
               '"parcor","matrixcalc","chron"),requireNamespace,logical(1),quietly=TRUE)));'
               'stopifnot(nzchar(Sys.which("ParaFly")))\'')
    try:
        result = vm.remote(command, capture_output=True, timeout=60)
        return result.returncode == 0 and any(
            len(parts := line.split()) == 3 and parts[0] == 'idle' and
            parts[1].isdigit() and int(parts[1]) >= 4 and parts[2].isdigit() and int(parts[2]) >= 4096
            for line in result.stdout.decode().splitlines())
    except (OSError, subprocess.TimeoutExpired):
        return False


def save(root, value):
    temporary = root / 'network.state.tmp'
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(root / 'network.json')
    return value


def submit(root, settings):
    validation = validate_inputs(settings)
    if not preflight():
        return {'status': 'unavailable', 'executed': False,
                'reason': 'Existing VM / local SLURM queue / official image dependencies not ready.'}
    remote_root = vm.remote_work_root(network=True) + '/' + root.name
    record = {'operation': 'network', 'runtime': 'existing-docker-vm',
              'remote_directory': remote_root, 'container_image': vm.image_path(),
              'status': 'starting', 'executed': 'unknown', 'input_validation': validation,
              'parameters': {key: settings[key] for key in ('nboots', 'ncis', 'cor')},
              'resources': {'queue': vm.partition(), 'cores': 4, 'memory_gb': 4,
                            'job_walltime': '01:00:00', 'controller_timeout_hours': 6},
              'deployment_changes': ['4G scheduler memory request', 'bash submission shell'],
              'reason': 'Use get_network_status; never resubmit this run after an interrupted connection.'}
    # Record intent before any side effect that might start a detached controller.
    save(root, record)
    try:
        result = vm.remote('umask 077; mkdir -p ' + vm.remote_work_root(network=True) + ' && mkdir ' + remote_root +
                           ' && tar xzf - -C ' + remote_root,
                           input=vm.bundle(root, settings, remote_root, INPUT_KEYS, network=True),
                           capture_output=True, timeout=60)
        if result.returncode:
            record.update(status='blocked', executed=False, reason='Fresh remote upload failed; no launch requested.')
            return save(root, record)
        result = vm.remote(f'cd {remote_root} && {{ nohup setsid python3 network_worker.py {remote_root} '
                           '> supervisor.log 2>&1 < /dev/null & }', capture_output=True, timeout=45)
        if result.returncode:
            record.update(status='unknown', reason='Launch acknowledgement failed; query this run before any further action.')
        else:
            record.update(status='submitted', executed='unknown',
                          reason='Controller submitted; query status for actual job submission and completion.')
    except (OSError, subprocess.TimeoutExpired):
        record.update(status='unknown')
    return save(root, record)


def verify(root, state):
    """Verify output, scheduler commands and bootstrap averages with the bundled checker."""
    log = root / 'work/logs'
    log.mkdir(exist_ok=True)
    jobs = state.get('jobs', {})
    accounting = [{'JobIDRaw': job, 'State': v['JobState'], 'ExitCode': v['ExitCode']}
                  for job, v in jobs.items()]
    (log / 'scheduler-jobs.json').write_text(json.dumps(accounting))
    (log / 'job_ids.txt').write_text('\n'.join(jobs) + '\n')
    verifier = Path(__file__).resolve().parent / 'scripts/advanced/verify_network.cjs'
    code = 'const R=require(process.argv[1]);process.stdout.write(JSON.stringify(R.verify(process.argv[2],Number(process.argv[3]))));'
    result = subprocess.run(['node', '-e', code, str(verifier), str(root / 'work'),
                             str(json.loads((root / 'network.json').read_text())['parameters']['nboots'])],
                            capture_output=True, text=True, timeout=60,
                            env={'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
                                 'HOME': str(Path.home()), 'LANG': 'C'})
    if result.returncode:
        raise ValueError('Output verification failed; inspect result files and scheduler records.')
    return json.loads(result.stdout)


def status(root, cancel=False):
    record = json.loads((root / 'network.json').read_text())
    remote_root = vm.remote_work_root(network=True) + '/' + root.name
    if record.get('remote_directory') != remote_root:
        raise ValueError('Recorded runtime directory does not match this run.')
    if record.get('collected'):
        return record
    try:
        if cancel:
            result = vm.remote(f'test -d {remote_root} && touch {remote_root}/cancel', capture_output=True, timeout=15)
            if result.returncode:
                raise OSError('Cancellation request could not be delivered.')
        result = vm.remote(f'cat {remote_root}/state.json', capture_output=True, timeout=15)
        if result.returncode:
            return {**record, 'connection_status': 'state_not_available', 'cancellation_requested': cancel,
                    'reason': 'Controller state not available yet; do not resubmit.'}
        state = json.loads(result.stdout)
        record.update({key: state[key] for key in ('status', 'executed', 'jobs', 'started_at',
                       'updated_at', 'ended_at', 'returncode', 'reason') if key in state})
        record['cancellation_requested'] = cancel or record.get('cancellation_requested', False)
        if (state['status'] in ('starting', 'running') and
                time.time() - state.get('updated_at', state.get('started_at', time.time())) > 120):
            record.update(status='unknown', reason='Controller heartbeat is stale; do not resubmit. Check VM and query again.')
        if state['status'] in TERMINAL:
            result = vm.remote(f'cd {remote_root} && mkdir -p work/res work/tmp work/data && '
                               'cp stdout.log work/data/network.stdout 2>/dev/null; '
                               f'cd {remote_root} && cp stderr.log work/data/network.stderr 2>/dev/null; '
                               f'cd {remote_root} && tar czf - work/res work/tmp work/data',
                               capture_output=True, timeout=120)
            if result.returncode:
                raise OSError('Output retrieval failed.')
            record['output_files'] = vm.restore_outputs(root, result.stdout)
            record['collected'] = True
            if state['status'] == 'process_completed':
                try:
                    record['verification'] = verify(root, state)
                    record['status'] = 'verified_completed'
                    record['reason'] = 'Scheduler jobs and bootstrap outputs verified; this is not biological validation.'
                except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
                    record.update(status='verification_failed', reason=str(exc))
        return save(root, record)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return {**record, 'connection_status': 'interrupted', 'cancellation_requested': cancel,
                'reason': 'Could not confirm remote state; do not resubmit. Existing records are retained.'}
