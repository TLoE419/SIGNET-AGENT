import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from agent.app.chat_ui import ChatServer
from agent.runtime import workspace_cis, workspace_genotype
import agent.tools.signet as signet


class WorkspaceCisTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.project = Path(temporary.name).resolve()
        self.run_id = 'completed-cis-chr1'
        self.root = self.project / 'runs' / self.run_id
        self.directory = self.root / 'work/res/resc'
        for folder in ('work/script', 'work/tmp', 'work/data', 'work/res/resc', 'logs', 'home', 'steps'):
            (self.root / folder).mkdir(parents=True, exist_ok=True)
        (self.root / 'manifest.json').write_text('{}')
        (self.root / 'work/config.ini').write_text('[ciseqtl]\nalpha.cis = 0.5\n')
        self.job = {'state': 'completed', 'step': 'cis', 'run_id': self.run_id,
                    'settings': {'alpha.cis': '0.01', 'nperms': '100', 'upstream': '1000', 'downstream': '2000'},
                    'required_outputs': ['res/resc/signet_all.sig.pValue_0.01']}
        project_patch = patch.object(signet, 'PROJECT', self.project)
        history_patch = patch.object(workspace_genotype, 'run_history', return_value={'jobs': {'cis': self.job}})
        project_patch.start()
        history_patch.start()
        self.addCleanup(project_patch.stop)
        self.addCleanup(history_patch.stop)
        self.associations = '1 1 0.001\n2 1 0.002\n1 2 0.003\n2 3 0.004\n1 4 0.005\n2 5 0.006\n'
        outputs = {
            'signet_all.sig.pValue_0.01': self.associations,
            'signet_common.eQTL.data': '0 1 2\n1 2 0\n2 0 1\n',
            'signet_low.eQTL.data': '0.1\n0.2\n0.3\n',
            'signet_rare.eQTL.data': '-0.1\n0.2\n-0.3\n',
            'signet_all.eQTL.data': '0 1 2 0.1 -0.1\n1 2 0 0.2 0.2\n2 0 1 0.3 -0.3\n',
            'signet_net.gexp.data': '1 2\n3 4\n5 6\n',
            'signet_net.genename': 'MEGF6\nGENE2\n',
            'signet_net.genepos': 'MEGF6 chr1 100 200\nGENE2 chr1 300 400\n',
        }
        for name, text in outputs.items():
            (self.directory / name).write_text(text)

    def test_saved_alpha_and_all_associations_use_official_reindexed_columns(self):
        with patch('agent.runtime.ssh_transport.remote', side_effect=AssertionError('Saved display must be local')):
            result = workspace_cis.summary(self.root, self.job)
        self.assertEqual(result['genes'], 2)
        self.assertEqual(result['counts'], {'common': 4, 'low': 1, 'rare': 1})
        self.assertEqual(len(result['pairs']), 6, 'Live associations must include rows beyond the archived excerpt')
        self.assertEqual(result['pairs'][0], {'gene': 'MEGF6', 'variant': '1', 'category': 'common', 'p_value': 0.001})
        self.assertEqual(result['pairs'][-2:], [
            {'gene': 'MEGF6', 'variant': '1', 'category': 'low', 'p_value': 0.005},
            {'gene': 'GENE2', 'variant': '1', 'category': 'rare', 'p_value': 0.006},
        ])
        self.job['required_outputs'] = ['res/resc/signet_all.sig.pValue_0.5']
        with self.assertRaises(ValueError):
            workspace_cis.summary(self.root, self.job)

    def test_empty_low_and_rare_categories_are_valid(self):
        for category in ('low', 'rare'):
            (self.directory / f'signet_{category}.eQTL.data').write_text('')
        (self.directory / 'signet_all.eQTL.data').write_text('0 1 2\n1 2 0\n2 0 1\n')
        (self.directory / 'signet_all.sig.pValue_0.01').write_text('1 1 0.001\n1 2 0.002\n2 3 0.003\n')
        result = workspace_cis.summary(self.root, self.job)
        self.assertEqual(result['counts'], {'common': 3, 'low': 0, 'rare': 0})

    def test_malformed_associations_and_inconsistent_matrices_are_rejected(self):
        significant = self.directory / 'signet_all.sig.pValue_0.01'
        for invalid in ('1 1 nan\n', '0 1 0.001\n', '1 6 0.001\n', '1 1 0.01\n',
                        '1 1 0.001 extra\n', self.associations + '1 1 0.001\n'):
            with self.subTest(invalid=invalid):
                significant.write_text(invalid)
                with self.assertRaises(ValueError):
                    workspace_cis.summary(self.root, self.job)
        significant.write_text(self.associations)
        (self.directory / 'signet_common.eQTL.data').write_text('0 1 2\n1 2\n')
        with self.assertRaises(ValueError):
            workspace_cis.summary(self.root, self.job)
        (self.directory / 'signet_common.eQTL.data').unlink()
        with self.assertRaises(OSError):
            workspace_cis.summary(self.root, self.job)

    def test_live_route_keeps_authentication_and_recorded_settings(self):
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

        query = f'?run={self.run_id}&stage=4&source=live'
        self.assertEqual(request(query, False)[0], 403)
        self.assertEqual(request(query + '&stage=4')[0], 400)
        self.assertEqual(request(query.replace('source=live', 'source=archive'))[0], 404)
        status, result = request(query)
        self.assertEqual((status, result['stage'], result['job']['settings']['alpha.cis']), (200, 4, '0.01'))
        self.assertEqual(result['summary']['counts'], {'common': 4, 'low': 1, 'rare': 1})
        self.assertEqual(len(result['summary']['pairs']), 6)
        self.job['state'] = 'running'
        self.assertEqual(request(query)[0], 404)


if __name__ == '__main__':
    unittest.main()
