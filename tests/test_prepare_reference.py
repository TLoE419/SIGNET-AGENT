import gzip
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from agent.runtime.jobs.prepare_reference import PreparationError, genetic_map_format, prepare, reference_format

SCRIPT = Path(__file__).resolve().parents[1] / 'agent/runtime/jobs/prepare_reference.py'
VCF_HEADER = '##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tR1\tR2\n'


class PrepareReferenceTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        # Four study markers: 100 matches, 200 has mismatched alleles, 300 is multi-allelic in the
        # reference, 400 is absent from the reference.
        (self.root / 'study.map').write_text('1\t.\t0\t100\n1\t.\t0\t200\n1\t.\t0\t300\n1\t.\t0\t400\n')
        (self.root / 'study.ped').write_text('F S1 0 0 1 -9 A G C T A C G G\nF S2 0 0 2 -9 G G C C A A 0 0\n')
        self.original = (self.root / 'study.ped').read_bytes()
        with gzip.open(self.root / 'ref.vcf.gz', 'wt') as f:
            f.write(VCF_HEADER + 'chr1\t100\trs1\tA\tG\t.\tPASS\t.\tGT:DP\t0|1:9\t./.:0\n'
                    'chr1\t200\trs2\tA\tG\t.\tPASS\t.\tGT\t0|0\t0|1\n'
                    'chr1\t300\trs3\tA\tC,T\t.\tPASS\t.\tGT\t0|1\t1|1\n'
                    'chr2\t400\trs4\tG\tA\t.\tPASS\t.\tGT\t0|1\t1|1\n')
        with gzip.open(self.root / 'map.gz', 'wt') as f:
            f.write('pos\tchr\tcM\n1\t1\t0\n1000001\t1\t2\n')

    def tearDown(self):
        self.folder.cleanup()

    def run_prepare(self, reference='ref.vcf.gz', genetic_map='map.gz', out='out'):
        r = self.root
        return prepare(str(r / 'study.ped'), str(r / 'study.map'), str(r / reference), str(r / genetic_map), str(r / out))

    def test_vcf_with_chr_prefix_is_converted_for_matching_markers_only(self):
        summary = self.run_prepare()
        out = self.root / 'out'
        self.assertEqual((out / 'ref/chr1.gen').read_text(), 'chr1_100 rs1 100 A G 0 1 0 0 0 0\n',
                         'chr1 naming accepted; missing ./. becomes 0 0 0')
        self.assertEqual((out / 'gmap/chr1.map').read_text().splitlines(),
                         ['position COMBINED_rate(cM/Mb) Genetic_Map(cM)', '1 2 0', '1000001 0 2'])
        self.assertEqual((out / 'study.map').read_text(), '1\t.\t0\t100\n')
        self.assertEqual((out / 'study.ped').read_text(), 'F S1 0 0 1 -9 A G\nF S2 0 0 2 -9 G G\n')
        self.assertEqual((self.root / 'study.ped').read_bytes(), self.original, 'the original study is never changed')
        self.assertEqual((summary['matched_markers'], summary['study_markers'], summary['study_samples']), (1, 4, 2))
        # Every study marker is accounted for: 1 kept + 3 rejected for different reasons.
        self.assertEqual(summary['rejected'], {'allele_mismatch': 1, 'not_biallelic_snv': 1, 'not_in_reference': 1})
        self.assertEqual(summary['matched_markers'] + sum(summary['rejected'].values()), summary['study_markers'])
        self.assertEqual(set(summary['rejected_meanings']), set(summary['rejected']))
        self.assertIn('other DNA strand', summary['rejected_meanings']['allele_mismatch'])
        self.assertEqual((summary['reference_calls_without_genotype'], summary['formats']['reference']), (1, 'vcf'))
        self.assertIsNone(summary['warning'])
        self.assertEqual(json.loads((out / 'summary.json').read_text()), summary)
        self.assertNotIn('S1', json.dumps(summary), 'no sample IDs in the summary')
        with self.assertRaisesRegex(PreparationError, 'already exists'):
            self.run_prepare()

    def test_files_already_in_signet_format_are_used_without_conversion(self):
        (self.root / 'ready.gen').write_text('chr1_100 rs1 100 A G 1 0 0 0 1 0\nchr1_250 rs9 250 C T 1 0 0 1 0 0\n')
        (self.root / 'ready.map').write_text('position COMBINED_rate(cM/Mb) Genetic_Map(cM)\n1 2 0\n9000 0 1\n')
        summary = self.run_prepare('ready.gen', 'ready.map')
        out = self.root / 'out'
        self.assertEqual(summary['formats'], {'reference': 'gen', 'genetic_map': 'impute2'})
        self.assertEqual((out / 'ref/chr1.gen').read_text(), 'chr1_100 rs1 100 A G 1 0 0 0 1 0\n')
        self.assertEqual((out / 'gmap/chr1.map').read_bytes(), (self.root / 'ready.map').read_bytes())

    def test_formats_are_detected_before_anything_is_written(self):
        self.assertEqual(reference_format(str(self.root / 'ref.vcf.gz')), 'vcf')
        self.assertEqual(genetic_map_format(str(self.root / 'map.gz')), 'pos_chr_cm')
        (self.root / 'legend.txt').write_text('id position a0 a1\nrs1 100 A G\n')
        (self.root / 'hapmap.txt').write_text('Chromosome\tPosition(bp)\tRate(cM/Mb)\tMap(cM)\n')
        with self.assertRaisesRegex(PreparationError, 'Unsupported reference format'):
            self.run_prepare(reference='legend.txt')
        with self.assertRaisesRegex(PreparationError, 'Unsupported genetic map format'):
            self.run_prepare(genetic_map='hapmap.txt')
        self.assertFalse((self.root / 'out').exists())

    def test_no_match_leaves_nothing_and_low_match_warns(self):
        (self.root / 'other.vcf').write_text(VCF_HEADER + '1\t999\trs\tA\tG\t.\tPASS\t.\tGT\t0|1\t1|1\n')
        with self.assertRaisesRegex(PreparationError, 'same genome build'):
            self.run_prepare(reference='other.vcf')
        self.assertEqual(list(self.root.glob('out*')), [])
        # Only 100 and 200 of twenty markers are in the reference: a 10% match.
        markers = ''.join(f'1\t.\t0\t{p}\n' for p in range(100, 2100, 100))
        (self.root / 'study.map').write_text(markers)
        (self.root / 'study.ped').write_text('F S1 0 0 1 -9 ' + 'A G ' * 20 + '\n')
        self.assertIn('different genome builds', self.run_prepare()['warning'])

    def test_command_line_reports_failures_as_json(self):
        result = subprocess.run([sys.executable, '-I', str(SCRIPT), '--study-ped', str(self.root / 'study.ped'),
                                 '--study-map', str(self.root / 'study.map'), '--reference', str(self.root / 'study.map'),
                                 '--genetic-map', str(self.root / 'map.gz'), '--out', str(self.root / 'cli')],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)['status'], 'failed')


if __name__ == '__main__':
    unittest.main()
