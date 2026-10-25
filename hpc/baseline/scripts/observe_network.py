#!/usr/bin/env python3
"""Observe `signet -n` and every job the user submits after it starts; write children.json."""
import argparse
import datetime
import getpass
import os
from pathlib import Path
import re
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fixture_io as io  # noqa: E402
import slurm_parse as sp  # noqa: E402

CHILD_FIELDS = ('JobID', 'JobName', 'Partition', 'Account', 'State', 'ExitCode',
                'Submit', 'Start', 'End', 'Elapsed', 'MaxRSS')


def stage_files(signet_dir):
    """SIGNET writes -n work under tmp/tmpn/stage<k>, not under the SIGNET root itself."""
    info = {}
    for stage in (1, 2):
        folder = Path(signet_dir) / 'tmp/tmpn' / ('stage%d' % stage)
        commands = folder / ('job%d_command' % stage)
        log = folder / ('submit%d_log' % stage)
        info[str(stage)] = {
            'folder_exists': folder.is_dir(),
            'command_lines': len(commands.read_text().splitlines()) if commands.is_file() else None,
            'sub_scripts': sorted(p.name for p in folder.glob('sub*.sh')) if folder.is_dir() else [],
            # `sbatch -W` still prints the id first; this is the only reliable stage tag,
            # because both stages reuse the same sub<i>.sh names.
            'submitted_ids': sorted(set(re.findall(r'Submitted batch job (\d+)',
                                                   log.read_text(errors='replace'))))
            if log.is_file() else [],
        }
    return info


def submitted_after(row, start):
    try:
        return datetime.datetime.strptime(row['Submit'], '%Y-%m-%dT%H:%M:%S') >= start
    except ValueError:
        return False


def children(rows, start, stages, parent_job_id=None):
    stage_of = {job: int(stage) for stage, item in stages.items() for job in item['submitted_ids']}
    result = []
    for row in rows:
        if '.' in row['JobID'] or row['JobID'] == parent_job_id or not submitted_after(row, start):
            continue
        steps = [r for r in rows if r['JobID'].startswith(row['JobID'] + '.')]
        peak = [r['MaxRSS'] for r in steps if r['MaxRSS']]
        child = {key: row[key] for key in CHILD_FIELDS}
        child.update(stage=stage_of.get(row['JobID']), step_max_rss=peak)
        result.append(child)
    return result


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def poll(user, start, signet_dir, parent_job_id):
    started = start.strftime('%Y-%m-%dT%H:%M:%S')
    queue = io.capture('squeue', sp.squeue_command(user=user), sp.parse_squeue)
    account = io.capture('sacct', sp.sacct_command(user=user, start=started), sp.parse_sacct)
    stages = stage_files(signet_dir)
    found = children(account['parsed'], start, stages, parent_job_id)
    record = {'ts': io.now_iso(), 'source': 'squeue+sacct', 'squeue': queue, 'sacct': account,
              'stages': stages, 'children': len(found),
              'active_children': sorted(c['JobID'] for c in found if not sp.is_terminal(c['State']))}
    return record, found, account


def observe(fixture, signet_dir, start, parent_pid=None, parent_job_id=None, user=None,
            interval=30, log_path=None, max_hours=48, sleep=time.sleep, clock=time.monotonic,
            is_alive=alive):
    io.check_interval(interval)
    if not parent_pid and not parent_job_id:
        raise ValueError('Give --parent-pid or --parent-job-id so the observer knows when -n ends.')
    fixture, user = Path(fixture), user or getpass.getuser()
    deadline, quiet = clock() + max_hours * 3600, 0
    status = {'started_at': io.now_iso(), 'network_start': start.isoformat(), 'interval': interval,
              'parent_pid': parent_pid, 'parent_job_id': parent_job_id}
    while True:
        record, found, account = poll(user, start, signet_dir, parent_job_id)
        if parent_job_id:
            row = sp.primary_row(account['parsed'], parent_job_id)
            parent_done = bool(row) and sp.is_terminal(row['State'])
        else:
            parent_done = not is_alive(parent_pid)
        record['parent_done'] = parent_done
        record.update(io.log_state(log_path))
        io.append_jsonl(fixture / 'snapshots.jsonl', record)
        io.write_json(fixture / 'children.json', found)
        # Two quiet polls in a row: sacct may still be catching up on the last child.
        quiet = quiet + 1 if parent_done and not record['active_children'] else 0
        timed_out = clock() >= deadline
        if quiet >= 2 or timed_out:
            (fixture / 'sacct_final.txt').write_text(account['raw'])
            io.write_json(fixture / 'sacct_final.json', account['parsed'])
            status.update(status='observer_deadline' if timed_out and quiet < 2 else 'terminal',
                          children=len(found), finished_at=io.now_iso())
            io.write_json(fixture / 'observer_status.json', status)
            return status
        sleep(interval)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture-dir', required=True)
    parser.add_argument('--signet-dir', required=True)
    parser.add_argument('--start', required=True, help='Local time YYYY-MM-DDTHH:MM:SS when -n started')
    parser.add_argument('--parent-pid', type=int)
    parser.add_argument('--parent-job-id')
    parser.add_argument('--interval', type=int, default=30)
    parser.add_argument('--log-path')
    parser.add_argument('--max-hours', type=float, default=48)
    args = parser.parse_args(argv)
    try:
        start = datetime.datetime.strptime(args.start, '%Y-%m-%dT%H:%M:%S')
        status = observe(args.fixture_dir, args.signet_dir, start, args.parent_pid,
                         args.parent_job_id, interval=args.interval, log_path=args.log_path,
                         max_hours=args.max_hours)
    except ValueError as error:
        parser.error(str(error))
    print('%s children=%s' % (status['status'], status['children']))


if __name__ == '__main__':
    main()
