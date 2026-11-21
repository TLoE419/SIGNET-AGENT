"""The SIGNET source installation run by the Python service on HPC3, against a real local Git repository."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from agent.runtime import hpc

GIT = ['git', '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main']
# HPC3 has GNU coreutils and util-linux; these stand-ins give macOS the same behavior.
DARWIN_TOOLS = {
    'mv': '#!/bin/sh\nfor a in "$@"; do shift; [ "$a" = -T ] || set -- "$@" "$a"; done\nexec /bin/mv "$@"\n',
    'sha256sum': '#!/bin/sh\nexec shasum -a 256 "$@"\n',
    'setsid': '#!/bin/sh\nexec "$@"\n',
}


class SourceInstallTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        base = Path(temp.name).resolve()
        repo = base / 'upstream'
        files = {'signet': b'#!/bin/bash\necho settings\n', 'config.ini.default': b'[basic]\ncohort = TCGA\n',
                 'example/geno/example.ped': b'FAM1 IND1 0 0 1 -9 A G\n', 'LICENSE.txt': b'license\n',
                 'LICENSE_THIRD_PARTY.md': b'third party\n', 'notes/development.txt': b'not audited\n'}
        for name, data in files.items():
            (repo / name).parent.mkdir(parents=True, exist_ok=True)
            (repo / name).write_bytes(data)
        git = lambda *args: subprocess.run([*GIT, '-C', str(repo), *args], check=True, capture_output=True, text=True).stdout
        git('init', '-q')
        git('add', '.')
        git('commit', '-qm', 'fixture')
        git('config', 'uploadpack.allowAnySHA1InWant', 'true')
        digest = lambda name: hashlib.sha256(files[name]).hexdigest()
        self.inventory = {'repository': f'file://{repo}', 'revision': git('rev-parse', 'HEAD').strip(),
                          'scripts': [{'path': 'signet', 'sha256': digest('signet')}],
                          'support_files': [{'path': 'config.ini.default', 'sha256': digest('config.ini.default')}],
                          'example_files': [{'path': 'example/geno/example.ped', 'sha256': digest('example/geno/example.ped')}]}
        self.root = base / 'signet-agent'
        self.source = self.root / 'software' / self.inventory['revision']
        self.config = {'root': str(self.root), 'source': str(self.source), 'image': str(self.root / 'images/s.sif'),
                       'executor': '', 'workRoot': str(self.root / 'runs'), 'partition': 'free',
                       'revision': self.inventory['revision']}
        bin_dir = base / 'bin'
        bin_dir.mkdir()
        for name, text in (DARWIN_TOOLS.items() if sys.platform == 'darwin' else ()):
            (bin_dir / name).write_text(text)
            (bin_dir / name).chmod(0o755)
        self.home = base / 'home'
        self.home.mkdir()
        self.env = {**os.environ, 'PATH': f'{bin_dir}:{os.environ["PATH"]}', 'HOME': str(self.home)}
        patcher = patch.object(hpc, 'SOURCE_INVENTORY', self.inventory)
        patcher.start()
        self.addCleanup(patcher.stop)

    def bash(self, script):
        return subprocess.run(['bash', '-s'], input=script, text=True, capture_output=True, env=self.env)

    def install(self):
        return self.bash(hpc._source_install(self.config))

    def start(self):
        token = hpc._CONFIG.set(self.config)
        try:
            script = hpc._signet_script(str(self.root))
        finally:
            hpc._CONFIG.reset(token)
        done = self.bash(script)
        self.assertEqual(done.returncode, 0, done.stderr)
        return hpc._parse(done.stdout.encode())

    def test_fresh_installation_publishes_only_audited_files_with_the_example_data(self):
        done = self.install()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual((self.source / 'example/geno/example.ped').read_text(), 'FAM1 IND1 0 0 1 -9 A G\n')
        self.assertTrue((self.source / 'LICENSE.txt').is_file())
        self.assertFalse((self.source / 'notes').exists(), 'files outside the audited inventory are not installed')
        self.assertFalse(list((self.root / 'software').glob('.install-*')), 'the staging folder is removed')
        again = self.install()
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn('already installed', again.stdout)

    def test_an_older_installation_gains_only_the_example_data(self):
        self.source.mkdir(parents=True)
        (self.source / 'signet').write_text('#!/bin/bash\necho settings\n')
        (self.source / 'config.ini.default').write_text('[basic]\ncohort = TCGA\n')
        (self.source / 'config.ini').write_text('user settings\n')
        done = self.install()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue((self.source / 'example/geno/example.ped').is_file())
        self.assertEqual((self.source / 'config.ini').read_text(), 'user settings\n', 'nothing already there changes')

    def test_a_hash_mismatch_publishes_nothing(self):
        self.inventory['scripts'] = [{'path': 'signet', 'sha256': '0' * 64}]
        self.assertNotEqual(self.install().returncode, 0)
        self.assertFalse(self.source.exists(), 'unverified files are never published')
        self.assertFalse(list((self.root / 'software').glob('.install-*')))

    def test_the_step_runs_in_the_background_and_reports_its_state(self):
        started = self.start()
        self.assertEqual(started['signet'], 'started')
        state = self.root / '.signet-agent/steps/signet.status'
        for _ in range(100):
            if 'state=done' in state.read_text() or 'state=failed' in state.read_text():
                break
            time.sleep(0.1)
        log = (self.root / '.signet-agent/steps/signet.log').read_text()
        self.assertIn('state=done', state.read_text(), log)
        self.assertIn('Installed and verified SIGNET', log)
        self.assertTrue((self.source / 'example').is_dir())
        self.assertEqual(self.start()['signet'], 'existing')

    def test_a_running_installation_is_not_started_twice(self):
        steps = self.root / '.signet-agent/steps'
        steps.mkdir(parents=True)
        sleeper = subprocess.Popen(['sleep', '30'])
        self.addCleanup(sleeper.kill)
        host = subprocess.run(['hostname'], capture_output=True, text=True).stdout.strip()
        (steps / 'signet.status').write_text(f'state=running\nhost={host}\npid={sleeper.pid}\n')
        self.assertEqual(self.start()['signet'], 'in_progress')
        sleeper.kill()
        sleeper.wait()
        self.assertEqual(self.start()['signet'], 'started', 'a stopped installation can be started again')


if __name__ == '__main__':
    unittest.main()
