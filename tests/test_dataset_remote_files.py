"""Run dataset browse/inspect scripts against local files; never submit a remote job."""
import http.client
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from agent.app.chat_ui import ChatServer
from agent.runtime import hpc_files, ssh_transport


class DatasetRemoteFilesTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.root = self.base / 'install'
        self.root.mkdir()
        self.data = self.base / 'shared/data'
        self.data.mkdir(parents=True)
        self.config = {'root': str(self.root), 'source': str(self.root / 'software/pinned'),
                       'image': str(self.root / 'images/signet.sif'), 'executor': '',
                       'workRoot': str(self.root / 'runs'), 'partition': ''}
        self.scripts = []
        self.denied_path = None
        for item in (patch.object(ssh_transport, 'available', return_value=True),
                     patch.object(ssh_transport, 'setup_environment', return_value=self.config),
                     patch.object(ssh_transport, 'environment', side_effect=AssertionError('Inspection needs no scientific runtime')),
                     patch.object(ssh_transport, 'remote', side_effect=self.remote),
                     patch.object(hpc_files, '_UNREADABLE_ON_COMPUTE', (str(self.base / 'node-local'),))):
            item.start()
            self.addCleanup(item.stop)

    def remote(self, command, input=b'', capture_output=True, timeout=None):
        self.assertEqual(command, 'bash -s')
        source = input.decode()
        self.scripts.append(source)
        if self.denied_path:
            # Also exercise denied access when a test runner has root privileges.
            source = source.replace('import stat\n', 'import stat\noriginal_access = os.access\n'
                                    f'os.access = lambda path, mode: False if path == {self.denied_path!r} else original_access(path, mode)\n')
        return subprocess.run(['bash', '-s'], input=source.encode(), capture_output=True, timeout=10)

    def file(self, name, content='PRIVATE_SAMPLE_CONTENT\n'):
        path = self.data / name
        path.write_text(content)
        return path

    def start_server(self):
        server = ChatServer(('127.0.0.1', 0), Mock())
        self.addCleanup(server.server_close)
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 3)
        self.addCleanup(server.shutdown)
        return server

    def post(self, server, body, path='/hpc/files/inspect', token=True, origin=True, raw=False):
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=4)
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['X-Chat-Token'] = server.token
        if origin:
            headers['Origin'] = f'http://127.0.0.1:{server.server_port}'
        try:
            connection.request('POST', path, body if raw else json.dumps(body), headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_inspect_reports_only_canonical_metadata_and_never_changes_reference_state(self):
        a, b = self.file('study.ped'), self.file('study.map', 'arbitrary binary\x00bytes')
        alias = self.data / 'alias.ped'
        alias.symlink_to(a)
        state = self.root / 'refdata/selected.tsv'
        state.parent.mkdir()
        state.write_text('ref\t/unchanged/ref.vcf\n')
        prepared = state.parent / 'prepared/example/summary.json'
        prepared.parent.mkdir(parents=True)
        prepared.write_text('{"unchanged":true}')
        before = {path: path.read_bytes() for path in (a, b, state, prepared)}
        names = sorted(str(path.relative_to(self.base)) for path in self.base.rglob('*'))
        result = hpc_files.inspect([str(alias), str(self.data / './study.map')])
        self.assertEqual(result, {'status': 'ok', 'executed': False, 'read_only': True,
                                 'files': [{'path': str(a), 'size': a.stat().st_size},
                                           {'path': str(b), 'size': b.stat().st_size}]})
        self.assertNotIn('PRIVATE_SAMPLE_CONTENT', json.dumps(result))
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual(sorted(str(path.relative_to(self.base)) for path in self.base.rglob('*')), names)
        script = self.scripts[0]
        for mutation_or_read in ('sbatch', 'mkdir', 'os.makedirs', 'open(', 'format_problem', 'subprocess', 'write_table', 'os.rename'):
            self.assertNotIn(mutation_or_read, script)

    def test_existing_list_and_shortcuts_browse_real_folders_without_reading_contents(self):
        file = self.file('study.ped')
        folder = self.data / 'nested'
        folder.mkdir()
        self.file('unsupported name.tsv')
        self.file('.hidden')
        result = hpc_files.list_folder(str(self.data))
        self.assertEqual((result['status'], result['kind']), ('ok', 'folder'))
        entries = {row['name']: row for row in result['entries']}
        self.assertEqual(set(entries), {'study.ped', 'nested', 'unsupported name.tsv'})
        self.assertFalse(entries['unsupported name.tsv']['supported'])
        self.assertEqual(hpc_files.list_folder(str(folder))['entries'], [])
        self.assertEqual(hpc_files.list_folder(str(file))['kind'], 'file')
        self.assertEqual(hpc_files.list_folder(str(self.data / 'missing'))['status'], 'failed')
        self.assertNotIn('PRIVATE_SAMPLE_CONTENT', json.dumps(result))
        lab = self.base / 'dfs1/lab'
        lab.mkdir(parents=True)
        original = hpc_files._shortcuts_script
        with patch.object(hpc_files, '_shortcuts_script', side_effect=lambda: original(str(self.base / 'dfs*'), str(self.base / 'crsp'))):
            shortcuts = hpc_files.shortcuts()
        self.assertEqual(shortcuts['status'], 'ok')
        self.assertIn(str(lab), [row['path'] for row in shortcuts['shortcuts']])

    def test_invalid_paths_types_duplicates_and_limits_never_reach_remote(self):
        for paths in (None, {}, [], 'file', [None], [1], ['relative/file'], ['/a/../b'], ['/a b'],
                      ['/a;id'], ['/a$(id)'], ['/a\nb'], ['/a\x00b'], ['/' + 'a' * 2048],
                      ['/same', '/same'], ['/a/./b', '/a/b'], ['/a'] * 129,
                      ['/' + str(index) + 'a' * 2040 for index in range(17)]):
            with self.subTest(paths=paths):
                self.assertEqual(hpc_files.inspect(paths)['status'], 'invalid')
        self.assertEqual(self.scripts, [])

    def test_missing_unreadable_empty_directory_and_special_files_are_rejected(self):
        empty = self.file('empty', '')
        private = self.file('private')
        fifo = self.data / 'pipe'
        os.mkfifo(fifo)
        for path, error in ((self.data / 'missing', 'missing'), (empty, 'empty'),
                            (self.data, 'regular'), (fifo, 'regular')):
            with self.subTest(path=path):
                result = hpc_files.inspect([str(path)])
                self.assertEqual(result['status'], 'invalid')
                self.assertIn(error, result['error'])
                self.assertNotIn('files', result)
        private.chmod(0)
        self.denied_path = str(private)
        self.assertIn('cannot read', hpc_files.inspect([str(private)])['error'])

    def test_canonical_symlink_destinations_are_checked_and_duplicate_targets_rejected(self):
        target = self.file('target')
        alias = self.data / 'alias'
        alias.symlink_to(target)
        self.assertEqual(hpc_files.inspect([str(alias), str(target)])['status'], 'invalid')
        bad = self.file('unsupported name')
        alias.unlink()
        alias.symlink_to(bad)
        self.assertEqual(hpc_files.inspect([str(alias)])['status'], 'invalid')
        local = self.base / 'node-local/target'
        local.parent.mkdir()
        local.write_text('unshared')
        alias.unlink()
        alias.symlink_to(local)
        self.assertIn('Compute nodes cannot read', hpc_files.inspect([str(alias)])['error'])
        alias.unlink()
        alias.symlink_to(self.data / 'missing')
        self.assertEqual(hpc_files.inspect([str(alias)])['status'], 'invalid')

    def test_authenticated_http_inspection_enforces_its_own_body_contract(self):
        server = self.start_server()
        file = self.file('real-input.tsv')
        body = {'paths': [str(file)]}
        self.assertEqual(self.post(server, body, token=False)[0], 403)
        self.assertEqual(self.post(server, body, origin=False)[0], 403)
        for invalid in ({}, [], None, {'paths': 'file'}, {'paths': []}, {'paths': ['/a'] * 129},
                        {**body, 'key': 'clinical'}, {**body, 'command': 'cat /etc/passwd'}):
            self.assertEqual(self.post(server, invalid)[0], 400)
        self.assertEqual(self.post(server, 'not json', raw=True)[0], 400)
        self.assertEqual(self.post(server, 'x' * 32769, raw=True)[0], 400)
        self.assertEqual(self.scripts, [])
        with patch.object(hpc_files, 'select', side_effect=AssertionError('Dataset inspection cannot select a reference')):
            status, result = self.post(server, body)
        self.assertEqual((status, result['files'][0]['path']), (200, str(file)))
        self.assertEqual(len(self.scripts), 1)
        self.assertEqual(self.post(server, json.dumps(body) + ' ' * 5000, raw=True)[0], 200)
        self.assertEqual(self.post(server, body, path='/hpc/files/inspect?command=id')[0], 404)


if __name__ == '__main__':
    unittest.main()
