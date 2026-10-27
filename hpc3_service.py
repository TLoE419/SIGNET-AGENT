"""HPC3 login state behind the local web API (/hpc3/* routes in chat_ui.py).

chat_ui.py checks that each request is local and carries the page token, then calls this
module. This module holds the login state and runs the actual work through hpc3_ssh.py:

  status()        cached hpc3_ssh.check() result (connected or not, and why)
  set_user(user)  validate a UCInetID and store it as HPC3_USER in the shared .env
  start_login()   begin a popup login in a background thread and return at once
  login_state()   progress of that login, polled by the page
  logout()        close the shared connection

Login states:
  idle              no login has been started since the service began or the last logout
  waiting_for_user  ssh is showing the password / Duo dialogs
  succeeded         the shared connection is open
  failed            cancelled, wrong password, Duo denied, or ssh failed (message says why)

No password ever reaches this module: ssh asks through native dialogs (hpc3_askpass.py)
and gets the answers straight back. Nothing here is logged, stored in chat history, or
offered to the language model as a tool.
"""
import os
from pathlib import Path
import sys
import threading
import time

import hpc3_ssh

# How long a status result is reused. The page may poll often; HPC3 should not see every poll.
STATUS_CACHE_SECONDS = 15


class Hpc3Error(Exception):
    """A request that cannot be served; status is the HTTP code chat_ui.py returns."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class Hpc3Service:
    """One per ChatServer. Thread-safe: request threads and the login thread share it."""

    def __init__(self, env_file, ssh=hpc3_ssh, clock=time.monotonic, platform=None):
        self.env_file = Path(env_file)
        self.ssh = ssh
        self.clock = clock
        self.platform = platform or sys.platform
        self.lock = threading.Lock()
        self.cache = None  # (time taken, check() result)
        self.login = {'state': 'idle', 'message': None}
        self.thread = None

    def status(self, refresh=False):
        """Connection status; reuses a result younger than STATUS_CACHE_SECONDS unless refresh."""
        with self.lock:
            if not refresh and self.cache and self.clock() - self.cache[0] < STATUS_CACHE_SECONDS:
                return self.cache[1]
        result = self.ssh.check()  # Network work happens outside the lock.
        with self.lock:
            self.cache = (self.clock(), result)
        return result

    def login_state(self):
        """A copy of the current login progress."""
        with self.lock:
            return dict(self.login)

    def set_user(self, user):
        """Store a new UCInetID. Refused while a login runs or a connection is open."""
        if not isinstance(user, str) or not self.ssh.valid_user(user.strip()):
            raise Hpc3Error(400, 'Enter your UCInetID: lowercase letters, digits, _ or -.')
        user = user.strip()
        with self.lock:
            if self.login['state'] == 'waiting_for_user':
                raise Hpc3Error(409, 'A login is in progress.')
        current = self._current_settings(required=False)
        # Changing the name under an open connection would show one user while connected as another.
        if current and current[0] != user and self.ssh.has_shared_connection(*current):
            raise Hpc3Error(409, 'Log out of HPC3 before changing the UCInetID.')
        write_env_value(self.env_file, 'HPC3_USER', user)
        os.environ['HPC3_USER'] = user
        with self.lock:
            self.cache = None
            self.login = {'state': 'idle', 'message': None}
        return {'user': user}

    def start_login(self):
        """Start a popup login unless one is running or the connection is already open."""
        if self.platform != 'darwin':
            raise Hpc3Error(501, 'Login dialogs need macOS. Run `python3 hpc3_ssh.py login` in a terminal.')
        user, host = self._current_settings(required=True)
        with self.lock:
            if self.login['state'] == 'waiting_for_user':
                raise Hpc3Error(409, 'A login is already in progress.')
            # Claim the slot before the slower connection check, so two clicks cannot both start.
            self.login = {'state': 'waiting_for_user', 'message': 'Check the login window and your Duo device.'}
        if self.ssh.has_shared_connection(user, host):
            return self._finish(0, 'Already logged in to %s@%s.' % (user, host))
        self.thread = threading.Thread(target=self._run_login, args=(user, host), daemon=True)
        self.thread.start()
        return self.login_state()

    def logout(self):
        """Close the shared connection. Refused while a login is still waiting for the user."""
        with self.lock:
            if self.login['state'] == 'waiting_for_user':
                raise Hpc3Error(409, 'Wait for the login to finish before logging out.')
        user, host = self._current_settings(required=True)
        code, message = self.ssh.logout(user, host)
        with self.lock:
            self.cache = None
            self.login = {'state': 'idle', 'message': None}
        if code != 0:
            raise Hpc3Error(502, message)
        return {'message': message}

    def _run_login(self, user, host):
        """Background thread: ssh shows the dialogs; record how it ended."""
        try:
            code, message = self.ssh.login(user, host, popup=True)
        except Exception:  # Any crash must still leave a final state for the page to read.
            code, message = 1, 'Login failed unexpectedly. Run `python3 hpc3_ssh.py check` to see why.'
        self._finish(code, message)

    def _finish(self, code, message):
        with self.lock:
            self.cache = None
            self.login = {'state': 'succeeded' if code == 0 else 'failed', 'message': message}
            return dict(self.login)

    def _current_settings(self, required):
        """(user, host) from the environment, or None / Hpc3Error(400) when not configured."""
        try:
            return self.ssh.settings()
        except ValueError:
            if required:
                raise Hpc3Error(400, 'Set your UCInetID first.')
            return None


def write_env_value(path, key, value):
    """Set KEY=value in a .env file, leaving every other line as it was.

    The new file is written beside the old one and swapped in at once, so an interruption
    never leaves a half-written .env. The file is readable by its owner only.
    """
    path = Path(path)
    lines = path.read_text().splitlines() if path.exists() else []
    replaced, output = False, []
    for line in lines:
        if line.split('=', 1)[0].strip() == key:
            if not replaced:
                output.append('%s=%s' % (key, value))
                replaced = True
            continue  # Drop duplicate definitions so only one value remains.
        output.append(line)
    if not replaced:
        output.append('%s=%s' % (key, value))
    temporary = path.with_name(path.name + '.tmp')
    descriptor = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as handle:
        handle.write('\n'.join(output) + '\n')
    os.chmod(str(temporary), 0o600)
    os.replace(str(temporary), str(path))
