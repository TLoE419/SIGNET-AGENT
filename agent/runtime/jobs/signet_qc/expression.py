"""Cohort-specific checks for SIGNET -t artifacts."""


def check_tcga(run_dir):
    # TODO: Check the VST matrix, sample and gene sidecars, annotation coverage, and chromosome scope.
    return 'not_evaluated'


def check_gtex(run_dir):
    # TODO: Check the expression BED, tissue and donor mapping, and the upstream genotype inputs.
    return 'not_evaluated'
