import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch

import signet_runtime
import ssh_transport


class TransportTest(unittest.TestCase):
    def serve_once(self, path, token):
        ready = threading.Event()

        def serve():
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(path)
            server.listen(1)
            ready.set()
            connection, _ = server.accept()
            with connection:
                stream = connection.makefile('rb')
                request = json.loads(stream.readline())
                self.assertEqual(request['token'], token)
                self.assertEqual(request['command'], 'printf test')
                self.assertEqual(stream.read(request['inputLength']), b'input')
                reply = {'ok': True, 'value': {'returncode': 0, 'signal': None,
                    'stdoutLength': len(b'output'), 'stderrLength': len(b'notice')}}
                connection.sendall(json.dumps(reply).encode() + b'\n')
                connection.sendall(b'outputnotice')
            server.close()

        thread = threading.Thread(target=serve)
        thread.start()
        ready.wait(2)
        return thread

    def test_remote_uses_private_socket_and_decodes_completed_process(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp') as directory:
            path = str(Path(directory) / 'broker.sock')
            thread = self.serve_once(path, 'secret')
            with patch.dict(os.environ, {'SIGNET_SSH_BROKER': path, 'SIGNET_SSH_BROKER_TOKEN': 'secret'}):
                result = ssh_transport.remote('printf test', input=b'input', capture_output=True, timeout=2)
            thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, b'output')
            self.assertEqual(result.stderr, b'notice')

    def test_signet_runtime_prefers_electron_transport_when_available(self):
        with patch.dict(os.environ, {'SIGNET_SSH_BROKER': '/tmp/test', 'SIGNET_SSH_BROKER_TOKEN': 'secret'}), \
                patch.object(ssh_transport, 'remote', return_value='broker-result') as remote:
            self.assertEqual(signet_runtime.remote('true', timeout=4), 'broker-result')
            remote.assert_called_once_with('true', timeout=4)


if __name__ == '__main__':
    unittest.main()
