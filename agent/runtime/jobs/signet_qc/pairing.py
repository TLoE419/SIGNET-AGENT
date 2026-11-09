"""Cohort-specific technical checks before SIGNET -a."""


def check_tcga(run_dir):
    # TODO: Verify genome build and count matched, unmatched, and ambiguous TCGA barcode pairings.
    return 'not_evaluated'


def check_gtex(run_dir):
    # TODO: Verify genome build and count donor matches within the selected tissue and run.
    return 'not_evaluated'
