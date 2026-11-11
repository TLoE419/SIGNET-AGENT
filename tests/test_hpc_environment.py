import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import agent.runtime.hpc as hpc
from agent.tools.hpc import (REVISION, check_hpc_environment, create_hpc_workspace, download_signet_container,
                             install_signet_source, read_hpc_setup_log)
from agent.tools.signet import dispatch_tool

GIT = ['git', '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main']


def completed(stdout, code=0):
    return subprocess.CompletedProcess(['electron-ssh'], code, stdout=stdout.encode(), stderr=b'')


def markers(**values):
    return ''.join(f'@@{key}\t{value}\n' for key, value in values.items())


READY = dict(user='tester', host='login-i15', workspace_path='/pub/tester/signet-agent', workspace='yes',
             workspace_writable='yes', sbatch='yes', apptainer='apptainer version 1.4.5', signet='yes',
             signet_revision=REVISION, signet_integrity='verified', signet_example='verified', file_container='3221225472', file_ref='1048576',
             file_gmap='2048', file_gtf='1500000000', file_clinical='512', file_prepare='4096')


class Remote:
    """Patch the Electron transport with a canned HPC3 reply and keep the call."""

    def __init__(self, stdout, code=0):
        self.available = patch.object(hpc.ssh_transport, 'available', return_value=True)
        self.environment = patch.object(hpc.ssh_transport, 'setup_environment', return_value={'root':'/pub/tester/signet-agent','source':'/pub/tester/signet-agent/software/pinned','image':'/pub/tester/signet-agent/images/signet.sif','executor':'/usr/bin/singularity','workRoot':'/pub/tester/signet-agent/runs','partition':'free','revision':REVISION})
        self.remote = patch.object(hpc.ssh_transport, 'remote', return_value=completed(stdout, code))

    def __enter__(self):
        self.available.start()
        self.environment.start()
        self.call = self.remote.start()
        return self.call

    def __exit__(self, *_):
        self.remote.stop()
        self.available.stop()
        self.environment.stop()


class CheckTest(unittest.TestCase):
    def check(self, stdout, code=0):
        with Remote(stdout, code) as remote:
            return check_hpc_environment(), remote

    def item(self, result, name):
        return next(c for c in result['checks'] if c['item'] == name)

    def test_requires_the_desktop_ssh_connection_and_never_falls_back_to_the_vm(self):
        with patch.object(hpc.ssh_transport, 'available', return_value=False), \
                patch.object(hpc.ssh_transport, 'remote') as remote:
            self.assertEqual(check_hpc_environment()['status'], 'unavailable')
        remote.assert_not_called()

    def test_disconnected_or_slow_hpc_is_reported_without_raising(self):
        with patch.object(hpc.ssh_transport, 'available', return_value=True), \
                patch.object(hpc.ssh_transport, 'remote', side_effect=OSError('timed out')):
            result = check_hpc_environment()
        self.assertEqual(result['status'], 'unavailable')
        self.assertIn('SSH panel', result['reason'])

    def test_ssh_without_a_configured_environment_is_not_called_unreachable(self):
        error = hpc.ssh_transport.SshRemoteError('Checking remote paths.')
        with patch.object(hpc.ssh_transport, 'available', return_value=True), \
                patch.object(hpc.ssh_transport, 'setup_environment', side_effect=error), \
                patch.object(hpc.ssh_transport, 'remote') as remote:
            result = check_hpc_environment()
        self.assertEqual((result['status'], result['reason']), ('not_ready', 'Checking remote paths.'))
        self.assertNotIn('not reachable', result['reason'])
        remote.assert_not_called()

    def test_missing_container_is_reported_instead_of_blocking_the_check(self):
        result, _ = self.check(markers(**{**READY, 'file_container': 'no'}))
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['not_ready'], ['container'])
        self.assertIn('images/signet-0.0.6.sif', self.item(result, 'container')['detail'])

    def test_missing_or_modified_example_data_is_reported_on_the_source_row(self):
        result, remote = self.check(markers(**{**READY, 'signet_example': 'missing'}))
        source = self.item(result, 'signet_source')
        self.assertEqual(source['status'], 'missing')
        self.assertIn('example data', source['detail'])
        self.assertIn('SIGNET_EXAMPLE_HASHES', remote.call_args.kwargs['input'].decode())
        self.assertIn('example/geno/example.ped', remote.call_args.kwargs['input'].decode())
        result, _ = self.check(markers(**{**READY, 'signet_example': 'mismatch'}))
        self.assertEqual(self.item(result, 'signet_source')['status'], 'problem')

    def test_ready_environment_reports_every_item_ok_and_read_only(self):
        result, remote = self.check('Welcome banner\n' + markers(**READY))
        self.assertEqual((result['ready'], result['not_ready'], result['read_only'], result['executed']), (True, [], True, False))
        self.assertEqual([c['item'] for c in result['checks']],
                         ['connection', 'workspace', 'slurm', 'apptainer', 'signet_source', 'container',
                          'reference_ref', 'reference_gmap', 'reference_gtf', 'reference_clinical',
                          'imputation_reference'])
        self.assertIn('3.0 GB', self.item(result, 'container')['detail'])
        self.assertEqual(remote.call_args.args, ('bash -s',))
        script = remote.call_args.kwargs['input'].decode()
        self.assertIn('sha256sum -c', script)
        self.assertNotIn('git -C', script)
        for reads_content in ('cat ', 'less ', 'grep ', 'sed ', 'awk ', 'tail '):
            self.assertNotIn(reads_content, script)

    def test_fresh_account_lists_what_still_needs_preparation(self):
        result, _ = self.check(markers(user='tester', host='login-i15', workspace_path='/pub/tester/signet-agent',
                                       workspace='no', sbatch='yes', apptainer='apptainer version 1.4.5', signet='no',
                                       file_container='no', file_ref='no', file_gmap='no', file_gtf='no', file_clinical='no',
                                       file_prepare='no'))
        self.assertEqual(result['not_ready'], ['workspace', 'signet_source', 'container', 'reference_ref',
                                               'reference_gmap', 'reference_gtf', 'reference_clinical',
                                               'imputation_reference'])
        self.assertEqual(self.item(result, 'workspace')['status'], 'missing')

    def test_wrong_revision_modified_source_and_empty_files_are_problems(self):
        for change, item in [({'signet_revision': 'a' * 40}, 'signet_source'), ({'signet_integrity': 'mismatch'}, 'signet_source'),
                             ({'signet': 'invalid'}, 'signet_source'), ({'file_gtf': 'empty'}, 'reference_gtf'),
                             ({'workspace_writable': 'no'}, 'workspace'), ({'apptainer': 'no'}, 'apptainer')]:
            with self.subTest(change=change):
                result, _ = self.check(markers(**{**READY, **change}))
                self.assertEqual(self.item(result, item)['status'], 'problem')
                self.assertEqual(result['not_ready'], [item])

    def test_background_steps_show_as_in_progress_or_point_to_their_log(self):
        base = {**READY, 'workspace': 'no', 'signet': 'no', 'file_container': 'no'}
        result, _ = self.check(markers(**base, step_workspace='running', step_workspace_host='login-i15',
                                       step_signet='failed', job_container='4242', job_container_state='RUNNING'))
        self.assertEqual(self.item(result, 'workspace')['status'], 'in_progress')
        self.assertIn('login-i15', self.item(result, 'workspace')['detail'])
        self.assertEqual(self.item(result, 'signet_source')['status'], 'problem')
        self.assertIn('read_hpc_setup_log("signet")', self.item(result, 'signet_source')['detail'])
        self.assertEqual(self.item(result, 'container')['status'], 'in_progress')
        result, _ = self.check(markers(**base, step_workspace='stopped', job_container='4242', job_container_state=''))
        self.assertEqual(self.item(result, 'workspace')['status'], 'problem')
        self.assertIn('read_hpc_setup_log("container")', self.item(result, 'container')['detail'])

    def test_incomplete_check_changes_nothing_and_says_so(self):
        result, _ = self.check('', code=255)
        self.assertEqual(result['status'], 'failed')


