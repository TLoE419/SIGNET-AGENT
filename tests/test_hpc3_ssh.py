"""Offline tests for hpc3_ssh.check(): every layer's failure, without touching the network.

DNS, the TCP probe and ssh are replaced by fakes, so these tests never contact HPC3, need no
VPN and use no credentials. The user name below is made up.
"""
import os
import socket
import subprocess
import unittest
from unittest.mock import patch

import hpc3_ssh as h

ENV = {'HPC3_USER': 'jdoe', 'HPC3_HOST': ''}
IDENTITY = 'host=login-i15\nuser=jdoe\nslurm=yes\n'
# How check() reports a login that reused the shared connection.
SHARED = 'shared_connection'


class FakeSsh:
    """Answers `ssh -O check` and the BatchMode login with scripted (code, stdout, stderr)."""

    def __init__(self, login=(0, IDENTITY, ''), master=(255, '', 'No such file or directory')):
        self.login, self.master, self.calls = login, master, []

    def __call__(self, argv, **kwargs):
        self.calls.append(argv)
        if 'BatchMode=yes' not in argv:
            code, out, err = self.master
        else:
            code, out, err = self.login
        if code is None:
            raise subprocess.TimeoutExpired(argv, kwargs.get('timeout'))
        return subprocess.CompletedProcess(argv, code, out, err)


class CheckTest(unittest.TestCase):
    """check() stops at the first broken layer and names it."""

    def run_check(self, ssh=None, dns=None, tcp=None, env=ENV):
        dns = dns or (lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('128.195.0.1', 22))])
        tcp = tcp or (lambda *a, **k: FakeSocket())
        ssh = ssh or FakeSsh()
        with patch.dict(os.environ, env), patch.object(h.socket, 'getaddrinfo', dns), \
                patch.object(h.socket, 'create_connection', tcp), patch.object(h.subprocess, 'run', ssh):
            return h.check()

    def assert_status(self, result, status, failed_step):
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
            raise socket.gaierror(8, 'nodename nor servname provided')
        self.assert_status(self.run_check(dns=dns), 'dns_failed', 'dns')

    def test_closed_port_means_vpn_is_needed_and_ssh_is_never_started(self):
        def tcp(*args, **kwargs):
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
        self.assertEqual(argv[-2:], ['--', h.DEFAULT_HOST])

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


class FakeSocket:
    """Stands in for a connected TCP socket."""

    def close(self):
        pass


if __name__ == '__main__':
    unittest.main()
