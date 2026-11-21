from contextlib import contextmanager, ExitStack
import http.client
import json
import subprocess
import threading
import unittest
from unittest.mock import patch

import agent.app.chat_ui as chat_ui
import agent.tools.hpc as hpc_tools
from agent.runtime import hpc, ssh_transport


class WorkflowEndpointTest(unittest.TestCase):
    def setUp(self):
        @contextmanager
        def factory(timing):
            yield None

        self.server = chat_ui.ChatServer(('127.0.0.1', 0), factory)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            result = conn.getresponse()
            return result.status, result.read().decode()
        finally:
            conn.close()

    def post(self, path, body='{}', headers=None):
        return self.request('POST', path, body, headers if headers is not None else {
            'Origin': self.origin, 'X-Chat-Token': self.server.token, 'Content-Type': 'application/json'})

    def test_python_remains_api_only(self):
        for path in ('/', '/workflow.js', '/workflow.css'):
            self.assertEqual(self.request('GET', path)[0], 404)

    def test_buttons_need_the_page_token_and_origin(self):
        with patch.object(hpc_tools, 'check_hpc_environment') as check:
            self.assertEqual(self.post('/hpc/check', headers={'Origin': self.origin})[0], 403)
            self.assertEqual(self.post('/hpc/check', headers={'X-Chat-Token': self.server.token})[0], 403)
        check.assert_not_called()

    def test_each_path_runs_exactly_one_tool(self):
        names = {'/hpc/check': 'check_hpc_environment', '/hpc/workspace': 'create_hpc_workspace',
                 '/hpc/signet': 'install_signet_source', '/hpc/container': 'download_signet_container',
                 '/hpc/prepare': 'prepare_imputation_reference'}
        for path, name in names.items():
            with self.subTest(path=path), patch.object(hpc_tools, name, return_value={'status': 'ok', 'from': name}) as tool:
                status, body = self.post(path)
            self.assertEqual((status, json.loads(body)), (200, {'status': 'ok', 'from': name}))
            tool.assert_called_once_with()

    def test_reference_buttons_pass_only_their_own_file(self):
        for key in ('ref', 'gmap', 'gtf', 'clinical'):
            with self.subTest(key=key), patch.object(hpc_tools, 'download_reference_file', return_value={'status': 'ok'}) as tool:
                self.assertEqual(self.post(f'/hpc/reference/{key}')[0], 200)
            tool.assert_called_once_with(key)
        self.assertEqual(self.post('/hpc/reference/secrets')[0], 404)

    def test_check_and_fixed_log_routes_never_call_setup_tools(self):
        response = {'status': 'ok', 'executed': False, 'step': 'ref', 'lines': ['Download failed.']}
        with ExitStack() as stack:
            check = stack.enter_context(patch.object(hpc_tools, 'check_hpc_environment',
                                                     return_value={'status': 'ok', 'read_only': True}))
            reader = stack.enter_context(patch.object(hpc_tools, 'read_hpc_setup_log', return_value=response))
            setup = [stack.enter_context(patch.object(hpc_tools, name)) for name in (
                'create_hpc_workspace', 'install_signet_source', 'download_signet_container',
                'download_reference_file', 'prepare_imputation_reference')]
            self.assertEqual(json.loads(self.post('/hpc/check')[1]), {'status': 'ok', 'read_only': True})
            for step in ('workspace', 'signet', 'container', 'ref', 'gmap', 'gtf', 'clinical', 'prepare'):
                with self.subTest(step=step):
                    reader.reset_mock()
                    status, body = self.post('/hpc/log/' + step)
                    self.assertEqual((status, json.loads(body)), (200, response))
                    reader.assert_called_once_with(step)
            check.assert_called_once_with()
            for tool in setup:
                tool.assert_not_called()

    def test_log_requests_require_authentication_and_an_empty_bounded_object(self):
        with patch.object(hpc_tools, 'read_hpc_setup_log') as reader:
            for headers in ({'Origin': self.origin}, {'X-Chat-Token': self.server.token},
                            {'Origin': self.origin, 'X-Chat-Token': 'wrong'},
                            {'Origin': 'https://elsewhere.example', 'X-Chat-Token': self.server.token}):
                self.assertEqual(self.post('/hpc/log/ref', headers=headers)[0], 403)
            for body in ('not json', '[]', 'null', 'false', '1', '{"path":"/etc/passwd"}',
                         '{"step":"clinical"}', 'x' * 1025):
                with self.subTest(body=body):
                    self.assertEqual(self.post('/hpc/log/ref', body)[0], 400)
            reader.assert_not_called()

    def test_log_whitelist_rejects_arbitrary_paths_queries_and_injection(self):
        with patch.object(hpc_tools, 'read_hpc_setup_log') as reader:
            for suffix in ('unknown', '../ref', '../../etc/passwd', '%2e%2e%2fref',
                           'ref.log', 'ref;id', 'ref?step=clinical', 'ref/extra', ''):
                with self.subTest(suffix=suffix):
                    self.assertEqual(self.post('/hpc/log/' + suffix)[0], 404)
            self.assertEqual(self.request('GET', '/hpc/log/ref')[0], 404)
            reader.assert_not_called()

    def test_log_endpoint_uses_existing_read_only_bounded_remote_log_reader(self):
        config = {'root': '/pub/tester/signet-agent', 'source': '/pub/tester/signet-agent/software/pinned',
                  'image': '/pub/tester/signet-agent/images/signet.sif', 'executor': '/usr/bin/singularity',
                  'workRoot': '/pub/tester/signet-agent/runs', 'partition': 'free'}
        output = b'@@workspace_path\t/pub/tester/signet-agent\n@@log_exists\tyes\n@@line\tDownload failed.\n'
        with patch.object(ssh_transport, 'available', return_value=True), \
                patch.object(ssh_transport, 'setup_environment', return_value=config), \
                patch.object(ssh_transport, 'remote', return_value=subprocess.CompletedProcess([], 0, output, b'')) as remote, \
                patch.object(hpc, 'start_step') as setup:
            status, body = self.post('/hpc/log/ref')
        value = json.loads(body)
        self.assertEqual((status, value['executed'], value['step'], value['lines']),
                         (200, False, 'ref', ['Download failed.']))
        remote.assert_called_once()
        self.assertEqual(remote.call_args.args, ('bash -s',))
        script = remote.call_args.kwargs['input'].decode()
        self.assertIn('tail -n 20 "$D/ref.log"', script)
        for mutation in ('sbatch ', 'mkdir ', 'curl ', 'wget ', 'rm ', 'git clone'):
            self.assertNotIn(mutation, script)
        setup.assert_not_called()

    def test_file_window_routes_pass_their_values_and_need_the_token(self):
        from agent.runtime import hpc_files
        with patch.object(hpc_files, 'select', return_value={'status': 'ok'}) as select:
            self.assertEqual(self.post('/hpc/files/select', '{"key":"gtf"}', headers={'Origin': self.origin})[0], 403)
            select.assert_not_called()
            status, _ = self.post('/hpc/files/select', json.dumps({'key': 'gtf', 'path': '/pub/u/a.gtf'}))
        self.assertEqual(status, 200)
        select.assert_called_once_with('gtf', '/pub/u/a.gtf')
        self.assertEqual(self.post('/hpc/files/unknown')[0], 404)
        self.assertEqual(self.post('/hpc/files/list', 'not json')[0], 400)
        self.assertEqual(self.post('/hpc/files/list', '{"path":"' + 'a' * 5000 + '"}')[0], 400)

    def test_unknown_actions_and_oversized_bodies_are_rejected(self):
        self.assertEqual(self.post('/hpc/read_file')[0], 404)
        self.assertEqual(self.post('/hpc/check', body='x' * 2048)[0], 400)


