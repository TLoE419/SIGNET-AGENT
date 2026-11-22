"""Run read-only Data browsing and inspection through a local fixture shell."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from agent.runtime import hpc, hpc_files, ssh_transport
from agent.tools.hpc import REVISION


class HpcFilesTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(os.path.realpath(temporary.name))
        self.root = self.base / 'install'
        self.config = {'root': str(self.root), 'source': f'{self.root}/software/{REVISION}',
                       'image': f'{self.root}/images/s.sif', 'workRoot': f'{self.root}/runs',
                       'executor': '', 'partition': 'lab_queue', 'revision': REVISION}
        self.scripts = []
        # Treat the test directory as shared storage, even when CI creates it under /tmp.
        # The node-local rejection test supplies its own blocked directory.
        for patcher in (patch.object(ssh_transport, 'available', return_value=True),
                        patch.object(hpc_files, '_UNREADABLE_ON_COMPUTE', (str(self.base / 'node-local'),)),
                        patch.object(ssh_transport, 'setup_environment', side_effect=lambda: self.config),
                        patch.object(ssh_transport, 'remote', side_effect=self.run_remote)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_remote(self, command, input=b'', capture_output=True, timeout=None):
        self.scripts.append(input.decode())
        return subprocess.run(['bash', '-s'], input=input, capture_output=True, timeout=30)

    def file(self, name, text='content\n'):
        path = self.base / 'data' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return str(path)

    def test_listing_hides_dotfiles_and_marks_names_scripts_cannot_handle(self):
        self.file('good.gtf')
        self.file('has space.gtf')
        self.file('.hidden')
        (self.base / 'data' / 'folder').mkdir()
        result = hpc_files.list_folder(str(self.base / 'data'))
        self.assertEqual(result['status'], 'ok')
        entries = {entry['name']: entry for entry in result['entries']}
        self.assertEqual(set(entries), {'good.gtf', 'has space.gtf', 'folder'})
        self.assertEqual((entries['folder']['kind'], entries['good.gtf']['size']), ('folder', 8))
        self.assertTrue(entries['good.gtf']['supported'])
        self.assertFalse(entries['has space.gtf']['supported'])

    def test_listing_reads_no_file_contents(self):
        path = self.file('secret.txt', 'participant-1234\n')
        self.assertNotIn('participant-1234', json.dumps(hpc_files.list_folder(os.path.dirname(path))))

    def test_unsafe_paths_never_reach_hpc3(self):
        for path in ('relative/x', '/a/../b', '/a b', '/a;rm', '', None, 7):
            with self.subTest(path=path):
                self.assertEqual(hpc_files.list_folder(path)['status'], 'invalid')
                self.assertEqual(hpc_files.inspect([path])['status'], 'invalid')
        self.assertEqual(self.scripts, [])

    def test_missing_and_folder_paths_are_explained(self):
        self.assertEqual(hpc_files.list_folder(str(self.base / 'nope'))['status'], 'failed')
        path = self.file('x.gtf')
        result = hpc_files.list_folder(path)
        self.assertEqual((result['status'], result['kind'], result['path']), ('ok', 'file', path))
        self.assertEqual(hpc_files.inspect([os.path.dirname(path)])['status'], 'invalid')

    def test_shortcuts_list_only_lab_spaces_of_the_account(self):
        dfs = self.base / 'dfs7'
        crsp = self.base / 'crsp'
        for folder in (dfs / 'mylab', dfs / 'pub', crsp / 'lab' / 'pi', crsp / 'home'):
            folder.mkdir(parents=True)
        script = hpc._prelude('/x') + hpc_files._shortcuts_script(str(self.base / 'dfs[0-9]*'), str(crsp))
        output = self.run_remote('bash -s', script.encode()).stdout.decode()
        line = next(item for item in output.splitlines() if item.startswith('@@result'))
        labels = {place['label'] for place in json.loads(line.split('\t', 1)[1])['shortcuts']}
        self.assertIn('Home', labels)
        self.assertIn('Lab: mylab', labels)
        self.assertIn('CRSP lab: pi', labels)
        self.assertFalse(any('pub' in label and label.startswith('Lab') for label in labels))

    def test_inspection_resolves_canonical_paths_without_contents_or_setup_writes(self):
        path = Path(self.file('input.tsv', 'participant-1234\n'))
        alias = path.with_name('alias.tsv')
        alias.symlink_to(path)
        result = hpc_files.inspect([str(alias)])
        self.assertEqual(result, {'status': 'ok', 'executed': False, 'read_only': True,
                                  'files': [{'path': str(path), 'size': path.stat().st_size}]})
        self.assertNotIn('participant-1234', json.dumps(result))
        for mutation in ('sbatch ', 'mkdir ', 'curl ', 'rm '):
            self.assertNotIn(mutation, self.scripts[0])
        self.assertFalse(self.root.exists())
        duplicate = hpc_files.inspect([str(path), str(alias)])
        self.assertEqual(duplicate['status'], 'invalid')

    def test_inspection_rejects_empty_and_node_local_files(self):
        empty = self.file('empty.tsv', '')
        self.assertEqual(hpc_files.inspect([empty])['status'], 'invalid')
        local = self.base / 'node-local'
        local.mkdir()
        path = local / 'hidden.tsv'
        path.write_text('local content\n')
        self.assertIn('Compute nodes', hpc_files.inspect([str(path)])['error'])

    def test_not_a_model_tool(self):
        from agent.tools.hpc import HPC_TOOLS
        self.assertFalse([tool.__name__ for tool in HPC_TOOLS if 'select' in tool.__name__ or 'list' in tool.__name__])


if __name__ == '__main__':
    unittest.main()
