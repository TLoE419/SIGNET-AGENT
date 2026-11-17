import http.client
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from agent.app.chat_ui import ChatServer
from agent.runtime import signet_jobs, workspace_adjustment, workspace_genotype
import agent.tools.signet as signet


class WorkspaceAdjustmentTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.project = Path(temporary.name).resolve()
        self.run_id = 'adjusted-chr1'
        self.root = self.project / 'runs' / self.run_id
        self.directory = self.root / 'work/res/resa'
        for folder in ('work/script', 'work/tmp', 'work/data', 'work/res/resa',
                       'work/res/resg', 'work/res/rest', 'logs', 'home', 'steps'):
            (self.root / folder).mkdir(parents=True, exist_ok=True)
        (self.root / 'manifest.json').write_text('{}')
        self.job = {'state': 'completed', 'step': 'adjust', 'run_id': self.run_id,
                    'options': {'npc': 2}, 'inputs': {'cli.file': '/remote/clinical.tsv'}}
        project_patch = patch.object(signet, 'PROJECT', self.project)
        history_patch = patch.object(workspace_genotype, 'run_history', return_value={'jobs': {'adjust': self.job}})
        project_patch.start()
        history_patch.start()
        self.addCleanup(project_patch.stop)
        self.addCleanup(history_patch.stop)
        self.ids = [f'TCGA-AA-A00{index}-01' for index in range(1, 5)]
        (self.directory / 'workspace-genotype-ids.txt').write_text('\n'.join(self.ids) + '\n')
        self.clinical = ('submitter_id\trace\tgender\n'
                         'TCGA-AA-A001\tasian\tfemale\n'
                         'TCGA-AA-A002\tblack or african american\tmale\n'
                         'TCGA-AA-A003\tamerican indian or alaska native\tmale\n'
                         'TCGA-AA-A004\twhite\tfemale\n'
                         'unmatched-placeholder\t\t\n')
        (self.directory / 'workspace-clinical.tsv').write_text('\ufeff' + self.clinical, encoding='utf-8')
        (self.directory / 'workspace-pca.evec').write_text(
            '#eigvals: 6 3 1\nTCGA-AA-A002 0.2 0.4 pop\n'
            'TCGA-AA-A003 0.3 0.5 pop\nTCGA-AA-A001 0.1 0.3 pop\n')
        (self.directory / 'workspace-pca.eval').write_text('6\n3\n1\n')
        outputs = {
            'signet_matched.gexp': '1 3\n3 5\n9 9\n10 10\n',
            'signet_gexp.data': '0.5 0.8\n-0.5 -0.8\n',
            'signet_gexp_rmpc.data': '0.25 0.4\n-0.25 -0.4\n',
            'signet_new.Geno': '0 1 2\n2 1 0\n1 0 1\n0 0 2\n',
            'signet_geno.data': '0 1 2\n2 1 0\n',
            'signet_new.Geno.map': '1 1 0 100\n1 2 0 200\n1 3 0 300\n',
        }
        for name, text in outputs.items():
            (self.directory / name).write_text(text)
        (self.root / 'work/res/resg/signet_Genotype.sampleID').write_text('\n'.join(self.ids + ['TCGA-AA-A005-01']) + '\n')
        (self.root / 'work/res/rest/signet_gexpID').write_text('\n'.join(self.ids + ['TCGA-AA-A006-01', 'TCGA-AA-A007-01']) + '\n')
        (self.root / 'work/res/rest/signet_gene_name').write_text('GENE1\nGENE2\n')

    def test_saved_result_uses_actual_pca_and_identically_retained_samples(self):
        with patch('agent.runtime.ssh_transport.remote', side_effect=AssertionError('Saved display must be local')):
            result = workspace_adjustment.completed_result(self.run_id)
        self.assertEqual(result['matching'], {'genotype': 5, 'expression': 6, 'matched': 4,
                                              'retained': 2, 'excluded': 2, 'variants': 3, 'genes': 2})
        self.assertEqual(result['pca'], {'points': [[0.1, 0.3], [0.2, 0.4]],
                                         'variance_explained': [60.0, 30.0], 'source': 'signet_smartpca'})
        self.assertEqual(result['npc'], 2)
        self.assertEqual(result['job']['inputs']['cli.file'], '/remote/clinical.tsv')
        self.assertAlmostEqual(result['comparison']['before_sd'], math.sqrt(2))
        self.assertAlmostEqual(result['comparison']['covariates_sd'], 0.65 * math.sqrt(2))
        self.assertAlmostEqual(result['comparison']['after_sd'], 0.325 * math.sqrt(2))

    def test_missing_provenance_or_misaligned_rows_are_rejected(self):
        path = self.directory / 'workspace-pca.evec'
        original = path.read_text()
        path.unlink()
        with self.assertRaises(OSError):
            workspace_adjustment.completed_result(self.run_id)
        path.write_text(original)
        (self.directory / 'signet_geno.data').write_text('2 1 0\n0 1 2\n')
        with self.assertRaises(ValueError):
            workspace_adjustment.completed_result(self.run_id)
        (self.directory / 'signet_geno.data').write_text('0 1 2\n2 1 0\n')
        (self.directory / 'workspace-pca.eval').write_text('nan\n3\n1\n')
        with self.assertRaises(ValueError):
            workspace_adjustment.completed_result(self.run_id)

    def test_live_route_keeps_authentication_and_saved_option_snapshot(self):
        server = ChatServer(('127.0.0.1', 0), Mock())
        self.addCleanup(server.server_close)
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 3)
        self.addCleanup(server.shutdown)

        def request(query, authenticated=True):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
            try:
                connection.request('GET', '/stage3/results' + query,
                                   headers={'X-Chat-Token': server.token} if authenticated else {})
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()

        query = f'?run={self.run_id}&source=live'
        self.assertEqual(request(query, False)[0], 403)
        self.assertEqual(request(query + '&source=live')[0], 400)
        status, result = request(query)
        self.assertEqual((status, result['npc']), (200, 2))
        self.job['state'] = 'running'
        self.assertEqual(request(query)[0], 404)

    def test_adjust_script_freezes_clinical_and_records_collection_failures(self):
        clinical = self.project / 'clinical.tsv'
        clinical.write_text(self.clinical)
        frozen = self.directory / 'workspace-clinical.tsv'
        config = self.root / 'work/config.ini'
        config.write_text(f'cli.file = {clinical}\nforcerm = F\nncore_local = 1\n')
        fake = self.project / 'fake-container'
        fake.write_text('#!/bin/bash\n'
                        'mkdir -p tmp/tmpa tmp/tmpg\n'
                        'printf "TCGA-AA-A001-01\\n" > tmp/tmpg/geno_id\n'
                        'printf "TCGA-AA-A001 1 2 pop\\n" > tmp/tmpa/Geno.pca.evec\n'
                        'printf "2\\n1\\n" > tmp/tmpa/Geno.eval\n')
        fake.chmod(0o700)
        settings = {'cli.file': str(clinical)}
        runtime = {'executor': str(fake), 'image': str(self.project / 'image.sif')}
        script = signet_jobs._job_script(runtime, self.run_id, 'adjust', signet_jobs.STEPS['adjust'],
                                        str(self.root), (), {'npc': 2}, settings)
        # The production job uses Linux sed; this shell check also runs on macOS hosts.
        if sys.platform == 'darwin':
            script = script.replace('sed -i ', 'sed -i "" ')
        result = subprocess.run(['bash'], input=script, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(frozen.read_text(), self.clinical)
        self.assertIn(f'cli.file = {frozen}', config.read_text())
        self.assertTrue((self.root / 'steps/adjust.done').read_text().startswith('0 '))
        self.assertEqual((self.directory / 'workspace-pca.eval').read_text(), '2\n1\n')

        clinical.unlink()
        result = subprocess.run(['bash'], input=script, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / 'steps/adjust.done').read_text().startswith('0 '),
                         'A failed input snapshot must reach the recorded exit marker')

        clinical.write_text(self.clinical)
        fake.write_text('#!/bin/bash\nexit 0\n')
        (self.root / 'work/tmp/tmpa/Geno.pca.evec').unlink()
        result = subprocess.run(['bash'], input=script, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / 'steps/adjust.done').read_text().startswith('0 '),
                         'A failed provenance collection must reach the recorded exit marker')


if __name__ == '__main__':
    unittest.main()
