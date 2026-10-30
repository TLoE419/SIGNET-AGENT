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
             signet_head=REVISION, signet_modified='0', file_container='3221225472', file_ref='1048576',
             file_gmap='2048', file_gtf='1500000000', file_clinical='512', file_prepare='4096')


class Remote:
    """Patch the Electron transport with a canned HPC3 reply and keep the call."""

    def __init__(self, stdout, code=0):
        self.available = patch.object(hpc.ssh_transport, 'available', return_value=True)
        self.remote = patch.object(hpc.ssh_transport, 'remote', return_value=completed(stdout, code))

    def __enter__(self):
        self.available.start()
        self.call = self.remote.start()
        return self.call

    def __exit__(self, *_):
        self.remote.stop()
        self.available.stop()


class WorkspaceTest(unittest.TestCase):
    def test_default_and_override_only_allow_plain_paths_and_user(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(hpc.workspace(), '/pub/$USER/signet-agent')
        with patch.dict(os.environ, {'SIGNET_HPC_WORKSPACE': '/dfs6/pub/$USER/my-signet'}):
            self.assertEqual(hpc.workspace(), '/dfs6/pub/$USER/my-signet')
        for bad in ['pub/x', '/pub/x;rm -rf ~', '/pub/$(id)', '/pub/../etc', '/pub/x y', '/pub/$HOME', "/pub/x'y"]:
            with self.subTest(bad=bad), patch.dict(os.environ, {'SIGNET_HPC_WORKSPACE': bad}):
                self.assertRaises(ValueError, hpc.workspace)


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

    def test_ready_environment_reports_every_item_ok_and_read_only(self):
        result, remote = self.check('Welcome banner\n' + markers(**READY))
        self.assertEqual((result['ready'], result['not_ready'], result['read_only'], result['executed']), (True, [], True, False))
        self.assertEqual([c['item'] for c in result['checks']],
                         ['connection', 'workspace', 'slurm', 'apptainer', 'signet_source', 'container',
                          'reference_ref', 'reference_gmap', 'reference_gtf', 'reference_clinical',
                          'imputation_reference'])
        self.assertIn('3.0 GB', self.item(result, 'container')['detail'])
        self.assertEqual(remote.call_args.args, ('bash -l -s',))
        script = remote.call_args.kwargs['input'].decode()
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

    def test_wrong_commit_modified_source_and_empty_files_are_problems(self):
        for change, item in [({'signet_head': 'a' * 40}, 'signet_source'), ({'signet_modified': '3'}, 'signet_source'),
                             ({'signet': 'not_git'}, 'signet_source'), ({'file_gtf': 'empty'}, 'reference_gtf'),
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
    def test_each_tool_runs_only_its_own_step(self):
        # Clone and download may also create the workspace; nothing else may cross over.
        commands = {'workspace': 'mkdir -p $W/containers $W/refdata $W/runs', 'signet': 'git clone', 'container': 'sbatch --parsable'}
        for tool, step in [(create_hpc_workspace, 'workspace'), (install_signet_source, 'signet'),
                           (download_signet_container, 'container')]:
            with self.subTest(step=step), Remote(markers(workspace_path='/w', **{step: 'started'})) as remote:
                result = tool()
                script = remote.call_args.kwargs['input'].decode()
            self.assertEqual((result['status'], result['step'], result['outcome'], result['executed']), ('ok', step, 'started', True))
            for other, command in commands.items():
                if other == step or other == 'workspace':
                    self.assertIn(command, script)
                else:
                    self.assertNotIn(command, script)

    def test_existing_and_running_steps_start_nothing(self):
        for outcome in ('existing', 'in_progress'):
            with self.subTest(outcome=outcome), Remote(markers(workspace_path='/w', signet=outcome)):
                result = install_signet_source()
            self.assertEqual((result['status'], result['executed']), ('ok', False))

    def test_clone_and_download_say_when_they_also_create_the_workspace(self):
        for tool, step in [(install_signet_source, 'signet'), (download_signet_container, 'container')]:
            with self.subTest(step=step), Remote(markers(workspace_path='/w', creates_workspace='yes', **{step: 'started'})):
                result = tool()
            self.assertTrue(result['creates_workspace'])
            self.assertIn('creates it first', result['detail'])

    def test_container_job_id_is_returned(self):
        with Remote(markers(workspace_path='/w', container='started', container_job='777')):
            self.assertEqual(download_signet_container()['job_id'], '777')

    def test_rejects_an_unpinned_source_and_unknown_log_steps(self):
        self.assertEqual(hpc.start_step('signet', 'https://example.com/x.git', 'main')['status'], 'invalid')
        self.assertEqual(hpc.start_step('signet', 'git@github.com:x/y.git', REVISION)['status'], 'invalid')
        self.assertEqual(read_hpc_setup_log('../../.ssh/id_rsa')['status'], 'invalid')

    def test_setup_log_returns_only_its_lines(self):
        with Remote(markers(workspace_path='/', log_exists='yes') + '@@line\tFATAL: no network\n@@line\tdone\n'):
            result = read_hpc_setup_log('container')
        self.assertEqual(result['lines'], ['FATAL: no network', 'done'])

    def test_model_can_call_them_through_the_dispatch_allow_list(self):
        with patch.object(hpc.ssh_transport, 'available', return_value=False):
            for name in ('check_hpc_environment', 'create_hpc_workspace', 'install_signet_source', 'download_signet_container'):
                self.assertEqual(dispatch_tool(name, {})['status'], 'unavailable')
            self.assertEqual(dispatch_tool('read_hpc_setup_log', {'step': 'signet'})['status'], 'unavailable')
        self.assertEqual(dispatch_tool('create_hpc_workspace', {'path': '/etc'})['status'], 'invalid')


class ScriptTest(unittest.TestCase):
    """Run the real scripts with local bash against a synthetic workspace and fake Slurm."""

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        base = Path(self.folder.name).resolve()
        self.base, self.root, self.home = base, base / 'signet-agent', base / 'home'
        self.home.mkdir()
        bin_dir = base / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'sbatch').write_text('#!/bin/bash\nprintf "%s\\n" "$@" > "$FAKE/sbatch.args"\necho "555;hpc3"\n')
        (bin_dir / 'squeue').write_text('#!/bin/bash\ncat "$FAKE/state" 2>/dev/null\n')
        for tool in ('sbatch', 'squeue'):
            (bin_dir / tool).chmod(0o755)
        self.env = {**os.environ, 'PATH': f'{bin_dir}:{os.environ["PATH"]}', 'FAKE': str(base), 'HOME': str(self.home)}

    def tearDown(self):
        self.folder.cleanup()

    def run_script(self, build):
        with patch.dict(os.environ, {'SIGNET_HPC_WORKSPACE': str(self.root)}):
            script = build(hpc.workspace())
        done = subprocess.run(['bash', '-s'], input=script.encode(), capture_output=True, check=True, env=self.env)
        return hpc._parse(done.stdout)

    def wait_for(self, step):
        status = self.home / f'.signet-agent/steps/{step}.status'
        for _ in range(200):
            if status.exists() and ('state=done' in status.read_text() or 'state=failed' in status.read_text()):
                return status.read_text()
            time.sleep(0.05)
        self.fail(f'{step} did not finish')

    def test_steps_run_in_the_background_one_at_a_time_and_never_overwrite(self):
        upstream = self.base / 'upstream'
        upstream.mkdir()
        subprocess.run([*GIT, 'init', '-q', str(upstream)], check=True)
        (upstream / 'signet').write_text('#!/bin/bash\n')
        subprocess.run([*GIT, '-C', str(upstream), 'add', '.'], check=True)
        subprocess.run([*GIT, '-C', str(upstream), 'commit', '-qm', 'pin'], check=True)
        pinned = subprocess.run(['git', '-C', str(upstream), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
        subprocess.run([*GIT, '-C', str(upstream), 'commit', '-q', '--allow-empty', '-m', 'later'], check=True)
        signet = lambda root: hpc._signet_script(root, str(upstream), pinned)

        # Cloning into a missing workspace creates it first.
        started = self.run_script(signet)
        self.assertEqual((started['signet'], started['creates_workspace']), ('started', 'yes'))
        self.assertIn('state=done', self.wait_for('signet'))
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
        self.assertTrue(all((self.root / f).is_dir() for f in hpc.WORKSPACE_FOLDERS))
        self.assertFalse((self.base / 'sbatch.args').exists(), 'cloning does not download the container')
        self.assertEqual(self.run_script(hpc._workspace_script)['workspace'], 'existing')
        head = subprocess.run(['git', '-C', str(self.root / 'signet'), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
        self.assertEqual(head, pinned)
        (self.root / 'signet/local-note').write_text('keep me')
        self.assertEqual(self.run_script(signet)['signet'], 'existing')
        self.assertEqual((self.root / 'signet/local-note').read_text(), 'keep me')

        first = self.run_script(hpc._container_script)
        self.assertEqual((first['container'], first['container_job']), ('started', '555'))
        self.assertNotIn('creates_workspace', first)
        arguments = (self.base / 'sbatch.args').read_text()
        self.assertIn('--partition=free', arguments)
        self.assertIn(f'apptainer pull --library https://library.sylabs.io {self.root}/containers/signet.partial.sif', arguments)
        self.assertNotIn('$W', arguments)
        (self.base / 'state').write_text('RUNNING\n')
        (self.base / 'sbatch.args').unlink()
        self.assertEqual(self.run_script(hpc._container_script)['container'], 'in_progress')
        self.assertFalse((self.base / 'sbatch.args').exists(), 'a running download is not submitted twice')

        check = self.run_script(hpc._check_script)
        self.assertEqual((check.get('step_workspace'), check['step_signet'], check['job_container'], check['job_container_state']),
                         (None, 'done', '555', 'RUNNING'), 'the clone created the workspace, so no separate workspace step ran')
        self.assertEqual(check['signet_head'], pinned)
        self.assertEqual(check['signet_modified'], '0')

    def test_workspace_alone_does_not_clone_or_download(self):
        self.assertEqual(self.run_script(hpc._workspace_script)['workspace'], 'started')
        self.assertIn('state=done', self.wait_for('workspace'))
        self.assertTrue(all((self.root / f).is_dir() for f in hpc.WORKSPACE_FOLDERS))
        self.assertFalse((self.root / 'signet').exists())
        self.assertFalse((self.base / 'sbatch.args').exists())

    def test_download_into_a_missing_workspace_creates_it_inside_the_job(self):
        started = self.run_script(hpc._container_script)
        self.assertEqual((started['container'], started['creates_workspace']), ('started', 'yes'))
        self.assertFalse(self.root.exists(), 'the job creates it on the compute node, not the login shell')
        wrap = (self.base / 'sbatch.args').read_text().splitlines()[-1]
        self.assertTrue(wrap.startswith(f'umask 077; if [ ! -d {self.root} ]; then mkdir -p {self.root}'))
        self.assertLess(wrap.index('mkdir -p'), wrap.index('apptainer pull'))
        (self.base / 'state').write_text('PENDING\n')
        check = self.run_script(hpc._check_script)
        values = hpc._checks(check, REVISION)
        self.assertEqual(next(c for c in values if c['item'] == 'workspace')['status'], 'in_progress')

    def test_failed_clone_leaves_nothing_and_its_log_is_readable(self):
        self.run_script(hpc._workspace_script)
        self.wait_for('workspace')
        broken = lambda root: hpc._signet_script(root, str(self.base / 'missing-repo'), 'a' * 40)
        self.assertEqual(self.run_script(broken)['signet'], 'started')
        self.assertIn('state=failed', self.wait_for('signet'))
        self.assertFalse((self.root / 'signet').exists())
        self.assertFalse((self.root / 'signet.partial').exists())
        self.assertEqual(self.run_script(hpc._check_script)['step_signet'], 'failed')
        log = self.run_script(lambda _root: hpc._log_script('signet'))
        self.assertEqual(log['log_exists'], 'yes')
        self.assertTrue(any('missing-repo' in line for line in log['lines']))


if __name__ == '__main__':
    unittest.main()
