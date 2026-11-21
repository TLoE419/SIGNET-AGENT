import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from agent.app.chat_ui import ChatServer
from agent.runtime import workspace_genotype, workspace_network
import agent.tools.signet as signet


class WorkspaceNetworkTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.project = Path(temporary.name).resolve()
        self.run_id = 'completed-network-chr1'
        self.root = self.project / 'runs' / self.run_id
        self.directory = self.root / 'work/res/resn'
        for folder in ('work/script', 'work/tmp', 'work/data', 'work/res/resn', 'logs', 'home', 'steps'):
            (self.root / folder).mkdir(parents=True, exist_ok=True)
        (self.root / 'manifest.json').write_text('{}')
        (self.root / 'work/config.ini').write_text('[network]\nnboots = 1000\ncor = 0.9\n')
        self.job = {'state': 'completed', 'step': 'network', 'run_id': self.run_id,
                    'settings': {'nboots': '2', 'cor': '0.3', 'ncis': '3',
                                 'ncores': '16', 'memory': '32', 'walltime': '4:00:00'}}
        for item in (patch.object(signet, 'PROJECT', self.project),
                     patch.object(workspace_genotype, 'run_history', return_value={'jobs': {'network': self.job}})):
            item.start()
            self.addCleanup(item.stop)
        self.frequency = self.directory / 'signet_Afreq'
        self.coefficient = self.directory / 'signet_CoeffMat0'
        self.positions = self.directory / 'signet_net.genepos'
        self.frequency.write_text('0,0.5,1\n1,0,0.5\n0.5,1,0\n')
        self.coefficient.write_text('0,-0.2,0.3\n0.4,0,-0.5\n-0.6,0.7,0\n')
        self.positions.write_text('MEGF6 chr1 100 200\nGENE2 chr1 300 400\nGENE3 chr1 500 600\n')

    def test_all_candidates_use_official_direction_and_saved_frequencies(self):
        with patch('agent.runtime.ssh_transport.remote', side_effect=AssertionError('Saved display must be local')):
            result = workspace_network.summary(self.root, self.job)
        self.assertEqual(result['genes'], 3)
        self.assertEqual(result['frequencies'], [{'frequency': 0.5, 'count': 3}, {'frequency': 1.0, 'count': 3}])
        self.assertEqual(len(result['edges']), 6, 'Live results must retain candidates beyond the old five-row excerpt')
        self.assertEqual(result['edges'][0], {'source': 'GENE2', 'target': 'MEGF6', 'frequency': 0.5})
        self.assertEqual(result['edges'][1], {'source': 'GENE3', 'target': 'MEGF6', 'frequency': 1.0})
        self.assertEqual(result['edges'][2], {'source': 'MEGF6', 'target': 'GENE2', 'frequency': 1.0})

    def test_rectangular_matrices_and_zero_candidate_results(self):
        self.frequency.write_text('0,0.5\n1,0\n0.5,1\n')
        self.coefficient.write_text('0 -0.2\n0.3 0\n0.4 -0.5\n')
        result = workspace_network.summary(self.root, self.job)
        self.assertEqual(result['frequencies'], [{'frequency': 0.5, 'count': 2}, {'frequency': 1.0, 'count': 2}])
        self.assertEqual(result['edges'][-1], {'source': 'GENE2', 'target': 'GENE3', 'frequency': 1.0})
        self.frequency.write_text('0,0\n0,0\n0,0\n')
        self.assertEqual(workspace_network.summary(self.root, self.job), {'genes': 3, 'frequencies': [], 'edges': []})

    def test_malformed_saved_outputs_and_wrong_job_identity_are_rejected(self):
        original = self.frequency.read_text()
        for invalid in ('nan,0,0\n0,0,0\n0,0,0\n', '1.1,0,0\n0,0,0\n0,0,0\n',
                        '-0.1,0,0\n0,0,0\n0,0,0\n', '0,,1\n0,0,0\n0,0,0\n',
                        '0,0\n0,0,0\n0,0,0\n', '0,0,0\n0,0,0\n'):
            with self.subTest(invalid=invalid):
                self.frequency.write_text(invalid)
                with self.assertRaises(ValueError):
                    workspace_network.summary(self.root, self.job)
        self.frequency.write_text(original)
        self.coefficient.write_text('0,inf,0\n0,0,0\n0,0,0\n')
        with self.assertRaises(ValueError):
            workspace_network.summary(self.root, self.job)
        self.coefficient.write_text('0,0,0\n0,0,0\n0,0,0\n')
        self.positions.write_text('MEGF6 chr1 100 200\nMEGF6 chr1 300 400\nGENE3 chr1 500 600\n')
        with self.assertRaises(ValueError):
            workspace_network.summary(self.root, self.job)
        self.job['run_id'] = 'another-run'
        with self.assertRaises(ValueError):
            workspace_network.summary(self.root, self.job)

    def test_live_route_uses_local_result_and_original_settings(self):
        server = ChatServer(('127.0.0.1', 0), Mock())
        self.addCleanup(server.server_close)
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 3)
        self.addCleanup(server.shutdown)

        def request(query, authenticated=True):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
            try:
                connection.request('GET', '/stage/results' + query,
                                   headers={'X-Chat-Token': server.token} if authenticated else {})
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()

        query = f'?run={self.run_id}&stage=5&source=live'
        self.assertEqual(request(query, False)[0], 403)
        self.assertEqual(request(query + '&stage=5')[0], 400)
        self.assertEqual(request(query.replace('source=live', 'source=archive'))[0], 400)
        with patch('agent.runtime.ssh_transport.remote', side_effect=AssertionError('Saved display must be local')):
            status, result = request(query)
        self.assertEqual((status, result['stage'], result['job']['settings']['nboots']), (200, 5, '2'))
        self.assertEqual(len(result['summary']['edges']), 6)
        self.job['state'] = 'running'
        self.assertEqual(request(query)[0], 404)


if __name__ == '__main__':
    unittest.main()
