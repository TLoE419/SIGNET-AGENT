"""Offline tests for hpc3_ssh.check(): every layer's failure, without touching the network.

DNS, the TCP probe and ssh are replaced by fakes, so these tests never contact HPC3, need no
VPN and use no credentials. The user name below is made up.
"""
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import hpc3_ssh as h

ENV = {'HPC3_USER': 'jdoe', 'HPC3_HOST': ''}
IDENTITY = 'host=login-i15\nuser=jdoe\nslurm=yes\n'
# How check() reports a login that reused the shared connection.
SHARED = 'shared_connection'


class FakeSsh:
    """Answers `ssh -O check` and the BatchMode login with scripted (code, stdout, stderr)."""

    def __init__(self, login=(0, IDENTITY, ''), master=(255, '', 'No such file or directory'), probe=None,
                 agent=(0, '256 SHA256:fake jdoe@laptop (ED25519)', '')):
        """Scripted answers for each kind of ssh call made by hpc3_ssh."""
        # probe: answer to the `true` liveness probe; defaults to the same as login.
        # agent: answer to `ssh-add -l`; by default a key is loaded so a login may be tried.
        self.login, self.master, self.probe, self.agent, self.calls = login, master, probe or login, agent, []

    def __call__(self, argv, **kwargs):
        """Stand in for subprocess.run: pick the scripted answer for this argv."""
        self.calls.append(argv)
        if argv[0] == 'ssh-add':
            code, out, err = self.agent
        elif 'BatchMode=yes' not in argv:
            code, out, err = self.master
        elif argv[-1] == 'true':
            code, out, err = self.probe
        else:
            code, out, err = self.login
        if code is None:
            raise subprocess.TimeoutExpired(argv, kwargs.get('timeout'))
        return subprocess.CompletedProcess(argv, code, out, err)


