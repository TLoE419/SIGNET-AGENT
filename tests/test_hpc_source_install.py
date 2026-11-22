import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

from agent.runtime import hpc


class SourceInstallTest(unittest.TestCase):
    """Run the actual installer against a pinned local repository, without SSH or network."""

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name).resolve()
        self.repository = self.root / 'repository'
        self.repository.mkdir()
        self.files = {'signet': b'#!/bin/bash\n', 'config.ini.default': b'[basic]\n',
                      'example/geno/example.ped': b'FAM1 IND1\n',
                      'LICENSE.txt': b'fixture\n', 'LICENSE_THIRD_PARTY.md': b'fixture\n'}
        for name, data in self.files.items():
            file = self.repository / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)
        self.git('init', '-q')
        self.git('add', '.')
        self.git('commit', '-qm', 'local fixture')
        revision = self.git('rev-parse', 'HEAD').strip()
        entry = lambda name: {'path': name, 'sha256': hashlib.sha256(self.files[name]).hexdigest()}
        self.inventory = {'repository': self.repository.as_uri(), 'revision': revision,
                          'scripts': [entry('signet')], 'support_files': [entry('config.ini.default')],
                          'example_files': [entry('example/geno/example.ped')]}
        workspace = self.root / 'workspace'
        self.source = workspace / 'software' / revision
        self.config = {'root': str(workspace), 'source': str(self.source), 'revision': revision,
                       'image': str(workspace / 'image.sif'), 'executor': '/bin/echo'}
        self.state = workspace / '.signet-agent/steps'
        # HPC3 uses GNU tools. These local stand-ins retain the used no-clobber semantics.
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        self.script(bin_dir / 'sha256sum', '#!/bin/sh\nexec shasum -a 256 "$@"\n')
        self.script(bin_dir / 'mv', '#!/bin/sh\nfor a in "$@"; do shift; [ "$a" = -T ] || set -- "$@" "$a"; done\nexec /bin/mv "$@"\n')
        self.script(bin_dir / 'setsid', '#!/bin/sh\nexec "$@"\n')
        self.env = {**os.environ, 'PATH': f'{bin_dir}:{os.environ["PATH"]}'}

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repository), '-c', 'user.name=fixture',
                                        '-c', 'user.email=fixture@example.invalid', *args], text=True)

    def script(self, path, text):
        path.write_text(text)
        path.chmod(0o700)

    def run_install(self, background=False):
        context = hpc._CONFIG.set(self.config)
        try:
            with patch.object(hpc, 'SOURCE_INVENTORY', self.inventory):
                script = hpc._signet_script(self.config['root']) if background else hpc._source_install(self.config)
        finally:
            hpc._CONFIG.reset(context)
        return subprocess.run(['bash', '-s'], input=script, capture_output=True, text=True,
                              env=self.env, timeout=10)

    def wait_for_background(self):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            text = (self.state / 'signet.status').read_text()
            if 'state=done' in text or 'state=failed' in text:
                return text
            time.sleep(0.02)
        self.fail('Local fixture installer did not finish: ' + (self.state / 'signet.log').read_text())

    def test_background_install_publishes_verified_source_once(self):
        started = self.run_install(background=True)
        self.assertEqual(started.returncode, 0, started.stderr)
        self.assertEqual(hpc._parse(started.stdout.encode())['signet'], 'started')
        self.assertIn('state=done', self.wait_for_background())
        for name, data in self.files.items():
            self.assertEqual((self.source / name).read_bytes(), data)
        (self.source / 'config.ini').write_text('user configuration\n')
        (self.source / 'notes.txt').write_text('keep\n')
        before = {str(p): p.read_bytes() for p in self.source.rglob('*') if p.is_file()}
        again = self.run_install(background=True)
        self.assertEqual(hpc._parse(again.stdout.encode())['signet'], 'existing')
        self.assertEqual({str(p): p.read_bytes() for p in self.source.rglob('*') if p.is_file()}, before)

    def test_a_running_install_is_not_started_again(self):
        self.state.mkdir(parents=True)
        self.state.joinpath('signet.status').write_text(
            f'state=running\nhost={os.uname().nodename}\npid={os.getpid()}\n')
        result = self.run_install(background=True)
        self.assertEqual(hpc._parse(result.stdout.encode())['signet'], 'in_progress')
        self.assertFalse(self.state.joinpath('signet.install').exists())

    def test_a_failed_hash_never_publishes_and_reports_failed(self):
        self.inventory['scripts'][0]['sha256'] = '0' * 64
        self.assertEqual(self.run_install(background=True).returncode, 0)
        self.assertIn('state=failed', self.wait_for_background())
        self.assertFalse(self.source.exists())
        self.assertFalse(list(self.source.parent.glob('.install-*')))

    def test_example_upgrade_preserves_existing_installation(self):
        self.source.mkdir(parents=True)
        for name in ('signet', 'config.ini.default'):
            (self.source / name).write_bytes(self.files[name])
        (self.source / 'config.ini').write_text('saved preferences\n')
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.source / 'example/geno/example.ped').read_bytes(), self.files['example/geno/example.ped'])
        self.assertEqual((self.source / 'config.ini').read_text(), 'saved preferences\n')
        (self.source / 'example/geno/example.ped').write_text('researcher edit\n')
        self.assertEqual(self.run_install().returncode, 0)
        self.assertEqual((self.source / 'example/geno/example.ped').read_text(), 'researcher edit\n')

    def test_tampered_example_is_never_added_and_source_link_is_refused(self):
        self.source.mkdir(parents=True)
        for name in ('signet', 'config.ini.default'):
            (self.source / name).write_bytes(self.files[name])
        self.inventory['example_files'][0]['sha256'] = '0' * 64
        self.assertNotEqual(self.run_install().returncode, 0)
        self.assertFalse((self.source / 'example').exists())
        original = self.source.with_name('original')
        self.source.rename(original)
        (original / 'example').mkdir()
        self.source.symlink_to(original, target_is_directory=True)
        refused = self.run_install(background=True)
        self.assertEqual(hpc._parse(refused.stdout.encode())['signet'], 'failed')
        self.assertEqual((original / 'signet').read_bytes(), self.files['signet'])


if __name__ == '__main__':
    unittest.main()
