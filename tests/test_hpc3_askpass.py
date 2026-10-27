"""Offline tests for hpc3_askpass.py, the dialog helper ssh calls for HPC3 login questions.

osascript is never run: the tests inspect the AppleScript and argv the helper would use, and
replace the dialog runner with scripted answers. No password is typed and nothing contacts
HPC3. The account name is made up.
"""
import io
import os
import subprocess
import unittest
from unittest.mock import patch

import hpc3_askpass as ap
import hpc3_ssh as h

LOGIN_PROMPT = '(jdoe@hpc3.rcic.uci.edu) Password: '
DUO = ('Duo two-factor login for jdoe\n\nEnter a passcode or select one of the following options:\n\n'
       ' 1. Duo Push to XXX-XXX-1234\n 2. Phone call to XXX-XXX-1234\n\nPasscode or option (1-2): ')


class Dialogs:
    """Replaces ask()'s dialog runner: records each dialog and answers from a script."""

    def __init__(self, *answers):
        self.answers, self.shown = list(answers), []

    def __call__(self, kind, message, title, buttons):
        self.shown.append({'kind': kind, 'message': message, 'title': title, 'buttons': buttons})
        return self.answers.pop(0)


class ScriptTest(unittest.TestCase):
    """The AppleScript itself: words as data, padlock icon, timeouts never approve."""

    def test_words_are_passed_as_data_after_the_options(self):
        message = '-e do shell script "rm -rf ~" Password:'
        argv = ap.osascript_command('secret', message, 'Title', ['Cancel', 'OK'])
        self.assertEqual(argv[-5:], ['--', message, 'Title', 'Cancel', 'OK'])
        script = [argv[i + 1] for i, value in enumerate(argv[:-5]) if value == '-e']
        self.assertFalse(any(message in line or 'Cancel' in line for line in script))

    def test_secret_answers_are_masked_and_others_are_not(self):
        self.assertIn('with hidden answer', ' '.join(ap.dialog_script('secret')))
        self.assertNotIn('with hidden answer', ' '.join(ap.dialog_script('text')))

    def test_every_dialog_uses_the_padlock_gives_up_and_timeouts_never_count(self):
        for kind in ('secret', 'text', 'choice', 'confirm', 'notice'):
            with self.subTest(kind=kind):
                script = '\n'.join(ap.dialog_script(kind))
                self.assertIn('giving up after %d' % ap.TIMEOUT, script)
                self.assertIn('LockedIcon.icns' if os.path.exists(ap.ICON) else 'with icon caution', script)
                if kind != 'notice':
                    self.assertIn('if gave up of reply then error number -128', script)


class AskTest(unittest.TestCase):
    """How each ssh question becomes friendly dialogs, in both languages."""

    def ask(self, prompt, *answers, mode='', language='en'):
        dialogs = Dialogs(*answers)
        with patch.object(ap, 'show', dialogs):
            return ap.ask(prompt, mode, language), dialogs.shown

    def test_password_prompt_becomes_a_plain_request_for_the_uci_password(self):
        answer, shown = self.ask(LOGIN_PROMPT, 'typed-answer')
        self.assertEqual(answer, 'typed-answer')
        self.assertEqual(shown[0]['kind'], 'secret')
        self.assertIn('HPC3 password for jdoe', shown[0]['message'])
        self.assertIn('never stores it', shown[0]['message'])
        self.assertEqual(shown[0]['buttons'], ['Cancel', 'Log in'])
        _, shown = self.ask(LOGIN_PROMPT, 'x', language='zh-Hant')
        self.assertIn('請輸入 jdoe 的 HPC3 密碼', shown[0]['message'])
        self.assertEqual((shown[0]['title'], shown[0]['buttons']), ('SIGNET – HPC3 登入', ['取消', '登入']))

    def test_duo_menu_becomes_buttons_and_push_returns_its_option_number(self):
        answer, shown = self.ask(DUO, 'Send Duo Push')
        self.assertEqual(answer, '1')
        self.assertEqual(shown[0]['kind'], 'choice')
        self.assertEqual(shown[0]['buttons'], ['Cancel', 'Enter passcode', 'Send Duo Push'])
        self.assertIn('jdoe', shown[0]['message'])

    def test_duo_passcode_path_asks_for_the_code(self):
        answer, shown = self.ask(DUO, '輸入驗證碼', '123456', language='zh-Hant')
        self.assertEqual(answer, '123456')
        self.assertEqual([d['kind'] for d in shown], ['choice', 'text'])
        self.assertIn('Duo 驗證碼', shown[1]['message'])

    def test_cancelling_any_step_returns_none(self):
        self.assertIsNone(self.ask(LOGIN_PROMPT, None)[0])
        self.assertIsNone(self.ask(DUO, None)[0])
        self.assertIsNone(self.ask(DUO, 'Enter passcode', None)[0])

    def test_unrecognised_questions_keep_sshs_own_wording(self):
        menu = 'Duo two-factor login for jdoe\n 1. Phone call\nPasscode or option (1-1): '
        for prompt, kind in (('Enter passphrase for key: ', 'secret'), ('Something new? ', 'text'),
                             (menu, 'secret')):
            with self.subTest(prompt=prompt):
                answer, shown = self.ask(prompt, 'typed')
                self.assertEqual((answer, shown[0]['kind'], shown[0]['message']), ('typed', kind, prompt))

    def test_confirm_and_notice_modes(self):
        self.assertEqual(self.ask('Allow?', 'yes', mode='confirm')[0], 'yes')
        self.assertEqual(self.ask('Allow?', 'yes', mode='confirm')[1][0]['buttons'], ['No', 'Yes'])
        self.assertEqual(self.ask('Touch your key', '', mode='none')[0], '')


