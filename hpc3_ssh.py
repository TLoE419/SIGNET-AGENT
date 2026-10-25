"""Check whether this computer can reach UCI HPC3 over SSH (Monitor Spec 02, first piece).

HPC3 accepts logins only from the UCI campus network or VPN, and every login needs either
a password plus Duo, or an SSH key with a passphrase. This module never sees or stores any
of those secrets. Authentication always happens in the user's own terminal:

  * SSH key: the key is unlocked in ssh-agent (or the macOS keychain) by the user, or
  * one interactive login (`python3 hpc3_ssh.py login`): password and Duo are typed into
    ssh itself, which then keeps a shared "control master" connection open for
    CONTROL_PERSIST. Later checks and commands reuse that connection without prompting.

check() walks the connection one layer at a time and stops at the first failure, so the
result says *where* it broke and what to do about it:

  1. config    HPC3_USER / HPC3_HOST are set and well formed
  2. dns       the host name resolves
  3. network   TCP port 22 answers (fails off campus without the VPN)
  4. master    whether a control-master connection is already open (informational)
  5. ssh       a non-interactive login works (BatchMode: it never prompts)
  6. identity  the remote side is the expected user on a host with Slurm

Usage:
  python3 hpc3_ssh.py check [--json]   # exit 0 when connected, 1 otherwise
  python3 hpc3_ssh.py login            # open the shared connection (password + Duo once);
                                       # does nothing if one is already open
  python3 hpc3_ssh.py logout           # close the shared connection, if there is one

Settings come from the environment or .env: HPC3_USER (your UCInetID, required) and
HPC3_HOST (default hpc3.rcic.uci.edu).
"""
import datetime
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys

DEFAULT_HOST = 'hpc3.rcic.uci.edu'
PORT = 22
# How long the shared connection stays open after the last use.
CONTROL_PERSIST = '8h'
# Seconds allowed for each layer; a dropped VPN should fail fast, not hang.
TCP_TIMEOUT = 5
SSH_TIMEOUT = 30
# The only command ever sent by check(): who and where we are, and whether Slurm exists.
# It is a constant, never built from user input.
REMOTE_COMMAND = ('printf "host=%s\\nuser=%s\\n" "$(hostname)" "$(id -un)"; '
                  'command -v sbatch >/dev/null && echo slurm=yes || echo slurm=no')

# ssh error text -> (status, hint). Checked in order; the first match wins.
SSH_ERRORS = (
    ('REMOTE HOST IDENTIFICATION HAS CHANGED', 'host_key_changed',
     'HPC3\'s host key differs from the one saved in ~/.ssh/known_hosts. This can mean the '
     'connection is being intercepted. Do not continue; check the key with RCIC first.'),
    ('Host key verification failed', 'host_key_unknown',
     'HPC3\'s host key is not trusted yet. Run `python3 hpc3_ssh.py login` once; ssh shows the '
     'fingerprint. Accept it only if it matches what RCIC or a teammate who already connected sees.'),
    ('Permission denied', 'auth_required',
     'HPC3 is reachable but no login is available without a prompt. Run '
     '`python3 hpc3_ssh.py login` (password + Duo), or unlock your SSH key with ssh-add.'),
    ('Connection refused', 'connection_refused',
     'HPC3 refused the SSH connection. The login nodes may be down; check RCIC status.'),
    ('timed out', 'timeout',
     'The SSH handshake timed out. Check the VPN connection and try again.'),
)


def settings():
    """Return (user, host) from the environment; raise ValueError if missing or malformed."""
    user = os.environ.get('HPC3_USER', '').strip()
    host = os.environ.get('HPC3_HOST', '').strip() or DEFAULT_HOST
    # Both values end up in an ssh argv; allow only plain user and host name characters.
    if not re.fullmatch(r'[a-z][a-z0-9_-]{0,31}', user):
        raise ValueError('Set HPC3_USER to your UCInetID (lowercase letters, digits, _ or -).')
    if not re.fullmatch(r'[A-Za-z0-9.-]{1,253}', host) or host.startswith('-'):
        raise ValueError('HPC3_HOST must be a plain host name, e.g. ' + DEFAULT_HOST)
    return user, host


