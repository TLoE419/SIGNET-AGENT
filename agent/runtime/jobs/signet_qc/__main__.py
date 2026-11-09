import argparse
from pathlib import Path

from . import COHORTS, STEPS, publish, qc_path, read_summary


def main(argv=None):
    parser = argparse.ArgumentParser(description='Publish SIGNET QC artifacts from a compute job or an existing run.')
    commands = parser.add_subparsers(dest='command', required=True)
    for step in STEPS:
        command = commands.add_parser(step)
        command.add_argument('--run-dir', type=Path, required=True)
        command.add_argument('--cohort', choices=COHORTS, required=True)
        command.add_argument('--job-id')
        command.add_argument('--exit-code', type=int)
    pairing = commands.add_parser('check-pairing')
    pairing.add_argument('--run-dir', type=Path, required=True)
    args = parser.parse_args(argv)

    try:
        if args.command in STEPS:
            publish(args.run_dir, args.command, args.cohort,
                    job_id=args.job_id, exit_code=args.exit_code)
        else:
            cohorts = []
            for step in STEPS:
                with qc_path(args.run_dir, step).open('rb') as stream:
                    cohorts.append(read_summary(stream, step)['cohort'])
            if cohorts[0] != cohorts[1]:
                raise ValueError('Genotype and expression QC belong to different cohorts.')
            publish(args.run_dir, 'pairing', cohorts[0])
    except (OSError, ValueError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
