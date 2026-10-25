import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import signet_tools as st
import visualization_runtime as vr


class VisualizationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name).resolve()
        self.patcher = patch.object(st, 'PROJECT', self.project)
        self.patcher.start()
        data = self.project / 'data'
        data.mkdir()
        self.a, self.c, self.g = [data / name for name in ('freq', 'coef', 'genes')]
        self.a.write_text('0,1\n1,0\n')
        self.c.write_text('0 0.5\n-0.2 0\n')
        self.g.write_text('A chr1 1 2\nB chr1 3 4\n')
        st.configure_signet('fixture')
        self.root = self.project / 'runs/fixture'
        st._update(self.root, {'Afreq': str(self.a), 'coef': str(self.c), 'vis.genepos': str(self.g), 'freq':'1','ntop':'1'})
        self.settings = st._settings(self.root)

    def tearDown(self):
        self.patcher.stop()
        self.temp.cleanup()

    def test_rejects_mismatch_nan_range_and_empty_network(self):
        self.assertEqual(vr.validate_inputs(self.settings)['edges_at_threshold'], 2)
        for bad in ['0,1,2\n1,0,2\n', '0,nan\n1,0\n', '0,2\n1,0\n', '0,0\n0,0\n']:
            self.a.write_text(bad)
            with self.assertRaises(ValueError):
                vr.validate_inputs(self.settings)

    def test_official_rectangular_matrix_contract(self):
        self.g.write_text('A chr1 1 2\nB chr1 3 4\nC chr1 5 6\n')
        self.a.write_text('0,1\n1,0\n1,0\n')
        self.c.write_text('0 0.5\n-0.2 0\n0.3 0\n')
        self.assertEqual(vr.validate_inputs(self.settings)['genes'], 3)

    def test_headless_bundle_changes_deployment_only(self):
        data = vr.bundle(self.root, self.settings, '/tmp/fixture')
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            script = archive.extractfile('work/script/netvis/netshiny.R').read()
            self.assertTrue(script.endswith(b'cat("SIGNET_STAGE6_EXPORTS_COMPLETED\\n")\n'))
            self.assertIn('Afreq = /tmp/fixture/inputs/0', archive.extractfile('work/config.ini').read().decode())
        self.assertNotIn('SIGNET_STAGE6_EXPORTS_COMPLETED', (self.root/'work/script/netvis/netshiny.R').read_text())

    def test_exit_zero_without_exports_is_failure_and_record_blocks_replay(self):
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode='w:gz'):
            pass
        replies = [subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0),
                   subprocess.CompletedProcess([], 0, stdout=archive.getvalue())]
        with patch.object(vr, 'preflight', return_value=True), patch.object(vr.vm, 'remote', side_effect=replies):
            result = st.dispatch_tool('run_visualization', dict(run_id='fixture', frequencies=str(self.a),
                  coefficients=str(self.c), gene_positions=str(self.g), frequency=1, top_networks=1))
        self.assertEqual(result['status'], 'failed')
        self.assertGreater(len(result['missing_required_outputs']), 0)
        result = st.dispatch_tool('run_visualization', dict(run_id='fixture', frequencies=str(self.a),
                  coefficients=str(self.c), gene_positions=str(self.g), frequency=1, top_networks=1))
        self.assertEqual(result['status'], 'invalid')
        self.assertFalse((self.root/'.active').exists())

    def test_verification_normalizes_newline_and_checks_local_html_assets(self):
        self.root.joinpath('logs/visualization.stdout').write_text('SIGNET_STAGE6_EXPORTS_COMPLETED')
        self.root.joinpath('logs/visualization.stderr').write_text('')
        folder = self.root/'work/res/resv'
        for name in ['signet_count_vs_freq.pdf', 'signet_circular_top1_freq\n1.pdf']:
            (folder/name).write_bytes(b'%PDF-1.4 fixture')
        (folder/'signet_count_vs_freq.eps').write_text('%!PS')
        (folder/'signet_edgelist_1.txt').write_text('source_gene_symbol,target_gene_symbol\nA,B\nB,A\n')
        (folder/'signet_top1_freq1.html').write_text('<script src="widget.js"></script>visNetwork')
        (folder/'widget.js').write_text('fixture')
        for name in ['signet_top1_freq1_name.txt','signet_enrich_KEGG_info_top1_freq1.txt','signet_enrich_Process_info_top1_freq1.txt']:
            (folder/name).write_text('fixture')
        validation = vr.validate_inputs(self.settings)
        result = vr.verify_exports(self.root,self.settings,validation,0)
        self.assertEqual(result['status'],'verified_completed')
        self.assertEqual(len(result['normalized_output_filenames']),1)
        (folder/'widget.js').unlink()
        self.assertEqual(vr.verify_exports(self.root,self.settings,validation,0)['status'],'failed')

    def test_preflight_failure_does_not_start_execution(self):
        with patch.object(vr, 'preflight', return_value=False), patch.object(vr.vm, 'remote') as remote:
            result = vr.execute(self.root,self.settings)
        self.assertEqual(result['status'], 'unavailable')
        remote.assert_not_called()
        self.assertFalse((self.root/'visualization.json').exists())

if __name__ == '__main__':
    unittest.main()
