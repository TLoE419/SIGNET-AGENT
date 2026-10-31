"""Desktop launcher drains existing work instead of replaying or truncating it."""
from contextlib import contextmanager
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import chat_ui
from electron.main.backend.server import serve


class DesktopServerTest(unittest.TestCase):
    def test_loopback_startup_does_not_resolve_hostnames(self):
        with patch('socket.getfqdn', side_effect=AssertionError('Loopback startup must not query DNS')):
            with chat_ui.ChatServer(('127.0.0.1', 0), lambda timing: None) as server:
                self.assertEqual(server.server_name, '127.0.0.1')
                self.assertEqual(server.server_port, server.server_address[1])
                self.assertGreater(server.server_port, 0)

    def test_parent_eof_waits_for_stage6_worker_before_final_checkpoint(self):
        @contextmanager
        def factory(timing):
            raise AssertionError('No model call expected')
            yield

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.chat-state.json'
            server = chat_ui.ChatServer(('127.0.0.1', 0), factory, state_file=path)
            server.turn_lock.acquire()
            read_fd, write_fd = os.pipe()
            events = io.StringIO()
            with os.fdopen(read_fd) as control:
                runner = threading.Thread(target=serve, args=(server, control, events))
                runner.start()
                try:
                    os.close(write_fd)  # Owner exits, even without sending a message.
                    time.sleep(0.25)
                    self.assertTrue(runner.is_alive())
                    self.assertFalse(path.exists())
                    server.events['test-session'] = [['work finished']]
                finally:
                    server.turn_lock.release()
                    runner.join(5)
                self.assertFalse(runner.is_alive())
            self.assertEqual(json.loads(path.read_text())['events']['test-session'], [['work finished']])
            self.assertEqual(json.loads(events.getvalue().splitlines()[-1])['event'], 'stopped')

    def test_server_factory_keeps_loopback_and_browser_defaults(self):
        with patch.object(chat_ui, 'load_dotenv'), patch('codex_provider.configured_model', return_value='test-model'):
            with chat_ui.create_server(port=0, state_file=None) as server:
                self.assertEqual(server.server_address[0], '127.0.0.1')
                self.assertEqual(server.model_label, 'Codex CLI / test-model')
                self.assertIsNone(server.state_file)
        with self.assertRaises(ValueError):
            chat_ui.create_server(provider='unsupported')
