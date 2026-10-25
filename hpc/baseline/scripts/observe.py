#!/usr/bin/env python3
"""Poll one Slurm job until sacct reports a stable terminal state; write snapshots.jsonl."""
import argparse
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fixture_io as io  # noqa: E402
import slurm_parse as sp  # noqa: E402

COLLECT = Path(__file__).resolve().parent / 'collect_outputs.sh'


def poll(job_id, log_path):
    """Return (record, sacct_state). sacct_state is None while squeue still lists the job."""
    record = io.capture('squeue', sp.squeue_command(job_id=job_id), sp.parse_squeue)
    state = None
    if record['returncode'] == 0 and record.get('error'):
        # Unparseable but successful output is kept raw; it says nothing about the job ending.
        record['state'] = None
    elif record['parsed']:
        record['state'] = record['parsed'][0]['state']
        if record['state'] == 'RUNNING':
            record['sstat'] = io.capture('sstat', sp.sstat_command(job_id), sp.parse_sstat)
    else:
        # squeue forgets finished jobs (or errors on unknown ids); sacct is authoritative from here.
        record = io.capture('sacct', sp.sacct_command(job_id=job_id), sp.parse_sacct)
        row = sp.primary_row(record['parsed'], job_id)
        state = row['State'] if row else ''
        record['state'] = state
    record['ts'] = io.now_iso()
    record.update(io.log_state(log_path))
    return record, state


def finish(job_id, fixture, status, collect):
    final = io.capture('sacct', sp.sacct_command(job_id=job_id), sp.parse_sacct)
    (fixture / 'sacct_final.txt').write_text(final['raw'])
    io.write_json(fixture / 'sacct_final.json', final['parsed'])
    status['sacct_final_error'] = final.get('error')
    if collect:
        code, out, err = io.run_command(['bash', str(COLLECT), str(fixture)], timeout=600)
        status['collect_outputs'] = {'returncode': code, 'stderr': err.strip()}
    status['finished_at'] = io.now_iso()
    io.write_json(fixture / 'observer_status.json', status)
    return status


def observe(job_id, fixture, interval=30, log_path=None, max_hours=48, collect=True,
            sleep=time.sleep, clock=time.monotonic):
    io.check_interval(interval)
    fixture = Path(fixture)
    log_path = log_path or fixture / 'stdout.log'
    status = {'job_id': str(job_id), 'started_at': io.now_iso(), 'interval': interval}
    deadline = clock() + max_hours * 3600
    previous = None
    while True:
        record, state = poll(job_id, log_path)
        io.append_jsonl(fixture / 'snapshots.jsonl', record)
        # sacct can lag behind the real end; require the same terminal state twice in a row.
        if state and sp.is_terminal(state) and state == previous:
            status.update(status='terminal', final_state=state)
            return finish(job_id, fixture, status, collect)
        previous = state
        if clock() >= deadline:
            status.update(status='observer_deadline', final_state=state or record.get('state'))
            return finish(job_id, fixture, status, collect)
        sleep(interval)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--fixture-dir', required=True)
    parser.add_argument('--interval', type=int, default=30)
    parser.add_argument('--log-path')
    parser.add_argument('--max-hours', type=float, default=48)
    parser.add_argument('--no-collect', action='store_true')
    args = parser.parse_args(argv)
    if not args.job_id.isdigit():
        parser.error('--job-id must be numeric')
    try:
        io.check_interval(args.interval)
    except ValueError as error:
        parser.error(str(error))
    status = observe(args.job_id, args.fixture_dir, args.interval, args.log_path,
                     args.max_hours, not args.no_collect)
    print('%s %s' % (status['status'], status.get('final_state')))


if __name__ == '__main__':
    main()