def control_path():
    """Socket of the shared connection; %C is ssh's hash of user, host and port."""
    return str(Path.home() / '.ssh' / 'signet-hpc3-%C')


def ssh_options(host_key_checking='yes'):
    """Options added to every ssh call made by this module.

    host_key_checking is 'yes' for automatic calls (an unknown or changed key is an error) and
    'ask' only for the interactive login, where the user sees and confirms the fingerprint.
    """
    return ['-o', 'StrictHostKeyChecking=' + host_key_checking,
            '-o', 'ControlPath=' + control_path(),
            '-o', 'ConnectTimeout=10',
            '-o', 'ClearAllForwardings=yes']


def check_command(user, host):
    """Non-interactive ssh argv: BatchMode makes ssh fail instead of asking for anything."""
    return (['ssh', '-o', 'BatchMode=yes', '-o', 'ControlMaster=no'] + ssh_options()
            + ['-l', user, '--', host, REMOTE_COMMAND])


def login_command(user, host):
    """Interactive ssh argv that authenticates once and leaves the shared connection running.

    -f -N: after the password and Duo prompts, go to the background without opening a shell.
    """
    return (['ssh', '-f', '-N', '-o', 'ControlMaster=yes', '-o', 'ControlPersist=' + CONTROL_PERSIST]
            + ssh_options('ask') + ['-l', user, '--', host])


def master_command(user, host, action):
    """`ssh -O check|exit`: ask the shared connection for its status, or close it."""
    return ['ssh', '-O', action] + ssh_options() + ['-l', user, '--', host]


def run(argv, timeout):
    """Run argv without a shell or stdin; return (returncode, stdout, stderr)."""
    try:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                timeout=timeout)
        return result.returncode, result.stdout, result.stderr
    except FileNotFoundError:
        return None, '', 'ssh is not installed or not on PATH'
    except subprocess.TimeoutExpired:
        return None, '', 'timed out after %d seconds' % timeout


def classify_ssh_error(stderr):
    """Map ssh's error text to a (status, hint) pair."""
    for needle, status, hint in SSH_ERRORS:
        if needle.lower() in stderr.lower():
            return status, hint
    return 'ssh_failed', 'SSH failed for an unrecognized reason; see the detail above.'


def parse_identity(stdout):
    """Turn the key=value lines printed by REMOTE_COMMAND into a dict."""
    return dict(line.split('=', 1) for line in stdout.splitlines() if '=' in line)


def last_line(text):
    """The most specific part of an error message, for display."""
    lines = [line.strip() for line in text.strip().splitlines() if line.strip()]
    return lines[-1] if lines else ''


def has_shared_connection(user, host):
    """True if a control-master connection from an earlier login is open (`ssh -O check`)."""
    code, _, _ = run(master_command(user, host, 'check'), timeout=10)
    return code == 0


def login(user, host):
    """Open the shared connection unless one is already open; returns (exit code, message).

    Without the pre-check, a second login would find the control socket taken, fall back to a
    separate unshared connection and ask for the password and Duo again for nothing.
    """
    if has_shared_connection(user, host):
        return 0, 'Already logged in to %s@%s; the shared connection is open.' % (user, host)
    # ssh needs ~/.ssh to exist for the control socket and known_hosts.
    (Path.home() / '.ssh').mkdir(mode=0o700, exist_ok=True)
    print('Opening a shared connection to %s@%s (kept for %s)...' % (user, host, CONTROL_PERSIST))
    # ssh itself prompts for the password and Duo on this terminal; this program never reads them.
    code = subprocess.call(login_command(user, host))
    if code != 0:
        return code, 'Login failed (ssh exit %d). Run `python3 hpc3_ssh.py check` to see why.' % code
    return 0, 'Logged in. Run `python3 hpc3_ssh.py check` to confirm.'


def logout(user, host):
    """Close the shared connection if one is open; returns (exit code, message)."""
    if not has_shared_connection(user, host):
        return 0, 'Not logged in; there is no shared connection to close.'
    code, _, err = run(master_command(user, host, 'exit'), timeout=10)
    if code != 0:
        return code or 1, 'Could not close the shared connection: ' + (last_line(err) or 'unknown error')
    return 0, 'Logged out of %s@%s.' % (user, host)