class CheckTest(unittest.TestCase):
    """check() stops at the first broken layer and names it."""

    def run_check(self, ssh=None, dns=None, tcp=None, env=ENV):
        """Run check() with DNS, TCP and ssh replaced; defaults are a healthy connection."""
        dns = dns or (lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('128.195.0.1', 22))])
        tcp = tcp or (lambda *a, **k: FakeSocket())
        ssh = ssh or FakeSsh()
        with patch.dict(os.environ, env), patch.object(h.socket, 'getaddrinfo', dns), \
                patch.object(h.socket, 'create_connection', tcp), patch.object(h.subprocess, 'run', ssh):
            return h.check()

    def assert_status(self, result, status, failed_step):
        """check() stopped at failed_step with this status and a hint for the user."""
        self.assertEqual(result['status'], status)
        self.assertFalse(result['connected'])
        self.assertEqual(result['steps'][-1], {**result['steps'][-1], 'name': failed_step, 'ok': False})
        self.assertTrue(result['hint'])

    def test_connected_with_a_key_reports_identity_and_slurm(self):
        result = self.run_check()
        self.assertEqual((result['status'], result['connected'], result['auth']), ('connected', True, 'key'))
        self.assertEqual(result['host'], h.DEFAULT_HOST)
        self.assertEqual(result['remote'], {'hostname': 'login-i15', 'user': 'jdoe', 'slurm': True})
        self.assertEqual([s['name'] for s in result['steps']],
                         ['config', 'dns', 'network', 'master', 'ssh', 'identity'])
        self.assertTrue(all(s['ok'] for s in result['steps']))
        self.assertIsNone(result['hint'])

    def test_connected_through_the_shared_connection(self):
        result = self.run_check(ssh=FakeSsh(master=(0, '', 'Master running (pid=4242)')))
        self.assertEqual((result['status'], result['auth']), ('connected', SHARED))

    def test_no_login_is_attempted_without_a_shared_connection_or_a_loaded_key(self):
        # HPC3 logs every refused attempt as a failed login, so the check must not knock.
        ssh = FakeSsh(agent=(1, 'The agent has no identities.', ''))
        result = self.run_check(ssh=ssh)
        self.assert_status(result, 'auth_required', 'ssh')
        self.assertIn('not attempted', result['steps'][-1]['detail'])
        self.assertFalse([argv for argv in ssh.calls if 'BatchMode=yes' in argv])

    def test_dead_shared_connection_is_closed_and_reported_stale(self):
        ssh = FakeSsh(login=(None, '', ''), master=(0, '', 'Master running (pid=4242)'))
        result = self.run_check(ssh=ssh)
        self.assert_status(result, 'stale_connection', 'master')
        self.assertIn('Log in again', result['hint'])
        self.assertIn('exit', [argv[2] for argv in ssh.calls if argv[1] == '-O'])
        # The probe ran the builtin `true`, and nothing else followed it.
        self.assertEqual(ssh.calls[-2][-1], 'true')

    def test_alive_connection_to_a_stuck_login_node_is_kept_and_reported(self):
        # The connection answers `true`, but HPC3 never finishes the identity command.
        ssh = FakeSsh(login=(None, '', ''), probe=(0, '', ''), master=(0, '', 'Master running (pid=4242)'))
        result = self.run_check(ssh=ssh)
        self.assert_status(result, 'node_unresponsive', 'ssh')
        self.assertEqual(result['auth'], 'shared_connection')
        self.assertIn('logged in', result['hint'])
        # The connection is NOT closed: logging in again would not help.
        self.assertNotIn('exit', [argv[2] for argv in ssh.calls if argv[1] == '-O'])

    def test_missing_or_unsafe_user_is_not_configured_and_nothing_is_contacted(self):
        for user in ('', 'JDoe', '-oProxyCommand=x', 'a b', 'x' * 40):
            with self.subTest(user=user):
                ssh = FakeSsh()
                result = self.run_check(ssh=ssh, env={'HPC3_USER': user})
                self.assert_status(result, 'not_configured', 'config')
                self.assertEqual(ssh.calls, [])
        result = self.run_check(env={'HPC3_USER': 'jdoe', 'HPC3_HOST': '-oProxyCommand=x'})
        self.assert_status(result, 'not_configured', 'config')

    def test_dns_failure(self):
        def dns(*args, **kwargs):
            """A name that does not resolve."""
            raise socket.gaierror(8, 'nodename nor servname provided')
        self.assert_status(self.run_check(dns=dns), 'dns_failed', 'dns')

    def test_closed_port_means_vpn_is_needed_and_ssh_is_never_started(self):
        def tcp(*args, **kwargs):
            """Port 22 that never answers (no VPN)."""
            raise socket.timeout('timed out')
        ssh = FakeSsh()
        result = self.run_check(tcp=tcp, ssh=ssh)
        self.assert_status(result, 'network_unreachable', 'network')
        self.assertIn('VPN', result['hint'])
        self.assertEqual(ssh.calls, [])

    def test_ssh_errors_are_classified(self):
        cases = {
            'jdoe@hpc3.rcic.uci.edu: Permission denied (publickey,keyboard-interactive).': 'auth_required',
            'Host key verification failed.': 'host_key_unknown',
            '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.':
                'host_key_changed',
            'ssh: connect to host hpc3.rcic.uci.edu port 22: Connection refused': 'connection_refused',
            'kex_exchange_identification: read: Connection reset by peer': 'ssh_failed',
        }
        for stderr, status in cases.items():
            with self.subTest(status=status):
                result = self.run_check(ssh=FakeSsh(login=(255, '', stderr)))
                self.assert_status(result, status, 'ssh')
                self.assertEqual(result['steps'][-1]['detail'], stderr.splitlines()[-1])

    def test_hung_handshake_and_missing_client(self):
        self.assert_status(self.run_check(ssh=FakeSsh(login=(None, '', ''))), 'timeout', 'ssh')

        def missing(argv, **kwargs):
            """No ssh client installed."""
            raise FileNotFoundError('ssh')
        self.assert_status(self.run_check(ssh=missing), 'ssh_missing', 'ssh')

    def test_wrong_user_or_no_slurm_is_unexpected(self):
        for out in ('host=login-i15\nuser=someone\nslurm=yes\n', 'host=box\nuser=jdoe\nslurm=no\n', ''):
            with self.subTest(out=out):
                result = self.run_check(ssh=FakeSsh(login=(0, out, '')))
                self.assert_status(result, 'unexpected_remote', 'identity')


