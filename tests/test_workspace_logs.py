"""Read actual owned logs without refreshing jobs or changing scientific state."""
import http.client
import json
import os
from pathlib import Path
import threading
import unittest
from unittest.mock import Mock, patch
from urllib.parse import urlencode

from agent.app.chat_ui import ChatServer
from agent.runtime import signet_jobs as jobs, ssh_transport, workspace_history, workspace_logs
from tests import test_signet_jobs as job_tests


class WorkspaceLogsTest(unittest.TestCase):
    setup_hpc = job_tests.StepsTest.setUp
    remote = job_tests.StepsTest.remote
    slurm = job_tests.StepsTest.slurm
    finish_job = job_tests.StepsTest.finish_job
    failed_expression = job_tests.StepsTest.failed_expression
    code_of = job_tests.StepsTest.code_of

    def setUp(self):
        self.setup_hpc()
        state = patch.dict(os.environ, {'SIGNET_HISTORY_STATE_FILE': str(self.project / 'history-state.json')})
        state.start()
        self.addCleanup(state.stop)
        self.base = {'datasets': [], 'runs': []}
        self.history_id = 'recorded--step_test'

    def history(self):
        return workspace_history.merge(self.base)

    def row(self, history_id=None):
        key = history_id or self.history_id
        return next(row for row in self.history()['runs'] if row['history_id'] == key)

    def read(self, attempt=1, stream='out', lines=50, history_id=None, job_id=None, identity=None):
        key = history_id or self.history_id
        row = self.row(key)
        entry = next(entry for entry in row['attempts']['expression']
                     if entry['number'] == attempt and entry['availability'] == 'recorded') if job_id is None else None
        return workspace_logs.read_step(key, 'expression', attempt,
            job_id if job_id is not None else entry['record'].get('job_id') or 'none',
            identity or row['record_identity'], stream, lines, history_loader=self.history)

    def test_current_and_prior_remote_logs_are_exact_and_read_only_even_with_stale_local_current_log(self):
        self.failed_expression()
        (self.root / 'steps/expression.err').write_text('stale local attempt 1 error\n')
        (self.root / 'steps/expression.job').write_text('12345\n')
        current = jobs.submit('step_test', 'expression', self.inputs)
        folder = self.remote_dir / 'steps'
        (folder / 'expression.out').write_text(''.join(f'line {index}\n' for index in range(300)))
        (folder / 'expression.err').write_text('<img src=x onerror=alert(1)>actual attempt 2\n')
        originals = {path: path.read_bytes() for path in [self.root / 'manifest.json', self.root / 'work/config.ini',
            self.root / 'steps/expression.json', self.root / 'steps/expression.attempt1.json',
            folder / 'expression.out', folder / 'expression.err', folder / 'expression.attempt1.out']}
        calls = len(self.calls)
        previous = self.read(1)
        latest = self.read(2, 'out', 3)
        error = self.read(2, 'err')
        self.assertEqual(previous['lines'], ['first attempt log'])
        self.assertEqual(previous['job_id'], '12345')
        self.assertEqual(latest['lines'], ['line 297', 'line 298', 'line 299'])
        self.assertEqual(latest['job_id'], current['job_id'])
        self.assertTrue(latest['truncated'])
        self.assertEqual(error['origin'], 'remote')
        self.assertEqual(error['lines'], ['<img src=x onerror=alert(1)>actual attempt 2'])
        self.assertEqual(originals, {path: path.read_bytes() for path in originals})
        self.assertTrue(all('tail -c 65537' in command for command in self.calls[calls:]))
        self.assertTrue(all(token not in command for command in self.calls[calls:]
                            for token in ('sbatch --parsable', 'scancel ', 'tar ', 'mkdir ')))

    def test_matching_local_job_marker_allows_offline_read_and_missing_is_not_empty(self):
        record = jobs.submit('step_test', 'expression', self.inputs)
        path = self.root / 'steps/expression.err'
        path.write_text('saved local log\n')
        with patch.object(ssh_transport, 'available', return_value=False):
            self.assertEqual(self.code_of(self.read, stream='err'), 'not_ready')
            (self.root / 'steps/expression.job').write_text(record['job_id'] + '\n')
            value = self.read(stream='err')
            self.assertEqual((value['origin'], value['status'], value['lines']), ('local', 'ready', ['saved local log']))
            path.write_bytes(b'')
            self.assertEqual((self.read(stream='err')['status'], self.read(stream='err')['lines']), ('empty', []))
            path.unlink()
            self.assertEqual(self.code_of(self.read, stream='err'), 'not_ready')
        self.assertEqual(self.code_of(self.read, stream='err'), 'not_found')

    def test_archive_logs_never_fall_back_to_the_same_named_remote_or_local_run(self):
        jobs.submit('step_test', 'expression', self.inputs)
        (self.remote_dir / 'steps/expression.err').write_text('live remote secret\n')
        archive = self.project / 'data/stage6-results/step_test'
        (archive / 'steps').mkdir(parents=True)
        (archive / 'history.json').write_text(json.dumps({'run_id': 'step_test'}))
        saved = {'state': 'failed', 'attempt': 3, 'job_id': '900', 'reason': 'Archived failure'}
        self.base['runs'] = [{'source': 'archive', 'run_id': 'step_test', 'dataset_id': None, 'jobs': {'expression': saved}}]
        path = archive / 'steps/expression.err'
        path.write_text('archived exact log\n')
        with patch.object(ssh_transport, 'remote', side_effect=AssertionError('Archives cannot query remote logs')):
            value = self.read(3, 'err', history_id='archive--step_test')
            self.assertEqual((value['source'], value['origin'], value['lines']), ('archive', 'local', ['archived exact log']))
            self.assertEqual(self.code_of(self.read, 3, 'out', history_id='archive--step_test'), 'not_found')

    def test_guarded_targets_and_remote_job_markers_prevent_log_borrowing(self):
        jobs.submit('step_test', 'expression', self.inputs)
        path = self.remote_dir / 'steps/expression.err'
        path.write_text('correct attempt log\n')
        calls = len(self.calls)
        self.assertEqual(self.code_of(self.read, stream='err', job_id='999'), 'conflict')
        self.assertEqual(self.code_of(self.read, stream='err', identity='0' * 64), 'conflict')
        self.assertEqual(len(self.calls), calls)
        marker = self.remote_dir / 'steps/expression.job'
        marker.write_text('different-job\n')
        self.assertEqual(self.code_of(self.read, stream='err'), 'conflict')
        marker.write_text('12345\n')
        (self.remote_dir / '.owner').write_text('foreign-owner\n')
        self.assertEqual(self.code_of(self.read, stream='err'), 'conflict')

    def test_logs_are_bounded_and_unsafe_or_unreadable_files_are_explicit(self):
        record = jobs.submit('step_test', 'expression', self.inputs)
        path = self.remote_dir / 'steps/expression.out'
        path.write_bytes(b'x' * (workspace_logs.MAX_BYTES * 3))
        value = self.read()
        self.assertTrue(value['truncated'])
        self.assertEqual(len(value['lines'][0]), workspace_logs.MAX_BYTES)
        path.unlink()
        outside = self.project / 'outside.log'
        outside.write_text('must not follow this link')
        path.symlink_to(outside)
        self.assertEqual(self.code_of(self.read), 'conflict')
        local = self.root / 'steps/expression.out'
        (self.root / 'steps/expression.job').write_text(record['job_id'] + '\n')
        os.mkfifo(local)
        self.assertEqual(self.code_of(self.read), 'remote_failed')
        local.unlink()
        local.write_text('readable only in fixture')
        original_open = workspace_logs.os.open
        def denied(path, *args, **kwargs):
            if Path(path) == local:
                raise PermissionError('fixture denies log access')
            return original_open(path, *args, **kwargs)
        with patch.object(workspace_logs.os, 'open', side_effect=denied):
            self.assertEqual(self.code_of(self.read), 'remote_failed')

    def test_refused_submission_has_its_own_explicit_submission_stream(self):
        self.failed_expression()
        (self.fake / 'bin/sbatch').write_text('#!/bin/bash\necho no-compute-resources >&2\nexit 1\n')
        self.assertEqual(self.code_of(jobs.submit, 'step_test', 'expression', self.inputs), 'remote_failed')
        value = self.read(2, 'submission')
        self.assertIsNone(value['job_id'])
        self.assertEqual(value['stream'], 'submission')
        self.assertEqual(value['lines'], ['no-compute-resources'])
        self.assertEqual(self.code_of(self.read, 2, 'err'), 'not_found')

    def test_operation_logs_use_owned_names_and_exact_metadata_revision(self):
        operation = 'genotype_tcga'
        saved = {'operation': operation, 'status': 'failed', 'executed': True,
                 'stdout_log': str(self.project / 'outside-secret'), 'reason': 'Saved failure hint'}
        metadata = self.root / (operation + '.json')
        metadata.write_text(json.dumps(saved))
        (self.root / 'logs' / (operation + '.stdout')).write_text('actual fixed owned log\n')
        row = self.row()
        entry = row['operations'][0]
        def read(revision):
            return workspace_logs.read_operation(self.history_id, operation, row['record_identity'], revision,
                history_loader=self.history)
        value = read(entry['record_revision'])
        self.assertEqual((value['origin'], value['lines']), ('local', ['actual fixed owned log']))
        metadata.write_text(json.dumps({**saved, 'reason': 'Changed operation'}))
        self.assertEqual(self.code_of(read, entry['record_revision']), 'conflict')
        metadata.unlink()
        (self.root / (operation + '.plan.json')).write_text(json.dumps(saved))
        plan = self.row()['operations'][0]
        self.assertEqual(self.code_of(read, plan['record_revision']), 'not_found')

    def test_http_route_requires_exact_source_identity_and_bounded_query(self):
        jobs.submit('step_test', 'expression', self.inputs)
        (self.remote_dir / 'steps/expression.err').write_text('HTTP exact log\n')
        server = ChatServer(('127.0.0.1', 0), Mock())
        self.addCleanup(server.server_close)
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 3)
        self.addCleanup(server.shutdown)
        server.stage6.history = self.history
        path = '/signet/history/recorded--step_test/steps/expression/log'
        query = {'attempt': '1', 'job_id': '12345', 'identity': self.row()['record_identity'], 'stream': 'err'}
        def request(values, token=True):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
            try:
                connection.request('GET', path + '?' + urlencode(values),
                    headers={'X-Chat-Token': server.token} if token else {})
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()
        self.assertEqual(request(query, token=False)[0], 403)
        for fields in ({'attempt': 'unknown'}, {**query, 'attempt': '1.5'}, {**query, 'lines': '201'},
                       {**query, 'stream': 'both'}, {**query, 'path': '/etc/passwd'},
                       {**query, 'lines': '²'}, {**query, 'lines': '9' * 5000},
                       {**query, 'attempt': '²'}, {**query, 'attempt': '9' * 5000}):
            self.assertEqual(request(fields)[0], 400)
        self.assertEqual(request({**query, 'job_id': '999'})[0], 409)
        status, value = request(query)
        self.assertEqual((status, value['lines'], value['identity']), (200, ['HTTP exact log'], query['identity']))


if __name__ == '__main__':
    unittest.main()
