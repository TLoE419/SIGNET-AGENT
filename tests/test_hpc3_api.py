"""Offline tests for the /hpc3 web API (chat_ui.py routes + hpc3_service.py).

A real ChatServer runs on a random local port, but hpc3_ssh is replaced by FakeSsh: no ssh
process starts, no dialog appears and nothing contacts HPC3. The UCInetID is made up and
.env lives in a temporary directory.
"""
from contextlib import contextmanager
import http.client
import json
import os
from pathlib import Path
import stat
import tempfile
import threading
import unittest
from unittest.mock import patch

import chat_ui
import hpc3_ssh
from hpc3_service import Hpc3Service, write_env_value
from test_chat import client_for, response

HOST = hpc3_ssh.DEFAULT_HOST


class FakeSsh:
    """Stands in for hpc3_ssh. login() blocks until the test releases it, like a user typing."""

    valid_user = staticmethod(hpc3_ssh.valid_user)
    CANCELLED = hpc3_ssh.CANCELLED

    def __init__(self):
        self.connected = False
        self.release = threading.Event()
        self.login_result = (0, 'Logged in.')
        self.calls = []

    def settings(self):
        user = os.environ.get('HPC3_USER', '')
        if not hpc3_ssh.valid_user(user):
            raise ValueError('not configured')
        return user, HOST

    def has_shared_connection(self, user, host):
        return self.connected

    def shared_connection_alive(self, user, host):
        return self.connected

    def check(self):
        self.calls.append('check')
        return {'status': 'connected' if self.connected else 'auth_required', 'connected': self.connected}

    def login(self, user, host, popup=False, language='en'):
        self.calls.append(('login', user, popup))
        self.language = language
        self.release.wait(5)
        self.connected = self.login_result[0] == 0
        return self.login_result

    def logout(self, user, host):
        self.calls.append('logout')
        was, self.connected = self.connected, False
        return 0, 'Logged out.' if was else 'Not logged in.'


