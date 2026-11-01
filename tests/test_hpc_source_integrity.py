import hashlib
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from agent.runtime import hpc


class SourceIntegrityTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / 'software' / 'pinned'
        self.source.mkdir(parents=True)
        self.files = {'signet': b'#!/bin/bash\necho settings\n', 'config.ini.default': b'[basic]\ncohort = TCGA\n'}
        for name, data in self.files.items():
            (self.source / name).write_bytes(data)
        self.inventory = {'revision': 'a' * 40, 'scripts': [{'path': 'signet', 'sha256': hashlib.sha256(self.files['signet']).hexdigest()}],
                          'support_files': [{'path': 'config.ini.default', 'sha256': hashlib.sha256(self.files['config.ini.default']).hexdigest()}]}
        self.config = {'root': str(self.root), 'source': str(self.source), 'image': str(self.root / 'image.sif'),
                       'executor': '/bin/echo', 'partition': 'test', 'revision': self.inventory['revision']}

    def check(self):
        before = {str(p.relative_to(self.root)): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in self.root.rglob('*') if p.is_file()}
        token = hpc._CONFIG.set(self.config)
        try:
            with patch.object(hpc, 'SOURCE_INVENTORY', self.inventory):
                result = subprocess.run(['bash', '-s'], input=hpc._check_script(str(self.root)), text=True, capture_output=True)
        finally:
            hpc._CONFIG.reset(token)
        self.assertEqual(result.returncode, 0, result.stderr)
        values = hpc._parse(result.stdout.encode())
        item = next(c for c in hpc._checks(values, self.inventory['revision']) if c['item'] == 'signet_source')
        after = {str(p.relative_to(self.root)): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)
        return item

    def test_hash_audited_archive_without_git_is_ready(self):
        self.assertFalse((self.source / '.git').exists())
        result = self.check()
        self.assertEqual(result['status'], 'ok', result)
        self.assertIn('hash', result['detail'].lower())

    def test_missing_or_modified_audited_files_fail(self):
        for name in self.files:
            with self.subTest(file=name, case='modified'):
                (self.source / name).write_bytes(b'modified\n')
                self.assertEqual(self.check()['status'], 'problem')
            with self.subTest(file=name, case='missing'):
                (self.source / name).unlink()
                self.assertEqual(self.check()['status'], 'problem')
            (self.source / name).write_bytes(self.files[name])

    def test_git_metadata_cannot_override_a_hash_failure(self):
        (self.source / '.git').mkdir()
        (self.source / 'signet').write_bytes(b'modified\n')
        self.assertEqual(self.check()['status'], 'problem')

    def test_existing_user_config_and_untracked_files_are_preserved(self):
        (self.source / 'config.ini').write_text('user settings\n')
        (self.source / 'notes.txt').write_text('keep this\n')
        self.assertEqual(self.check()['status'], 'ok')

    def test_missing_source_is_missing(self):
        self.config['source'] = str(self.root / 'absent')
        self.assertEqual(self.check()['status'], 'missing')

    def test_source_link_is_rejected_without_modifying_its_target(self):
        link = self.root / 'linked-source'
        link.symlink_to(self.source, target_is_directory=True)
        self.config['source'] = str(link)
        self.assertEqual(self.check()['status'], 'problem')

    def test_desktop_revision_must_match_the_audited_manifest(self):
        self.config['revision'] = 'b' * 40
        token = hpc._CONFIG.set(self.config)
        try:
            with patch.object(hpc, 'SOURCE_INVENTORY', self.inventory):
                with self.assertRaisesRegex(ValueError, 'revision'):
                    hpc._check_script(str(self.root))
        finally:
            hpc._CONFIG.reset(token)

    def test_unknown_integrity_result_cannot_be_reported_ready(self):
        result = next(c for c in hpc._checks({'signet': 'yes'}, self.inventory['revision']) if c['item'] == 'signet_source')
        self.assertEqual(result['status'], 'problem')


if __name__ == '__main__':
    unittest.main()
