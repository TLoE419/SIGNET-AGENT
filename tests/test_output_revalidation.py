"""Manual output checks use an existing job, never another scientific submission."""
import http.client
import json
import re
import threading
import unittest
from unittest.mock import Mock

from agent.app.chat_ui import ChatServer
from agent.runtime import signet_jobs as jobs
import test_signet_jobs as fixtures


class OutputRevalidationTest(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.StepsTest()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.root = self.f.root

    def seed(self):
        jobs.submit('step_test', 'expression', self.f.inputs)
        self.f.finish_job(outputs=())
        record = jobs.status('step_test', 'expression', refresh=True)
        self.assertEqual(record['state'], 'failed')
        self.assertTrue(jobs.output_revalidation(record)['eligible'])
        return record

    def check(self, **changes):
        target = {'expected_job_id': '12345', 'expected_attempt': 1, **changes}
        return jobs.revalidate('step_test', 'expression', **target)

    def assert_no_compute_commands(self, calls):
        scripts = ['\n'.join(line for line in call.splitlines() if not line.lstrip().startswith('#')) for call in calls]
        self.assertFalse(any(re.search(r'\b(?:sbatch|scancel)\b|tar xzf|bash ./signet', script) for script in scripts))

    def test_missing_outputs_can_be_collected_without_new_job_or_setting_changes(self):
        failed = self.seed()
        snapshot = self.root / 'workspace-expression.json'
        snapshot.write_text(json.dumps({'inputs': failed['inputs'], 'settings': failed['settings']}))
        protected = [snapshot, self.root / 'work/config.ini', self.f.remote_dir / 'work/config.ini',
                     self.f.remote_dir / 'steps/expression.sbatch', self.f.remote_dir / 'steps/expression.job']
        originals = {path: path.read_bytes() for path in protected}
        self.f.finish_job()
        start = len(self.f.calls)
        record = self.check()
        self.assertEqual((record['state'], record['job_id'], record.get('attempt', 1)), ('completed', '12345', 1))
        for field in ('inputs', 'settings', 'resources', 'submitted_at'):
            self.assertEqual(record[field], failed[field])
        self.assertEqual(record['original_failure']['reason'], failed['reason'])
        self.assertEqual((record['original_failure']['job_id'], record['original_failure']['attempt']), ('12345', 1))
        self.assertEqual(record['original_failure']['missing_outputs'], failed['missing_outputs'])
        self.assertEqual(record['output_checks_total'], 1)
        self.assertEqual(record['output_checks'][0]['before']['state'], 'failed')
        self.assertEqual(record['output_checks'][0]['after']['state'], 'completed')
        self.assertFalse(jobs.output_revalidation(record)['eligible'])
        self.assertFalse(jobs.output_revalidation(record)['active'])
        self.assertEqual(originals, {path: path.read_bytes() for path in originals})
        for relative in fixtures.OUTPUTS:
            self.assertFalse((self.root / 'work' / relative).exists())
            self.assertEqual((self.f.remote_dir / 'work' / relative).read_text(), 'data\n')
        self.assert_no_compute_commands(self.f.calls[start:])

    def test_still_missing_outputs_stay_failed_and_original_evidence_survives_later_success(self):
        failed = self.seed()
        first = self.check()
        self.assertEqual(first['state'], 'failed')
        self.assertEqual(first['missing_outputs'], failed['missing_outputs'])
        self.assertTrue(jobs.output_revalidation(first)['eligible'])
        original = json.loads(json.dumps(first['original_failure']))
        self.f.finish_job()
        final = self.check()
        self.assertEqual(final['state'], 'completed')
        self.assertEqual(final['original_failure'], original)
        self.assertEqual(final['output_checks_total'], 2)
        self.assertEqual([check['after']['state'] for check in final['output_checks']], ['failed', 'completed'])
        self.assertEqual(json.loads((self.root / 'steps/expression.json').read_text())['original_failure'], original)

    def test_legacy_unconfirmed_marker_can_validate_then_resume_collection(self):
        failed = self.seed()
        failed.update(exit_code=None, reason='The job did not finish its last line.')
        jobs._save(self.root, failed)
        (self.f.remote_dir / 'steps/expression.done').unlink()
        checking = self.check()
        self.assertEqual(checking['state'], 'validating')
        self.assertTrue(jobs.output_revalidation(checking)['active'])
        self.assertIsNone(checking.get('finished_at'))
        self.f.finish_job()
        start = len(self.f.calls)
        final = jobs.status('step_test', 'expression', refresh=True)
        self.assertEqual((final['state'], final['job_id'], final.get('attempt', 1)), ('completed', '12345', 1))
        self.assertEqual(final['original_failure']['reason'], failed['reason'])
        self.assertFalse(jobs.output_revalidation(final)['active'])
        self.assert_no_compute_commands(self.f.calls[start:])

    def test_stale_and_nonrecoverable_targets_are_rejected_before_remote_access(self):
        failed = self.seed()
        variants = [{'state': state} for state in ('completed', 'cancelled', 'running', 'pending', 'unknown')]
        variants += [{'exit_code': '1'}, {'failure_hints': ['Execution halted']},
                     {'slurm_state': 'FAILED'}, {'slurm_state': 'CANCELLED'},
                     {'cancel_requested_at': '2026-11-17T10:00:00Z'}, {'job_id': None}]
        for change in variants:
            with self.subTest(change=change):
                jobs._save(self.root, {**failed, **change})
                before = (self.root / 'steps/expression.json').read_bytes()
                calls = len(self.f.calls)
                with self.assertRaises(jobs.StepError):
                    self.check()
                self.assertEqual(len(self.f.calls), calls)
                self.assertEqual((self.root / 'steps/expression.json').read_bytes(), before)
        jobs._save(self.root, failed)
        for target in ({'expected_job_id': '999'}, {'expected_attempt': 2}, {'expected_attempt': True}):
            with self.subTest(target=target):
                calls = len(self.f.calls)
                with self.assertRaises(jobs.StepError):
                    self.check(**target)
                self.assertEqual(len(self.f.calls), calls)

    def test_foreign_owner_job_marker_or_remote_environment_cannot_supply_results(self):
        self.seed()
        self.f.finish_job()
        owner = self.f.remote_dir / '.owner'
        marker = self.f.remote_dir / 'steps/expression.job'
        for path in (owner, marker):
            original = path.read_bytes()
            path.write_text('foreign\n')
            with self.assertRaises(jobs.StepError):
                self.check()
            self.assertFalse(any((self.root / 'work' / relative).exists() for relative in fixtures.OUTPUTS))
            path.write_bytes(original)
        self.f.config['workRoot'] += '/different-environment'
        with self.assertRaises(jobs.StepError):
            self.check()
        self.assertFalse(any((self.root / 'work' / relative).exists() for relative in fixtures.OUTPUTS))

    def test_live_children_are_not_cancelled_or_downloaded_during_a_check(self):
        self.seed()
        self.f.finish_job()
        self.f.slurm(workdir_555=str(self.f.remote_dir / 'work/tmp/child'))
        start = len(self.f.calls)
        try:
            record = self.check()
            self.assertNotEqual(record['state'], 'completed')
        except jobs.StepError:
            pass
        self.assertFalse(any((self.root / 'work' / relative).exists() for relative in fixtures.OUTPUTS))
        self.assertFalse((self.f.fake / 'scancel').exists())
        self.assert_no_compute_commands(self.f.calls[start:])

    def test_linked_exit_markers_logs_and_outputs_are_rejected_before_changing_the_record(self):
        self.seed()
        self.f.finish_job()
        outside = self.f.hpc / 'foreign-job-artifact'
        outside.write_text('0 2026-11-01T10:00:00\n')
        original_record = (self.root / 'steps/expression.json').read_bytes()
        for relative in ('steps/expression.done', 'steps/expression.err', 'work/' + fixtures.OUTPUTS[0]):
            with self.subTest(relative=relative):
                target = self.f.remote_dir / relative
                original = target.read_bytes()
                target.unlink()
                target.symlink_to(outside)
                try:
                    with self.assertRaises(jobs.StepError):
                        self.check()
                    self.assertEqual((self.root / 'steps/expression.json').read_bytes(), original_record)
                    self.assertFalse(any((self.root / 'work' / path).exists() for path in fixtures.OUTPUTS))
                    self.assertEqual(outside.read_text(), '0 2026-11-01T10:00:00\n')
                finally:
                    target.unlink()
                    target.write_bytes(original)

    def test_remote_only_validation_preserves_conflicting_local_files_without_transfer(self):
        self.seed()
        self.f.finish_job()
        for relative in fixtures.OUTPUTS:
            path = self.root / 'work' / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('conflicting old local data\n')
        originals = {path: path.read_bytes() for path in (self.root / 'work/res/rest').rglob('*') if path.is_file()}
        start = len(self.f.calls)
        record = self.check()
        self.assertEqual(record['state'], 'completed')
        self.assertEqual(originals, {path: path.read_bytes() for path in originals})
        self.assertFalse(any('tar czf' in call for call in self.f.calls[start:]))
        self.f.lose_connection_on = 'tar czf -'
        record = jobs.status('step_test', 'expression', refresh=True)
        self.assertEqual(record['state'], 'completed')
        self.assertEqual(originals, {path: path.read_bytes() for path in originals})

    def test_http_requires_exact_target_and_page_token(self):
        self.seed()
        server = ChatServer(('127.0.0.1', 0), Mock())
        self.addCleanup(server.server_close)
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 3)
        self.addCleanup(server.shutdown)
        route = '/signet/runs/step_test/steps/expression/revalidate'

        def request(body, token=True):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
            headers = {'Content-Type': 'application/json', 'Origin': f'http://127.0.0.1:{server.server_port}'}
            if token:
                headers['X-Chat-Token'] = server.token
            try:
                connection.request('POST', route, json.dumps(body), headers)
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()

        body = {'expected_job_id': '12345', 'expected_attempt': 1}
        self.assertEqual(request(body, token=False)[0], 403)
        self.assertEqual(request({})[0], 400)
        self.assertEqual(request({**body, 'expected_attempt': '1'})[0], 400)
        self.assertEqual(request({**body, 'expected_job_id': '999'})[0], 409)
        self.f.finish_job()
        status, record = request(body)
        self.assertEqual(status, 200)
        self.assertEqual((record['state'], record['job_id'], record.get('attempt', 1)), ('completed', '12345', 1))
        self.assertFalse(record['output_revalidation']['eligible'])


if __name__ == '__main__':
    unittest.main()
