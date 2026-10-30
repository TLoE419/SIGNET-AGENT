from contextlib import contextmanager
import http.client
import json
import threading
import unittest
from unittest.mock import patch

import agent.app.chat_ui as chat_ui
import agent.tools.hpc as hpc_tools


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

    def test_panel_assets_are_served(self):
        for path in ('/workflow.js', '/workflow.css'):
            self.assertEqual(self.request('GET', path)[0], 200)
        self.assertIn('id="workflow"', self.request('GET', '/')[1])

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

    def test_unknown_actions_and_oversized_bodies_are_rejected(self):
        self.assertEqual(self.post('/hpc/read_file')[0], 404)
        self.assertEqual(self.post('/hpc/check', body='x' * 2048)[0], 400)


if __name__ == '__main__':
    unittest.main()
