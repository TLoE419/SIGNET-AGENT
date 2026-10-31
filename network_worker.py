"""VM-side Stage 5 supervisor; fixed entry point, owned scheduler jobs only."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time


def command(argv):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise RuntimeError('Scheduler query failed')
    return result.stdout


def owned_job(line, root):
    fields = dict(re.findall(r'(\w+)=(\S+)', line))
    work = fields.get('WorkDir', '')
    if work == str(root / 'work') or work.startswith(str(root / 'work') + '/'):
        return {key: fields.get(key) for key in ('JobId', 'JobState', 'ExitCode', 'WorkDir')}
    return None


def snapshot(root, jobs):
    candidates = set(command(['squeue', '-h', '-o', '%i']).split()) | set(jobs)
    for path in (root / 'work/tmp/tmpn').glob('stage*/submit*_log'):
        candidates.update(re.findall(r'Submitted batch job (\d+)', path.read_text(errors='replace')))
    for job in candidates:
        if not job.isdigit():
            raise RuntimeError('Unexpected scheduler job identifier')
        try:
            line = command(['scontrol', 'show', 'job', job, '-o'])
        except RuntimeError:
            if job in jobs and jobs[job]['JobState'] == 'COMPLETED':
                continue
            raise
        value = owned_job(line, root)
        if value:
            jobs[job] = value
    return [j for j, v in jobs.items() if v['JobState'] in
            ('PENDING', 'RUNNING', 'CONFIGURING', 'COMPLETING', 'SUSPENDED', 'RESIZING')]


def save(root, state):
    temporary = root / 'state.tmp'
    temporary.write_text(json.dumps(state) + '\n')
    temporary.replace(root / 'state.json')


def run(root, seconds=21600):
    jobs, child, lock = {}, None, None
    state = {'status': 'starting', 'executed': False, 'jobs': jobs, 'started_at': time.time()}
    try:
        # Serialize launchers for the entire analysis, including preprocessing between jobs.
        import fcntl
        lock = open(root.parent / '.signet-network.lock', 'a')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if command(['squeue', '-h', '-o', '%i']).strip():
            raise RuntimeError('Scheduler is busy; no analysis started')
        if (root / 'cancel').exists():
            state['status'] = 'cancelled'
            return
        settings = dict(line.split('=', 1) for line in (root / 'work/config.ini').read_text().splitlines()
                        if '=' in line and not line.lstrip().startswith('#'))
        image = next(value.strip() for key, value in settings.items() if key.strip() == 'sif')
        if not re.fullmatch(r'/[A-Za-z0-9_./-]+', image) or '..' in Path(image).parts:
            raise ValueError('Invalid VM image path.')
        env = {'PATH': str(root / 'work/bin') + ':' + os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'),
               'HOME': str(Path.home()), 'LANG': 'C', 'SINGULARITY_BIND': str(root) + ',' + str(Path(image).parent),
               'OPENBLAS_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1'}
        with open(root / 'stdout.log', 'xb') as out:
            with open(root / 'stderr.log', 'xb') as err:
                state.update(status='running', executed=True)
                save(root, state)
                child = subprocess.Popen(['bash', './signet', '-n'], cwd=root / 'work',
                                         env=env, stdout=out, stderr=err, start_new_session=True)
                while True:
                    snapshot(root, jobs)
                    state['updated_at'] = time.time()
                    save(root, state)
                    if (root / 'cancel').exists() or time.time() - state['started_at'] > seconds:
                        state['status'] = 'cancelled' if (root / 'cancel').exists() else 'timed_out'
                        break
                    if child.poll() is not None:
                        state.update(status='process_completed' if child.returncode == 0 else 'failed',
                                     returncode=child.returncode)
                        break
                    time.sleep(5)
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
        state.update(status='failed' if child else 'blocked', reason=str(exc))
    finally:
        try:
            if child and child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=3)
            active = snapshot(root, jobs)
            for job in active:
                # Recheck ownership immediately before cancellation; IDs can be reused.
                line = command(['scontrol', 'show', 'job', job, '-o'])
                if owned_job(line, root):
                    command(['scancel', job])
            for _ in range(10):
                if not snapshot(root, jobs):
                    break
                time.sleep(1)
            else:
                raise RuntimeError('Owned scheduler jobs remain active')
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
            state.update(status='unknown', reason=str(exc))
        if lock is not None:
            lock.close()
        state['ended_at'] = time.time()
        save(root, state)


def valid_runtime_directory(folder):
    valid = bool(re.fullmatch(r'/tmp/signet-agent-network/[A-Za-z0-9][A-Za-z0-9_-]{0,63}', str(folder)))
    runtime_file = folder / 'runtime.json'
    if runtime_file.is_file() and not runtime_file.is_symlink():
        runtime = json.loads(runtime_file.read_text())
        work_root = runtime.get('workRoot', '')
        valid = (isinstance(work_root, str) and bool(re.fullmatch(r'/[A-Za-z0-9_./-]+', work_root))
                 and '..' not in Path(work_root).parts and folder.parent == Path(work_root) / 'network'
                 and bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', folder.name)))
    return valid and not folder.is_symlink()


if __name__ == '__main__':
    folder = Path(sys.argv[1])
    if not valid_runtime_directory(folder):
        raise SystemExit('Invalid runtime directory')
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: (folder / 'cancel').touch())
    run(folder)
