"""Validate identifiers shared by the -g and -t outputs before SIGNET -a."""

from collections import Counter
import gzip
import re

from . import expression, genotype
from .checks import read_identifiers, read_run_settings
from .issues import IssueCode


class PairingIssue(IssueCode):
    GENOME_BUILD_UNVERIFIED = 'genome_build_unverified'
    GENOME_BUILD_MISMATCH = 'genome_build_mismatch'
    UPSTREAM_QC_NOT_PASSED = 'upstream_qc_not_passed'
    AMBIGUOUS_SAMPLE_PAIRING = 'ambiguous_sample_pairing'
    NO_UNAMBIGUOUS_SAMPLE_MATCHES = 'no_unambiguous_sample_matches'
    UNMATCHED_SUBJECTS = 'unmatched_subjects'
    INVALID_TCGA_SAMPLE_BARCODE = 'invalid_tcga_sample_barcode'
    TCGA_PATIENT_KEY_COLLISION = 'tcga_patient_key_collision'

    @property
    def severity(self):
        if self in (self.GENOME_BUILD_UNVERIFIED, self.UNMATCHED_SUBJECTS):
            return 'warning'
        return super().severity


TCGA_SAMPLE_BARCODE = re.compile(
    r'TCGA-([A-Za-z0-9]{2})-([A-Za-z0-9]{4})-\d{2}[A-Za-z]?(?:-[A-Za-z0-9]+)*')


def check_prerequisites(report, genotype_build, expression_build, upstream):
    report.metrics.update(genotype_build=genotype_build, expression_build=expression_build)
    if not genotype_build or not expression_build:
        report.issue(PairingIssue.GENOME_BUILD_UNVERIFIED)
    elif genotype_build != expression_build:
        report.issue(PairingIssue.GENOME_BUILD_MISMATCH)
    if any(summary.get('qc_status') != 'pass' for summary in upstream):
        report.issue(PairingIssue.UPSTREAM_QC_NOT_PASSED)


def check_matches(genotype_keys, expression_keys, report, collisions=()):
    genotype_counts = Counter(genotype_keys)
    expression_counts = Counter(expression_keys)
    shared_subjects = genotype_counts.keys() & expression_counts.keys()
    genotype_only = genotype_counts.keys() - expression_counts.keys()
    expression_only = expression_counts.keys() - genotype_counts.keys()
    ambiguous_subjects = {
        key for key in shared_subjects
        if genotype_counts[key] != 1 or expression_counts[key] != 1 or key in collisions
    }
    matched_count = len(shared_subjects) - len(ambiguous_subjects)
    report.metrics.update(matched_subjects=matched_count, ambiguous_subjects=len(ambiguous_subjects),
                          genotype_only_subjects=len(genotype_only), expression_only_subjects=len(expression_only))
    if matched_count:
        one_to_one_subjects = shared_subjects - ambiguous_subjects
        genotype_order = [key for key in genotype_keys if key in one_to_one_subjects]
        expression_order = [key for key in expression_keys if key in one_to_one_subjects]
        report.metrics['alignment'] = {
            'one_to_one_subject_count': matched_count,
            'expression_reordering_required': genotype_order != expression_order,
            'genotype_excluded_row_count': len(genotype_keys) - matched_count,
            'expression_excluded_row_count': len(expression_keys) - matched_count,
        }
    if ambiguous_subjects:
        report.issue(PairingIssue.AMBIGUOUS_SAMPLE_PAIRING)
    if not matched_count:
        report.issue(PairingIssue.NO_UNAMBIGUOUS_SAMPLE_MATCHES)
    if genotype_only or expression_only:
        report.issue(PairingIssue.UNMATCHED_SUBJECTS)


def tcga_subjects(sample_ids, report):
    subjects = []
    sites = {}
    for sample_id in sample_ids:
        match = TCGA_SAMPLE_BARCODE.fullmatch(sample_id)
        if not match:
            report.issue(PairingIssue.INVALID_TCGA_SAMPLE_BARCODE)
            return None
        site, subject = match.groups()
        subjects.append(subject)
        sites.setdefault(subject, set()).add(site)
    return subjects, sites


def check_tcga(run_dir, report):
    config = read_run_settings(run_dir)
    genotype_prefix = genotype.tcga_prefix(run_dir, config)
    expression_prefix = expression.tcga_prefix(run_dir, config)
    genotype_id_file = genotype_prefix.with_name(genotype_prefix.name + '_Genotype.sampleID')
    expression_id_file = expression_prefix.with_name(expression_prefix.name + '_gexpID')
    genotype_subjects = tcga_subjects(read_identifiers(genotype_id_file), report)
    expression_subjects = tcga_subjects(read_identifiers(expression_id_file), report)
    if genotype_subjects is None or expression_subjects is None:
        return

    genotype_keys, genotype_sites = genotype_subjects
    expression_keys, expression_sites = expression_subjects
    # SIGNET -a joins on the third barcode component. Reject keys shared across sites.
    shared_keys = genotype_sites.keys() & expression_sites.keys()
    collisions = {key for key in shared_keys if len(genotype_sites[key] | expression_sites[key]) > 1}
    if collisions:
        report.issue(PairingIssue.TCGA_PATIENT_KEY_COLLISION)
    check_matches(genotype_keys, expression_keys, report, collisions)


def check_gtex(run_dir, report):
    config = read_run_settings(run_dir)
    with gzip.open(expression.gtex_bed(run_dir, config), 'rt') as stream:
        donors = expression.bed_header(stream)
    check_matches(genotype.gtex_samples(run_dir, config), donors, report)
