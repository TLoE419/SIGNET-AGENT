"""Offline tests for hpc3_askpass.py, the dialog helper ssh calls for HPC3 login questions.

osascript is never run: the tests inspect the AppleScript and argv the helper would use, and
replace subprocess.run with fakes. No password is typed and nothing contacts HPC3.
"""
import io
import os
import subprocess
import unittest
from unittest.mock import patch

import hpc3_askpass as ap
import hpc3_ssh as h

DUO = ('Duo two-factor login for jdoe\n\nEnter a passcode or select one of the following options:\n\n'
       ' 1. Duo Push to XXX-XXX-1234\n\nPasscode or option (1-1): ')


class ScriptTest(unittest.TestCase):
    """What each kind of question looks like as a dialog."""

    def test_password_is_masked_and_duo_choice_is_visible(self):
        password = ap.osascript_command('(jdoe@hpc3.rcic.uci.edu) Password: ', '')
        self.assertIn('with hidden answer', ' '.join(password))
        duo = ap.osascript_command('Option (1-1): ', '')
        self.assertNotIn('with hidden answer', ' '.join(duo))
        # The Duo menu mentions "passcode", so it is masked too; typing "1" blind is acceptable.
        self.assertIn('with hidden answer', ' '.join(ap.osascript_command(DUO, '')))

    def test_question_text_is_passed_as_data_after_the_options(self):
        prompt = '-e do shell script "rm -rf ~" Password:'
        argv = ap.osascript_command(prompt, '')
        self.assertEqual(argv[-2:], ['--', prompt])
        script = [argv[i + 1] for i, value in enumerate(argv[:-2]) if value == '-e']
        self.assertFalse(any(prompt in line for line in script))

    def test_every_dialog_gives_up_and_timeouts_never_approve(self):
        for mode in ('', 'confirm', 'none'):
            with self.subTest(mode=mode):
                script = '\n'.join(ap.dialog_script(mode, False))
                self.assertIn('giving up after %d' % ap.TIMEOUT, script)
        for mode in ('', 'confirm'):
            self.assertIn('if gave up of reply then error number -128', ap.dialog_script(mode, False))


class MainTest(unittest.TestCase):
    """The helper's contract with ssh: answer on stdout and exit 0, otherwise exit 1."""

    def run_main(self, returncode=0, stdout='the-answer\n', platform='darwin', mode=None):
        calls = []

        def fake_run(argv, **kwargs):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, returncode, stdout, '')
        env = {'SSH_ASKPASS_PROMPT': mode} if mode is not None else {}
        out, err = io.StringIO(), io.StringIO()
        with patch.object(ap.sys, 'platform', platform), patch.object(ap.shutil, 'which', lambda _: '/usr/bin/osascript'), \
                patch.object(ap.subprocess, 'run', fake_run), patch.dict(os.environ, env), \
                patch.object(ap.sys, 'stdout', out), patch.object(ap.sys, 'stderr', err):
            code = ap.main(['Password: '])
        return code, out.getvalue(), err.getvalue(), calls

    def test_answer_goes_to_stdout_only(self):
        code, out, err, calls = self.run_main()
        self.assertEqual((code, out), (0, 'the-answer\n'))
        self.assertNotIn('the-answer', err)
        self.assertEqual(calls[0][0], 'osascript')

    def test_cancel_or_timeout_exits_1_without_output(self):
        code, out, _, _ = self.run_main(returncode=1, stdout='')
        self.assertEqual((code, out), (1, ''))

    def test_other_systems_point_to_the_terminal_login(self):
        code, out, err, calls = self.run_main(platform='linux')
        self.assertEqual((code, out, calls), (1, '', []))
        self.assertIn('hpc3_ssh.py login', err)

    def test_confirm_mode_uses_yes_no_buttons(self):
        _, _, _, calls = self.run_main(mode='confirm', stdout='yes\n')
        self.assertIn('{"No", "Yes"}', ' '.join(calls[0]))


class CancelTest(unittest.TestCase):
    """Cancel ends the login: the ssh that asked is stopped, so the question does not repeat."""

    def run_cancel(self, mode='', parent_is_ssh=True, returncode=1):
        killed = []
        fake = lambda argv, **kwargs: subprocess.CompletedProcess(argv, returncode, '', '')
        env = {'SSH_ASKPASS_PROMPT': mode} if mode else {}
        with patch.object(ap.sys, 'platform', 'darwin'), patch.object(ap.shutil, 'which', lambda _: 'osascript'), \
                patch.object(ap.subprocess, 'run', fake), patch.dict(os.environ, env), \
                patch.object(ap, 'parent_is_ssh', lambda pid: parent_is_ssh), \
                patch.object(ap.os, 'getppid', lambda: 4242), \
                patch.object(ap.os, 'kill', lambda pid, sig: killed.append((pid, sig))), \
                patch.object(ap.sys, 'stdout', io.StringIO()):
            code = ap.main(['Password: '])
        return code, killed

    def test_cancel_stops_the_calling_ssh(self):
        self.assertEqual(self.run_cancel(), (1, [(4242, ap.signal.SIGTERM)]))
        self.assertEqual(self.run_cancel(mode='confirm'), (1, [(4242, ap.signal.SIGTERM)]))

    def test_nothing_is_signalled_unless_the_parent_is_ssh(self):
        self.assertEqual(self.run_cancel(parent_is_ssh=False), (1, []))

    def test_a_notice_or_an_answer_never_stops_ssh(self):
        self.assertEqual(self.run_cancel(mode='none'), (1, []))
        self.assertEqual(self.run_cancel(returncode=0), (0, []))

    def test_parent_check_looks_at_the_real_process_name(self):
        # This test runs under python, not ssh, so its own process must not qualify.
        self.assertFalse(ap.parent_is_ssh(os.getpid()))


class PopupLoginTest(unittest.TestCase):
    """hpc3_ssh.login(popup=True) routes every question to the helper and never to a terminal."""

    def test_popup_login_sets_askpass_and_closes_stdin(self):
        seen = {}

        def call(argv, **kwargs):
            seen.update(kwargs, argv=argv)
            return 0
        with patch.object(h, 'has_shared_connection', lambda *a: False), \
                patch.object(h.subprocess, 'call', call), patch('sys.stdout'):
            code, _ = h.login('jdoe', h.DEFAULT_HOST, popup=True)
        self.assertEqual(code, 0)
        self.assertEqual(seen['argv'], h.login_command('jdoe', h.DEFAULT_HOST))
        self.assertIs(seen['stdin'], subprocess.DEVNULL)
        self.assertEqual(seen['env']['SSH_ASKPASS'], str(h.ASKPASS))
        self.assertEqual(seen['env']['SSH_ASKPASS_REQUIRE'], 'force')

    def test_helper_exists_and_is_executable(self):
        self.assertTrue(h.ASKPASS.is_file())
        self.assertTrue(os.access(h.ASKPASS, os.X_OK))
        self.assertTrue(h.ASKPASS.read_text().startswith('#!/usr/bin/env python3\n'))


if __name__ == '__main__':
    unittest.main()