class CommandTest(unittest.TestCase):
    """The ssh argv is fixed, non-interactive for checks, and never trusts unknown host keys."""

    def test_check_never_prompts_and_sends_only_the_constant_command(self):
        argv = h.check_command('jdoe', h.DEFAULT_HOST)
        self.assertEqual(argv[0], 'ssh')
        self.assertIn('BatchMode=yes', argv)
        self.assertIn('StrictHostKeyChecking=yes', argv)
        self.assertIn('ControlMaster=no', argv)
        self.assertEqual(argv[-3:], ['--', h.DEFAULT_HOST, h.REMOTE_COMMAND])

    def test_login_lets_the_user_confirm_the_host_key_and_keeps_the_connection(self):
        argv = h.login_command('jdoe', h.DEFAULT_HOST)
        self.assertIn('StrictHostKeyChecking=ask', argv)
        self.assertNotIn('StrictHostKeyChecking=yes', argv)
        self.assertNotIn('BatchMode=yes', argv)
        self.assertIn('ControlPersist=' + h.CONTROL_PERSIST, argv)
        self.assertIn('ServerAliveInterval=15', argv)
        self.assertEqual(argv[-2:], ['--', h.DEFAULT_HOST])

    def test_control_socket_name_does_not_depend_on_this_computers_host_name(self):
        # %C hashes the local host name too, which changes when a laptop changes networks.
        self.assertNotIn('%C', h.control_path())
        self.assertNotIn('%l', h.control_path())
        self.assertTrue(h.control_path().endswith('signet-hpc3-%r@%h-%p'))

    def test_all_commands_share_one_control_socket(self):
        path = 'ControlPath=' + h.control_path()
        for argv in (h.check_command('jdoe', 'h'), h.login_command('jdoe', 'h'),
                     h.master_command('jdoe', 'h', 'check')):
            self.assertIn(path, argv)

    def test_report_marks_the_failed_step(self):
        report = h.format_report({'status': 'network_unreachable', 'hint': 'Connect to the VPN.',
                                  'steps': [{'name': 'dns', 'ok': True, 'detail': '1.2.3.4'},
                                            {'name': 'network', 'ok': False, 'detail': 'timed out'}]})
        self.assertIn('[!!] network', report)
        self.assertIn('Next: Connect to the VPN.', report)


class LoginLogoutTest(unittest.TestCase):
    """login and logout look at the shared connection first, so they never prompt for nothing."""

    OPEN = (0, '', 'Master running (pid=4242)')
    CLOSED = (255, '', 'Control socket connect(/x): No such file or directory')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = patch.object(h.Path, 'home', lambda: Path(self.temp.name))
        self.home.start()

    def tearDown(self):
        self.home.stop()
        self.temp.cleanup()

    def run_with(self, function, master, login_code=0):
        """Run login() or logout() with ssh faked; return code, message and the calls made."""
        ssh, interactive = FakeSsh(master=master), []

        def call(argv):
            """Record the interactive ssh login and return the scripted exit code."""
            interactive.append(argv)
            return login_code
        with patch.object(h.subprocess, 'run', ssh), patch.object(h.subprocess, 'call', call), \
                patch('sys.stdout'):
            code, message = function('jdoe', h.DEFAULT_HOST)
        return code, message, ssh.calls, interactive

    def test_login_when_already_logged_in_does_not_start_ssh_again(self):
        code, message, _, interactive = self.run_with(h.login, self.OPEN)
        self.assertEqual(code, 0)
        self.assertIn('Already logged in', message)
        self.assertEqual(interactive, [])

    def test_login_without_a_connection_runs_the_interactive_ssh_once(self):
        code, message, _, interactive = self.run_with(h.login, self.CLOSED)
        self.assertEqual((code, interactive), (0, [h.login_command('jdoe', h.DEFAULT_HOST)]))
        self.assertIn('Logged in', message)
        self.assertTrue((Path(self.temp.name) / '.ssh').is_dir())

    def test_failed_login_points_to_check(self):
        code, message, _, _ = self.run_with(h.login, self.CLOSED, login_code=255)
        self.assertEqual(code, 255)
        self.assertIn('hpc3_ssh.py check', message)

    def test_login_replaces_a_dead_shared_connection(self):
        ssh, interactive = FakeSsh(login=(None, '', ''), master=self.OPEN), []

        def call(argv):
            """Record the interactive ssh login and return success."""
            interactive.append(argv)
            return 0
        with patch.object(h.subprocess, 'run', ssh), patch.object(h.subprocess, 'call', call), patch('sys.stdout'):
            code, message = h.login('jdoe', h.DEFAULT_HOST)
        self.assertEqual((code, interactive), (0, [h.login_command('jdoe', h.DEFAULT_HOST)]))
        self.assertEqual([argv[2] for argv in ssh.calls if argv[1] == '-O'], ['check', 'exit'])

    def test_cancelled_login_is_reported_as_cancelled(self):
        code, message, _, _ = self.run_with(h.login, self.CLOSED, login_code=h.CANCELLED)
        self.assertEqual((code, message), (h.CANCELLED, 'Login cancelled.'))

    def test_logout_without_a_connection_says_so_plainly(self):
        code, message, calls, _ = self.run_with(h.logout, self.CLOSED)
        self.assertEqual(code, 0)
        self.assertIn('Not logged in', message)
        self.assertNotIn('exit', [argv[2] for argv in calls])

    def test_logout_closes_an_open_connection(self):
        code, message, calls, _ = self.run_with(h.logout, self.OPEN)
        self.assertEqual(code, 0)
        self.assertIn('Logged out', message)
        self.assertEqual([argv[2] for argv in calls], ['check', 'exit'])


class FakeSocket:
    """Stands in for a connected TCP socket."""

    def close(self):
        """Nothing to close for a fake socket."""
        pass


if __name__ == '__main__':
    unittest.main()
