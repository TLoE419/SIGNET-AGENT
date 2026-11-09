"""Check SIGNET -g artifacts for each cohort."""

import gzip
from itertools import zip_longest
import re

from .checks import (
    artifact_prefix, check_ids, check_numeric_matrix, input_path,
    read_identifiers, read_run_settings, split_whitespace_rows,
)
from .issues import IssueCode


class GenotypeIssue(IssueCode):
    GENOTYPE_SAMPLE_ORDER_MISMATCH = 'genotype_sample_order_mismatch'
    IMPUTATION_MANIFEST_MISSING = 'imputation_manifest_missing'
    IMPUTATION_CHUNKS_INCOMPLETE = 'imputation_chunks_incomplete'
    INVALID_SNP_COORDINATES = 'invalid_snp_coordinates'
    INVALID_SNP_MAF = 'invalid_snp_maf'
    PLINK_SNP_ORDER_MISMATCH = 'plink_snp_order_mismatch'
    PLINK_MATRIX_ORDER_MISMATCH = 'plink_matrix_order_mismatch'
    VCF_SAMPLE_ORDER_MISMATCH = 'vcf_sample_order_mismatch'
    VCF_HEADER_MISSING = 'vcf_header_missing'
    SNP_ID_COUNT_MISMATCH = 'snp_id_count_mismatch'
    DUPLICATE_SNP_IDS = 'duplicate_snp_ids'


GENOTYPE_DOSAGES = {'0', '1', '2'}
SNP_ID_ISSUES = (GenotypeIssue.SNP_ID_COUNT_MISMATCH, GenotypeIssue.DUPLICATE_SNP_IDS)
TCGA_PARAMETERS = ('mind', 'geno', 'hwe', 'int', 'ncore_local', 'restrict.tcga.geno')
IMPUTE_OUTPUT = re.compile(r'(?:^|\s)-o impute/(impute_chr\d+chunk\d+)(?:\s|$)')


def tcga_prefix(run_dir, config):
    return artifact_prefix(run_dir, config, 'resg.tcga', 'res/resg/signet')


def check_tcga(run_dir, report):
    config = read_run_settings(run_dir)
    prefix = tcga_prefix(run_dir, config)
    sample_ids = read_identifiers(prefix.with_name(prefix.name + '_Genotype.sampleID'))
    matrix_path = prefix.with_name(prefix.name + '_Geno')
    with matrix_path.open() as stream:
        sample_count, snp_count = check_numeric_matrix(
            split_whitespace_rows(stream), report, encoding=GENOTYPE_DOSAGES)

    report.metrics.update(sample_count=sample_count, snp_count=snp_count)
    report.metrics['parameters'] = {key: config[key] for key in TCGA_PARAMETERS if key in config}
    check_ids(sample_ids, sample_count, report)

    plink_dir = run_dir / 'work/tmp/tmpg'
    record_plink_retention(run_dir, config, plink_dir, sample_ids, report)
    check_imputation_chunks(plink_dir, report)


def record_plink_retention(run_dir, config, plink_dir, output_sample_ids, report):
    """Compare final sample order with PLINK and record counts when inputs remain available."""
    for key, metric in (('ped.file', 'input_sample_count'), ('map.file', 'input_snp_count')):
        source = input_path(run_dir, config, key)
        if source and source.is_file():
            with source.open('rb') as stream:
                report.metrics[metric] = sum(bool(line.strip()) for line in stream)

    plink_map = plink_dir / 'clean_Genotype.map'
    if plink_map.is_file():
        with plink_map.open() as stream:
            report.metrics['plink_retained_snp_count'] = sum(bool(line.strip()) for line in stream)

    plink_dosages = plink_dir / 'clean_Genotype.data'
    if plink_dosages.is_file():
        retained_sample_ids = read_identifiers(plink_dosages, column=1)
        report.metrics['plink_retained_sample_count'] = len(retained_sample_ids)
        if output_sample_ids != retained_sample_ids:
            report.issue(GenotypeIssue.GENOTYPE_SAMPLE_ORDER_MISMATCH)


def check_imputation_chunks(plink_dir, report):
    """Check both ParaFly's completion record and the output of each planned IMPUTE2 command."""
    manifest = plink_dir / 'impute_params.txt'
    if not manifest.is_file():
        report.issue(GenotypeIssue.IMPUTATION_MANIFEST_MISSING)
        return

    expected_outputs = []
    for command in manifest.read_text().splitlines():
        if not command.strip():
            continue
        output = IMPUTE_OUTPUT.search(command)
        if not output:
            raise ValueError('Invalid IMPUTE2 chunk manifest.')
        expected_outputs.append(plink_dir / 'impute' / output.group(1))

    output_count = sum(path.is_file() and path.stat().st_size > 0 for path in set(expected_outputs))
    completion_log = plink_dir / 'impute_params.txt.completed'
    completed_count = 0
    if completion_log.is_file():
        with completion_log.open() as stream:
            completed_count = sum(bool(command.strip()) for command in stream)

    expected_count = len(expected_outputs)
    report.metrics.update(imputation_expected_chunks=expected_count,
                          imputation_output_chunks=output_count,
                          imputation_completed_commands=completed_count)
    if expected_count == 0 or output_count != expected_count or completed_count != expected_count:
        report.issue(GenotypeIssue.IMPUTATION_CHUNKS_INCOMPLETE,
                     parameters=('--ncores', '--int', '--ref', '--gmap'))


