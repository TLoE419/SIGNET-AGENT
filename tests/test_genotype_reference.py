import gzip
import json
from pathlib import Path
import tempfile
import unittest

from scripts.prepare_genotype_reference import prepare


class ReferencePreparationTest(unittest.TestCase):
    def test_conversion_preserves_study_calls_and_filters_allele_mismatch(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);study=root/'study';study.mkdir()
            (study/'example.map').write_text('1 . 0 100\n1 . 0 200\n')
            (study/'example.ped').write_text('F S1 0 0 1 -9 A G C T\nF S2 0 0 2 -9 G G C C\n')
            vcf=root/'source.vcf'
            vcf.write_text('#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tR1\tR2\n'
                           '1\t100\trs1\tA\tG\t.\tPASS\t.\tGT\t0|1\t1|1\n'
                           '1\t200\trs2\tA\tG\t.\tPASS\t.\tGT\t0|0\t0|1\n')
            gm=root/'source.gmap.gz'
            with gzip.open(gm,'wt') as f:f.write('pos chr cM\n1 1 0\n1000001 1 2\n')
            out=root/'out';original=(study/'example.ped').read_bytes()
            prepare(vcf,out,study,gm)
            self.assertEqual((study/'example.ped').read_bytes(),original)
            self.assertEqual((out/'example.ped').read_text(),'F S1 0 0 1 -9 A G\nF S2 0 0 2 -9 G G\n')
            self.assertEqual((out/'ref/chr1.gen').read_text(),'chr1_100 rs1 100 A G 0 1 0 0 0 1\n')
            self.assertEqual((out/'gmap/chr1.map').read_text().splitlines()[1],'1 2 0')
            report=json.loads((out/'provenance.json').read_text())
            self.assertEqual(report['matched_position_and_allele_markers'],1)
            self.assertEqual(report['rejected']['allele_mismatch'],1)
            with self.assertRaises(FileExistsError):prepare(vcf,out,study,gm)

    def test_no_compatible_markers_is_not_treated_as_usable_reference(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);study=root/'study';study.mkdir()
            (study/'example.map').write_text('1 . 0 100\n')
            (study/'example.ped').write_text('F S1 0 0 1 -9 C T\n')
            vcf=root/'source.vcf'
            vcf.write_text('#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tR1\n'
                           '1\t100\trs1\tA\tG\t.\tPASS\t.\tGT\t0|1\n')
            with self.assertRaisesRegex(AssertionError,'No position AND allele-compatible'):
                prepare(vcf,root/'out',study,root/'unused.gmap.gz')
