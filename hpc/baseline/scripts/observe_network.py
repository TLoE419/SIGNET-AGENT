#!/usr/bin/env python3
"""Observe `signet -n` and the child jobs it submits (Monitor Spec 01, 6.5 and experiment N1).

`signet -n` runs on the login node (inside tmux) and submits its own Slurm jobs with
`sbatch -W`, so there is no single job ID to follow. Instead, every poll records:
  - squeue -u $USER and sacct -u $USER -S <start>, raw and parsed;
  - for each stage, the line count of job<k>_command, the sub*.sh scripts present, and the
    job IDs printed in submit<k>_log, all under $SIGNET_DIR/tmp/tmpn/stage<k>/;
  - the log tail of the parent's output.

Every job submitted after --start is treated as a candidate child. Each child is tagged
with stage 1 or 2 from the submit logs, because both stages reuse the names sub<i>.sh.

The observer stops after the parent has ended (process gone, or --parent-job-id terminal)
and no child is active for two consecutive polls, or at the --max-hours deadline.

Outputs in the fixture: snapshots.jsonl, children.json, sacct_final.txt, sacct_final.json,
observer_status.json.

Usage (normally started by start_network.sh):
  observe_network.py --fixture-dir DIR --signet-dir DIR --start YYYY-MM-DDTHH:MM:SS
                     (--parent-pid PID | --parent-job-id ID) [--interval 30]
                     [--log-path PATH] [--max-hours 48]
"""
import argparse
import datetime
import getpass
import os
from pathlib import Path
import re
import sys
import time

# Sibling modules live next to this script; it is run directly, not installed as a package.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fixture_io as io  # noqa: E402
import slurm_parse as sp  # noqa: E402

# Columns copied from the allocation row of each child into children.json.
CHILD_FIELDS = ('JobID', 'JobName', 'Partition', 'Account', 'State', 'ExitCode',
                'Submit', 'Start', 'End', 'Elapsed', 'MaxRSS')


def stage_files(signet_dir):
    """Describe SIGNET's -n bookkeeping files for stages 1 and 2.

    SIGNET writes -n work under tmp/tmpn/stage<k>, not under the SIGNET root itself.
    """
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
    """True if the sacct Submit time is at or after start; unknown times are excluded."""
    try:
        return datetime.datetime.strptime(row['Submit'], '%Y-%m-%dT%H:%M:%S') >= start
    except ValueError:
        return False


def children(rows, start, stages, parent_job_id=None):
    """Build children.json entries from parsed sacct rows.

    Only allocation rows (no '.batch' / '.extern' suffix) submitted after start count as
    children; the parent job itself (N2) is excluded. Peak memory comes from the steps.
    """
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
    """True while the process exists (signal 0 only checks; it sends nothing)."""
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # The process exists but belongs to someone else.
        return True


def poll(user, start, signet_dir, parent_job_id):
    """Take one snapshot; returns (record, children, sacct capture)."""
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
    """Poll until the parent and all children have finished; return the status dict.

    sleep, clock and is_alive are injectable so tests can drive the loop without waiting.
    """
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
            # N2: the parent runs inside its own Slurm job.
            row = sp.primary_row(account['parsed'], parent_job_id)
            parent_done = bool(row) and sp.is_terminal(row['State'])
        else:
            # N1: the parent is a process on this login node.
            parent_done = not is_alive(parent_pid)
        record['parent_done'] = parent_done
        record.update(io.log_state(log_path))
        io.append_jsonl(fixture / 'snapshots.jsonl', record)
        # Rewritten every poll so a partial list survives if the observer is killed.
        io.write_json(fixture / 'children.json', found)
        # Two quiet polls in a row: sacct may still be catching up on the last child.
        observed = all(record[name]['returncode'] == 0 and not record[name].get('error')
                       for name in ('squeue', 'sacct'))
        # A failed query says nothing about whether child jobs are still running.
        quiet = quiet + 1 if observed and parent_done and not record['active_children'] else 0
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
    """Command-line entry point; argument errors exit with a usage message."""
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--fixture-dir', required=True, help='Existing fixture directory')
    parser.add_argument('--signet-dir', required=True, help='SIGNET install directory')
    parser.add_argument('--start', required=True, help='Local time YYYY-MM-DDTHH:MM:SS when -n started')
    parser.add_argument('--parent-pid', type=int, help='PID of the process running signet -n (N1)')
    parser.add_argument('--parent-job-id', help='Slurm job running signet -n (N2)')
    parser.add_argument('--interval', type=int, default=30, help='Seconds between polls (>= 15)')
    parser.add_argument('--log-path', help="Parent's output log to tail")
    parser.add_argument('--max-hours', type=float, default=48, help='Give up after this long')
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
