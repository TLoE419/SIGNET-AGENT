import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import signet_runtime as rt
import signet_tools as st


def archive_of(files):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


class RuntimeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name).resolve()
        self.patch = patch.object(st, 'PROJECT', self.project)
        self.patch.start()
        (self.project / 'data').mkdir()
        st.configure_signet('fixture')
        self.root = self.project / 'runs/fixture'
        self.values = {}
        for key in rt.INPUT_KEYS:
            path = self.project / 'data' / key
            path.write_text('fixture\n')
            self.values[key] = str(path)
        st._update(self.root, self.values)

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_bundle_limits_upload_and_maps_paths(self):
        (self.project / '.env').write_text('PRIVATE_SECRET')
        with tarfile.open(fileobj=io.BytesIO(rt.bundle(self.root, st._settings(self.root), '/tmp/signet-agent/fixture'))) as archive:
            names = archive.getnames()
            self.assertFalse(any('.env' in name or 'manifest' in name for name in names))
            self.assertEqual(sum(name.startswith('inputs/') for name in names), 6)
            config = archive.extractfile('work/config.ini').read().decode()
            self.assertNotIn(str(self.project), config)
            self.assertIn('matched.gexp = /tmp/signet-agent/fixture/inputs/0', config)
        self.assertIn('StrictHostKeyChecking=yes', rt.ssh_args())

    def test_unavailable_never_uploads_or_marks_attempt(self):
        with patch.object(rt, 'preflight', return_value=False), patch.object(rt, 'remote') as remote:
            result = rt.execute_cis(self.root, st._settings(self.root))
            self.assertEqual(result['status'], 'unavailable')
            self.assertFalse(result['executed'])
            remote.assert_not_called()
        self.assertFalse((self.root / 'cis_eqtl.json').exists())

    def test_real_tool_routes_mac_stage_four_only(self):
        f = next(iter(self.values.values()))
        with patch.object(st.sys, 'platform', 'darwin'), patch.object(rt, 'execute_cis', return_value={'status': 'fixture'}) as execute:
            result = st.dispatch_tool('cis_eqtl', dict(run_id='fixture', expression=f, expression_with_pc=f,
                genotype=f, snp_map=f, snp_maf=f, gene_positions=f))
            self.assertEqual(result['status'], 'fixture')
            self.assertEqual(execute.call_args.args[1]['alpha.cis'], '0.05')
        self.assertFalse((self.root / '.active').exists())

    def test_execution_retrieves_evidence_and_does_not_trust_exit_zero(self):
        returned = archive_of({'work/res/resc/partial': b'partial'})
        responses = [subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0),
                     subprocess.CompletedProcess([], 0, stdout=returned)]
        with patch.object(rt, 'preflight', return_value=True), patch.object(rt, 'remote', side_effect=responses) as remote:
            result = rt.execute_cis(self.root, st._settings(self.root))
        self.assertEqual(result['status'], 'failed')
        self.assertTrue(result['executed'])
        self.assertEqual(len(result['missing_required_outputs']), 5)
        self.assertIn('work/res/resc/partial', result['output_files'])
        self.assertIn('timeout -k 5 1800s', remote.call_args_list[1].args[0])
        self.assertIn('OPENBLAS_NUM_THREADS=1', remote.call_args_list[1].args[0])
        self.assertEqual(json.loads((self.root / 'cis_eqtl.json').read_text())['status'], 'failed')

    def test_transport_failure_records_unknown_to_prevent_replay(self):
        with patch.object(rt, 'preflight', return_value=True), patch.object(rt, 'remote', side_effect=[
                subprocess.CompletedProcess([], 0), subprocess.TimeoutExpired('ssh', 330)]):
            result = rt.execute_cis(self.root, st._settings(self.root))
        self.assertEqual(result['executed'], 'unknown')
        self.assertTrue((self.root / 'cis_eqtl.json').exists())

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
