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

TITLE = 'SIGNET – HPC3 login'
# Seconds before an unanswered dialog closes itself, so a forgotten login cannot hang forever.
TIMEOUT = 120
# Questions whose answers are secret are typed into a masked field.
SECRET = re.compile(r'password|passphrase|passcode', re.I)


def dialog_script(mode, secret):
    """AppleScript for one dialog. The question text arrives as argv, never as code.

    Passing the text as an argument (not pasting it into the script) means nothing in the
    question can change what the script does.
    """
    lines = ['on run argv', 'activate']
    if mode == 'none':
        lines.append('display dialog (item 1 of argv) with title "%s" buttons {"OK"} default button "OK" '
                     'giving up after %d with icon note' % (TITLE, TIMEOUT))
        lines.append('return ""')
    elif mode == 'confirm':
        lines.append('set reply to display dialog (item 1 of argv) with title "%s" buttons {"No", "Yes"} '
                     'default button "Yes" cancel button "No" giving up after %d with icon caution'
                     % (TITLE, TIMEOUT))
        # A timed-out confirmation must count as "No", never as approval.
        lines.append('if gave up of reply then error number -128')
        lines.append('return "yes"')
    else:
        lines.append('set reply to display dialog (item 1 of argv) default answer ""%s with title "%s" '
                     'buttons {"Cancel", "OK"} default button "OK" cancel button "Cancel" '
                     'giving up after %d with icon note'
                     % (' with hidden answer' if secret else '', TITLE, TIMEOUT))
        lines.append('if gave up of reply then error number -128')
        lines.append('return text returned of reply')
    lines.append('end run')
    return lines


def osascript_command(prompt, mode):
    """argv for osascript: each script line as its own -e, then the question as data."""
    argv = ['osascript']
    for line in dialog_script(mode, bool(SECRET.search(prompt))):
        argv += ['-e', line]
    return argv + ['--', prompt]


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
    # Answers come back on stdout only; stderr is left for osascript's own errors.
    result = subprocess.run(osascript_command(prompt, mode), stdout=subprocess.PIPE,
                            stdin=subprocess.DEVNULL, universal_newlines=True)
    if result.returncode != 0:
        # Cancel, No, or timeout. A notice (mode none) has nothing to refuse, so it never aborts.
        if mode != 'none':
            abort_login()
        return 1
    sys.stdout.write(result.stdout)
    return 0


if __name__ == '__main__':
    sys.exit(main())
