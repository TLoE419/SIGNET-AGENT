"""The input checks run on HPC3 before -t and -a (agent/runtime/jobs/step_inputs.py), on local files."""
import gzip
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from agent.runtime import step_proposal
from agent.runtime.jobs import step_inputs

CHECKER = Path(step_inputs.__file__)
HEADER = 'race\tgender\tid\tsubmitter_id\n'


class StepInputsTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.dir = Path(temp.name)
        ids = ''.join(f'TCGA-AA-000{n}-01A\n' for n in range(1, 6))
        (self.dir / 'geno').write_text(ids)
        (self.dir / 'gexp').write_text(ids)

    def clinical(self, rows, ending='\n'):
        path = self.dir / 'clinical.tsv'
        path.write_text(ending.join([HEADER.rstrip('\n')] + [f'{race}\t{sex}\tx\tTCGA-AA-000{n}' for n, race, sex in rows]) + ending)
        return str(path)

    def check(self, path, choices=None, out=None):
        args = ['clinical', path, str(self.dir / 'geno'), str(self.dir / 'gexp'), json.dumps(choices or {})]
        done = subprocess.run([sys.executable, '-I', str(CHECKER), *args, *([out] if out else [])],
                              capture_output=True, text=True, check=True)
        return json.loads(done.stdout)

    def test_unknown_race_needs_a_choice_and_counts_only_matched_patients(self):
        path = self.clinical([(1, 'white', 'female'), (2, 'asian', 'male'), (3, 'black or african american', 'male'),
                              (4, 'Unknown', 'female'), (5, 'not reported', 'male'), (9, 'Unknown', 'male')])
        result = self.check(path)
        self.assertEqual(result['matched_patients'], 5)
        self.assertEqual(result['unrecognized_race'], {'Unknown': 1}, 'patient 9 has no genotype or expression results')
        self.assertEqual(result['needs_choice'], ['Unknown'])
        self.assertNotIn('TCGA', json.dumps(result))
        chosen = self.check(path, {'Unknown': 'not_reported'})
        self.assertEqual((chosen['needs_choice'], chosen['problems']), ([], []))
        self.assertEqual(chosen['races_after'], {'white': 3, 'asian': 1, 'black or african american': 1})

    def test_the_copy_applies_choices_and_never_changes_the_original(self):
        path = self.clinical([(1, 'white', 'female'), (2, 'asian', 'male'), (3, 'black or african american', 'male'),
                              (4, 'Unknown', 'female'), (5, '', 'male')], ending='\r\n')
        out = self.dir / 'run/clinical/clinical.signet.tsv'
        self.assertNotIn('written', self.check(path, {'Unknown': 'exclude'}, str(out)), 'a value without a choice blocks the copy')
        result = self.check(path, {'Unknown': 'exclude', '(blank)': 'not_reported'}, str(out))
        self.assertTrue(result['written'])
        self.assertTrue(result['windows_line_endings'])
        copy = out.read_text()
        self.assertNotIn('\r', copy)
        # signet -a removes "american indian or alaska native" from expression and genotype data alike.
        self.assertIn('american indian or alaska native\tfemale\tx\tTCGA-AA-0004', copy)
        self.assertIn('not reported\tmale\tx\tTCGA-AA-0005', copy)
        self.assertIn('Unknown', Path(path).read_text())

    def test_missing_patients_or_races_stop_the_step_before_it_runs(self):
        two_races = self.check(self.clinical([(n, 'white', 'male') for n in range(1, 5)] + [(5, 'asian', 'female')]))
        self.assertIn('requires exactly asian, black or african american, and white', ' '.join(two_races['problems']))
        partial = self.check(self.clinical([(1, 'white', 'female'), (2, 'asian', 'male'), (3, 'black or african american', 'male')]))
        self.assertIn('2 matched patients are not in the clinical table', ' '.join(partial['problems']))
        (self.dir / 'clinical.tsv').write_text('id\trace\nTCGA-AA-0001\twhite\n')
        self.assertIn('submitter_id', ' '.join(self.check(str(self.dir / 'clinical.tsv'))['problems']))

    def test_gtf_check(self):
        collapsed = 'chr1\tHAVANA\tgene\t1\t2\t.\t+\t.\tgene_id "A"; transcript_type "protein_coding";\n'
        full = 'chr1\tHAVANA\tgene\t1\t2\t.\t+\t.\tgene_id "A"; gene_type "protein_coding";\n'
        cases = {'ok.gtf': (collapsed.encode(), None), 'full.gtf': (full.encode(), 'not collapsed'),
                 'zipped.gtf.gz': (gzip.compress(collapsed.encode()), 'uncompressed'), 'table.txt': (b'a b c\n', '9 tab-separated')}
        for name, (data, problem) in cases.items():
            with self.subTest(name=name):
                (self.dir / name).write_bytes(data)
                found = step_inputs.gtf_problem(str(self.dir / name))
                self.assertIsNone(found) if problem is None else self.assertIn(problem, found)

    def test_legacy_cards_use_environment_defaults_without_global_file_selection(self):
        config = {'root': '/pub/u/signet-agent'}
        with patch('agent.runtime.ssh_transport.remote', side_effect=AssertionError('No global selection lookup')):
            self.assertEqual(step_proposal._reference_path('clinical', config), '/pub/u/signet-agent/refdata/clinical.tsv')
            self.assertEqual(step_proposal._reference_path('gtf', config), '/pub/u/signet-agent/refdata/gencode.v22.genes.gtf')


if __name__ == '__main__':
    unittest.main()
