#!/usr/bin/env python3
"""Show ssh's login questions in a native macOS dialog (SSH_ASKPASS helper for HPC3 login).

When ssh runs without a terminal (from the app's backend), it cannot ask for the password
or the Duo choice itself. With SSH_ASKPASS pointing here and SSH_ASKPASS_REQUIRE=force,
ssh starts this program once per question, passing the question text as the only argument,
and reads the answer from this program's stdout.

So the answer goes from the dialog straight back to ssh through a pipe. It is never seen by
the web page or the Python server, never written to disk, and never logged. This program
exists only for the length of one question.

Exit status (what ssh expects):
  0  the answer was printed to stdout
  1  the user cancelled, the dialog timed out, or no dialog is available here

Cancel ends the whole login. ssh would otherwise treat a cancelled answer as a wrong
password and ask again, once per allowed attempt and login method, so the dialog would keep
coming back. On Cancel or timeout this program therefore stops the ssh process that called
it (its parent), after checking that the parent really is ssh.

The dialogs carry SIGNET's title and the macOS padlock, and say in plain words what is being
asked: HPC3's "(user@host) Password:" becomes a short request for the UCI password, and the
Duo menu becomes buttons ("Send Duo Push" / "Enter passcode") instead of typing an option
number. Any question it does not recognise is still asked with ssh's own wording. Wording
follows SIGNET_LANGUAGE (en or zh-Hant), which the backend sets from the page's language.

ssh also sets SSH_ASKPASS_PROMPT:
  (unset)   a question needing a typed answer (password, Duo option, host key yes/no)
  confirm   a yes/no confirmation; printing "yes" approves
  none      a notice only; nothing is read back

Only macOS is supported for now (osascript). Elsewhere it exits 1 with a message, and the
user can log in from a terminal with `python3 hpc3_ssh.py login` instead.
"""
import os
import re
import shutil
import signal
import subprocess
import sys

# Seconds before an unanswered dialog closes itself, so a forgotten login cannot hang forever.
TIMEOUT = 120
# Questions whose answers are secret are typed into a masked field.
SECRET = re.compile(r'password|passphrase|passcode', re.I)
# macOS's own padlock, so the dialog reads as a sign-in rather than a generic script prompt.
ICON = '/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/LockedIcon.icns'
# What ssh asks on HPC3: "(user@host) Password:" and the Duo menu ending in "Passcode or option".
PASSWORD = re.compile(r'^\((?P<user>[^@()\s]+)@[^()\s]+\)\s*password:\s*$', re.I)
DUO_USER = re.compile(r'Duo two-factor login for (\S+)')
DUO_OPTION = re.compile(r'^\s*(\d+)\.\s+(.+?)\s*$', re.M)

# Dialog wording in the page's language (SIGNET_LANGUAGE, set by the backend from the page).
TEXT = {
    'en': {
        'title': 'SIGNET – HPC3 login', 'ok': 'OK', 'cancel': 'Cancel', 'login': 'Log in',
        'yes': 'Yes', 'no': 'No', 'account': 'your account',
        'password': 'Enter the HPC3 password for {user}.\n\nThis is your UCI password. SIGNET hands it '
                    'straight to ssh and never stores it.',
        'duo': 'Duo two-factor verification for {user}.\n\nHow would you like to verify?',
        'push': 'Send Duo Push', 'passcode_button': 'Enter passcode',
        'passcode': 'Enter a Duo passcode for {user}.',
    },
    'zh-Hant': {
        'title': 'SIGNET – HPC3 登入', 'ok': '確定', 'cancel': '取消', 'login': '登入',
        'yes': '是', 'no': '否', 'account': '你的帳號',
        'password': '請輸入 {user} 的 HPC3 密碼。\n\n也就是你的 UCI 密碼。SIGNET 只會把它直接交給 ssh，'
                    '不會儲存。',
        'duo': '{user} 需要進行 Duo 雙重驗證。\n\n請選擇驗證方式：',
        'push': '傳送 Duo 推播', 'passcode_button': '輸入驗證碼',
        'passcode': '請輸入 {user} 的 Duo 驗證碼。',
    },
}