def check():
    """Diagnose the connection layer by layer; returns a JSON-serializable dict.

    Keys: status ('connected' or the failing reason), connected, user, host, auth
    ('shared_connection' or 'key'), remote (hostname, user, slurm), steps, hint, checked_at.
    """
    result = {'status': None, 'connected': False, 'user': None, 'host': None, 'auth': None,
              'remote': None, 'steps': [], 'hint': None,
              'checked_at': datetime.datetime.now().astimezone().isoformat(timespec='seconds')}

    def step(name, ok, detail):
        result['steps'].append({'name': name, 'ok': ok, 'detail': detail})
        return ok

    def fail(status, hint):
        result.update(status=status, hint=hint)
        return result

    try:
        user, host = settings()
    except ValueError as error:
        step('config', False, str(error))
        return fail('not_configured', 'Add HPC3_USER=<your UCInetID> to .env.')
    result.update(user=user, host=host)
    step('config', True, '%s@%s' % (user, host))

    try:
        addresses = sorted({info[4][0] for info in socket.getaddrinfo(host, PORT, type=socket.SOCK_STREAM)})
    except socket.gaierror as error:
        step('dns', False, str(error))
        return fail('dns_failed', 'The host name does not resolve. Check your internet connection '
                                  'and HPC3_HOST.')
    step('dns', True, ', '.join(addresses))

    try:
        socket.create_connection((host, PORT), timeout=TCP_TIMEOUT).close()
    except OSError as error:
        step('network', False, str(error) or type(error).__name__)
        return fail('network_unreachable', 'Port 22 does not answer. Connect to the UCI VPN '
                                           '(or the campus network) and try again.')
    step('network', True, 'port %d open' % PORT)

    has_master = has_shared_connection(user, host)
    step('master', True, 'shared connection open' if has_master else 'no shared connection')

    code, out, err = run(check_command(user, host), timeout=SSH_TIMEOUT)
    if code is None and 'not installed' in err:
        step('ssh', False, err)
        return fail('ssh_missing', 'Install the OpenSSH client.')
    if code != 0:
        step('ssh', False, last_line(err) or 'exit %s' % code)
        return fail(*classify_ssh_error(err))
    result['auth'] = 'shared_connection' if has_master else 'key'
    step('ssh', True, 'logged in without a prompt (%s)' % result['auth'])

    remote = parse_identity(out)
    result['remote'] = {'hostname': remote.get('host'), 'user': remote.get('user'),
                        'slurm': remote.get('slurm') == 'yes'}
    if remote.get('user') != user or remote.get('slurm') != 'yes':
        step('identity', False, out.strip() or 'no output')
        return fail('unexpected_remote', 'Logged in, but not as %s on a host with Slurm. Check '
                                         'HPC3_USER and HPC3_HOST.' % user)
    step('identity', True, '%s on %s, Slurm available' % (remote['user'], remote['host']))
    result.update(status='connected', connected=True)
    return result


def format_report(result):
    """Human-readable lines for the terminal."""
    lines = ['HPC3 connection: %s' % result['status']]
    for item in result['steps']:
        lines.append('  [%s] %-8s %s' % ('ok' if item['ok'] else '!!', item['name'], item['detail']))
    if result['hint']:
        lines.append('Next: ' + result['hint'])
    return '\n'.join(lines)


def main(argv=None):
    """Command-line entry point: check, login or logout."""
    argv = sys.argv[1:] if argv is None else argv
    try:
        from dotenv import load_dotenv
        load_dotenv(Path(__file__).with_name('.env'))
    except ImportError:
        pass  # .env support is optional; plain environment variables still work
    command = argv[0] if argv else 'check'
    if command == 'check':
        result = check()
        print(json.dumps(result, indent=2) if '--json' in argv[1:] else format_report(result))
        return 0 if result['connected'] else 1
    if command not in ('login', 'logout'):
        print(__doc__.split('Usage:')[1].split('Settings')[0].rstrip(), file=sys.stderr)
        return 2
    try:
        user, host = settings()
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2
    code, message = (login if command == 'login' else logout)(user, host)
    print(message, file=sys.stderr if code else sys.stdout)
    return code


if __name__ == '__main__':
    sys.exit(main())
