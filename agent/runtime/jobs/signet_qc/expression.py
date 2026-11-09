"""Check SIGNET -t artifacts for each cohort."""

from collections import Counter
import gzip

from .checks import (
    artifact_prefix, check_ids, check_numeric_matrix, chromosome_scope,
    input_path, read_identifiers, read_run_settings, split_whitespace_rows,
)
from .issues import IssueCode


class ExpressionIssue(IssueCode):
    ZERO_OUTPUT_GENES = 'zero_output_genes'
    GENE_POSITION_ORDER_MISMATCH = 'gene_position_order_mismatch'
    UNEXPECTED_CHROMOSOMES = 'unexpected_chromosomes'
    EXPRESSION_SAMPLE_ORDER_MISMATCH = 'expression_sample_order_mismatch'
    EXPRESSION_SAMPLE_IDS_NOT_IN_INPUT = 'expression_sample_ids_not_in_input'
    UNMAPPED_EXPRESSION_DONORS = 'unmapped_expression_donors'
    CHROMOSOMES_MISSING_FROM_GENOTYPE = 'chromosomes_missing_from_genotype'
    EXPRESSION_INDEX_MISSING = 'expression_index_missing'
    INVALID_GENE_COORDINATES = 'invalid_gene_coordinates'
    GENE_ID_COUNT_MISMATCH = 'gene_id_count_mismatch'
    DUPLICATE_GENE_IDS = 'duplicate_gene_ids'
    DONOR_ID_COUNT_MISMATCH = 'donor_id_count_mismatch'
    DUPLICATE_DONOR_IDS = 'duplicate_donor_ids'


GENE_ID_ISSUES = (ExpressionIssue.GENE_ID_COUNT_MISMATCH, ExpressionIssue.DUPLICATE_GENE_IDS)
DONOR_ID_ISSUES = (ExpressionIssue.DONOR_ID_COUNT_MISMATCH, ExpressionIssue.DUPLICATE_DONOR_IDS)


def check_coordinates(coordinate_rows, report, *, zero_based=False):
    """TCGA uses inclusive GTF coordinates. GTEx uses half-open BED intervals."""
    genes_by_chromosome = Counter()
    invalid_count = 0
    minimum_start = 0 if zero_based else 1
    for row in coordinate_rows:
        try:
            chromosome, start, end = row
            start, end = int(start), int(end)
        except ValueError:
            invalid_count += 1
            continue
        if start < minimum_start or end < start or (zero_based and end == start):
            invalid_count += 1
        else:
            genes_by_chromosome[chromosome] += 1
    report.metrics['genes_by_chromosome'] = dict(sorted(genes_by_chromosome.items()))
    if invalid_count:
        annotation_option = '--gtf' if zero_based else '--pmap'
        report.issue(ExpressionIssue.INVALID_GENE_COORDINATES, parameters=(annotation_option,))
    return genes_by_chromosome


def tcga_prefix(run_dir, config):
    return artifact_prefix(run_dir, config, 'rest.tcga', 'res/rest/signet')


def gtex_bed(run_dir, config):
    prefix = artifact_prefix(run_dir, config, 'rest.gtex', 'res/rest/signet')
    tissue = config.get('tissue')
    if not tissue or '/' in tissue or '\\' in tissue:
        raise ValueError('GTEx tissue is missing or invalid.')
    return prefix.with_name(f'{prefix.name}_expression_normalized_igt2log_GTEx_{tissue}.expression.bed.gz')


def check_tcga(run_dir, report):
    config = read_run_settings(run_dir)
    prefix = tcga_prefix(run_dir, config)
    sample_ids = read_identifiers(prefix.with_name(prefix.name + '_gexpID'))
    gene_ids = read_identifiers(prefix.with_name(prefix.name + '_gene_name'))
    with prefix.with_name(prefix.name + '_gene_pos').open() as stream:
        positions = list(split_whitespace_rows(stream))
    # The TCGA VST matrix has samples in rows and genes in columns.
    with prefix.with_name(prefix.name + '_gexp').open() as stream:
        sample_count, gene_count = check_numeric_matrix(split_whitespace_rows(stream), report)
    report.metrics.update(sample_count=sample_count, gene_count=gene_count, normalization='DESeq2_VST')
    check_ids(sample_ids, sample_count, report)
    check_ids(gene_ids, gene_count, report, 'gene', GENE_ID_ISSUES)
    if not gene_count:
        report.issue(ExpressionIssue.ZERO_OUTPUT_GENES, parameters=('--pmap', '--restrict'))

    coordinate_gene_ids = [row[0] for row in positions if row]
    if gene_ids != coordinate_gene_ids or len(positions) != gene_count:
        report.issue(ExpressionIssue.GENE_POSITION_ORDER_MISMATCH, parameters=('--pmap',))
    output_chromosomes = check_coordinates((row[1:] for row in positions), report)
    restriction = config.get('restrict.tcga')
    allowed_chromosomes = chromosome_scope(restriction)
    if allowed_chromosomes is not None and set(output_chromosomes) - allowed_chromosomes:
        report.issue(ExpressionIssue.UNEXPECTED_CHROMOSOMES, parameters=('--restrict',))
    report.metrics['parameters'] = {'restrict': restriction, 'minimum_sample_total_counts': 2500000}
    check_tcga_input_samples(input_path(run_dir, config, 'gexp.file'), sample_ids, report)


