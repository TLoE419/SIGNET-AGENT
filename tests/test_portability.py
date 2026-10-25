"""Portable configuration and source installation checks; no real credentials or datasets."""
import hashlib
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import signet_tools as st
import signet_runtime as runtime
from scripts import setup_source


class PortabilityTest(unittest.TestCase):
    def test_missing_source_returns_actionable_error_without_creating_run(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(st, 'PROJECT', Path(folder)), \
                patch.dict(os.environ, {'SIGNET_SOURCE': 'missing'}):
            result = st.configure_signet('new')
            self.assertEqual(result['status'], 'invalid')
            self.assertIn('scripts/setup_source.py', result['error'])
            self.assertFalse((Path(folder) / 'runs').exists())

    def test_paths_are_resolved_from_project_and_settings_apply_after_import(self):
        with patch.dict(os.environ, {'SIGNET_SOURCE': 'local/source',
                                    'SIGNET_RUNTIME_PROJECT': 'local/runtime', 'SIGNET_SSH_PORT': '2230'}):
            self.assertEqual(st.source_path(), (st.PROJECT / 'local/source').resolve())
            self.assertEqual(runtime.host_project(), (runtime.PROJECT / 'local/runtime').resolve())
            args = runtime.ssh_args()
            self.assertEqual(args[args.index('-p') + 1], '2230')
            self.assertIn('StrictHostKeyChecking=yes', args)

    def test_invalid_runtime_settings_are_rejected_before_connection(self):
        for port in ('0', '65536', '22;id', '-1', '１２'):
            with self.subTest(port=port), patch.dict(os.environ, {'SIGNET_SSH_PORT': port}):
                with self.assertRaises(ValueError):
                    runtime.ssh_args()
        for image in ('relative.sif', '/image;id', '/a/../image.sif', '/a b.sif'):
            with self.subTest(image=image), patch.dict(os.environ, {'SIGNET_CONTAINER_IMAGE': image}):
                with self.assertRaises(ValueError):
                    runtime.image_path()
        with patch.dict(os.environ, {'SIGNET_CONTAINER_IMAGE': '/runtime/images/signet.sif'}):
            self.assertEqual(runtime.image_path(), '/runtime/images/signet.sif')


class SourceSetupTest(unittest.TestCase):
    def archive(self, files):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as archive:
            for name, data in files.items():
                info = tarfile.TarInfo(name)
                info.size, info.mode = len(data), 0o755
                archive.addfile(info, io.BytesIO(data))
        return buffer.getvalue()

    def install(self, destination, files):
        data = b'audited code\n'
        inventory = {'scripts': [{'path': 'signet', 'sha256': hashlib.sha256(data).hexdigest()}],
                     'support_files': [], 'revision': 'fixed-commit', 'repository': 'unused'}
        with patch.object(setup_source, 'INVENTORY', inventory), patch.object(setup_source, 'LICENSES', ('LICENSE.txt',)), \
                patch.object(setup_source.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, self.archive(files))) as run:
            result = setup_source.install(destination, checkout=destination.parent)
            self.assertEqual(run.call_args.args[0][3:5], ['archive', 'fixed-commit'])
            return result

    def test_install_has_only_selected_code_and_license(self):
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder) / 'source'
            self.install(destination, {'signet': b'audited code\n', 'LICENSE.txt': b'license'})
            self.assertEqual(sorted(p.name for p in destination.iterdir()), ['LICENSE.txt', 'signet'])
            with self.assertRaisesRegex(ValueError, 'already exists'):
                self.install(destination, {})
            self.assertEqual((destination / 'signet').read_bytes(), b'audited code\n')

    def test_hash_mismatch_missing_code_and_unexpected_data_do_not_install(self):
        cases = [
            {'signet': b'changed', 'LICENSE.txt': b'license'},
            {'LICENSE.txt': b'license'},
            {'signet': b'audited code\n', 'LICENSE.txt': b'license', 'data/secret': b'private'},
            {'../escape': b'private'},
        ]
        for files in cases:
            with self.subTest(files=list(files)), tempfile.TemporaryDirectory() as folder:
                destination = Path(folder) / 'source'
                with self.assertRaises(ValueError):
                    self.install(destination, files)
                self.assertFalse(destination.exists())
                self.assertEqual(list(Path(folder).iterdir()), [])
