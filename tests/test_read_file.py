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


if __name__ == '__main__':
    unittest.main()
