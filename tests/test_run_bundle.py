"""The run folder uploaded to HPC3 and the results downloaded back (agent.runtime.remote)."""
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import agent.runtime.remote as rt
from agent.runtime import ssh_transport
import agent.tools.signet as st


def archive_of(files):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


class BundleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name).resolve()
        self.patch = patch.object(st, 'PROJECT', self.project)
        self.patch.start()
        (self.project / 'data').mkdir()
        st.configure_signet('fixture')
        self.root = self.project / 'runs/fixture'

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_bundle_holds_only_the_scripts_and_config_with_hpc3_paths(self):
        (self.project / '.env').write_text('PRIVATE_SECRET')
        with patch.object(ssh_transport, 'available', return_value=False):
            data = rt.bundle(self.root, st._settings(self.root), '/pub/u/runs/fixture')
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            names = archive.getnames()
            self.assertFalse(any('.env' in name or 'manifest' in name or name.startswith('inputs') for name in names))
            self.assertIn('work/signet', names)
            config = archive.extractfile('work/config.ini').read().decode()
            self.assertNotIn(str(self.project), config)
            self.assertIn('/pub/u/runs/fixture/work', config)

    def test_uploaded_runtime_wrapper_reloads_module_in_clean_worker_environment(self):
        runtime_bin = self.project / 'container'
        runtime_bin.write_text('#!/bin/bash\n[ "${MODULE_FIXTURE:-}" = loaded ] || exit 73\n[ -n "${USER:-}" ] || exit 74\nprintf "%s" "$1"\n')
        runtime_bin.chmod(0o700)
        init = self.project / 'module-init.sh'
        init.write_text('module(){ export MODULE_FIXTURE=loaded; }\n')
        runtime = {'executor': str(runtime_bin), 'partition': 'standard', 'runtimeModule': 'singularity/3.9.4'}
        with patch.object(ssh_transport, 'available', return_value=True), \
                patch.object(ssh_transport, 'environment', return_value=runtime):
            data = rt.bundle(self.root, st._settings(self.root), '/tmp/fixture')
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            self.assertEqual(json.load(archive.extractfile('runtime.json'))['runtimeModule'], 'singularity/3.9.4')
            script = archive.extractfile('work/bin/singularity').read()
        wrapper = self.project / 'uploaded-wrapper'
        wrapper.write_bytes(script)
        wrapper.chmod(0o700)
        for _ in range(2):
            result = subprocess.run([str(wrapper), 'module-ready'], capture_output=True,
                env={'PATH': '/usr/bin:/bin', 'HOME': str(self.project), 'BASH_ENV': str(init)})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, b'module-ready')

    def test_output_paths_symlinks_and_overwrite_are_rejected(self):
        for name in ['../escape', '/tmp/escape', 'work/config.ini', 'work/res/../../escape']:
            with self.assertRaises(ValueError):
                rt.restore_outputs(self.root, archive_of({name: b'bad'}))
        target = self.root / 'work/res/safe'
        target.write_text('original')
        with self.assertRaises(ValueError):
            rt.restore_outputs(self.root, archive_of({'work/res/safe': b'changed'}))
        self.assertEqual(target.read_text(), 'original')
        (self.root / 'work/res/link').symlink_to(self.project / 'data')
        with self.assertRaises(ValueError):
            rt.restore_outputs(self.root, archive_of({'work/res/link/secret': b'bad'}))


if __name__ == '__main__':
    unittest.main()
