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
        self.assertEqual(self.qc('genotype')['qc_status'], 'pass')

    def test_gtex_genotype_checks_original_missingness_and_vcf_order(self):
        self.write('config.ini', 'tissue = Lung\n')
        self.write('res/resg/signet_clean_Genotype_repNA.data', '0 2\n')
        self.write('res/resg/signet_snps.map', '1 rs1 0 10\n1 rs2 0 20\n')
        self.write('res/resg/signet_snps.maf', '0.2\n0.5\n')
        self.write('tmp/tmpg/GTEx_Lung.raw', 'FID IID PAT MAT SEX PHENOTYPE rs1_A rs2_G\n'
                   'GTEX-AA GTEX-AA 0 0 0 -9 NA 2\n')
        header = '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\t'
        self.write('tmp/tmpg/GTEx_snp.vcf', header + 'GTEX-AA\n')
        report = self.qc('genotype', 'GTEx')
        self.assertEqual(report['qc_status'], 'pass')
        self.assertEqual(report['metrics']['missing_values_before_replacement'], 1)
        self.write('tmp/tmpg/GTEx_snp.vcf', header + 'GTEX-BB\n')
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
