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

    def request(self, query='', authenticated=True, *, route='/stage3/results'):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        try:
            headers = {'X-Chat-Token': self.server.token} if authenticated else {}
            connection.request('GET', route + query, headers=headers)
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
        self.assertEqual(self.request('?run=first&source=archive'), (200, first_snapshot))
        self.assertEqual(self.request('?run=first&source=invalid')[0], 400)
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
        # Missing dataset labels must not hide separately verified stage artifacts.
        self.assertEqual(self.request('?run=first&source=archive'), (200, snapshot))
        self.assertIsNone(self.server.stage6.history()['runs'][0]['dataset_id'])

    def test_explicit_sources_dispatch_without_falling_back_to_a_same_name(self):
        _, snapshot = self.archive('shared')
        self.saved_steps_fixture('saved')
        with patch('agent.runtime.workspace_adjustment.completed_result', return_value={'live': True}) as live_pca:
            self.assertEqual(self.request('?run=shared&source=archive'), (200, snapshot))
            live_pca.assert_not_called()
            self.assertEqual(self.request('?run=shared&source=live'), (200, {'live': True}))
        with patch('agent.runtime.workspace_genotype.completed_result', return_value={'live': True}) as live_step:
            self.assertEqual(self.request_saved_step('?run=saved&stage=1&source=archive')[0], 200)
            self.assertEqual(self.request_saved_step('?run=absent&stage=1&source=archive')[0], 404)
            live_step.assert_not_called()
            self.assertEqual(self.request_saved_step('?run=saved&stage=1&source=live'), (200, {'live': True}))

    def saved_steps_fixture(self, run_id, chromosome='1'):
        path, _ = self.archive(run_id)
        report_path = path.parent / 'verification.json'
        report = json.loads(report_path.read_text())
        jobs = {
            'genotype': {'job_id': '123', 'state': 'completed', 'settings': {'restrict.tcga.geno': chromosome}},
            'expression': {'job_id': '124', 'state': 'completed', 'settings': {'restrict.tcga': chromosome}},
            'cis': {'job_id': '125', 'state': 'completed', 'settings': {'alpha.cis': '0.05'}},
            'network': {'job_id': '126', 'state': 'completed', 'settings': {'ncis': '3', 'nboots': '2'}},
        }
        report['jobs'].update(jobs)
        report_path.write_text(json.dumps(report))
        stages = {
            '1': {'samples': 2, 'variants': 3, 'nonzero_bins': [1, 1, 0, 1, 0, 0],
                  'genotype_codes': [3, 2, 1]},
            '2': {'samples': 2, 'genes': 2, 'histogram': [{'lower': 11, 'upper': 12, 'count': 4}],
                  'gene_summary': [{'gene': 'MEGF6', 'min': 11.1, 'median': 11.2, 'max': 11.3}]},
            '4': {'genes': 2, 'counts': {'common': 1, 'low': 0, 'rare': 1},
                  'pairs': [{'gene': 'MEGF6', 'variant': '17', 'category': 'rare', 'p_value': 0.001}]},
            '5': {'genes': 2, 'frequencies': [{'frequency': 0.5, 'count': 1}, {'frequency': 1, 'count': 1}],
                  'edges': [{'source': 'MEGF6', 'target': 'CHD5', 'frequency': 0.5}]},
        }
        stages_path = path.parent / 'stages.json'
        stages_path.write_text(json.dumps({'run_id': run_id, 'stages': stages}))
        return stages_path, report_path, stages, jobs

    def request_saved_step(self, query='', authenticated=True):
        return self.request(query, authenticated, route='/stage/results')

    def test_saved_steps_return_the_requested_stage_and_verified_job(self):
        first, report, stages, jobs = self.saved_steps_fixture('first')
        second, _, _, _ = self.saved_steps_fixture('second', chromosome='2')
        second_record = json.loads(second.read_text())
        second_record['stages']['1']['nonzero_bins'] = [3, 0, 0, 0, 0, 0]
        second.write_text(json.dumps(second_record))
        original_files = [path.read_bytes() for path in (first, second, report)]
        for stage, job_type in zip(('1', '2', '4', '5'), ('genotype', 'expression', 'cis', 'network')):
            with self.subTest(stage=stage):
                self.assertEqual(self.request_saved_step(f'?run=first&stage={stage}'), (200, {
                    'run_id': 'first', 'stage': int(stage), 'job': jobs[job_type], 'summary': stages[stage],
                }))
        status, other = self.request_saved_step('?run=second&stage=1')
        self.assertEqual(status, 200)
        self.assertEqual(other['job']['settings'], {'restrict.tcga.geno': '2'})
        self.assertEqual(other['summary']['nonzero_bins'], [3, 0, 0, 0, 0, 0])
        self.assertEqual([path.read_bytes() for path in (first, second, report)], original_files)
        self.assertEqual(self.server.stage6.sessions, {})
        self.assertFalse(self.state_file.exists())
        self.provider.assert_not_called()

    def test_invalid_missing_or_unlinked_saved_steps_never_fall_back(self):
        path, report_path, stages, _ = self.saved_steps_fixture('first')
        query = '?run=first&stage=1'
        unavailable = (404, {'error': 'No readable archived result for this stage.'})
        self.assertEqual(self.request_saved_step(query, authenticated=False)[0], 403)
        for invalid in ('', '?run=first&stage=3', '?run=first&stage=6', query + '&stage=2',
                        query + '&run=second', query + '&source=invalid', query + '&source=archive&source=archive'):
            with self.subTest(query=invalid):
                self.assertEqual(self.request_saved_step(invalid)[0], 400)
        self.assertEqual(self.request_saved_step('?run=missing&stage=1'), unavailable)
        self.assertEqual(self.request_saved_step('?run=..%2Ffirst&stage=1'), unavailable)

        path.write_text(json.dumps({'run_id': 'another-run', 'stages': stages}))
        self.assertEqual(self.request_saved_step(query), unavailable)
        path.write_text(json.dumps({'run_id': 'first', 'stages': {'1': {**stages['1'], 'variants': 1}}}))
        self.assertEqual(self.request_saved_step(query), unavailable)
        path.write_text(json.dumps({'run_id': 'first', 'stages': stages}))
        outside = self.project / 'unrelated-stages.json'
        path.rename(outside)
        self.assertEqual(self.request_saved_step(query), unavailable)
        path.symlink_to(outside)
        self.assertEqual(self.request_saved_step(query), unavailable)
        path.unlink()
        outside.rename(path)

        verification = json.loads(report_path.read_text())
        verification['jobs']['genotype']['state'] = 'failed'
        report_path.write_text(json.dumps(verification))
        self.assertEqual(self.request_saved_step(query), unavailable)
        verification['jobs']['genotype']['state'] = 'completed'
        report_path.write_text(json.dumps(verification))
        (path.parent / 'history.json').unlink()
        status, result = self.request_saved_step(query + '&source=archive')
        self.assertEqual((status, result['summary']), (200, stages['1']))
        self.assertIsNone(self.server.stage6.history()['runs'][0]['dataset_id'])
