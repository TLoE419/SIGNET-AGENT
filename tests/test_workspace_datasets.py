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

    def test_delete_http_requires_token_and_local_origin_and_preserves_data_on_rejection(self):
        route = '/signet/datasets/example-chr1'
        for authenticated, origin in ((False, True), (True, False), (False, False)):
            self.assertEqual(self.request('DELETE', route, authenticated=authenticated, origin=origin)[0], 403)
            self.assertEqual(self.request('GET')[1]['datasets'][0]['id'], 'example-chr1')
        self.assertEqual(self.request('DELETE', route), (200, {'deleted': 'example-chr1'}))
        self.assertEqual(self.request('GET')[1]['datasets'], [])
        self.assertEqual(self.seed_path.read_bytes(), self.seed_bytes)

    def test_read_without_state_preserves_seed_and_exposes_canonical_choices(self):
        status, catalog = self.request('GET')
        self.assertEqual(status, 200)
        record = catalog['datasets'][0]
        self.assertEqual(record['name'], 'Chromosome one')
        self.assertEqual(record['inputs'], self.seed['inputs'])
        self.assertEqual(record['default_inputs'], self.seed['inputs'])
        self.assertEqual(record['alternative_inputs']['clinical'], ['clinical-review.tsv'])
        self.assertEqual(record['selections'], dict.fromkeys(datasets.KINDS, 0))
        self.assertFalse(self.store.exists())
        self.assertEqual(self.seed_path.read_bytes(), self.seed_bytes)
        self.assertEqual(self.request('GET', '/stage6/history')[1]['datasets'],
                         [{**self.seed, 'name': 'Chromosome one'}])

    def test_create_and_partial_selection_persist_across_server_instances(self):
        alternatives = {'genotype': ['B.ped', 'B.map'], 'expression': ['B-expression.tsv'],
                        'clinical': ['B-clinical.tsv']}
        status, created = self.request('POST', body={'name': ' New cohort ',
                                                   'folder': '/not-opened/dataset B',
                                                   'alternative_inputs': alternatives})
        self.assertEqual(status, 201)
        self.assertTrue(created['id'].startswith('dataset-'))
        self.assertEqual(created['name'], 'New cohort')
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
        legacy = {'version': 1, 'datasets': [{**changed, 'name': ['舊資料組', 'New cohort']}]}
        self.write_json(self.store, legacy)
        legacy_bytes = self.store.read_bytes()
        self.assertEqual(datasets.list_datasets()[-1], changed)
        self.assertEqual(self.store.read_bytes(), legacy_bytes)
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

    def test_deletion_is_authenticated_persistent_and_idempotent_for_seed_and_custom(self):
        _, custom = self.request('POST', body={'name': 'Custom study', 'inputs': {'clinical': ['study.tsv']}})
        for dataset_id in ('example-chr1', custom['id']):
            route = '/signet/datasets/' + dataset_id
            self.assertEqual(self.request('DELETE', route, origin=False)[0], 403)
            self.assertEqual(self.request('DELETE', route, authenticated=False)[0], 403)
            self.assertEqual(self.request('DELETE', route + '?unexpected=1')[0], 400)
            self.assertEqual(self.request('DELETE', route), (200, {'deleted': dataset_id}))
            self.assertEqual(self.request('DELETE', route), (200, {'deleted': dataset_id}))
            self.assertEqual(self.request('PATCH', route, {'inputs': {'clinical': ['stale.tsv']}})[0], 404)
        self.assertEqual(self.request('DELETE', '/signet/datasets/unknown')[0], 404)
        self.assertEqual(self.request('GET')[1]['datasets'], [])
        self.assertEqual(self.seed_path.read_bytes(), self.seed_bytes)
        state = json.loads(self.store.read_text())
        self.assertEqual(state['datasets'], [])
        self.assertEqual(set(state['deleted']), {'example-chr1', custom['id']})
        fresh = ChatServer(('127.0.0.1', 0), Mock())
        self.addCleanup(fresh.server_close)
        self.assertEqual(fresh.stage6.history()['datasets'], [])
        status, replacement = self.request('POST', body={'name': 'Custom study'})
        self.assertEqual(status, 201)
        self.assertNotEqual(replacement['id'], custom['id'])
        self.assertEqual([row['id'] for row in datasets.list_datasets()], [replacement['id']])

    def test_deleted_live_run_stays_readable_without_restoring_its_dataset(self):
        for run_id, dataset_id in [('retained-run', 'example-chr1'), ('legacy-run', 'legacy-not-in-catalog')]:
            root = self.project / 'runs' / run_id
            self.write_json(root / 'manifest.json', {'cohort': 'TCGA'})
            snapshot = {'run_id': run_id, 'dataset_id': dataset_id, 'submitted_at': '2026-11-17T10:00:00-0800',
                        'inputs': {'ped.file': '/shared/frozen.ped', 'map.file': '/shared/frozen.map',
                                   'ref': '/shared/chr', 'gmap': '/shared/chr'},
                        'settings': {'restrict.tcga.geno': '1'}, 'resources': {'cpus': 1}}
            self.write_json(root / 'workspace-genotype.json', snapshot)
            self.write_json(root / 'steps/genotype.json', {**snapshot, 'step': 'genotype', 'state': 'completed'})
            tables = root / 'work/res/resg'
            tables.mkdir(parents=True)
            (root / 'work/config.ini').write_text('cohort = TCGA\n')
            (tables / 'signet_Geno').write_text('0 1\n')
            (tables / 'signet_Genotype.sampleID').write_text('mock-sample\n')
        before = self.request('GET', '/stage6/history')[1]
        baseline = next(row for row in before['runs'] if row['run_id'] == 'retained-run')
        self.assertTrue(baseline['capabilities']['continue_analysis'])
        self.assertIn('1', baseline['capabilities']['stage_results'])
        preserved = {path: path.read_bytes() for path in (self.project / 'runs').rglob('*') if path.is_file()}
        self.assertEqual(self.request('DELETE', '/signet/datasets/example-chr1')[0], 200)
        after = self.request('GET', '/stage6/history')[1]
        self.assertEqual([row['id'] for row in after['datasets']], ['legacy-not-in-catalog'])
        rows = {row['run_id']: row for row in after['runs']}
        retained = rows['retained-run']
        self.assertTrue(retained['dataset_deleted'])
        self.assertFalse(retained['capabilities']['continue_analysis'])
        self.assertIn('1', retained['capabilities']['stage_results'])
        self.assertTrue(rows['legacy-run']['capabilities']['continue_analysis'])
        for key in ('dataset_id', 'history_id', 'record_identity', 'inputs', 'jobs'):
            self.assertEqual(retained[key], baseline[key])
        run = '/signet/runs/retained-run'
        for method, route, body in [
            ('GET', '/signet/genotype/example', None),
            ('POST', '/signet/genotype/example', {'run_id': 'new-example', 'inputs': {}, 'settings': {}, 'resources': {}}),
            ('GET', run + '/genotype/retry?expected_job_id=none&expected_attempt=1', None),
            ('GET', run + '/steps/genotype/rerun', None),
            ('POST', run + '/steps/genotype/rerun', {'new_run_id': 'linked', 'revision': 'stale', 'parameters': {}}),
            ('POST', run + '/rerun/submit', {'confirmed': True}),
            ('POST', run + '/steps/expression', {'inputs': {}}),
        ] + [('GET', run + '/' + step + '/example', None) for step in ('expression', 'adjust', 'cis', 'network', 'visualize')]:
            with self.subTest(method=method, route=route):
                status, error = self.request(method, route, body)
                self.assertEqual((status, error['code']), (409, 'conflict'))
                self.assertIn('dataset was deleted', error['error'])
        self.assertEqual(self.request('GET', run)[1]['steps']['genotype']['state'], 'completed')
        self.assertFalse((self.project / 'runs/linked').exists())
        self.assertFalse((self.project / 'runs/new-example').exists())
        for path, contents in preserved.items():
            self.assertEqual(path.read_bytes(), contents)

    def test_concurrent_delete_and_stale_patch_cannot_resurrect_a_seed(self):
        route = '/signet/datasets/example-chr1'
        with ThreadPoolExecutor(max_workers=2) as pool:
            update = pool.submit(self.request, 'PATCH', route, {'inputs': {'clinical': ['stale.tsv']}})
            removal = pool.submit(self.request, 'DELETE', route)
            self.assertEqual(removal.result()[0], 200)
            self.assertIn(update.result()[0], (200, 404))
        self.assertEqual(datasets.list_datasets(), [])

    def test_reference_choices_persist_per_dataset_and_reset_without_affecting_inputs(self):
        _, customized = self.request('POST', body={'name': ['新資料', 'New cohort']})
        seed_route = '/signet/datasets/example-chr1'
        custom_route = '/signet/datasets/' + customized['id']
        panel = '/pub/u/panels/chr1.vcf.gz'
        genetic_map = '/dfs6b/pub/u/chromosome-1.map'
        annotation = '/share/crsp/u/genes.gtf'
        status, updated = self.request('PATCH', seed_route, {'references': {'ref': panel}})
        self.assertEqual(status, 200)
        self.assertEqual(updated['inputs'], self.seed['inputs'])
        self.assertEqual(updated['references'], {'ref': panel})

        status, updated = self.request('PATCH', seed_route,
                                       {'inputs': {'clinical': ['chosen.tsv']},
                                        'references': {'gtf': annotation, 'gmap': genetic_map}})
        self.assertEqual(status, 200)
        self.assertEqual(updated['references'], {'ref': panel, 'gmap': genetic_map, 'gtf': annotation})
        self.assertEqual(updated['inputs']['clinical'], ['chosen.tsv'])
        self.assertEqual(self.request('PATCH', custom_route, {'references': {'ref': '/pub/u/chr2.vcf'}})[0], 200)
        persisted = json.loads(self.store.read_text(encoding='utf-8'))
        self.assertEqual(persisted['version'], 1)
        self.assertEqual(datasets.list_datasets(), self.request('GET')[1]['datasets'])
        self.assertEqual(datasets.list_datasets()[0], updated)

        status, restored = self.request('PATCH', seed_route, {'references': {'ref': None}})
        self.assertEqual(status, 200)
        self.assertEqual(restored['references'], {'gmap': genetic_map, 'gtf': annotation})
        status, restored = self.request('PATCH', seed_route, {'references': {'gmap': None, 'gtf': None}})
        self.assertEqual(status, 200)
        self.assertNotIn('references', restored)
        self.assertEqual(restored['inputs']['clinical'], ['chosen.tsv'])
        self.assertEqual(datasets.list_datasets()[1]['references'], {'ref': '/pub/u/chr2.vcf'})
        self.assertEqual(self.seed_path.read_bytes(), self.seed_bytes)

    def test_reference_updates_merge_with_other_partial_changes(self):
        route = '/signet/datasets/example-chr1'
        changes = [{'inputs': {'clinical': ['study.tsv']}},
                   {'references': {'ref': '/pub/u/reference.vcf'}},
                   {'references': {'gmap': '/pub/u/genetic.map'}}]
        with ThreadPoolExecutor(max_workers=3) as pool:
            replies = list(pool.map(lambda body: self.request('PATCH', route, body), changes))
        self.assertEqual([status for status, _ in replies], [200, 200, 200])
        record = datasets.list_datasets()[0]
        self.assertEqual(record['inputs']['clinical'], ['study.tsv'])
        self.assertEqual(record['references'], {'ref': '/pub/u/reference.vcf', 'gmap': '/pub/u/genetic.map'})

    def test_invalid_reference_updates_do_not_overwrite_existing_catalog(self):
        route = '/signet/datasets/example-chr1'
        self.assertEqual(self.request('PATCH', route, {'references': {'ref': '/pub/u/valid.vcf'}})[0], 200)
        before = self.store.read_bytes()
        for body in ({}, {'references': {}}, {'references': None}, {'references': {'clinical': '/pub/u/study.tsv'}},
                     {'references': {'ref': 'relative.vcf'}}, {'references': {'ref': '/pub/u/../other.vcf'}},
                     {'references': {'ref': '/pub/u//not-canonical.vcf'}}, {'references': {'ref': '/pub/u/./file.vcf'}},
                     {'references': {'ref': '/tmp/compute-cannot-read.vcf'}}, {'references': {'gtf': ['file.gtf']}},
                     {'inputs': None, 'references': {'ref': None}},
                     {'inputs': {'clinical': ['not-saved.tsv']}, 'references': {'gtf': '/pub/u/$unsupported.gtf'}}):
            with self.subTest(body=body):
                self.assertEqual(self.request('PATCH', route, body)[0], 400)
                self.assertEqual(self.store.read_bytes(), before)
        self.assertEqual(self.request('PATCH', route, {'references': {'ref': None}}, origin=False)[0], 403)
        self.assertEqual(self.request('PATCH', route, {'references': {'ref': None}}, authenticated=False)[0], 403)
        self.assertEqual(self.store.read_bytes(), before)

    def test_reference_defaults_are_private_and_return_current_environment_fallbacks(self):
        route = '/signet/references'
        with patch('agent.runtime.ssh_transport.available', return_value=False):
            self.assertEqual(self.request('GET', route, authenticated=False)[0], 403)
            self.assertEqual(self.request('GET', route + '?unexpected=1')[0], 400)
            status, reply = self.request('GET', route)
            self.assertEqual((status, reply['code']), (412, 'not_ready'))
        with patch('agent.runtime.ssh_transport.available', return_value=True), \
                patch('agent.runtime.ssh_transport.setup_environment', return_value={'root': '/pub/u/settings'}), \
                patch('agent.runtime.signet_jobs._shell', return_value=(0, {
                    'reference': '/dfs6b/pub/u/override.vcf',
                    'genetic_map': '/pub/u/settings/refdata/gmap/chr1.b38.gmap.gz',
                    'annotation': '/pub/u/settings/refdata/gencode.v22.genes.gtf',
                }, [])) as shell:
            status, reply = self.request('GET', route)
            self.assertEqual(status, 200)
            self.assertEqual(reply, {'references': {
                'ref': '/dfs6b/pub/u/override.vcf',
                'gmap': '/pub/u/settings/refdata/gmap/chr1.b38.gmap.gz',
                'gtf': '/pub/u/settings/refdata/gencode.v22.genes.gtf',
            }})
            script = shell.call_args.args[0]
            self.assertIn('W=/pub/u/settings\n', script)
            for key in datasets.REFERENCE_KEYS:
                self.assertIn('selected_of ' + key, script)
            shell.side_effect = TimeoutError()
            status, reply = self.request('GET', route)
            self.assertEqual((status, reply['code']), (504, 'read_timeout'))
            shell.side_effect = OSError()
            status, reply = self.request('GET', route)
            self.assertEqual((status, reply['code']), (502, 'remote_failed'))
        self.assertFalse(self.store.exists())

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
        self.assertEqual(history['runs'][0]['name'], 'Original run')
        self.assertEqual(history['runs'][0]['jobs'], report['jobs'])
        self.assertEqual(self.request('DELETE', '/signet/datasets/example-chr1')[0], 200)
        deleted_history = self.request('GET', '/stage6/history')[1]
        self.assertEqual(deleted_history['datasets'], [])
        row = deleted_history['runs'][0]
        self.assertEqual(row['dataset_id'], 'example-chr1')
        self.assertEqual(row['inputs'], recorded['inputs'])
        self.assertTrue(row['capabilities']['stage6_graph'])
        self.assertEqual(self.server.stage6.completed_result('saved-run', archive_only=True)['graph']['counts'],
                         report['graph'])
        for path, contents in preserved.items():
            self.assertEqual(path.read_bytes(), contents)

    def test_authentication_and_invalid_bodies_do_not_write(self):
        self.assertEqual(self.request('GET', authenticated=False)[0], 403)
        self.assertEqual(self.request('POST', body={'name': ['甲', 'A']}, authenticated=False)[0], 403)
        self.assertEqual(self.request('POST', body={'name': ['甲', 'A']}, origin=False)[0], 403)
        self.assertEqual(self.request('PATCH', '/signet/datasets/example-chr1',
                                      {'inputs': {'clinical': []}}, origin=False)[0], 403)
        for body in ({'id': 'injected', 'name': 'A'}, {'name': ''}, {'name': ['', 'A']},
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
            with self.assertRaises(StepError):
                datasets.delete_dataset('example-chr1')
        self.assertEqual(self.store.read_bytes(), before)
        self.assertEqual(list(self.store.parent.glob('*.tmp')), [])
        self.assertFalse((self.project / 'data/workspace-datasets.json').exists())


if __name__ == '__main__':
    unittest.main()