class PreparationLogDiagnosticTest(unittest.TestCase):
    def test_fixed_converter_failures_are_visible_without_other_log_content(self):
        reasons = (
            'Unsupported reference format. Supported: VCF (.vcf or .vcf.gz) or IMPUTE2 .gen.',
            'Unsupported genetic map format. Supported: "pos chr cM" (SHAPEIT4/Eagle) or IMPUTE2 "position rate cM".',
            'No study marker matches the reference by position and alleles; check that both use the same genome build.',
            'The genetic map does not cover the study markers.',
        )
        for reason in reasons:
            with self.subTest(reason=reason):
                source = json.dumps({'status': 'failed', 'error': reason, 'path': '/private/input.vcf'})
                self.assertEqual(hpc._preparation_log_summary(['old private data', source]), [reason])

    def test_arbitrary_failures_paths_dynamic_data_and_malformed_errors_stay_redacted(self):
        errors = ('File missing: /private/reference.vcf', "invalid literal for int(): 'participant-1234'",
                  'Only one chromosome per study is supported for now; found PRIVATE_VALUE.',
                  'The genetic map does not cover the study markers. /private/extra', ['private'], {'private': 1})
        for error in errors:
            with self.subTest(error=error):
                result = hpc._preparation_log_summary([json.dumps({'status': 'failed', 'error': error})])
                self.assertEqual(result, ['Reference preparation did not report success. Check the selected inputs and the remote job log.'])


if __name__ == '__main__':
    unittest.main()
