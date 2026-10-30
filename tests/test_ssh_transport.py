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


class EnvironmentContractTest(unittest.TestCase):
    def config(self):
        return {'root': '/home/user/signet', 'source': '/home/user/signet/software/rev',
                'image': '/home/user/signet/images/signet.sif', 'executor': '/usr/bin/apptainer',
                'workRoot': '/home/user/signet/runs', 'partition': 'standard', 'revision': 'rev'}

    def test_runtime_uses_the_verified_desktop_configuration(self):
        with patch.dict(os.environ, {'SIGNET_SSH_BROKER': '/tmp/test', 'SIGNET_SSH_BROKER_TOKEN': 'secret'}), \
                patch.object(ssh_transport, 'request', return_value={'stdout': json.dumps(self.config()).encode()}):
            self.assertEqual(signet_runtime.image_path(), self.config()['image'])
            self.assertEqual(signet_runtime.container_command(), '/usr/bin/apptainer')
            self.assertEqual(signet_runtime.partition(), 'standard')
            self.assertEqual(signet_runtime.remote_work_root(), '/home/user/signet/runs/cis')
            self.assertEqual(signet_runtime.remote_work_root(network=True), '/home/user/signet/runs/network')

    def test_environment_rejects_unsafe_paths_and_propagates_not_ready(self):
        config = self.config()
        config['workRoot'] = '/home/user/../other'
        with patch.object(ssh_transport, 'request', return_value={'stdout': json.dumps(config).encode()}):
            with self.assertRaises(OSError):
                ssh_transport.environment()
        with patch.object(ssh_transport, 'request', side_effect=ssh_transport.SshRemoteError('Prepare environment')):
            with self.assertRaisesRegex(OSError, 'Prepare environment'):
                ssh_transport.environment()


if __name__ == '__main__':
    unittest.main()