def check_tcga_input_samples(source, output_sample_ids, report):
    if source is None or not source.is_file():
        return
    with (gzip.open(source, 'rt') if source.suffix == '.gz' else source.open()) as stream:
        input_sample_ids = next(stream, '').split()[1:]
    if not input_sample_ids:
        return
    retained_ids = set(output_sample_ids)
    if retained_ids - set(input_sample_ids):
        report.issue(ExpressionIssue.EXPRESSION_SAMPLE_IDS_NOT_IN_INPUT, parameters=('--gexp',))
        return
    report.metrics['input_sample_count'] = len(input_sample_ids)
    expected_order = [sample_id for sample_id in input_sample_ids if sample_id in retained_ids]
    if output_sample_ids != expected_order:
        report.issue(ExpressionIssue.EXPRESSION_SAMPLE_ORDER_MISMATCH, parameters=('--gexp',))


def bed_header(stream):
    header = next(stream, '').rstrip('\r\n').split('\t')
    if header[:4] != ['#chr', 'start', 'end', 'gene_id']:
        raise ValueError('Invalid GTEx expression BED header.')
    return header[4:]


def read_gtex_donor_lookup(path):
    donor_by_sample = {}
    with path.open() as stream:
        if next(stream, '').split() != ['SAMPID', 'SUBJID']:
            raise ValueError('Invalid GTEx donor lookup header.')
        for row in split_whitespace_rows(stream):
            if len(row) != 2 or row[0] in donor_by_sample:
                raise ValueError('Invalid or duplicate GTEx sample mapping.')
            sample_id, donor_id = row
            donor_by_sample[sample_id] = donor_id
    return donor_by_sample


def check_gtex(run_dir, report):
    config = read_run_settings(run_dir)
    bed = gtex_bed(run_dir, config)
    expression_dir = run_dir / 'work/tmp/tmpt'
    donor_by_sample = read_gtex_donor_lookup(expression_dir / 'lookup_sample_subject_tissue.txt')

    gene_ids = []
    coordinates = []

    def collect_gene_metadata(stream):
        # Each BED row has chromosome, start, end and gene ID before the donor values.
        for row in split_whitespace_rows(stream):
            coordinates.append(row[:3])
            if len(row) >= 4:
                gene_ids.append(row[3])
            yield row

    with gzip.open(bed, 'rt') as stream:
        donor_ids = bed_header(stream)
        gene_count, sample_count = check_numeric_matrix(collect_gene_metadata(stream), report, metadata_columns=4)
    report.metrics.update(sample_count=sample_count, gene_count=gene_count, tissue=config['tissue'],
                          normalization='TMM_log2_CPM_plus_1')
    check_ids(donor_ids, sample_count, report, 'donor', DONOR_ID_ISSUES)
    check_ids(gene_ids, gene_count, report, 'gene', GENE_ID_ISSUES)
    if not gene_count:
        report.issue(ExpressionIssue.ZERO_OUTPUT_GENES, parameters=('--gtf',))
    if set(donor_ids) - set(donor_by_sample.values()):
        report.issue(ExpressionIssue.UNMAPPED_EXPRESSION_DONORS, parameters=('--tissue',))
    output_chromosomes = check_coordinates(coordinates, report, zero_based=True)
    genotype_chromosomes = read_identifiers(expression_dir / 'vcf_chr_list')
    if set(output_chromosomes) - set(genotype_chromosomes):
        report.issue(ExpressionIssue.CHROMOSOMES_MISSING_FROM_GENOTYPE, parameters=('--tissue',))
    index_paths = (bed.with_suffix('.gz.tbi'), bed.with_suffix('.gz.csi'))
    if not any(path.is_file() and path.stat().st_size for path in index_paths):
        report.issue(ExpressionIssue.EXPRESSION_INDEX_MISSING)
