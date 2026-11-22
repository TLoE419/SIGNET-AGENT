"""Research files stay private even when an old client requests a former read tool."""
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

import agent.core.conversation as main
import agent.tools.general as tools
import agent.tools.signet as st


class ReadFileTest(unittest.TestCase):
    def test_registry_and_legacy_dispatch_refuse_all_file_contents_before_open(self):
        self.assertNotIn(tools.read_file, main.config.tools)
        with patch.object(Path, 'open', side_effect=AssertionError('No file may be opened')):
            for path in ('data/private.tsv', 'runs/demo/work/res/resn/signet_Afreq',
                         'runs/demo/work/res/resv/signet_edgelist_0.5.txt', '/outside/private.tsv'):
                with self.subTest(path=path):
                    result = st.dispatch_tool('read_file', {'path': path, 'max_lines': 2})
                    self.assertEqual(result['status'], 'invalid')
                    self.assertEqual(result['error_code'], 'privacy_blocked')
                    self.assertNotIn(path, str(result))
                    self.assertFalse(result['executed'])
                    with self.assertRaises(ValueError):
                        tools.read_file(path)

    def test_controlled_summary_retains_approved_counts_without_records(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary).resolve()
            path = project / 'data/PRIVATE-FILENAME.tsv'
            path.parent.mkdir()
            path.write_text('patient_id\trace\nPRIVATE-PERSON\tasian\n')
            with patch.object(tools, 'PROJECT', project):
                result = st.dispatch_tool('summarize_table', {'path': str(path)})
        self.assertEqual(result['rows'], 1)
        self.assertEqual(result['per_column']['race']['values'], {'asian': 1})
        self.assertNotIn('PRIVATE', str(result))


class SummarizeTableTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.patch = patch.object(tools, 'PROJECT', self.root)
        self.patch.start()
        (self.root / 'data').mkdir()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_counts_categories_and_hides_identifiers(self):
        rows = ['submitter_id\trace\tgender\tage']
        rows += [f'TCGA-44-{1000 + i}\t{"white" if i % 3 else ""}\t{"female" if i % 2 else "male"}\t{40 + i}' for i in range(30)]
        (self.root / 'data/clinical.tsv').write_text('\r\n'.join(rows) + '\r\n')
        result = st.dispatch_tool('summarize_table', {'path': 'data/clinical.tsv'})
        self.assertEqual((result['status'], result['rows'], result['delimiter']), ('ok', 30, 'tab'))
        self.assertEqual(result['columns'], ['submitter_id', 'race', 'gender', 'age'])
        self.assertTrue(result['windows_line_endings'])
        self.assertEqual(result['per_column']['race'], {'blank': 10, 'distinct': 1, 'values': {'white': 20}})
        self.assertEqual(result['per_column']['gender']['values'], {'female': 15, 'male': 15})
        self.assertEqual(result['per_column']['submitter_id'], {'blank': 0, 'distinct': 'more than 20'})
        self.assertNotIn('values', result['per_column']['age'], 'many distinct values are never listed')
        self.assertNotIn('TCGA-44', str(result))
        self.assertIn(tools.summarize_table, main.config.tools)

    def test_a_small_identifier_column_is_counted_but_never_listed(self):
        (self.root / 'data/few.csv').write_text('sample_id,group\nTCGA-44-0001,a\nTCGA-44-0002,b\n')
        result = tools.summarize_table('data/few.csv')
        self.assertEqual(result['per_column']['sample_id'], {'blank': 0, 'distinct': 2})
        self.assertNotIn('group', result['per_column'])
        self.assertNotIn('TCGA-44', str(result))
        for bad in ('../outside.tsv', '.env', 'data/missing.tsv'):
            self.assertEqual(st.dispatch_tool('summarize_table', {'path': bad})['status'], 'invalid', bad)


if __name__ == '__main__':
    unittest.main()
