import copy
import hashlib
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from agent.app.chat_ui import ChatServer
from agent.runtime import workspace_history as history
from agent.runtime.signet_jobs import StepError
import agent.tools.signet as signet


class WorkspaceHistoryTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.project = Path(temporary.name).resolve()
        self.store = self.project / 'profile/workspace-history.json'
        self.dataset_store = self.project / 'profile/workspace-datasets.json'
        for item in (patch.object(signet, 'PROJECT', self.project),
                     patch.dict(os.environ, {'SIGNET_HISTORY_STATE_FILE': str(self.store),
                                             'SIGNET_DATASETS_STATE_FILE': str(self.dataset_store)}),
                     patch('agent.runtime.ssh_transport.remote', side_effect=AssertionError('History is local'))):
            item.start()
            self.addCleanup(item.stop)
        self.datasets = [{'id': 'cohort-a', 'name': ['資料 A', 'Cohort A'],
                          'inputs': {'genotype': ['/shared/study.ped', '/shared/study.map'],
                                     'expression': [], 'clinical': []}},
                         {'id': 'cohort-b', 'name': ['資料 B', 'Cohort B'],
                          'inputs': {'genotype': [], 'expression': [], 'clinical': []}}]
        for dataset in self.datasets:
            self.write(self.project / 'data/datasets' / (dataset['id'] + '.json'), dataset)
        self.base = {'datasets': copy.deepcopy(self.datasets), 'runs': []}

    @staticmethod
    def write(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding='utf-8')

    def run_root(self, run_id, **manifest):
        root = self.project / 'runs' / run_id
        self.write(root / 'manifest.json', {'revision': 'pinned-revision', 'cohort': 'TCGA', **manifest})
        return root

    def generic(self, root, step='genotype', **overrides):
        record = {'run_id': root.name, 'step': step, 'state': 'completed',
                  'inputs': {'ped.file': '/shared/study.ped', 'map.file': '/shared/study.map'},
                  'settings': {'mind': '0.05'}, 'resources': {'cpus': 2},
                  'submitted_at': '2026-11-17T10:00:00-0800', **overrides}
        self.write(root / 'steps' / (step + '.json'), record)
        return record

    def load(self):
        return history.merge(self.base)

    def test_generic_and_configured_runs_are_visible_without_guessing_dataset(self):
        root = self.run_root('old-slurm')
        expected = self.generic(root)
        self.write(root / 'steps/genotype.attempt1.json', {**expected, 'state': 'failed'})
        self.run_root('configured-only')
        before = {path: path.read_bytes() for path in self.project.rglob('*') if path.is_file()}
        rows = {row['run_id']: row for row in self.load()['runs']}
        record = rows['old-slurm']
        self.assertEqual(record['history_id'], 'recorded--old-slurm')
        self.assertIsNone(record['dataset_id'])
        self.assertEqual(record['association'], {'status': 'unclassified', 'method': None})
        self.assertEqual(record['jobs'], {'genotype': expected})
        self.assertEqual(record['inputs'], self.datasets[0]['inputs'])
        self.assertEqual(record['capabilities'], {'continue_analysis': False, 'stage_results': [],
                                                 'stage6_graph': False, 'assign_dataset': True})
        self.assertEqual(rows['configured-only']['status'], 'configured')
        self.assertFalse(self.store.exists())
        self.assertEqual(before, {path: path.read_bytes() for path in before})

    def test_old_operation_settings_distinguish_preparation_from_execution(self):
        root = self.run_root('old-agent')
        self.write(root / 'genotype_tcga.json', {'operation': 'genotype_tcga', 'status': 'process_completed',
                                              'executed': True, 'returncode': 0,
                                              'settings_file': str(root / 'work/config.ini')})
        self.write(root / 'network.plan.json', {'operation': 'network', 'executed': True,
                                               'settings_snapshot': '/do/not/open/arbitrary.ini'})
        (root / 'network.config.ini').write_text('# frozen preparation\nnboots=7\ncor = 0.8\n')
        (root / 'work').mkdir()
        (root / 'work/config.ini').write_text('mind = 0.98765\nnboots = 9876\n')
        with patch.object(signet, '_settings', side_effect=AssertionError('Current config is not history')):
            record = self.load()['runs'][0]
        operations = {operation['operation']: operation for operation in record['operations']}
        self.assertEqual(operations['genotype_tcga']['settings'], {})
        self.assertEqual(operations['genotype_tcga']['settings_evidence'], 'not_recorded')
        self.assertEqual(operations['genotype_tcga']['status'], 'process_completed')
        self.assertEqual(operations['network']['settings'], {'nboots': '7', 'cor': '0.8'})
        self.assertEqual(operations['network']['settings_evidence'], 'prepared_snapshot')
        self.assertEqual(operations['network']['status'], 'prepared')
        self.assertIs(operations['network']['executed'], False)
        self.assertEqual(record['jobs'], {})

    def test_same_id_archive_and_workspace_are_distinct_and_agent_operations_attach(self):
        root = self.run_root('shared')
        self.generic(root)
        output = root / 'work/res/resg'
        output.mkdir(parents=True)
        (output / 'signet_Geno').write_text('1 2\n')
        (output / 'signet_Genotype.sampleID').write_text('sample\n')
        self.write(root / 'workspace-genotype.json', {'run_id': 'shared', 'dataset_id': 'cohort-a'})
        self.write(root / 'plot_pca.json', {'operation': 'plot_pca', 'status': 'failed', 'executed': True})
        common = {'run_id': 'shared', 'name': ['分析', 'Analysis'], 'inputs': copy.deepcopy(self.datasets[0]['inputs']),
                  'jobs': {'genotype': {'state': 'completed'}}, 'status': 'completed', 'graph': None}
        self.base['runs'] = [{**common, 'source': 'live', 'dataset_id': 'cohort-a'},
                             {**common, 'source': 'archive', 'dataset_id': 'retired-dataset'}]
        self.write(self.project / 'data/stage6-results/shared/history.json',
                   {'run_id': 'shared', 'dataset_id': 'retired-dataset'})
        result = self.load()
        self.assertEqual([row['history_id'] for row in result['runs']], ['workspace--shared', 'archive--shared'])
        self.assertEqual(result['runs'][0]['operations'][0]['operation'], 'plot_pca')
        self.assertEqual(result['runs'][0]['dataset_id'], 'cohort-a')
        self.assertEqual(result['runs'][1]['dataset_id'], 'retired-dataset')
        self.assertEqual(result['runs'][0]['capabilities']['stage_results'], ['1'])
        self.assertEqual(result['datasets'], self.datasets)

    def test_interrupted_start_does_not_claim_an_operation_was_never_executed(self):
        root = self.run_root('interrupted-start')
        path = root / 'genotype_tcga.json'
        self.write(path, {'operation': 'genotype_tcga', 'status': 'starting', 'executed': False})
        before = path.read_bytes()
        operation = self.load()['runs'][0]['operations'][0]
        self.assertEqual(operation['status'], 'starting')
        self.assertEqual(operation['executed'], 'unknown')
        self.assertEqual(path.read_bytes(), before)
        self.write(root / 'network.plan.json', {'operation': 'network', 'status': 'starting', 'executed': False})
        prepared = next(item for item in self.load()['runs'][0]['operations'] if item['operation'] == 'network')
        self.assertEqual(prepared['status'], 'prepared')
        self.assertIs(prepared['executed'], False)

    def test_generic_top_state_does_not_treat_catalog_order_as_freshness(self):
        root = self.run_root('multiple-steps')
        genotype = self.generic(root, state='completed', submitted_at='2026-11-16T10:00:00-0800')
        expression = self.generic(root, step='expression', state='failed', submitted_at='2026-11-17T10:00:00-0800')
        row = self.load()['runs'][0]
        # STEPS lists expression before genotype; its order is not a timeline.
        self.assertEqual(row['status'], 'recorded')
        self.assertEqual(row['jobs'], {'genotype': genotype, 'expression': expression})

    def test_manual_assignment_persists_reassigns_and_preserves_source_bytes(self):
        root = self.run_root('legacy')
        self.generic(root)
        before = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in root.rglob('*') if path.is_file()}
        row = self.load()['runs'][0]
        assigned = history.assign_dataset(row['history_id'], 'cohort-a', row['revision'], self.load)
        self.assertEqual(assigned['dataset_id'], 'cohort-a')
        self.assertEqual(assigned['association'], {'status': 'manual', 'method': 'manual'})
        self.assertTrue(assigned['capabilities']['assign_dataset'])
        reassigned = history.assign_dataset(row['history_id'], 'cohort-b', assigned['revision'], self.load)
        self.assertEqual(reassigned['dataset_id'], 'cohort-b')
        self.assertEqual(self.load()['runs'][0]['dataset_id'], 'cohort-b')
        self.assertEqual(before, {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in before})
        self.assertFalse(self.dataset_store.exists())
        # A newly configured directory with the same name is a different run.
        (root / 'manifest.json').unlink()
        self.write(root / 'manifest.json', {'revision': 'pinned-revision', 'cohort': 'TCGA'})
        self.assertIsNone(self.load()['runs'][0]['dataset_id'])

    def test_stale_and_explicit_ownership_are_not_overwritten(self):
        root = self.run_root('legacy')
        self.generic(root)
        row = self.load()['runs'][0]
        self.generic(root, state='failed')
        with self.assertRaisesRegex(StepError, 'records changed'):
            history.assign_dataset(row['history_id'], 'cohort-a', row['revision'], self.load)
        self.assertFalse(self.store.exists())
        self.write(root / 'manifest.json', {'dataset_id': 'cohort-a'})
        row = self.load()['runs'][0]
        self.assertEqual(row['dataset_id'], 'cohort-a')
        with self.assertRaisesRegex(StepError, 'ownership cannot'):
            history.assign_dataset(row['history_id'], 'cohort-b', row['revision'], self.load)
        self.generic(root, dataset_id='cohort-b')
        conflicted = self.load()['runs'][0]
        self.assertIsNone(conflicted['dataset_id'])
        self.assertFalse(conflicted['capabilities']['assign_dataset'])
        self.assertTrue(any('conflicting' in issue for issue in conflicted['issues']))

    def test_invalid_records_stay_visible_and_unsafe_paths_are_not_read(self):
        root = self.run_root('damaged')
        (root / 'manifest.json').write_text('{broken')
        self.write(root / 'rerun.json', {'source_run': '../../other-project'})
        self.write(root / 'unsafe.json', {'operation': '../../arbitrary', 'status': 'completed'})
        (root / 'steps').mkdir()
        (root / 'steps/genotype.json').write_text('{broken')
        outside = self.project / 'outside.json'
        self.write(outside, {'operation': 'network', 'status': 'completed'})
        (root / 'network.json').symlink_to(outside)
        linked = self.project / 'runs/linked'
        linked.symlink_to(root, target_is_directory=True)
        rows = self.load()['runs']
        self.assertEqual([row['run_id'] for row in rows], ['damaged'])
        self.assertGreaterEqual(len(rows[0]['issues']), 3)
        self.assertEqual(rows[0]['operations'], [])
        self.assertFalse(self.store.exists())

    def test_corrupt_assignment_store_errors_without_overwriting(self):
        self.run_root('legacy')
        self.store.parent.mkdir()
        self.store.write_bytes(b'{preserve-this')
        for action in (self.load, lambda: history.assign_dataset('recorded--legacy', 'cohort-a', '0' * 64, self.load)):
            with self.assertRaisesRegex(StepError, 'unreadable'):
                action()
            self.assertEqual(self.store.read_bytes(), b'{preserve-this')

    def test_unclassified_archive_assignment_is_anchored_to_verification(self):
        root = self.project / 'data/stage6-results/unknown'
        self.write(root / 'verification.json', {'run': 'unknown', 'graph': {}, 'jobs': {}})
        self.base['runs'] = [{'run_id': 'unknown', 'source': 'archive', 'dataset_id': None,
                              'name': ['未知', 'Unknown'], 'inputs': {kind: [] for kind in ('genotype', 'expression', 'clinical')},
                              'jobs': {}, 'graph': None, 'status': 'unknown'}]
        row = self.load()['runs'][0]
        self.assertTrue(row['capabilities']['assign_dataset'])
        assigned = history.assign_dataset(row['history_id'], 'cohort-a', row['revision'], self.load)
        self.assertEqual(assigned['dataset_id'], 'cohort-a')
        self.write(root / 'verification.json', {'run': 'unknown', 'graph': {'changed': True}, 'jobs': {}})
        restored = self.load()['runs'][0]
        self.assertIsNone(restored['dataset_id'])
        self.assertTrue(any('no longer matches' in issue for issue in restored['issues']))

    def test_authenticated_assignment_route_uses_saved_revision(self):
        self.run_root('legacy')
        server = ChatServer(('127.0.0.1', 0), Mock())
        self.addCleanup(server.server_close)
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 3)
        self.addCleanup(server.shutdown)
        server.stage6.history = self.load
        row = self.load()['runs'][0]
        route = '/signet/history/' + row['history_id'] + '/dataset'

        def request(body, *, token=True, origin=True, path=route):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=4)
            headers = {'Content-Type': 'application/json'}
            if token:
                headers['X-Chat-Token'] = server.token
            if origin:
                headers['Origin'] = f'http://127.0.0.1:{server.server_port}'
            try:
                connection.request('PATCH', path, json.dumps(body), headers)
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()

        body = {'dataset_id': 'cohort-a', 'revision': row['revision']}
        self.assertEqual(request(body, token=False)[0], 403)
        self.assertEqual(request(body, origin=False)[0], 403)
        self.assertFalse(self.store.exists())
        self.assertEqual(request({**body, 'run_id': 'arbitrary'})[0], 400)
        self.assertEqual(request({**body, 'dataset_id': 'unknown'})[0], 404)
        status, saved = request(body)
        self.assertEqual(status, 200)
        self.assertEqual(saved['association']['status'], 'manual')
        self.assertEqual(saved['dataset_id'], 'cohort-a')
        self.assertEqual(request({**body, 'revision': '0' * 64})[0], 409)


if __name__ == '__main__':
    unittest.main()
