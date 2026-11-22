import base64
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zlib

from agent.runtime import signet_jobs as jobs, ssh_transport, workspace_projection as projection
import agent.tools.signet as signet


class WorkspaceProjectionTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.project = self.base / 'desktop'
        self.run_id = 'projection-fixture'
        self.root = self.project / 'runs' / self.run_id
        self.remote = self.base / 'hpc/runs' / self.run_id
        for folder in ('work/script', 'work/tmp', 'work/data', 'work/res', 'logs', 'home', 'steps'):
            (self.root / folder).mkdir(parents=True, exist_ok=True)
        (self.root / 'manifest.json').write_text('{}')
        (self.remote / 'steps').mkdir(parents=True)
        (self.remote / 'work').mkdir()
        (self.remote / '.owner').write_text('fixture-owner')
        (self.root / 'steps/remote.owner').write_text(json.dumps({'remote_dir': str(self.remote), 'token': 'fixture-owner'}))
        self.config = {'root': str(self.base / 'hpc'), 'workRoot': str(self.remote.parent),
                       'image': str(self.base / 'hpc/image.sif'), 'source': str(self.base / 'hpc/source'),
                       'executor': '/bin/echo', 'partition': 'fixture'}
        self.calls = []
        for mocked in (patch.object(signet, 'PROJECT', self.project),
                       patch.object(jobs, '_environment', return_value=self.config),
                       patch.object(ssh_transport, 'remote', side_effect=self.execute)):
            mocked.start()
            self.addCleanup(mocked.stop)


    def execute(self, command, **kwargs):
        self.assertEqual(command, 'bash -s')
        self.calls.append(kwargs['input'].decode())
        return subprocess.run(['bash', '-s'], input=kwargs['input'], capture_output=True, timeout=10)


    def place(self, relative, text):
        path = self.remote / 'work' / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path


    def record(self, stage, **changes):
        step = projection.STEPS[stage]
        value = {'step': step, 'run_id': self.run_id, 'state': 'completed', 'job_id': '12345', 'attempt': 1,
                 'remote_dir': str(self.remote), 'image': self.config['image'], 'partition': 'fixture',
                 'settings': {'alpha.cis': '0.05'}, 'options': {'npc': 2}, **changes}
        for name in ['workspace-genotype.json'] + ([] if stage == 1 else
                ['workspace-expression.json' if stage == 2 else 'workspace-adjust.json']):
            (self.root / name).write_text(json.dumps({'run_id': self.run_id, 'dataset_id': 'example-chr1'}))
        path = self.root / 'steps' / (step + '.json')
        path.write_text(json.dumps(value))
        (self.remote / 'steps' / (step + '.job')).write_text(value['job_id'])
        (self.remote / 'steps' / (step + '.done')).write_text('0 2026-11-18T01:02:03Z\n')
        return path


    def genotype(self):
        self.place('res/resg/signet_Genotype.sampleID', 'PRIVATE-SAMPLE-1\nPRIVATE-SAMPLE-2\n')
        self.place('res/resg/signet_Geno', '0 1 2\n2 1 0\n')
        self.record(1)


    def expression(self):
        self.place('res/rest/signet_gexpID', 'PRIVATE-SAMPLE-1\nPRIVATE-SAMPLE-2\n')
        self.place('res/rest/signet_gene_name', 'GENE1\nGENE2\n')
        self.place('res/rest/signet_gene_pos', '100\n200\n')
        self.place('res/rest/signet_gexp', '1 2\n3 4\n')
        self.record(2)


    def adjustment(self):
        ids = ['TCGA-AA-A001-01', 'TCGA-AA-A002-01', 'TCGA-AA-A003-01', 'TCGA-AA-A004-01']
        self.place('res/resa/workspace-genotype-ids.txt', '\n'.join(ids) + '\n')
        self.place('res/resa/workspace-clinical.tsv', 'submitter_id\trace\tgender\n'
                   'TCGA-AA-A001\tasian\tfemale\nTCGA-AA-A002\tblack or african american\tmale\n'
                   'TCGA-AA-A003\tamerican indian or alaska native\tmale\nTCGA-AA-A004\twhite\tfemale\n')
        self.place('res/resa/workspace-pca.evec', '#eigvals: 6 3 1\nTCGA-AA-A002 0.2 0.4 pop\n'
                   'TCGA-AA-A003 0.3 0.5 pop\nTCGA-AA-A001 0.1 0.3 pop\n')
        self.place('res/resa/workspace-pca.eval', '6\n3\n1\n')
        for name, text in {
                'signet_matched.gexp': '1 3\n3 5\n9 9\n10 10\n',
                'signet_gexp.data': '0.5 0.8\n-0.5 -0.8\n',
                'signet_gexp_rmpc.data': '0.25 0.4\n-0.25 -0.4\n',
                'signet_new.Geno': '0 1 2\n2 1 0\n1 0 1\n0 0 2\n',
                'signet_geno.data': '0 1 2\n2 1 0\n',
                'signet_new.Geno.map': '1 1 0 100\n1 2 0 200\n1 3 0 300\n'}.items():
            self.place('res/resa/' + name, text)
        self.place('res/resg/signet_Genotype.sampleID', '\n'.join(ids + ['TCGA-AA-A005-01']) + '\n')
        self.place('res/rest/signet_gexpID', '\n'.join(ids + ['TCGA-AA-A006-01', 'TCGA-AA-A007-01']) + '\n')
        self.place('res/rest/signet_gene_name', 'GENE1\nGENE2\n')
        self.record(3)


    def test_all_three_stages_return_only_aggregates_without_local_results(self):
        for stage, seed in ((1, self.genotype), (2, self.expression), (3, self.adjustment)):
            with self.subTest(stage=stage):
                seed()
                result = projection.completed_result(self.run_id, stage)
                text = json.dumps(result)
                self.assertNotIn('PRIVATE-SAMPLE', text)
                self.assertNotIn('TCGA-AA-', text)
                self.assertFalse(any((self.root / 'work/res').rglob('*')))
                if stage == 3:
                    self.assertNotIn('points', result['pca'])
                    self.assertEqual(result['pca']['point_count'], 2)
                    image = base64.b64decode(result['pca']['png_base64'])
                    self.assertTrue(image.startswith(b'\x89PNG\r\n\x1a\n'))
                    self.assertEqual(result['matching']['retained'], 2)
                else:
                    self.assertEqual(result['summary']['samples'], 2)
        self.assertFalse(any('sbatch ' in call or 'scancel ' in call or 'tar cz' in call for call in self.calls))

    def test_changed_owner_job_or_environment_is_rejected(self):
        self.genotype()
        for path in (self.remote / '.owner', self.remote / 'steps/genotype.job'):
            original = path.read_text()
            path.write_text('foreign')
            with self.assertRaises(ValueError):
                projection.completed_result(self.run_id, 1)
            path.write_text(original)
        self.config['workRoot'] += '-other'
        with self.assertRaises(ValueError):
            projection.completed_result(self.run_id, 1)

    def test_redirected_individual_output_is_rejected(self):
        self.genotype()
        path = self.remote / 'work/res/resg/signet_Geno'
        moved = path.with_name('foreign')
        path.rename(moved)
        path.symlink_to(moved)
        with self.assertRaises(ValueError):
            projection.completed_result(self.run_id, 1)

    def test_unexpected_remote_fields_are_rejected(self):
        self.genotype()
        result = projection.completed_result(self.run_id, 1)
        record = json.loads((self.root / 'steps/genotype.json').read_text())
        payload = {'version': 1, 'run_id': self.run_id, 'stage': 1, 'job_id': '12345',
                   'attempt': 1, 'source_fingerprint': 'a' * 64, 'summary': result['summary'],
                   'private_rows': ['PRIVATE-SAMPLE']}
        reply = subprocess.CompletedProcess([], 0, ('@@workspace_projection\t' + json.dumps(payload)).encode())
        with patch.object(ssh_transport, 'remote', return_value=reply), self.assertRaises(ValueError):
            projection.completed_result(self.run_id, 1)

    def test_live_http_route_uses_remote_projection_and_keeps_token_guard(self):
        import http.client
        import threading
        from unittest.mock import Mock
        from agent.app.chat_ui import ChatServer
        self.genotype()
        server = ChatServer(('127.0.0.1', 0), Mock())
        worker = threading.Thread(target=server.serve_forever)
        worker.start()
        try:
            for authenticated, expected in ((False, 403), (True, 200)):
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                try:
                    connection.request('GET', '/stage/results?run=' + self.run_id + '&stage=1&source=live',
                                       headers={'X-Chat-Token': server.token} if authenticated else {})
                    response = connection.getresponse()
                    self.assertEqual(response.status, expected)
                    data = response.read().decode()
                    self.assertNotIn('PRIVATE-SAMPLE', data)
                finally:
                    connection.close()
        finally:
            server.shutdown()
            worker.join()
            server.server_close()

    def test_unlinked_or_changed_workspace_snapshot_is_rejected(self):
        self.genotype()
        path = self.root / 'workspace-genotype.json'
        path.write_text(json.dumps({'run_id': 'other', 'dataset_id': 'example-chr1'}))
        with self.assertRaises(ValueError):
            projection.completed_result(self.run_id, 1)
        self.record(1)
        def changed(command, **kwargs):
            reply = self.execute(command, **kwargs)
            path.write_text('{}')
            return reply
        with patch.object(ssh_transport, 'remote', side_effect=changed), self.assertRaises(ValueError):
            projection.completed_result(self.run_id, 1)

    def test_configured_mount_alias_is_allowed_but_run_redirect_is_rejected(self):
        self.genotype()
        configured = self.remote.parent
        physical = configured.with_name('physical-runs')
        configured.rename(physical)
        configured.symlink_to(physical, target_is_directory=True)
        self.assertEqual(projection.completed_result(self.run_id, 1)['summary']['samples'], 2)
        original = physical / self.run_id
        foreign = physical / 'foreign-run'
        original.rename(foreign)
        original.symlink_to(foreign, target_is_directory=True)
        with self.assertRaises(ValueError):
            projection.completed_result(self.run_id, 1)
