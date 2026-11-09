import gzip
import json
from pathlib import Path
import tempfile
import unittest

from agent.runtime.jobs import signet_qc


class SignetQcTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.run_dir = Path(temp.name)
        self.work = self.run_dir / 'work'

    def write(self, name, data):
        path = self.work / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.suffix == '.gz':
            with gzip.open(path, 'wt') as stream:
                stream.write(data)
        else:
            path.write_text(data)

    def qc(self, step, cohort='TCGA', **kwargs):
        path = signet_qc.publish(self.run_dir, step, cohort, **kwargs)
        return json.loads(path.read_text())

    def native_reports(self, sample_id):
        directory = self.run_dir / 'steps/native-qc'
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'plink-1.imiss').write_text(f'IID N_MISS N_GENO\n{sample_id} 1 2\n')
        (directory / 'plink-1.lmiss').write_text('SNP N_MISS N_GENO\nrs1 1 1\nrs2 0 1\n')
        (directory / 'plink-1.frq').write_text('SNP MAF\nrs1 NA\nrs2 0.5\n')
        (directory / 'plink-1.hwe').write_text('SNP TEST P\nrs1 ALL NA\nrs2 ALL 0.8\nrs2 UNAFF 0.7\n')
        return directory

    def test_tcga_expression_checks_dimensions_and_zero_gene_output(self):
        self.write('config.ini', 'restrict.tcga = 1\n')
        self.write('res/rest/signet_gexpID', 'TCGA-AA-1234-01A\n')
        self.write('res/rest/signet_gene_name', 'GENE1\n')
        self.write('res/rest/signet_gene_pos', 'GENE1 chr1 5 9\n')
        self.write('res/rest/signet_gexp', '1.25\n')
        self.assertEqual(self.qc('expression')['qc_status'], 'pass')
        self.write('res/rest/signet_gexp', '\n')
        self.write('res/rest/signet_gene_name', '')
        self.write('res/rest/signet_gene_pos', '')
        report = self.qc('expression', exit_code=0)
        self.assertEqual(report['qc_status'], 'blocked')
        self.assertIn('zero_output_genes', {issue['code'] for issue in report['issues']})

    def test_tcga_genotype_requires_each_imputation_chunk(self):
        self.write('res/resg/signet_Genotype.sampleID', 'TCGA-AA-1234-01A\n')
        self.write('res/resg/signet_Geno', '0 2\n')
        command = 'impute2 -o impute/impute_chr1chunk1\n'
        self.write('tmp/tmpg/impute_params.txt', command)
        self.write('tmp/tmpg/impute_params.txt.completed', command)
        report = self.qc('genotype', exit_code=0)
        self.assertEqual(report['qc_status'], 'blocked')
        self.assertEqual(report['issues'][0]['code'], 'imputation_chunks_incomplete')
        self.write('tmp/tmpg/impute/impute_chr1chunk1', 'imputed\n')
        report = self.qc('genotype')
        self.assertEqual(report['qc_status'], 'pass')
        self.assertEqual(report['metrics']['missingness_before_zero_replacement']['status'], 'unavailable')
        self.native_reports('TCGA-AA-1234-01A')
        self.write('tmp/tmpg/impute/impute_chr1chunk1_info',
                   'info certainty concord_type1\n0.9 0.95 0.8\n-0.2 1 -1\n')
        metrics = self.qc('genotype')['metrics']
        missingness = metrics['missingness_before_zero_replacement']
        self.assertEqual(missingness['overall_rate'], 0.5)
        self.assertEqual(missingness['per_snp_rate'], {'count': 2, 'min': 0.0, 'median': 0.5, 'max': 1.0})
        self.assertEqual(metrics['minor_allele_frequency']['groups']['all']['count'], 1)
        self.assertEqual(metrics['hardy_weinberg_p_values']['groups']['UNAFF']['median'], 0.7)
        self.assertEqual(metrics['imputation_quality']['concord_type1']['count'], 1)
        self.assertEqual(metrics['imputation_quality']['info']['min'], -0.2)

    def test_gtex_genotype_checks_original_missingness_and_vcf_order(self):
        self.write('config.ini', 'tissue = Lung\n')
        self.write('res/resg/signet_clean_Genotype_repNA.data', '0 2\n')
        self.write('res/resg/signet_snps.map', '1 rs1 0 10\n1 rs2 0 20\n')
        self.write('res/resg/signet_snps.maf', '0.2\n0.5\n')
        self.write('tmp/tmpg/GTEx_Lung.raw', 'FID IID PAT MAT SEX PHENOTYPE rs1_A rs2_G\n'
                   'GTEX-AA GTEX-AA 0 0 0 -9 NA 2\n')
        native = self.native_reports('GTEX-AA')
        (native / 'vcf-samples.txt').write_text('GTEX-AA\n')
        report = self.qc('genotype', 'GTEx')
        self.assertEqual(report['qc_status'], 'pass')
        self.assertEqual(report['metrics']['missing_values_before_replacement'], 1)
        missingness = report['metrics']['missingness_before_zero_replacement']
        self.assertEqual(missingness['status'], 'measured')
        self.assertEqual(missingness['per_sample_rate'], {'count': 1, 'min': 0.5, 'median': 0.5, 'max': 0.5})
        (native / 'vcf-samples.txt').write_text('GTEX-BB\n')
        self.assertEqual(self.qc('genotype', 'GTEx')['issues'][0]['code'], 'vcf_sample_order_mismatch')
        self.write('res/resg/signet_snps.maf', 'not-a-frequency\n0.5\n')
        self.assertEqual(self.qc('genotype', 'GTEx')['issues'][0]['code'], 'invalid_snp_maf')

    def test_gtex_expression_checks_donors_and_genotype_chromosomes(self):
        self.write('config.ini', 'tissue = Lung\n')
        bed = 'res/rest/signet_expression_normalized_igt2log_GTEx_Lung.expression.bed.gz'
        self.write(bed, '#chr\tstart\tend\tgene_id\tGTEX-AA\nchr1\t0\t1\tGENE1\t1.25\n')
        self.write(bed + '.tbi', 'index')
        self.write('tmp/tmpt/lookup_sample_subject_tissue.txt', 'SAMPID\tSUBJID\nGTEX-AA-X\tGTEX-AA\n')
        self.write('tmp/tmpt/vcf_chr_list', 'chr1\n')
        self.assertEqual(self.qc('expression', 'GTEx')['qc_status'], 'pass')
        self.write('tmp/tmpt/vcf_chr_list', 'chr2\n')
        report = self.qc('expression', 'GTEx')
        self.assertEqual(report['issues'][0]['code'], 'chromosomes_missing_from_genotype')

    def test_pairing_blocks_build_mismatch_and_tcga_patient_key_collision(self):
        self.write('res/resg/signet_Genotype.sampleID', 'TCGA-AA-1234-01A\n')
        self.write('res/rest/signet_gexpID', 'TCGA-BB-1234-01A\n')
        report = self.qc('pairing', genotype_build='GRCh37', expression_build='GRCh38')
        self.assertEqual(report['qc_status'], 'blocked')
        self.assertEqual({issue['code'] for issue in report['issues']},
                         {'genome_build_mismatch', 'tcga_patient_key_collision',
                          'ambiguous_sample_pairing', 'no_unambiguous_sample_matches'})
        self.assertNotIn('TCGA-AA-1234-01A', json.dumps(report))
        self.write('res/rest/signet_gexpID', 'TCGA-AA-1234-01A\ninvalid\n')
        report = self.qc('pairing', genotype_build='GRCh38', expression_build='GRCh38')
        self.assertEqual([issue['code'] for issue in report['issues']], ['invalid_tcga_sample_barcode'])
        self.assertNotIn('matched_subjects', report['metrics'])

    def test_pairing_reports_order_of_the_shared_subset(self):
        self.write('res/resg/signet_Genotype.sampleID', 'TCGA-AA-1234-01A\nTCGA-AA-5678-01A\n')
        self.write('res/rest/signet_gexpID', 'TCGA-AA-5678-01A\nTCGA-AA-0000-01A\nTCGA-AA-1234-01A\n')
        report = self.qc('pairing', genotype_build='GRCh38', expression_build='GRCh38')
        self.assertEqual(report['qc_status'], 'review_required')
        self.assertEqual(report['metrics']['alignment'], {
            'one_to_one_subject_count': 2,
            'expression_reordering_required': True,
            'genotype_excluded_row_count': 0,
            'expression_excluded_row_count': 1,
        })
