import json
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
             signet_revision=REVISION, signet_integrity='verified', signet_example='verified', file_container='3221225472')


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

    def test_local_runtime_helper_error_is_not_reported_as_an_hpc_connection_issue(self):
        configuration = {
            'root': '/pub/tester/signet-agent', 'source': '/pub/tester/signet-agent/software/pinned',
            'image': '/pub/tester/signet-agent/images/signet.sif', 'executor': '/usr/bin/singularity',
            'workRoot': '/pub/tester/signet-agent/runs', 'partition': 'free', 'revision': REVISION,
            'runtimeModule': 'singularity/3.8',
        }
        for read_errors in ([FileNotFoundError(2, 'missing', '/private/path/runtime_modules.sh')],
                            ['', PermissionError(13, 'denied', '/private/path/runtime_modules.sh')]):
            with (
                self.subTest(read_errors=read_errors),
                patch.object(hpc.ssh_transport, 'available', return_value=True),
                patch.object(hpc.ssh_transport, 'request', return_value={'stdout': json.dumps(configuration).encode()}),
                patch.object(hpc.ssh_transport.Path, 'read_text', side_effect=read_errors),
                patch.object(hpc.ssh_transport, 'remote') as remote,
            ):
                result = check_hpc_environment()
                self.assertEqual((result['status'], result['code'], result['executed']),
                                 ('unavailable', 'local_runtime_missing', False))
                self.assertIn('SIGNET app file', result['reason'])
                self.assertIn('runtime_modules.sh', result['detail'])
                self.assertNotIn('/private/path', str(result))
                remote.assert_not_called()

    def test_transport_distinguishes_timeouts_from_ended_sessions(self):
        for transport_code, check_code, reason in (
            ('CONNECTION_TIMEOUT', 'remote_timeout', 'did not respond in time'),
            ('REMOTE_SLOW', 'remote_timeout', 'did not respond in time'),
            ('SESSION_CLOSED', 'remote_disconnected', 'connection to HPC3 ended'),
            ('STALE_CONNECTION', 'remote_disconnected', 'connection to HPC3 ended'),
        ):
            error = hpc.ssh_transport.SshRemoteError('Broker details', code=transport_code)
            with self.subTest(transport_code=transport_code), Remote('') as remote:
                remote.side_effect = error
                result = check_hpc_environment()
                self.assertEqual((result['status'], result['code']), ('unavailable', check_code))
                self.assertIn(reason, result['reason'])
                self.assertNotIn('Broker details', result['reason'])

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

    def test_workspace_timeout_preserves_confirmed_checks_and_skips_storage_checks(self):
        result, _ = self.check(markers(user='tester', host='login-i15', workspace_path=READY['workspace_path'],
                                       sbatch='yes', apptainer=READY['apptainer'], workspace_timeout='yes'))
        self.assertFalse(result['ready'])
        self.assertEqual(len(result['checks']), 6)
        self.assertEqual([item['item'] for item in result['checks'] if item['status'] == 'ok'],
                         ['connection', 'slurm', 'apptainer'])
        self.assertEqual(self.item(result, 'workspace')['status'], 'problem')
        self.assertIn('timed out', self.item(result, 'workspace')['detail'])
        self.assertEqual(self.item(result, 'signet_source')['status'], 'unknown')
        self.assertEqual(self.item(result, 'container')['status'], 'unknown')

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
                         ['connection', 'workspace', 'slurm', 'apptainer', 'signet_source', 'container'])
        self.assertIn('3.0 GB', self.item(result, 'container')['detail'])
        self.assertEqual(remote.call_args.args, ('bash -s',))
        script = remote.call_args.kwargs['input'].decode()
        self.assertIn('sha256sum -c', script)
        self.assertNotIn('git -C', script)
        for reads_content in ('cat ', 'less ', 'grep ', 'sed ', 'awk ', 'tail '):
            self.assertNotIn(reads_content, script)

    def test_legacy_dataset_files_and_jobs_do_not_affect_shared_readiness(self):
        result, remote = self.check(markers(**READY, file_ref='no', file_gmap='no', file_gtf='no',
                                     file_clinical='empty', file_prepare='no', prepare_state='stale',
                                     job_ref='41', job_ref_state='RUNNING', job_prepare_terminal='failed'))
        self.assertTrue(result['ready'])
        self.assertEqual(result['not_ready'], [])
        script = remote.call_args.kwargs['input'].decode()
        for excluded in ('refdata/clinical.tsv', 'refdata/ref/', 'refdata/gmap/',
                         'refdata/prepared/', 'refdata/selected.tsv', 'clinical_columns_ok', 'prepared_state'):
            self.assertNotIn(excluded, script)

    def test_fresh_account_lists_what_still_needs_preparation(self):
        result, _ = self.check(markers(user='tester', host='login-i15', workspace_path='/pub/tester/signet-agent',
                                       workspace='no', sbatch='yes', apptainer='apptainer version 1.4.5', signet='no',
                                       file_container='no'))
        self.assertEqual(result['not_ready'], ['workspace', 'signet_source', 'container'])
        self.assertEqual(self.item(result, 'workspace')['status'], 'missing')

    def test_wrong_revision_modified_source_and_empty_files_are_problems(self):
        for change, item in [({'signet_revision': 'a' * 40}, 'signet_source'), ({'signet_integrity': 'mismatch'}, 'signet_source'),
                             ({'signet': 'invalid'}, 'signet_source'), ({'file_container': 'empty'}, 'container'),
                             ({'workspace_writable': 'no'}, 'workspace'), ({'apptainer': 'no'}, 'apptainer')]:
            with self.subTest(change=change):
                result, _ = self.check(markers(**{**READY, **change}))
                self.assertEqual(self.item(result, item)['status'], 'problem')
                self.assertEqual(result['not_ready'], [item])

    def test_background_steps_show_progress_or_failure_details(self):
        base = {**READY, 'workspace': 'no', 'signet': 'no', 'file_container': 'no'}
        result, _ = self.check(markers(**base, step_workspace='running', step_workspace_host='login-i15',
                                       step_signet='failed', job_container='4242', job_container_state='RUNNING'))
        self.assertEqual(self.item(result, 'workspace')['status'], 'in_progress')
        self.assertIn('login-i15', self.item(result, 'workspace')['detail'])
        self.assertEqual(self.item(result, 'signet_source')['status'], 'problem')
        self.assertEqual('The last SIGNET installation failed.', self.item(result, 'signet_source')['detail'])
        self.assertEqual(self.item(result, 'container')['status'], 'in_progress')
        result, _ = self.check(markers(**base, step_workspace='stopped', job_container='4242', job_container_state=''))
        self.assertEqual(self.item(result, 'workspace')['status'], 'problem')
        self.assertIn('Download job 4242 ended without producing', self.item(result, 'container')['detail'])

    def test_example_only_background_install_reports_progress(self):
        result, _ = self.check(markers(**{**READY, 'signet_example': 'missing'},
                                       step_signet='running', step_signet_host='login-i15'))
        self.assertEqual(self.item(result, 'signet_source')['status'], 'in_progress')

    def test_incomplete_check_changes_nothing_and_says_so(self):
        result, _ = self.check('', code=255)
        self.assertEqual(result['status'], 'failed')