class Hpc3ApiTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env_file = Path(self.temp.name) / '.env'
        self.env = patch.dict(os.environ, {'HPC3_USER': 'jdoe'})
        self.env.start()
        self.ssh = FakeSsh()
        self.now = [0.0]
        client, _ = client_for(response('unused'))

        @contextmanager
        def factory(timing):
            yield client

        self.server = chat_ui.ChatServer(('127.0.0.1', 0), factory)
        self.server.hpc3 = Hpc3Service(self.env_file, ssh=self.ssh, clock=lambda: self.now[0],
                                       platform='darwin')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = 'http://127.0.0.1:%d' % self.server.server_port

    def tearDown(self):
        self.ssh.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.env.stop()
        self.temp.cleanup()

    def request(self, method, path, payload=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        try:
            if headers is None:
                headers = {'Origin': self.origin, 'X-Chat-Token': self.server.token}
            body = json.dumps(payload) if payload is not None else None
            conn.request(method, path, body=body, headers=headers)
            result = conn.getresponse()
            return result.status, json.loads(result.read().decode() or 'null')
        finally:
            conn.close()

    def wait_for_login_end(self):
        self.server.hpc3.thread.join(3)
        return self.request('GET', '/hpc3/login')[1]

    # --- Request boundaries --------------------------------------------------------------

    def test_every_route_needs_the_page_token_and_origin(self):
        for method, path in (('GET', '/hpc3/status'), ('GET', '/hpc3/login'), ('POST', '/hpc3/login'),
                             ('POST', '/hpc3/logout'), ('POST', '/hpc3/user')):
            with self.subTest(path=path, method=method):
                self.assertEqual(self.request(method, path, {}, {'Origin': self.origin})[0], 403)
                self.assertEqual(self.request(method, path, {}, {'X-Chat-Token': 'wrong',
                                                                 'Origin': self.origin})[0], 403)
        bad_origin = {'Origin': 'http://evil.example', 'X-Chat-Token': self.server.token}
        self.assertEqual(self.request('POST', '/hpc3/login', {}, bad_origin)[0], 403)
        self.assertEqual(self.ssh.calls, [])

    def test_no_route_takes_a_password_and_bad_bodies_are_rejected(self):
        self.assertEqual(self.request('POST', '/hpc3/unknown', {})[0], 404)
        self.assertEqual(self.request('POST', '/hpc3/user', ['jdoe'])[0], 400)
        status, body = self.request('POST', '/hpc3/user', {'user': 'jdoe', 'password': 'x'})
        self.assertEqual(status, 200)  # Extra fields are ignored, never used.
        self.assertNotIn('x', json.dumps(body))

    # --- Status ----------------------------------------------------------------------------

    def test_status_is_cached_for_fifteen_seconds_unless_refreshed(self):
        self.assertEqual(self.request('GET', '/hpc3/status'), (200, {'status': 'auth_required', 'connected': False}))
        self.request('GET', '/hpc3/status')
        self.assertEqual(self.ssh.calls.count('check'), 1)
        self.now[0] = 16
        self.request('GET', '/hpc3/status')
        self.request('GET', '/hpc3/status?refresh=1')
        self.assertEqual(self.ssh.calls.count('check'), 3)

    # --- Login -----------------------------------------------------------------------------

    def test_login_runs_in_the_background_and_reports_progress(self):
        status, body = self.request('POST', '/hpc3/login', {})
        self.assertEqual((status, body['state']), (202, 'waiting_for_user'))
        self.assertEqual(self.request('GET', '/hpc3/login')[1]['state'], 'waiting_for_user')
        self.ssh.release.set()
        self.assertEqual(self.wait_for_login_end(), {'state': 'succeeded', 'message': 'Logged in.', 'cancelled': False})
        self.assertIn(('login', 'jdoe', True), self.ssh.calls)

    def test_page_language_reaches_the_login_dialogs(self):
        self.request('POST', '/hpc3/login', {'language': 'zh-Hant'})
        self.ssh.release.set()
        self.wait_for_login_end()
        self.assertEqual(self.ssh.language, 'zh-Hant')

    def test_failed_login_keeps_the_reason(self):
        self.ssh.login_result = (255, 'Login failed (ssh exit 255).')
        self.request('POST', '/hpc3/login', {})
        self.ssh.release.set()
        self.assertEqual(self.wait_for_login_end(), {'state': 'failed', 'message': 'Login failed (ssh exit 255).',
                                                     'cancelled': False})

    def test_cancelled_login_is_marked_so_the_page_can_say_so(self):
        self.ssh.login_result = (hpc3_ssh.CANCELLED, 'Login cancelled.')
        self.request('POST', '/hpc3/login', {})
        self.ssh.release.set()
        self.assertEqual(self.wait_for_login_end(), {'state': 'failed', 'message': 'Login cancelled.', 'cancelled': True})

    def test_only_one_login_at_a_time_and_no_logout_or_user_change_meanwhile(self):
        self.request('POST', '/hpc3/login', {})
        self.assertEqual(self.request('POST', '/hpc3/login', {})[0], 409)
        self.assertEqual(self.request('POST', '/hpc3/logout', {})[0], 409)
        self.assertEqual(self.request('POST', '/hpc3/user', {'user': 'other'})[0], 409)
        self.ssh.release.set()
        self.wait_for_login_end()
        self.assertEqual(sum(1 for call in self.ssh.calls if call[0] == 'login'), 1)

    def test_login_when_already_connected_shows_no_dialog(self):
        self.ssh.connected = True
        status, body = self.request('POST', '/hpc3/login', {})
        self.assertEqual((status, body['state']), (200, 'succeeded'))
        self.assertIn('Already logged in', body['message'])
        self.assertFalse([call for call in self.ssh.calls if call[0] == 'login'])

    def test_login_needs_a_ucinetid_and_macos(self):
        del os.environ['HPC3_USER']
        self.assertEqual(self.request('POST', '/hpc3/login', {})[0], 400)
        os.environ['HPC3_USER'] = 'jdoe'
        self.server.hpc3.platform = 'linux'
        status, body = self.request('POST', '/hpc3/login', {})
        self.assertEqual(status, 501)
        self.assertIn('hpc3_ssh.py login', body['error'])
        self.assertEqual(self.request('GET', '/hpc3/login')[1]['state'], 'idle')

    # --- Logout ----------------------------------------------------------------------------

    def test_logout_closes_the_connection_and_resets_the_login_state(self):
        self.request('POST', '/hpc3/login', {})
        self.ssh.release.set()
        self.wait_for_login_end()
        self.assertEqual(self.request('POST', '/hpc3/logout', {}), (200, {'message': 'Logged out.'}))
        self.assertEqual(self.request('GET', '/hpc3/login')[1]['state'], 'idle')

    # --- UCInetID --------------------------------------------------------------------------

    def test_user_is_validated_and_written_to_env(self):
        for bad in ('', 'JDoe', '-oProxyCommand=x', 'a b', 42):
            with self.subTest(user=bad):
                self.assertEqual(self.request('POST', '/hpc3/user', {'user': bad})[0], 400)
        self.assertFalse(self.env_file.exists())
        self.assertEqual(self.request('POST', '/hpc3/user', {'user': ' newid '}), (200, {'user': 'newid'}))
        self.assertEqual(self.env_file.read_text(), 'HPC3_USER=newid\n')
        self.assertEqual(os.environ['HPC3_USER'], 'newid')

    def test_changing_user_while_connected_is_refused(self):
        self.ssh.connected = True
        self.assertEqual(self.request('POST', '/hpc3/user', {'user': 'other'})[0], 409)
        self.assertEqual(self.request('POST', '/hpc3/user', {'user': 'jdoe'})[0], 200)  # Same user is fine.


class WriteEnvTest(unittest.TestCase):
    """Only the one key changes; everything else in .env is kept exactly."""

    def test_replaces_one_line_keeps_others_and_restricts_permissions(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / '.env'
            path.write_text('# comment\nGROQ_API_KEY=keep-me\nHPC3_USER=old\nHPC3_HOST=\nHPC3_USER=dup\n')
            write_env_value(path, 'HPC3_USER', 'new')
            self.assertEqual(path.read_text(), '# comment\nGROQ_API_KEY=keep-me\nHPC3_USER=new\nHPC3_HOST=\n')
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertFalse((Path(folder) / '.env.tmp').exists())

    def test_appends_when_the_key_is_missing(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / '.env'
            path.write_text('GROQ_API_KEY=keep-me')
            write_env_value(path, 'HPC3_USER', 'new')
            self.assertEqual(path.read_text(), 'GROQ_API_KEY=keep-me\nHPC3_USER=new\n')


class ServiceFailureTest(unittest.TestCase):
    def test_a_crashing_login_still_ends_in_failed(self):
        ssh = FakeSsh()

        def crash(*args, **kwargs):
            raise RuntimeError('boom')
        ssh.login = crash
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'HPC3_USER': 'jdoe'}):
            service = Hpc3Service(Path(folder) / '.env', ssh=ssh, platform='darwin')
            service.start_login()
            service.thread.join(3)
            state = service.login_state()
        self.assertEqual(state['state'], 'failed')
        self.assertNotIn('boom', state['message'])


if __name__ == '__main__':
    unittest.main()
