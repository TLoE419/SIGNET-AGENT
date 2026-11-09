"""Collect PLINK's native reports on the same inputs SIGNET uses for dosages."""

from pathlib import Path
from shutil import copyfile
from statistics import median
import subprocess
from tempfile import TemporaryDirectory

from .checks import read_run_settings, split_whitespace_rows


REPORTS_DIR = 'steps/native-qc'


def collect(run_dir, cohort):
    """Run inside the SIGNET container. Publish reports only after all commands succeed."""
    target = run_dir / REPORTS_DIR
    if target.exists():
        raise ValueError('Native genotype QC reports already exist for this run.')
    plink_dir = run_dir / 'work/tmp/tmpg'
    if cohort == 'TCGA':
        impute_dir = plink_dir / 'impute'
        # --data uses the same Oxford files as SIGNET's --recodeA.
        datasets = [('--data', path.with_suffix('')) for path in sorted(impute_dir.glob('imputed_chr*.gen'))]
    else:
        tissue = read_run_settings(run_dir).get('tissue')
        if not tissue or '/' in tissue or '\\' in tissue:
            raise ValueError('GTEx tissue is missing or invalid.')
        # This PED/MAP pair already has the same MAC filter as the published dosages.
        datasets = [('--file', plink_dir / f'GTEx_{tissue}')]

    if not datasets:
        raise ValueError('No SIGNET genotype inputs for native PLINK QC.')
    target.parent.mkdir(exist_ok=True)
    with TemporaryDirectory(prefix='.native-qc-', dir=target.parent) as temporary:
        stage = Path(temporary)
        for index, (input_option, prefix) in enumerate(datasets, start=1):
            output_prefix = stage / f'plink-{index}'
            options = ['--missing', '--hardy']
            existing_frequency = prefix.with_name(prefix.name + '.frq')
            if input_option == '--file' and existing_frequency.is_file() and existing_frequency.stat().st_size:
                copyfile(existing_frequency, output_prefix.with_suffix('.frq'))
            else:
                options.append('--freq')
            subprocess.run(['plink', input_option, str(prefix), *options, '--threads', '1',
                            '--out', str(output_prefix)], check=True)
            for suffix in ('.imiss', '.lmiss', '.frq', '.hwe'):
                output = output_prefix.with_suffix(suffix)
                if not output.is_file() or not output.stat().st_size:
                    raise ValueError(f'PLINK did not produce {suffix}.')
        if cohort == 'GTEx':
            vcf = plink_dir / 'GTEx_snp.vcf'
            if not vcf.is_file():
                vcf = vcf.with_suffix('.vcf.gz')
            try:
                samples = subprocess.check_output(['bcftools', 'query', '-l', str(vcf)])
            except (OSError, subprocess.CalledProcessError):
                print('Could not collect the VCF sample list with bcftools.')
            else:
                (stage / 'vcf-samples.txt').write_bytes(samples)
        # Each HPC run allows one genotype step. Avoid reusing partial or stale report sets.
        stage.rename(target)


def table_rows(path, *columns, optional=()):
    """Yield named native report columns regardless of whitespace or column order."""
    with path.open() as stream:
        header = next(stream, '').split()
        indices = [header.index(column) for column in columns]
        indices.extend(header.index(column) if column in header else None for column in optional)
        for row in split_whitespace_rows(stream):
            if len(row) != len(header):
                raise ValueError('Invalid native report row.')
            yield tuple(row[index] if index is not None else None for index in indices)


def distribution(values):
    if not values:
        return {'count': 0}
    return {'count': len(values), 'min': min(values), 'median': median(values), 'max': max(values)}


def missingness(report_paths, sample_ids, expected_snps):
    """Aggregate PLINK N_MISS and N_GENO counts across chromosomes."""
    if not report_paths:
        return {'status': 'unavailable', 'reason': 'plink_missing_reports_unavailable'}

    sample_missing = dict.fromkeys(sample_ids, 0)
    sample_totals = dict.fromkeys(sample_ids, 0)
    variant_rates = []
    variant_missing = variant_total = variant_count = 0
    try:
        for sample_report in report_paths:
            seen_samples = set()
            for sample_id, missing, total in table_rows(sample_report, 'IID', 'N_MISS', 'N_GENO'):
                if sample_id in seen_samples or sample_id not in sample_missing:
                    raise ValueError('PLINK sample IDs differ from the genotype output.')
                seen_samples.add(sample_id)
                missing, total = missing_counts(missing, total)
                sample_missing[sample_id] += missing
                sample_totals[sample_id] += total
            if seen_samples != sample_missing.keys():
                raise ValueError('PLINK sample IDs differ from the genotype output.')

            variant_report = sample_report.with_suffix('.lmiss')
            for missing, total in table_rows(variant_report, 'N_MISS', 'N_GENO'):
                missing, total = missing_counts(missing, total)
                variant_count += 1
                variant_missing += missing
                variant_total += total
                if total:
                    variant_rates.append(missing / total)
    except (OSError, ValueError):
        return {'status': 'unverified', 'reason': 'invalid_or_incomplete_plink_missing_reports'}

    if (variant_count != expected_snps or variant_total == 0
            or sum(sample_missing.values()) != variant_missing or sum(sample_totals.values()) != variant_total):
        return {'status': 'unverified', 'reason': 'plink_missing_reports_do_not_match_outputs'}
    sample_rates = [sample_missing[sample] / total for sample, total in sample_totals.items() if total]
    overall_rate = variant_missing / variant_total
    return {
        'status': 'measured', 'source': 'plink --missing',
        'sample_count': len(sample_ids), 'snp_count': variant_count,
        'missing_call_count': variant_missing, 'overall_rate': overall_rate,
        'overall_hard_call_rate': 1 - overall_rate,
        'per_sample_rate': distribution(sample_rates), 'per_snp_rate': distribution(variant_rates),
    }


def missing_counts(missing, total):
    missing, total = int(missing), int(total)
    if not 0 <= missing <= total:
        raise ValueError('Invalid PLINK missing counts.')
    return missing, total


def variant_quality(report_paths, *, column, group_column=None, upper=1):
    if not report_paths:
        return {'status': 'unavailable'}
    values_by_group = {}
    try:
        for path in report_paths:
            columns = (group_column, column) if group_column else (column,)
            for row in table_rows(path, *columns):
                group, value = row if group_column else ('all', row[0])
                values = values_by_group.setdefault(group, [])
                if value in ('NA', 'nan'):
                    continue
                number = float(value)
                if not 0 <= number <= upper:
                    raise ValueError('Invalid PLINK QC metric.')
                values.append(number)
    except (OSError, ValueError):
        return {'status': 'unverified'}
    return {'status': 'measured', 'groups': {group: distribution(values) for group, values in values_by_group.items()}}


def record_quality(run_dir, sample_ids, snp_count, report, *, stage):
    directory = run_dir / REPORTS_DIR
    report.metrics['native_plink_input_stage'] = stage
    report.metrics['missingness_before_zero_replacement'] = missingness(
        sorted(directory.glob('plink-*.imiss')), sample_ids, snp_count)
    report.metrics['minor_allele_frequency'] = variant_quality(
        sorted(directory.glob('plink-*.frq')), column='MAF', upper=0.5)
    report.metrics['hardy_weinberg_p_values'] = variant_quality(
        sorted(directory.glob('plink-*.hwe')), column='P', group_column='TEST')