class StepToolTest(unittest.TestCase):
    def test_source_installation_stays_with_the_desktop_environment(self):
        with patch.object(hpc.ssh_transport, 'remote') as remote:
            for tool in (create_hpc_workspace, install_signet_source):
                result = tool()
                self.assertEqual((result['status'], result['executed']), ('blocked', False))
                self.assertIn('Workflow panel', result['reason'])
        remote.assert_not_called()

    def test_container_download_is_refused_until_its_checksum_is_pinned(self):
        with patch.object(hpc, 'CONTAINER_SHA256', None), patch.object(hpc.ssh_transport, 'remote') as remote:
            result = download_signet_container()
        self.assertEqual((result['status'], result['executed']), ('blocked', False))
        self.assertIn('checksum', result['reason'])
        remote.assert_not_called()

    def test_container_download_is_a_verified_slurm_job(self):
        with patch.object(hpc, 'CONTAINER_SHA256', 'a' * 64), \
                Remote(markers(workspace_path='/pub/tester/signet-agent', container='started', container_job='42')) as remote:
            result = download_signet_container()
        self.assertEqual((result['status'], result['executed'], result['job_id']), ('ok', True, '42'))
        script = remote.call_args.kwargs['input'].decode()
        self.assertIn('sbatch --parsable --job-name=signet-container', script)
        for expected in (hpc.CONTAINER_URL, str(hpc.CONTAINER_BYTES), 'a' * 64, 'ln "$PARTIAL" "$I"'):
            self.assertIn(expected, script)
        self.assertNotIn('library://', script)
        self.assertNotIn('pull', script.split('SIGNET_JOB')[1])

    def test_container_job_never_publishes_a_wrong_file(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(hpc, 'CONTAINER_SHA256', 'a' * 64):
            image = Path(directory, 'images', 'signet.sif')
            bin_dir = Path(directory, 'bin')
            bin_dir.mkdir()
            # A stand-in for an HTML quota page returned instead of the image.
            curl = bin_dir / 'curl'
            curl.write_text('#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\nprintf "<html>" > "$2"\n')
            curl.chmod(0o700)
            stat = bin_dir / 'stat'
            stat.write_text('#!/bin/sh\nwc -c < "$3" | tr -d " "\n')
            stat.chmod(0o700)
            done = subprocess.run(['bash', '-c', hpc._container_job()], capture_output=True, text=True,
                                  env={**os.environ, 'I': str(image), 'PATH': f"{bin_dir}:{os.environ['PATH']}"})
            self.assertEqual(done.returncode, 1)
            self.assertIn('expected', done.stderr)
            self.assertEqual(list(image.parent.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