def dialog_script(kind):
    """AppleScript for one dialog kind. All words arrive as argv, never as code.

    argv: 1 message, 2 title, 3... button labels (the last one is the default, the first one
    cancels). Passing text as arguments means nothing in ssh's question can change what the
    script does.
    kind: secret / text (typed answer), choice (three buttons), confirm (yes/no), notice.
    """
    icon = ('with icon (POSIX file "%s" as alias)' % ICON) if os.path.exists(ICON) else 'with icon caution'
    common = 'with title (item 2 of argv) giving up after %d %s' % (TIMEOUT, icon)
    lines = ['on run argv', 'activate']
    if kind == 'notice':
        lines.append('display dialog (item 1 of argv) buttons {item 3 of argv} default button 1 ' + common)
        return lines + ['return ""', 'end run']
    if kind in ('secret', 'text'):
        hidden = ' with hidden answer' if kind == 'secret' else ''
        lines.append('set reply to display dialog (item 1 of argv) default answer ""%s buttons '
                     '{item 3 of argv, item 4 of argv} default button 2 cancel button 1 %s' % (hidden, common))
        result = 'text returned of reply'
    elif kind == 'choice':
        lines.append('set reply to display dialog (item 1 of argv) buttons {item 3 of argv, item 4 of argv, '
                     'item 5 of argv} default button 3 cancel button 1 ' + common)
        result = 'button returned of reply'
    else:  # confirm
        lines.append('set reply to display dialog (item 1 of argv) buttons {item 3 of argv, item 4 of argv} '
                     'default button 2 cancel button 1 ' + common)
        result = '"yes"'
    # A dialog that timed out counts as Cancel, never as an answer or an approval.
    lines += ['if gave up of reply then error number -128', 'return ' + result, 'end run']
    return lines


def osascript_command(kind, message, title, buttons):
    """argv for osascript: each script line as its own -e, then the words as data after --."""
    argv = ['osascript']
    for line in dialog_script(kind):
        argv += ['-e', line]
    return argv + ['--', message, title] + list(buttons)


def show(kind, message, title, buttons):
    """Run one dialog; the typed text or chosen button, or None if cancelled or timed out."""
    result = subprocess.run(osascript_command(kind, message, title, buttons), stdout=subprocess.PIPE,
                            stdin=subprocess.DEVNULL, universal_newlines=True)
    return result.stdout.rstrip('\n') if result.returncode == 0 else None


def ask(prompt, mode, language):
    """Turn one ssh question into friendly dialogs; return the answer for ssh, or None.

    Unrecognised questions are still asked, with ssh's own wording, so a change in HPC3's
    prompts never blocks a login.
    """
    t = TEXT[language]
    if mode == 'none':
        show('notice', prompt, t['title'], [t['ok']])
        return ''
    if mode == 'confirm':
        return show('confirm', prompt, t['title'], [t['no'], t['yes']])
    password = PASSWORD.match(prompt.strip())
    if password:
        return show('secret', t['password'].format(user=password.group('user')), t['title'], [t['cancel'], t['login']])
    if 'passcode or option' in prompt.lower():
        user = (DUO_USER.search(prompt) or [None, t['account']])[1]
        push = next((number for number, label in DUO_OPTION.findall(prompt) if 'push' in label.lower()), None)
        if push:
            choice = show('choice', t['duo'].format(user=user), t['title'],
                          [t['cancel'], t['passcode_button'], t['push']])
            if choice == t['push']:
                return push  # The menu number for "Duo Push"; the user then approves on the phone.
            if choice == t['passcode_button']:
                return show('text', t['passcode'].format(user=user), t['title'], [t['cancel'], t['ok']])
            return None
    kind = 'secret' if SECRET.search(prompt) else 'text'
    return show(kind, prompt, t['title'], [t['cancel'], t['ok']])


def parent_is_ssh(pid):
    """True if pid is an ssh client; nothing else is ever signalled."""
    result = subprocess.run(['ps', '-o', 'comm=', '-p', str(pid)], stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, universal_newlines=True)
    return os.path.basename(result.stdout.strip()) == 'ssh'


def abort_login():
    """Stop the ssh that asked, so a cancelled question ends the login instead of repeating."""
    parent = os.getppid()
    if parent > 1 and parent_is_ssh(parent):
        os.kill(parent, signal.SIGTERM)


def main(argv=None):
    """Ask one question; print the answer for ssh. Never prints the answer anywhere else."""
    argv = sys.argv[1:] if argv is None else argv
    prompt = argv[0] if argv else 'HPC3 login'
    mode = os.environ.get('SSH_ASKPASS_PROMPT', '')
    if sys.platform != 'darwin' or not shutil.which('osascript'):
        print('No login dialog is available on this system; run `python3 hpc3_ssh.py login` '
              'in a terminal instead.', file=sys.stderr)
        return 1
    language = os.environ.get('SIGNET_LANGUAGE')
    answer = ask(prompt, mode, language if language in TEXT else 'en')
    if answer is None:
        # Cancel, No, or timeout: end the login instead of letting ssh ask again.
        abort_login()
        return 1
    # Answers go to stdout only, which is ssh's pipe; nothing is logged.
    sys.stdout.write(answer + '\n')
    return 0

if __name__ == '__main__':
    sys.exit(main())
