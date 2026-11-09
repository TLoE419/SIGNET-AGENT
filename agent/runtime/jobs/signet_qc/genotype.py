"""Cohort-specific checks for SIGNET -g artifacts."""


def check_tcga(run_dir):
    # TODO: Check genotype dimensions and sample IDs, PLINK attrition, and IMPUTE2 chunk completion.
    return 'not_evaluated'


def check_gtex(run_dir):
    # TODO: Check VCF/PLINK sample and SNP alignment, tissue selection, and missingness before NA replacement.
    return 'not_evaluated'
