import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from agent.app.chat_ui import ChatServer
from agent.runtime import workspace_genotype
from agent.stage6.workspace import Workspace, live_completed_result
import agent.tools.signet as signet


class WorkspaceVisualizationTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.project = Path(temporary.name).resolve()
        project_patch = patch.object(signet, 'PROJECT', self.project)
        project_patch.start()
        self.addCleanup(project_patch.stop)
        self.run_id = 'visualized-chr1'
        self.root = self.project / 'runs' / self.run_id
        for folder in ('work/script', 'work/tmp', 'work/data', 'work/res/resv', 'logs', 'home', 'steps'):
            (self.root / folder).mkdir(parents=True, exist_ok=True)
        (self.root / 'manifest.json').write_text('{}')
        (self.root / 'work/config.ini').write_text('[netvis]\nfreq = 0.99\nntop = 99\n')
        self.directory = self.root / 'work/res/resv'
        self.edge_path = self.directory / 'signet_edgelist_0.45.txt'
        self.edge_header = 'source_gene_symbol,target_gene_symbol,frequency,coefficient\n'
        self.edge_source = (self.edge_header + 'MEGF6,B,0.5,0.2\nB,MEGF6,1,-0.4\n'
                            'B,C,0.8,0.1\nD,E,0.6,0.3\n')
        self.edge_path.write_text(self.edge_source)
        self.name_path = self.directory / 'signet_top1_freq0.45_name.txt'
        self.name_path.write_text('MEGF6\nB\nC\n')
        required = ['res/resv/signet_edgelist_0.45.txt', 'res/resv/signet_count_vs_freq.pdf',
                    'res/resv/signet_count_vs_freq.eps', 'res/resv/signet_top1_freq0.45.html',
                    'res/resv/signet_top1_freq0.45_name.txt', 'res/resv/signet_circular_top1_freq0.45.pdf']
        for relative in required:
            path = self.root / 'work' / relative
            if not path.exists():
                path.write_text('Saved official export\n')
        self.settings = {'freq': '0.45', 'ntop': '1'}
        self.snapshot = {'run_id': self.run_id, 'dataset_id': workspace_genotype.DATASET_ID,
                         'submitted_at': '2026-11-17T16:00:00-0800', 'inputs': {},
                         'settings': self.settings.copy(), 'resources': {'cpus': 2, 'mem_gb': 16, 'hours': 1},
                         'input_sources': {'Afreq': '/remote/run/work/res/resn/signet_Afreq',
                                           'coef': '/remote/run/work/res/resn/signet_CoeffMat0',
                                           'vis.genepos': '/remote/run/work/res/resn/signet_net.genepos'}}
        self.snapshot_path = self.root / 'workspace-visualize.json'
        self.snapshot_path.write_text(json.dumps(self.snapshot))
        self.job = {**self.snapshot, 'state': 'completed', 'step': 'visualize',
                    'required_outputs': required, 'job_id': '606', 'finished_at': '2026-11-17T16:05:00-0800'}
        self.job_path = self.root / 'steps/visualize.json'
        self.job_path.write_text(json.dumps(self.job))
        genotype = {'run_id': self.run_id, 'dataset_id': workspace_genotype.DATASET_ID,
                    'submitted_at': '2026-11-17T12:00:00-0800',
                    'inputs': {'ped.file': '/remote/study.ped', 'map.file': '/remote/study.map',
                               'ref': '/remote/ref/chr', 'gmap': '/remote/gmap/chr'},
                    'settings': {'restrict.tcga.geno': '1'}, 'resources': {'cpus': 8, 'mem_gb': 32, 'hours': 4}}
        (self.root / workspace_genotype.SNAPSHOT).write_text(json.dumps(genotype))
        (self.root / 'steps/genotype.json').write_text(json.dumps({**genotype, 'step': 'genotype', 'state': 'completed'}))

    def test_result_uses_saved_settings_and_actual_subnetwork_export(self):
        before = {path: path.read_bytes() for path in (self.snapshot_path, self.job_path, self.edge_path)}
        with patch('agent.runtime.ssh_transport.remote', side_effect=AssertionError('Saved graphs are local')):
            result = live_completed_result(self.run_id)
        self.assertEqual((result['source'], result['frequency'], result['top_networks']), ('live', 0.45, 1))
        self.assertEqual(result['job']['settings'], self.settings)
        self.assertEqual(result['graph']['counts'], {'connections': 4, 'genes': 5, 'subnetworks': 2, 'displayed': 1})
        self.assertEqual(result['graph']['display_nodes'], ['B', 'C', 'MEGF6'])
        self.assertEqual(result['graph']['edges'][0], {'source': 'MEGF6', 'target': 'B', 'frequency': 0.5, 'coefficient': 0.2})
        self.assertEqual(sum('MEGF6' in (edge['source'], edge['target']) for edge in result['graph']['edges']), 2)
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)

    def test_original_export_resolves_tied_subnetwork_order(self):
        self.edge_path.write_text(self.edge_header + 'A,B,0.5,0.1\nB,A,0.6,0.2\n'
                                  'MEGF6,Z,0.7,0.3\nZ,MEGF6,0.8,0.4\n')
        self.name_path.write_text('MEGF6\nZ\n')
        result = live_completed_result(self.run_id)
        self.assertEqual(result['graph']['display_nodes'], ['MEGF6', 'Z'])
        self.assertEqual(result['graph']['counts']['subnetworks'], 2)

    def test_incomplete_job_or_invalid_exports_do_not_become_a_graph(self):
        for invalid in (self.edge_header, self.edge_source.replace('0.5,0.2', '0.4,0.2'),
                        self.edge_source + 'MEGF6,B,0.5,0.2\n',
                        self.edge_source.replace('0.5,0.2', 'nan,0.2')):
            with self.subTest(invalid=invalid):
                self.edge_path.write_text(invalid)
                with self.assertRaises(ValueError):
                    live_completed_result(self.run_id)
        self.edge_path.write_text(self.edge_source)
        self.name_path.write_text('D\nE\n')
        with self.assertRaises(ValueError):
            live_completed_result(self.run_id)
        self.name_path.write_text('MEGF6\nB\nC\n')
        for changed in ({'state': 'running'}, {'run_id': 'different-run'},
                        {'settings': {'freq': '0.5', 'ntop': '1'}}, {'required_outputs': []}):
            self.job_path.write_text(json.dumps({**self.job, **changed}))
            with self.assertRaises(ValueError):
                live_completed_result(self.run_id)
        self.job_path.write_text(json.dumps(self.job))
        self.snapshot_path.write_text(json.dumps({**self.snapshot, 'settings': {'freq': '0.45', 'ntop': 1.5}}))
        self.job_path.write_text(json.dumps({**self.job, 'settings': {'freq': '0.45', 'ntop': 1.5}}))
        with self.assertRaises(ValueError):
            live_completed_result(self.run_id)
        self.snapshot_path.write_text(json.dumps(self.snapshot))
        self.job_path.write_text(json.dumps(self.job))
        self.edge_path.write_text(self.edge_header + 'X' * 140000 + ',B,0.5,0.2\n')
        with self.assertRaises(ValueError):
            live_completed_result(self.run_id)
        history = workspace_genotype.run_history(self.root)
        self.assertIsNone(history['graph'])
        self.assertTrue(history['result_error'])
        self.edge_path.write_text(self.edge_source)
        self.name_path.unlink()
        with self.assertRaises(ValueError):
            live_completed_result(self.run_id)

    def test_authenticated_live_route_and_history_keep_the_same_run(self):
        server = ChatServer(('127.0.0.1', 0), Mock())
        self.addCleanup(server.server_close)
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 3)
        self.addCleanup(server.shutdown)

        def request(path, authenticated=True):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
            try:
                connection.request('GET', path, headers={'X-Chat-Token': server.token} if authenticated else {})
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()

        path = f'/stage6/results?run={self.run_id}&source=live'
        self.assertEqual(request(path, False)[0], 403)
        self.assertEqual(request(path + '&source=live')[0], 400)
        self.assertEqual(request(path.replace('source=live', 'source=archive'))[0], 400)
        with patch('agent.runtime.ssh_transport.remote', side_effect=AssertionError('Saved graphs are local')):
            status, result = request(path)
            listing = request('/stage6/results')[1]['runs']
            history = request('/stage6/history')[1]['runs']
        self.assertEqual((status, result['source'], result['run_id']), (200, 'live', self.run_id))
        self.assertEqual([row['run_id'] for row in listing], [self.run_id])
        self.assertEqual(history[0]['run_id'], self.run_id)
        self.assertEqual(history[0]['source'], 'live')
        self.assertEqual(history[0]['graph'], result['graph']['counts'])
        self.assertEqual(history[0]['jobs']['visualize']['settings'], self.settings)
        self.assertEqual(request(f'/stage6/results?run={self.run_id}')[1]['graph'], result['graph'])


if __name__ == '__main__':
    unittest.main()