class MainTest(unittest.TestCase):
    """The helper's contract with ssh: answer on stdout and exit 0; cancel exits 1 and ends ssh."""

    def run_main(self, answer, platform='darwin', language=None, parent_is_ssh=True):
        killed, seen = [], {}

        def fake_ask(prompt, mode, lang):
            seen['language'] = lang
            return answer
        env = {'SIGNET_LANGUAGE': language} if language else {}
        out, err = io.StringIO(), io.StringIO()
        with patch.object(ap.sys, 'platform', platform), patch.object(ap.shutil, 'which', lambda _: 'osascript'), \
                patch.object(ap, 'ask', fake_ask), patch.dict(os.environ, env), \
                patch.object(ap, 'parent_is_ssh', lambda pid: parent_is_ssh), patch.object(ap.os, 'getppid', lambda: 4242), \
                patch.object(ap.os, 'kill', lambda pid, sig: killed.append((pid, sig))), \
                patch.object(ap.sys, 'stdout', out), patch.object(ap.sys, 'stderr', err):
            code = ap.main([LOGIN_PROMPT])
        return code, out.getvalue(), err.getvalue(), killed, seen.get('language')

    def test_answer_goes_to_stdout_only(self):
        code, out, err, killed, _ = self.run_main('the-answer')
        self.assertEqual((code, out, killed), (0, 'the-answer\n', []))
        self.assertNotIn('the-answer', err)

    def test_cancel_exits_1_and_stops_the_calling_ssh(self):
        code, out, _, killed, _ = self.run_main(None)
        self.assertEqual((code, out, killed), (1, '', [(4242, ap.signal.SIGTERM)]))

    def test_nothing_is_signalled_unless_the_parent_is_ssh(self):
        self.assertEqual(self.run_main(None, parent_is_ssh=False)[3], [])

    def test_language_comes_from_the_environment_and_falls_back_to_english(self):
        self.assertEqual(self.run_main('x', language='zh-Hant')[4], 'zh-Hant')
        self.assertEqual(self.run_main('x', language='fr')[4], 'en')
        self.assertEqual(self.run_main('x')[4], 'en')

    def test_other_systems_point_to_the_terminal_login(self):
        code, out, err, killed, _ = self.run_main('x', platform='linux')
        self.assertEqual((code, out), (1, ''))
        self.assertIn('hpc3_ssh.py login', err)

    def test_parent_check_looks_at_the_real_process_name(self):
        # This test runs under python, not ssh, so its own process must not qualify.
        self.assertFalse(ap.parent_is_ssh(os.getpid()))


class PopupLoginTest(unittest.TestCase):
    """hpc3_ssh.login(popup=True) routes every question to the helper and never to a terminal."""

    def test_popup_login_sets_askpass_language_and_closes_stdin(self):
        seen = {}

        def call(argv, **kwargs):
            seen.update(kwargs, argv=argv)
            return 0
        with patch.object(h, 'shared_connection_alive', lambda *a: False), \
                patch.object(h.subprocess, 'call', call), patch('sys.stdout'):
            code, _ = h.login('jdoe', h.DEFAULT_HOST, popup=True, language='zh-Hant')
        self.assertEqual(code, 0)
        self.assertEqual(seen['argv'], h.login_command('jdoe', h.DEFAULT_HOST))
        self.assertIs(seen['stdin'], subprocess.DEVNULL)
        self.assertEqual(seen['env']['SSH_ASKPASS'], str(h.ASKPASS))
        self.assertEqual(seen['env']['SSH_ASKPASS_REQUIRE'], 'force')
        self.assertEqual(seen['env']['SIGNET_LANGUAGE'], 'zh-Hant')
        self.assertEqual(h.askpass_environment('<script>')['SIGNET_LANGUAGE'], 'en')

    def test_helper_exists_and_is_executable(self):
        self.assertTrue(h.ASKPASS.is_file())
        self.assertTrue(os.access(h.ASKPASS, os.X_OK))
        self.assertTrue(h.ASKPASS.read_text().startswith('#!/usr/bin/env python3\n'))


if __name__ == '__main__':
    unittest.main()