def gtex_plink_raw(run_dir, config):
    tissue = config.get('tissue')
    if not tissue or '/' in tissue or '\\' in tissue:
        raise ValueError('GTEx tissue is missing or invalid.')
    return run_dir / 'work/tmp/tmpg' / f'GTEx_{tissue}.raw'


def gtex_samples(run_dir, config):
    return read_identifiers(gtex_plink_raw(run_dir, config), column=1, header=True)


def check_gtex(run_dir, report):
    config = read_run_settings(run_dir)
    sample_ids = gtex_samples(run_dir, config)
    prefix = artifact_prefix(run_dir, config, 'resg.gtex', 'res/resg/signet')
    published_matrix = prefix.with_name(prefix.name + '_clean_Genotype_repNA.data')
    with published_matrix.open() as stream:
        sample_count, snp_count = check_numeric_matrix(
            split_whitespace_rows(stream), report, encoding=GENOTYPE_DOSAGES)
    report.metrics.update(sample_count=sample_count, snp_count=snp_count, tissue=config['tissue'],
                          parameters={'minimum_minor_allele_count': 5})
    check_ids(sample_ids, sample_count, report)

    snp_ids = check_gtex_snp_metadata(prefix, snp_count, report)
    plink_raw = gtex_plink_raw(run_dir, config)
    check_plink_dosages(plink_raw, published_matrix, snp_ids, snp_count, report)
    check_vcf_sample_order(plink_raw.parent / 'GTEx_snp.vcf', sample_ids, report)


def check_gtex_snp_metadata(prefix, expected_snps, report):
    snp_ids = []
    invalid_positions = 0
    with prefix.with_name(prefix.name + '_snps.map').open() as stream:
        # A PLINK MAP row has chromosome, SNP ID, genetic distance and base position.
        for row in split_whitespace_rows(stream):
            if len(row) != 4 or not row[3].isdigit() or int(row[3]) < 1:
                invalid_positions += 1
            if len(row) > 1:
                snp_ids.append(row[1])
    check_ids(snp_ids, expected_snps, report, 'snp', SNP_ID_ISSUES)
    if invalid_positions:
        report.issue(GenotypeIssue.INVALID_SNP_COORDINATES)

    frequencies = read_identifiers(prefix.with_name(prefix.name + '_snps.maf'))
    try:
        invalid_frequency = any(not 0 <= float(value) <= 0.5 for value in frequencies)
    except ValueError:
        invalid_frequency = True
    if len(frequencies) != expected_snps or invalid_frequency:
        report.issue(GenotypeIssue.INVALID_SNP_MAF)
    return snp_ids


def check_plink_dosages(raw, published_matrix, snp_ids, expected_snps, report):
    """The published matrix strips six PLINK columns and replaces each NA with 0."""
    with raw.open() as original, published_matrix.open() as published:
        header = next(original, '').split()
        if header[:6] != ['FID', 'IID', 'PAT', 'MAT', 'SEX', 'PHENOTYPE']:
            raise ValueError('Invalid PLINK raw header.')
        # PLINK appends the counted allele to each SNP ID (for example, rs42_A).
        dosage_columns = header[6:]
        dosage_snp_ids = [column.rsplit('_', 1)[0] for column in dosage_columns]
        if dosage_snp_ids != snp_ids:
            report.issue(GenotypeIssue.PLINK_SNP_ORDER_MISMATCH)

        missing_before_replacement = 0
        matrix_mismatches = 0
        original_rows = split_whitespace_rows(original)
        published_rows = split_whitespace_rows(published)
        for raw_row, published_row in zip_longest(original_rows, published_rows, fillvalue=[]):
            raw_dosages = raw_row[6:]
            missing_before_replacement += raw_dosages.count('NA')
            expected_dosages = ['0' if value == 'NA' else value for value in raw_dosages]
            if expected_dosages != published_row:
                matrix_mismatches += 1

    report.metrics['missing_values_before_replacement'] = missing_before_replacement
    if matrix_mismatches or len(dosage_columns) != expected_snps:
        report.issue(GenotypeIssue.PLINK_MATRIX_ORDER_MISMATCH)


def check_vcf_sample_order(vcf, plink_sample_ids, report):
    # VCF has nine fixed columns before the sample IDs.
    with (vcf.open() if vcf.is_file() else gzip.open(vcf.with_suffix('.vcf.gz'), 'rt')) as stream:
        for line in stream:
            if line.startswith('#CHROM\t'):
                vcf_sample_ids = line.rstrip('\r\n').split('\t')[9:]
                if vcf_sample_ids != plink_sample_ids:
                    report.issue(GenotypeIssue.VCF_SAMPLE_ORDER_MISMATCH)
                return
    report.issue(GenotypeIssue.VCF_HEADER_MISSING)
