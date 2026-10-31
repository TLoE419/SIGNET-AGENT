#!/usr/bin/env python3
"""Observe one Slurm job from submission to a stable terminal state (Monitor Spec 01, 6.3).

submit_step.sh starts this in the background on the HPC3 login node right after sbatch.
Every poll appends one JSON line to <fixture>/snapshots.jsonl with the raw command output,
the parsed rows, the job state and the last lines of the job's stdout log.

Polling sequence:
  1. While squeue still lists the job, record squeue (and sstat while RUNNING).
  2. Once squeue no longer lists it, switch to sacct, the authoritative record.
  3. Stop when sacct reports the same terminal state on two consecutive polls,
     because sacct can lag behind the real end of the job.
  4. Write sacct_final.txt / sacct_final.json and observer_status.json, then run
     collect_outputs.sh to record the files the step produced.

Usage:
  observe.py --job-id 12345678 --fixture-dir fixtures/<run_id> [--interval 30]
             [--log-path PATH] [--max-hours 48] [--no-collect]

The interval can never be below 15 seconds (HPC3 login-node etiquette). Command failures
become error fields in the snapshot instead of crashing the observer.
"""
import argparse
from pathlib import Path
import sys
import time

# Sibling modules live next to this script; it is run directly, not installed as a package.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fixture_io as io  # noqa: E402
import slurm_parse as sp  # noqa: E402

COLLECT = Path(__file__).resolve().parent / 'collect_outputs.sh'


def poll(job_id, log_path):
    """Take one snapshot of the job.

    Returns (record, sacct_state). sacct_state is None while squeue still lists the job,
    and the sacct State string ('' if sacct does not know the job yet) afterwards.
    """
    record = io.capture('squeue', sp.squeue_command(job_id=job_id), sp.parse_squeue)
    state = None
    if record['returncode'] == 0 and record.get('error'):
        # Unparseable but successful output is kept raw; it says nothing about the job ending.
        record['state'] = None
    elif record['parsed']:
        record['state'] = record['parsed'][0]['state']
        if record['state'] == 'RUNNING':
            # sstat only works for running steps; a failure is recorded inside the snapshot.
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
    """Write the final accounting files and observer_status.json; optionally list outputs."""
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
    """Poll until a stable terminal state or the max_hours deadline; return the status dict.

    sleep and clock are injectable so tests can drive the loop without waiting.
    """
    io.check_interval(interval)
    fixture = Path(fixture)
    log_path = log_path or fixture / 'stdout.log'
    status = {'job_id': str(job_id), 'started_at': io.now_iso(), 'interval': interval}
    # A forgotten observer must not poll a login node forever.
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
    """Command-line entry point; validates the job ID and interval before polling."""
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--job-id', required=True, help='Numeric Slurm job ID')
    parser.add_argument('--fixture-dir', required=True, help='Existing fixture directory')
    parser.add_argument('--interval', type=int, default=30, help='Seconds between polls (>= 15)')
    parser.add_argument('--log-path', help='Log to tail (default: <fixture>/stdout.log)')
    parser.add_argument('--max-hours', type=float, default=48, help='Give up after this long')
    parser.add_argument('--no-collect', action='store_true', help='Skip collect_outputs.sh')
    args = parser.parse_args(argv)
    # The ID is passed to Slurm commands; accept digits only.
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
