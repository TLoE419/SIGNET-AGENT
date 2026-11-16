import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from agent.app.chat_ui import ChatServer
import agent.tools.signet as st


class Stage3ArchiveTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.project = Path(temporary.name).resolve()
        project_patch = patch.object(st, 'PROJECT', self.project)
        project_patch.start()
        self.addCleanup(project_patch.stop)

        catalog = self.project / 'data/datasets/chromosome-one.json'
        catalog.parent.mkdir(parents=True)
        catalog.write_text(json.dumps({
            'id': 'chromosome-one', 'name': ['染色體一', 'Chromosome one'], 'inputs': {},
        }))

        self.provider = Mock()
        self.state_file = self.project / '.chat-state.json'
        self.server = ChatServer(('127.0.0.1', 0), self.provider, state_file=self.state_file)
        self.addCleanup(self.server.server_close)
        thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 3)
        self.addCleanup(self.server.shutdown)

    def archive(self, run_id, npc=3, retained=2):
        root = self.project / 'data/stage6-results' / run_id
        root.mkdir(parents=True)
        (root / 'history.json').write_text(json.dumps({
            'run_id': run_id, 'dataset_id': 'chromosome-one',
            'name': ['封存執行', 'Archived run'], 'inputs': {'genotype': ['snapshot.ped']},
        }))
        (root / 'verification.json').write_text(json.dumps({
            'run': run_id,
            'jobs': {
                'adjust': {'state': 'completed', 'options': {'npc': npc}},
                'visualize': {'state': 'completed', 'settings': {'freq': 0.45, 'ntop': 1}},
            },
            'graph': {'connections': 1, 'genes': 2, 'subnetworks': 1, 'displayed': 1},
        }))
        (root / 'signet_edgelist_0.45.txt').touch()
        snapshot = {
            'run_id': run_id, 'npc': npc,
            'matching': {
                'genotype': 9, 'expression': 8, 'matched': retained + 1, 'retained': retained,
                'excluded': 1, 'variants': 12, 'genes': 2,
            },
            'pca': {
                'points': [[-index, index + 0.1] for index in range(retained)],
                'variance_explained': [6.5, 3.2], 'source': 'retained_genotype',
            },
            'comparison': {'before_sd': 0.76, 'after_sd': 0.53, 'covariates_sd': 0.56},
        }
        path = root / 'stage3.json'
        path.write_text(json.dumps(snapshot))
        return path, snapshot

    def request(self, query='', authenticated=True):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        try:
            headers = {'X-Chat-Token': self.server.token} if authenticated else {}
            connection.request('GET', '/stage3/results' + query, headers=headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_read_only_endpoint_returns_only_the_requested_archived_run(self):
        first, first_snapshot = self.archive('first')
        second, second_snapshot = self.archive('second', npc=2, retained=3)
        self.assertEqual(self.request('?run=first', authenticated=False)[0], 403)
        self.assertEqual(self.request()[0], 400)
        self.assertEqual(self.request('?run=first&run=second')[0], 400)
        self.assertEqual(self.request('?run=first&source=archive')[0], 400)
        self.assertEqual(self.request('?run=first'), (200, first_snapshot))
        self.assertEqual(self.request('?run=second'), (200, second_snapshot))
        self.assertEqual(json.loads(first.read_text()), first_snapshot)
        self.assertEqual(json.loads(second.read_text()), second_snapshot)
        self.assertEqual(self.server.stage6.sessions, {})
        self.assertFalse(self.state_file.exists())
        self.provider.assert_not_called()

    def test_missing_unlinked_and_invalid_display_results_never_fall_back(self):
        path, snapshot = self.archive('first')
        unavailable = (404, {'error': 'No readable archived Stage 3 result for this run.'})
        self.assertEqual(self.request('?run=absent'), unavailable)
        self.assertEqual(self.request('?run=..%2Ffirst'), unavailable)
        self.archive('invalid-npc', npc=11)
        self.assertEqual(self.request('?run=invalid-npc'), unavailable)
        for patch_fields in (
            {'run_id': 'another-run'},
            {'npc': 7},
            {'matching': {**snapshot['matching'], 'excluded': 0}},
            {'pca': {**snapshot['pca'], 'points': [[0, float('nan')], [1, 1]]}},
        ):
            path.write_text(json.dumps({**snapshot, **patch_fields}))
            self.assertEqual(self.request('?run=first'), unavailable)

        partial = {**snapshot, 'pca': None, 'comparison': None}
        path.write_text(json.dumps(partial))
        self.assertEqual(self.request('?run=first'), (200, partial))

        other = self.project / 'unrelated-stage3.json'
        path.rename(other)
        self.assertEqual(self.request('?run=first'), unavailable)
        path.symlink_to(other)
        self.assertEqual(self.request('?run=first'), unavailable)
        path.unlink()
        path.write_text(json.dumps(snapshot))
        (path.parent / 'history.json').unlink()
        self.assertEqual(self.request('?run=first'), unavailable)