class StepToolTest(unittest.TestCase):
    def test_source_installation_refuses_a_different_pin_before_remote_execution(self):
        with patch.object(hpc.ssh_transport, 'remote') as remote:
            for repository, revision in ((hpc.SOURCE_INVENTORY['repository'], 'a' * 40),
                                         ('https://example.invalid/foreign.git', REVISION)):
                result = hpc.start_step('signet', repository, revision)
                self.assertEqual((result['status'], result['executed']), ('invalid', False))
        remote.assert_not_called()

    def test_workspace_has_no_separate_step(self):
        with patch.object(hpc.ssh_transport, 'remote') as remote:
            result = create_hpc_workspace()
        self.assertEqual((result['status'], result['executed']), ('blocked', False))
        self.assertIn('Installing SIGNET creates the workspace', result['reason'])
        remote.assert_not_called()


    def test_source_installation_runs_in_the_background_and_shows_the_workflow_panel(self):
        from agent.tools.ui import UI_CHANNEL
        requests = []
        token = UI_CHANNEL.set(requests.append)
        try:
            with Remote(markers(workspace_path='/pub/tester/signet-agent', signet='started')) as remote:
                result = install_signet_source()
        finally:
            UI_CHANNEL.reset(token)
        self.assertEqual((result['status'], result['executed'], result['outcome']), ('ok', True, 'started'))
        script = remote.call_args.kwargs['input'].decode()
        self.assertIn(REVISION, script)
        self.assertIn('git -C "$stage/repository" fetch -q --depth=1', script)
        self.assertIn('sha256sum --check --status', script)
        self.assertIn('nohup setsid', script, 'the login-node install is detached from the SSH command')
        self.assertIn('/pub/tester/signet-agent/software/pinned', script, 'it installs where the desktop check looks')
        self.assertEqual(requests, [{'panel': 'workflow', 'visible': True, 'refresh': True}])
        with Remote(markers(workspace_path='/w', signet='existing')):
            result = install_signet_source()
        self.assertEqual((result['executed'], result['outcome']), (False, 'existing'))

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
                                  env={**os.environ, 'I': str(image), 'D': str(Path(directory, '.signet-agent', 'steps')),
                                       'PATH': f"{bin_dir}:{os.environ['PATH']}"})
            self.assertEqual(done.returncode, 1)
            self.assertIn('expected', done.stderr)
            self.assertEqual(list(image.parent.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
