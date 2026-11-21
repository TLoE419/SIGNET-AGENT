"""Local dataset metadata persistence; no remote files or scientific jobs are touched."""
from concurrent.futures import ThreadPoolExecutor
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from agent.app.chat_ui import ChatServer
from agent.runtime import workspace_datasets as datasets
from agent.runtime.signet_jobs import StepError
import agent.tools.signet as signet


class WorkspaceDatasetsTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.project = Path(temporary.name).resolve()
        self.store = self.project / 'profile/workspace-datasets.json'
        for item in (patch.object(signet, 'PROJECT', self.project),
                     patch.dict(os.environ, {'SIGNET_DATASETS_STATE_FILE': str(self.store)}),
                     patch('agent.runtime.ssh_transport.remote', side_effect=AssertionError('Metadata is local'))):
            item.start()
            self.addCleanup(item.stop)
        self.seed = {'id': 'example-chr1', 'name': ['第一號染色體', 'Chromosome one'],
                     'inputs': {'genotype': ['original.ped', 'original.map'],
                                'expression': ['original-expression.tsv'], 'clinical': []}}
        self.seed_path = self.project / 'data/datasets/example-chr1.json'
        self.write_json(self.seed_path, self.seed)
        self.seed_bytes = self.seed_path.read_bytes()
        self.server = ChatServer(('127.0.0.1', 0), Mock())
        self.addCleanup(self.server.server_close)
        worker = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 3)
        self.addCleanup(self.server.shutdown)

    @staticmethod
    def write_json(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding='utf-8')

    def request(self, method, path='/signet/datasets', body=None, authenticated=True, origin=True):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=4)
        headers = {'Content-Type': 'application/json'}
        if authenticated:
            headers['X-Chat-Token'] = self.server.token
        if origin:
            headers['Origin'] = f'http://127.0.0.1:{self.server.server_port}'
        try:
            connection.request(method, path, None if body is None else json.dumps(body), headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_read_without_state_preserves_seed_and_exposes_canonical_choices(self):
        status, catalog = self.request('GET')
        self.assertEqual(status, 200)
        record = catalog['datasets'][0]
        self.assertEqual(record['inputs'], self.seed['inputs'])
        self.assertEqual(record['default_inputs'], self.seed['inputs'])
        self.assertEqual(record['alternative_inputs']['clinical'], ['clinical-review.tsv'])
        self.assertEqual(record['selections'], dict.fromkeys(datasets.KINDS, 0))
        self.assertFalse(self.store.exists())
        self.assertEqual(self.seed_path.read_bytes(), self.seed_bytes)
        self.assertEqual(self.request('GET', '/stage6/history')[1]['datasets'], [self.seed])

    def test_create_and_partial_selection_persist_across_server_instances(self):
        alternatives = {'genotype': ['B.ped', 'B.map'], 'expression': ['B-expression.tsv'],
                        'clinical': ['B-clinical.tsv']}
        status, created = self.request('POST', body={'name': [' 新資料 ', ' New cohort '],
                                                   'folder': '/not-opened/dataset B',
                                                   'alternative_inputs': alternatives})
        self.assertEqual(status, 201)
        self.assertTrue(created['id'].startswith('dataset-'))
        self.assertEqual(created['name'], ['新資料', 'New cohort'])
        self.assertEqual(created['inputs'], dict.fromkeys(datasets.KINDS, []))
        self.assertEqual(created['default_inputs'], created['inputs'])
        route = '/signet/datasets/' + created['id']
        status, changed = self.request('PATCH', route, {'inputs': {'clinical': alternatives['clinical']}})
        self.assertEqual(status, 200)
        self.assertEqual(changed['selections'], {'genotype': 0, 'expression': 0, 'clinical': 1})
        # New server-side readers use disk, not a remembered browser draft.
        fresh = ChatServer(('127.0.0.1', 0), Mock())
        self.addCleanup(fresh.server_close)
        self.assertEqual(fresh.stage6.history()['datasets'][-1]['inputs'], changed['inputs'])
        self.assertEqual(datasets.list_datasets()[-1], changed)
        restored = self.request('PATCH', route, {'inputs': {'clinical': []}})[1]
        self.assertEqual(restored['selections']['clinical'], 0)
        self.assertEqual(restored['alternative_inputs'], alternatives)
        self.assertEqual(self.seed_path.read_bytes(), self.seed_bytes)

    def test_parallel_partial_updates_merge_and_duplicate_creations_are_rejected(self):
        route = '/signet/datasets/example-chr1'
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda body: self.request('PATCH', route, {'inputs': body}),
                                    [{'genotype': ['other.ped', 'other.map']}, {'clinical': ['other.tsv']}]))
        self.assertEqual([status for status, _ in results], [200, 200])
        saved = self.request('GET')[1]['datasets'][0]
        self.assertEqual(saved['inputs'], {'genotype': ['other.ped', 'other.map'],
                                          'expression': ['original-expression.tsv'], 'clinical': ['other.tsv']})
        self.assertEqual(saved['default_inputs'], self.seed['inputs'])
        self.assertEqual(saved['alternative_inputs']['genotype'], ['other.ped', 'other.map'])
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: self.request('POST', body={'name': ['相同名稱', 'Same name']}), range(2)))
        self.assertEqual(sorted(status for status, _ in responses), [201, 409])
        self.assertEqual(len(datasets.list_datasets()), 2)

    def test_catalog_updates_do_not_rewrite_frozen_run_inputs_or_settings(self):
        archive = self.project / 'data/stage6-results/saved-run'
        recorded = {'run_id': 'saved-run', 'dataset_id': 'example-chr1', 'name': ['原執行', 'Original run'],
                    'inputs': {'genotype': ['frozen.ped', 'frozen.map'], 'expression': [], 'clinical': ['frozen.tsv']}}
        report = {'run': 'saved-run', 'jobs': {'visualize': {'state': 'completed',
                  'settings': {'freq': '0.45', 'ntop': '1'}}},
                  'graph': {'connections': 1, 'genes': 2, 'subnetworks': 1, 'displayed': 1}}
        self.write_json(archive / 'history.json', recorded)
        self.write_json(archive / 'verification.json', report)
        (archive / 'signet_edgelist_0.45.txt').write_text(
            'source_gene_symbol,target_gene_symbol,frequency,coefficient\nMEGF6,B,0.5,0.2\n')
        snapshot = self.project / 'runs/untouched/workspace-genotype.json'
        self.write_json(snapshot, {'run_id': 'untouched', 'inputs': {'ped.file': '/frozen/study.ped'}})
        preserved = {path: path.read_bytes() for path in [*archive.iterdir(), snapshot, self.seed_path]}
        self.assertEqual(self.request('PATCH', '/signet/datasets/example-chr1',
                                      {'inputs': {'genotype': ['current.ped', 'current.map']}})[0], 200)
        history = self.request('GET', '/stage6/history')[1]
        self.assertEqual(history['datasets'][0]['inputs']['genotype'], ['current.ped', 'current.map'])
        self.assertEqual(history['runs'][0]['inputs'], recorded['inputs'])
        self.assertEqual(history['runs'][0]['jobs'], report['jobs'])
        for path, contents in preserved.items():
            self.assertEqual(path.read_bytes(), contents)

    def test_authentication_and_invalid_bodies_do_not_write(self):
        self.assertEqual(self.request('GET', authenticated=False)[0], 403)
        self.assertEqual(self.request('POST', body={'name': ['甲', 'A']}, authenticated=False)[0], 403)
        self.assertEqual(self.request('POST', body={'name': ['甲', 'A']}, origin=False)[0], 403)
        self.assertEqual(self.request('PATCH', '/signet/datasets/example-chr1',
                                      {'inputs': {'clinical': []}}, origin=False)[0], 403)
        for body in ({'id': 'injected', 'name': ['甲', 'A']}, {'name': 'A'}, {'name': ['', 'A']},
                     {'name': ['\ud800', 'A']},
                     {'name': ['甲', 'A'], 'inputs': {'unknown': []}},
                     {'name': ['甲', 'A'], 'inputs': {'clinical': ['line\nbreak']}},
                     {'name': ['甲', 'A'], 'inputs': {'clinical': ['duplicate', 'duplicate']}},
                     {'name': ['甲', 'A'], 'folder': 'x' * 4097},
                     {'name': ['甲', 'A'], 'alternative_inputs': {'clinical': 'not a list'}},
                     {'name': ['甲', 'A'], 'inputs': {'clinical': ['x'] * 129}}):
            with self.subTest(body=body):
                self.assertEqual(self.request('POST', body=body)[0], 400)
        self.assertEqual(self.request('POST', body={'name': ['x' * 32768, 'A']})[0], 400)
        self.assertEqual(self.request('PATCH', '/signet/datasets/example-chr1', {'inputs': {}})[0], 400)
        self.assertEqual(self.request('PATCH', '/signet/datasets/missing', {'inputs': {'clinical': []}})[0], 404)
        self.assertEqual(self.request('GET', '/signet/datasets?unexpected=1')[0], 400)
        self.assertFalse(self.store.exists())

    def test_corrupt_catalog_returns_errors_without_overwriting_or_disconnect(self):
        for source in ('{broken', '{"version":1,"datasets":[{}]}', '{"version":2,"datasets":[]}'):
            with self.subTest(source=source):
                self.store.parent.mkdir(parents=True, exist_ok=True)
                self.store.write_text(source)
                for method, path, body in [('GET', '/signet/datasets', None),
                        ('POST', '/signet/datasets', {'name': ['甲', 'A']}),
                        ('PATCH', '/signet/datasets/example-chr1', {'inputs': {'clinical': []}}),
                        ('GET', '/stage6/history', None)]:
                    self.assertEqual(self.request(method, path, body)[0], 409)
                    self.assertEqual(self.store.read_text(), source)

    def test_symlinked_state_and_failed_atomic_replace_preserve_previous_files(self):
        target = self.project / 'untouched.json'
        target.write_text('unchanged')
        self.store.parent.mkdir(parents=True)
        self.store.symlink_to(target)
        self.assertEqual(self.request('POST', body={'name': ['甲', 'A']})[0], 409)
        self.assertEqual(target.read_text(), 'unchanged')
        self.store.unlink()
        datasets.create_dataset(['甲', 'A'])
        before = self.store.read_bytes()
        with patch.object(datasets.os, 'replace', side_effect=OSError('simulated disk failure')):
            with self.assertRaises(StepError):
                datasets.update_dataset('example-chr1', {'clinical': ['/metadata/only/not-opened.tsv']})
        self.assertEqual(self.store.read_bytes(), before)
        self.assertEqual(list(self.store.parent.glob('*.tmp')), [])
        self.assertFalse((self.project / 'data/workspace-datasets.json').exists())


if __name__ == '__main__':
    unittest.main()
