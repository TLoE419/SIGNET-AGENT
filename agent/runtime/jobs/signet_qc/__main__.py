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
    pairing_command = commands.add_parser('check-pairing')
    pairing_command.add_argument('--run-dir', type=Path, required=True)
    pairing_command.add_argument('--genotype-build', choices=('GRCh37', 'GRCh38'))
    pairing_command.add_argument('--expression-build', choices=('GRCh37', 'GRCh38'))
    args = parser.parse_args(argv)

    try:
        if args.command in STEPS:
            publish(args.run_dir, args.command, args.cohort,
                    job_id=args.job_id, exit_code=args.exit_code)
        else:
            publish_pairing(args)
    except (OSError, ValueError) as error:
        parser.error(str(error))


def publish_pairing(args):
    summaries = {}
    for step in STEPS:
        with qc_path(args.run_dir, step).open('rb') as stream:
            summaries[step] = read_summary(stream, step)

    cohort = summaries['genotype']['cohort']
    if cohort != summaries['expression']['cohort']:
        raise ValueError('Genotype and expression QC belong to different cohorts.')
    publish(args.run_dir, 'pairing', cohort, upstream=summaries.values(),
            genotype_build=args.genotype_build, expression_build=args.expression_build)


if __name__ == '__main__':
    main()
