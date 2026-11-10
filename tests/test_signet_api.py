"""Route tests for /signet/* (agent/app/signet_api.py) through a real ChatServer on a free port.

HPC3 is the same fake as in test_signet_jobs.py: a temporary folder plus
stand-in Slurm commands, reached through a patched SSH transport. These tests
check what only the HTTP layer adds: token/Origin/Host checks on every route,
status codes, error codes and JSON shapes.
"""
from contextlib import contextmanager
import http.client
import json
import threading
import unittest
from unittest.mock import patch

import agent.app.chat_ui as chat_ui
import agent.runtime.ssh_transport as ssh_transport
import test_signet_jobs


class SignetApiTest(unittest.TestCase):
    # Reuse the fake HPC3 folder, fake Slurm and the run "step_test" from the service tests.
    setUp_hpc = test_signet_jobs.StepsTest.setUp
    remote = test_signet_jobs.StepsTest.remote
    slurm = test_signet_jobs.StepsTest.slurm
    finish_job = test_signet_jobs.StepsTest.finish_job

    def setUp(self):
        self.setUp_hpc()

        @contextmanager
        def factory(timing):
            yield None

        self.server = chat_ui.ChatServer(('127.0.0.1', 0), factory)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f'http://127.0.0.1:{self.server.server_port}'
        self.addCleanup(self.thread.join)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def call(self, method, path, body=None, headers=None):
        """Send one request as the app page would (token + Origin) unless headers are given."""
        if headers is None:
            headers = {'X-Chat-Token': self.server.token, 'Origin': self.origin, 'Content-Type': 'application/json'}
        data = body if isinstance(body, (str, bytes)) or body is None else json.dumps(body)
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=20)
        try:
            conn.request(method, path, body=data, headers=headers)
            result = conn.getresponse()
            text = result.read().decode()
            return result.status, json.loads(text) if text.startswith('{') else text
        finally:
            conn.close()

    def submit(self, run_id='step_test'):
        return self.call('POST', f'/signet/runs/{run_id}/steps/expression', {'inputs': self.inputs})

    def test_every_route_needs_the_page_token_and_writes_need_the_origin(self):
        routes = [('GET', '/signet/catalog'), ('GET', '/signet/runs'), ('POST', '/signet/runs'),
                  ('GET', '/signet/runs/step_test'), ('PATCH', '/signet/runs/step_test/settings'),
                  ('POST', '/signet/runs/step_test/steps/expression'), ('GET', '/signet/runs/step_test/steps/expression'),
                  ('POST', '/signet/runs/step_test/steps/expression/cancel'),
                  ('GET', '/signet/runs/step_test/steps/expression/log')]
        for method, path in routes:
            self.assertEqual(self.call(method, path, '{}', {'Origin': self.origin})[0], 403, path)
            self.assertEqual(self.call(method, path, '{}', {'X-Chat-Token': 'wrong', 'Origin': self.origin})[0], 403, path)
            self.assertEqual(self.call(method, path, '{}', {'X-Chat-Token': self.server.token, 'Origin': self.origin,
                                                            'Host': 'evil.example:80'})[0], 403, path)
            if method != 'GET':
                self.assertEqual(self.call(method, path, '{}', {'X-Chat-Token': self.server.token})[0], 403, path)
        self.assertEqual(self.calls, [])
        self.assertFalse((self.root / 'steps').exists())

    def test_catalog_and_unknown_routes_and_methods(self):
        status, value = self.call('GET', '/signet/catalog')
        self.assertEqual((status, value['steps'][0]['name']), (200, 'expression'))
        self.assertEqual(self.call('GET', '/signet/nothing')[1]['code'], 'not_found')
        self.assertEqual(self.call('POST', '/signet/catalog', {})[0], 405)
        self.assertEqual(self.call('GET', '/signet/runs/step_test/settings')[0], 405)
        self.assertEqual(self.call('GET', '/signet/catalog?x=1')[0], 400)
        self.assertEqual(self.call('PATCH', '/chat', {})[0], 404)

    def test_create_list_and_read_runs(self):
        status, value = self.call('POST', '/signet/runs', {'run_id': 'luad_t1', 'cohort': 'TCGA'})
        self.assertEqual((status, value['run_id'], value['settings']['cohort']), (201, 'luad_t1', 'TCGA'))
        self.assertEqual(self.call('POST', '/signet/runs', {'run_id': 'luad_t1'})[1]['code'], 'conflict')
        for bad in ({'run_id': '../x'}, {'run_id': 'ok', 'cohort': 'mouse'}, {'cohort': 'TCGA'},
                    {'run_id': 'ok', 'extra': 1}, '[1]', 'not json'):
            status, value = self.call('POST', '/signet/runs', bad)
            self.assertEqual((status, value['code']), (400, 'invalid_request'), bad)
        status, value = self.call('GET', '/signet/runs')
        self.assertEqual(status, 200)
        self.assertEqual({item['run_id'] for item in value['runs']}, {'step_test', 'luad_t1'})
        status, value = self.call('GET', '/signet/runs/luad_t1')
        self.assertEqual((status, value['cohort'], value['steps']), (200, 'TCGA', {}))
        self.assertEqual(self.call('GET', '/signet/runs/missing')[0], 404)

    def test_settings_patch_is_whitelisted(self):
        status, value = self.call('PATCH', '/signet/runs/step_test/settings', {'values': {'restrict.tcga': 1}})
        self.assertEqual((status, value['settings']['restrict.tcga']), (200, '1'))
        for bad in ({'values': {'forcerm': 'T'}}, {'values': {'restrict.tcga': 30}}, {'restrict.tcga': 1}, {}):
            self.assertEqual(self.call('PATCH', '/signet/runs/step_test/settings', bad)[0], 400, bad)
        self.assertEqual(self.call('PATCH', '/signet/runs/missing/settings', {'values': {'restrict.tcga': 1}})[0], 404)

    def test_step_lifecycle_submit_status_log_and_finished_cancel(self):
        status, value = self.submit()
        self.assertEqual((status, value['state'], value['job_id']), (202, 'submitted', '12345'))
        self.assertEqual(self.submit()[1]['code'], 'conflict')
        self.assertEqual(self.call('PATCH', '/signet/runs/step_test/settings', {'values': {'restrict.tcga': 2}})[0], 409)
        self.slurm(squeue='RUNNING')
        status, value = self.call('GET', '/signet/runs/step_test/steps/expression?refresh=1')
        self.assertEqual((status, value['state']), (200, 'running'))
        (self.remote_dir / 'steps/expression.out').write_text('one\ntwo\nthree\n')
        status, value = self.call('GET', '/signet/runs/step_test/steps/expression/log?lines=2')
        self.assertEqual((status, value), (200, {'lines': ['two', 'three'], 'truncated': True}))
        self.finish_job()
        status, value = self.call('GET', '/signet/runs/step_test/steps/expression?refresh=1')
        self.assertEqual((status, value['state']), (200, 'completed'))
        self.assertEqual(self.call('GET', '/signet/runs/step_test')[1]['steps']['expression']['state'], 'completed')
        self.assertEqual(self.call('POST', '/signet/runs/step_test/steps/expression/cancel')[0], 409)

    def test_cancel_running_step(self):
        self.submit()
        self.slurm(squeue='RUNNING', name='signet-expression-step_test')
        status, value = self.call('POST', '/signet/runs/step_test/steps/expression/cancel', {})
        self.assertEqual((status, value['state']), (200, 'cancelling'))
        self.assertEqual(self.submit()[0], 409)
        self.slurm(squeue='', sacct='CANCELLED')
        status, value = self.call('GET', '/signet/runs/step_test/steps/expression?refresh=1')
        self.assertEqual((status, value['state']), (200, 'cancelled'))
        self.assertEqual(self.call('POST', '/signet/runs/step_test/steps/expression/cancel', {'force': True})[0], 400)

    def test_scheduler_outage_keeps_unknown_submission_recoverable_over_http(self):
        self.lose_connection_on = 'sbatch --parsable'
        status, value = self.submit()
        self.assertEqual((status, value['state']), (202, 'unknown'))
        self.lose_connection_on = None
        for name in ('squeue', 'sacct'):
            (self.fake / 'bin' / name).write_text('#!/bin/bash\nexit 1\n')
        path = '/signet/runs/step_test/steps/expression'
        status, value = self.call('GET', path + '?refresh=1')
        self.assertEqual((status, value['state']), (200, 'unknown'))
        self.assertEqual(self.submit()[0], 409)
        self.assertEqual(self.call('PATCH', '/signet/runs/step_test/settings',
                                   {'values': {'restrict.tcga': 1}})[0], 409)
        for name in ('squeue', 'sacct'):
            (self.fake / 'bin' / name).write_text('#!/bin/bash\n' + test_signet_jobs.FAKE_SLURM[name] + '\n')
        self.slurm(queued_id='888', squeue='RUNNING')
        status, value = self.call('GET', path + '?refresh=1')
        self.assertEqual((status, value['state'], value['job_id']), (200, 'running', '888'))
        self.finish_job()
        status, value = self.call('GET', path + '?refresh=1')
        self.assertEqual((status, value['state']), (200, 'completed'))

    def test_network_cancel_after_parent_ended_keeps_http_settings_locked(self):
        (self.root / 'steps').mkdir()
        (self.remote_dir / 'steps').mkdir(parents=True)
        record = {'step': 'network', 'run_id': 'step_test', 'remote_dir': str(self.remote_dir),
                  'job_id': '12345', 'state': 'running'}
        (self.root / 'steps/network.json').write_text(json.dumps(record))
        test_signet_jobs.StepsTest.signet_children(self)
        self.slurm(squeue='', sacct='CANCELLED')
        path = '/signet/runs/step_test/steps/network'
        status, value = self.call('POST', path + '/cancel', {})
        self.assertEqual((status, value['state']), (200, 'cancelling'))
        self.assertEqual(self.call('PATCH', '/signet/runs/step_test/settings', {'values': {'nboots': 2}})[0], 409)
        self.assertEqual(self.call('POST', path, {'inputs': {}})[0], 409)
        (self.fake / 'workdir_777').unlink()
        status, value = self.call('GET', path + '?refresh=1')
        self.assertEqual((status, value['state']), (200, 'cancelled'))
        self.assertEqual(self.call('PATCH', '/signet/runs/step_test/settings', {'values': {'nboots': 2}})[0], 200)

    def test_network_done_marker_without_accounting_waits_for_children_over_http(self):
        from agent.runtime import signet_jobs
        (self.root / 'steps').mkdir()
        (self.remote_dir / 'steps').mkdir(parents=True)
        (self.root / 'steps/network.json').write_text(json.dumps({
            'step': 'network', 'run_id': 'step_test', 'remote_dir': str(self.remote_dir),
            'job_id': '12345', 'state': 'running'}))
        test_signet_jobs.StepsTest.signet_children(self)
        for relative in signet_jobs.STEPS['network'].required:
            path = self.remote_dir / 'work' / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('fresh output\n')
        (self.remote_dir / 'steps/network.done').write_text('0 2026-11-10T00:00:00-08:00\n')
        self.slurm(squeue='', sacct='')
        path = '/signet/runs/step_test/steps/network?refresh=1'
        self.assertEqual(self.call('GET', path)[1]['state'], 'validating')
        self.assertEqual(self.call('PATCH', '/signet/runs/step_test/settings', {'values': {'nboots': 2}})[0], 409)
        self.assertFalse((self.root / 'work/res/resn/signet_Afreq').exists())
        (self.fake / 'workdir_777').unlink()
        queue = self.fake / 'bin/squeue'
        queue.write_text('#!/bin/bash\nexit 1\n')
        self.assertEqual(self.call('GET', path)[1]['state'], 'validating')
        self.assertFalse((self.root / 'work/res/resn/signet_Afreq').exists())
        queue.write_text('#!/bin/bash\n' + test_signet_jobs.FAKE_SLURM['squeue'] + '\n')
        status, value = self.call('GET', path)
        self.assertEqual((status, value['state']), (200, 'completed'))
        self.assertEqual((self.root / 'work/res/resn/signet_Afreq').read_text(), 'fresh output\n')

    def test_retry_never_returns_previous_outputs_over_http(self):
        self.submit()
        self.finish_job(err='Error in fread(x): failed\n')
        path = '/signet/runs/step_test/steps/expression'
        self.assertEqual(self.call('GET', path + '?refresh=1')[1]['state'], 'failed')
        for relative in test_signet_jobs.OUTPUTS:
            (self.remote_dir / 'work' / relative).write_text('old-attempt-only\n')
        changed = self.hpc / 'ws/refdata/new_counts'
        changed.write_text('new input\n')
        self.slurm(sbatch_reply='222')
        status, record = self.call('POST', path, {'inputs': {**self.inputs, 'gexp.file': str(changed)}})
        self.assertEqual((status, record['job_id']), (202, '222'))
        self.finish_job(outputs=())
        status, record = self.call('GET', path + '?refresh=1')
        self.assertEqual(status, 200)
        self.assertNotEqual(record['state'], 'completed')
        self.assertFalse((self.root / 'work' / test_signet_jobs.OUTPUTS[0]).exists())

    def test_refresh_downloads_later_visible_outputs_over_http_without_new_job(self):
        self.submit()
        path = '/signet/runs/step_test/steps/expression'
        self.finish_job(outputs=())
        self.assertNotEqual(self.call('GET', path + '?refresh=1')[1]['state'], 'completed')
        self.finish_job()
        status, record = self.call('GET', path + '?refresh=1')
        self.assertEqual((status, record['state'], record['job_id']), (200, 'completed', '12345'))
        self.assertEqual((self.root / 'work' / test_signet_jobs.OUTPUTS[0]).read_text(), 'data\n')
        self.assertEqual(sum('sbatch --parsable' in call for call in self.calls), 1)

    def test_sbatch_refusal_keeps_an_independent_attempt_over_http(self):
        self.submit()
        self.finish_job(outputs=())
        path = '/signet/runs/step_test/steps/expression'
        self.assertEqual(self.call('GET', path + '?refresh=1')[1]['state'], 'failed')
        batch = self.fake / 'bin/sbatch'
        batch.write_text('#!/bin/bash\necho temporarily-refused >&2\nexit 1\n')
        self.assertEqual(self.submit()[0], 502)
        record = self.call('GET', path)[1]
        self.assertEqual((record['state'], record['attempt']), ('failed', 2))
        batch.write_text('#!/bin/bash\n' + test_signet_jobs.FAKE_SLURM['sbatch'] + '\n')
        self.slurm(sbatch_reply='222')
        status, record = self.submit()
        self.assertEqual((status, record['attempt']), (202, 3))
        self.assertIn('temporarily-refused', (self.remote_dir / 'steps/expression.attempt2.sbatch.err').read_text())

    def test_refresh_recovers_a_saved_missing_marker_failure_and_downloads_results(self):
        status, record = self.submit()
        self.assertEqual(status, 202)
        self.finish_job()
        record.update(state='failed', slurm_state='COMPLETED', exit_code=None,
                      reason='The job did not finish its last line.', finished_at='2026-11-01T10:00:01')
        (self.root / 'steps/expression.json').write_text(json.dumps(record))
        path = '/signet/runs/step_test/steps/expression'
        self.assertEqual(self.call('GET', path)[1]['state'], 'failed')
        status, value = self.call('GET', path + '?refresh=1')
        self.assertEqual((status, value['state'], value['job_id']), (200, 'completed', '12345'))
        self.assertEqual((self.root / 'work/res/rest/signet_gexp').read_text(), 'data\n')
        self.assertEqual(sum('sbatch --parsable' in call for call in self.calls), 1)

    def test_unexpected_error_still_gets_a_json_reply(self):
        (self.project / 'runs/broken').mkdir()
        (self.project / 'runs/broken/manifest.json').write_text('{not json')
        with patch('sys.stderr'):
            status, value = self.call('GET', '/signet/runs')
        self.assertEqual((status, value['code']), (500, 'internal_error'))
        self.assertNotIn('JSONDecodeError', value['error'])

    def test_step_errors_map_to_status_codes(self):
        self.assertEqual(self.call('POST', '/signet/runs/step_test/steps/expression', {'inputs': {'gexp.file': '/etc/passwd'}})[0], 400)
        self.assertEqual(self.call('POST', '/signet/runs/step_test/steps/expression', {})[0], 400)
        self.assertEqual(self.call('POST', '/signet/runs/step_test/steps/visualize', {'inputs': self.inputs})[0], 404)
        self.assertEqual(self.call('GET', '/signet/runs/step_test/steps/expression')[0], 404)
        for query in ('refresh=2', 'stream=out&stream=err', 'other=1'):
            self.assertEqual(self.call('GET', f'/signet/runs/step_test/steps/expression?{query}')[0], 400, query)
        with patch.object(ssh_transport, 'available', return_value=False):
            status, value = self.submit()
            self.assertEqual((status, value['code']), (412, 'not_ready'))
        self.lose_connection_on = 'tar xzf'
        status, value = self.submit()
        self.assertEqual((status, value['code']), (502, 'remote_failed'))
        self.lose_connection_on = None
        self.submit()
        for query in ('lines=0', 'lines=201', 'lines=abc', 'stream=all'):
            self.assertEqual(self.call('GET', f'/signet/runs/step_test/steps/expression/log?{query}')[0], 400, query)


if __name__ == '__main__':
    unittest.main()
