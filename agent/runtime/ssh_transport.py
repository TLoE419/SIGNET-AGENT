"""Private request client for the Electron-owned SSH connection.

The renderer cannot access this Unix socket. Electron passes its path and a
per-launch token only to the Python child process it owns.
"""
import json
import os
import re
import shlex
import select
import time
from pathlib import Path
import socket
import subprocess


MAX_PAYLOAD = 1024 * 1024 * 1024


class SshRemoteError(OSError):
    """A safe failure returned by the authenticated Electron broker."""

    def __init__(self, message, *, code=None):
        super().__init__(message)
        self.code = code


class LocalRuntimeHelperError(OSError):
    """The desktop could not read its bundled remote runtime helper."""


def is_timeout(error):
    while error is not None:
        if isinstance(error, (TimeoutError, subprocess.TimeoutExpired)):
            return True
        if isinstance(error, SshRemoteError) and error.code in ('CONNECTION_TIMEOUT', 'REMOTE_SLOW'):
            return True
        error = error.__cause__
    return False


def available():
    return bool(os.environ.get('SIGNET_SSH_BROKER') and os.environ.get('SIGNET_SSH_BROKER_TOKEN'))


def _cancelled_receive(connection, count, stop, deadline):
    chunks, received = [], 0
    while received < count:
        if stop.is_set():
            raise OSError('SSH status wait was cancelled.')
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise socket.timeout()
        if not select.select([connection], [], [], min(0.2, remaining))[0]:
            continue
        chunk = connection.recv(min(count - received, 65536))
        if not chunk:
            break
        chunks.append(chunk)
        received += len(chunk)
    return b''.join(chunks)


def request(action, cancel_event=None, **values):
    path = os.environ.get('SIGNET_SSH_BROKER')
    token = os.environ.get('SIGNET_SSH_BROKER_TOKEN')
    if not path or not token:
        raise OSError('Electron SSH transport is not available.')
    input_data = values.pop('input', b'')
    if not isinstance(input_data, bytes) or len(input_data) > MAX_PAYLOAD:
        raise OSError('SSH transport input is too large.')
    header = json.dumps({'token': token, 'action': action, 'inputLength': len(input_data), **values}, separators=(',', ':')).encode() + b'\n'
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        connection.settimeout(max(5, values.get('timeoutMs', 30000) / 1000 + 5))
        connection.connect(path)
        connection.sendall(header)
        if input_data:
            connection.sendall(input_data)
        if cancel_event is None:
            stream = connection.makefile('rb')
            response_header = stream.readline(65537)
            receive = stream.read
        else:
            deadline = time.monotonic() + max(5, values.get('timeoutMs', 30000) / 1000 + 5)
            receive = lambda count: _cancelled_receive(connection, count, cancel_event, deadline)
            response_header = b''
            while len(response_header) <= 65536:
                char = receive(1)
                response_header += char
                if not char or char == b'\n':
                    break
        if not response_header.endswith(b'\n') or len(response_header) > 65536:
            raise OSError('Electron SSH transport returned an invalid response.')
        reply = json.loads(response_header)
        if not reply.get('ok'):
            error = reply.get('error') or {}
            raise SshRemoteError(error.get('message') or 'SSH operation failed.', code=error.get('code'))
        value = reply['value']
        stdout_length, stderr_length = value.get('stdoutLength'), value.get('stderrLength')
        if (not isinstance(stdout_length, int) or not isinstance(stderr_length, int) or
                stdout_length < 0 or stderr_length < 0 or stdout_length + stderr_length > MAX_PAYLOAD):
            raise OSError('Electron SSH transport returned invalid output lengths.')
        stdout, stderr = receive(stdout_length), receive(stderr_length)
        if len(stdout) != stdout_length or len(stderr) != stderr_length or receive(1):
            raise OSError('Electron SSH transport response was truncated or malformed.')
    except SshRemoteError:
        raise
    except (socket.timeout, OSError, ValueError, KeyError, TypeError) as error:
        raise OSError('Electron SSH transport is unavailable.') from error
    finally:
        connection.close()
    return {**value, 'stdout': stdout, 'stderr': stderr}


def runtime_module_prelude(config):
    """Reload the pinned module inside each command/job, never in shell startup files."""
    name = config.get('runtimeModule')
    if name is None:
        return ''
    if not isinstance(name, str) or not re.fullmatch(r'(singularity|apptainer)/[0-9][A-Za-z0-9_.+-]*', name):
        raise OSError('Invalid remote container runtime module.')
    try:
        helpers = (Path(__file__).resolve().parents[2] / 'runtime_modules.sh').read_text(encoding='utf-8')
    except (OSError, UnicodeError) as error:
        raise LocalRuntimeHelperError('Could not read the local SIGNET runtime helper.') from error
    return helpers + "\nif ! signet_load_module " + shlex.quote(name) + "; then echo 'Could not load container runtime module.' >&2; exit 1; fi\n"


def with_runtime_module(command, config):
    prelude = runtime_module_prelude(config)
    return 'bash -c ' + shlex.quote(prelude + '\nexec bash -c ' + shlex.quote(command)) if prelude else command


def _validated(config, paths, partition_pattern):
    for key in paths:
        candidate = config.get(key)
        if not isinstance(candidate, str) or not re.fullmatch(r'/[A-Za-z0-9_./-]+', candidate) or '..' in candidate.split('/'):
            raise OSError('Invalid remote environment path.')
    if not re.fullmatch(partition_pattern, config.get('partition', '')):
        raise OSError('Invalid remote scheduler partition.')
    runtime_module_prelude(config)  # Validate the optional pinned module before any command.
    return config


def environment():
    """Verified environment for the currently connected desktop SSH account."""
    return _validated(json.loads(request('environment')['stdout']),
                      ('root', 'source', 'image', 'executor', 'workRoot'), r'[A-Za-z0-9_-]{1,80}')


def setup_environment(cancel_event=None):
    """Configured paths for setup work, available before verification; executor and partition may still be empty."""
    config = _validated(json.loads(request('setup-environment', **(
                        {'cancel_event': cancel_event} if cancel_event is not None else {}))['stdout']),
                        ('root', 'source', 'image', 'workRoot'), r'[A-Za-z0-9_-]{0,80}')
    if not isinstance(config.get('executor', ''), str) or not re.fullmatch(r'(/[A-Za-z0-9_./-]+)?', config.get('executor', '')):
        raise OSError('Invalid remote environment path.')
    return config


def remote(command, **kwargs):
    if not isinstance(command, str) or not command:
        raise ValueError('A non-empty remote command is required.')
    timeout = kwargs.pop('timeout', None)
    cancel_event = kwargs.pop('cancel_event', None)
    input_data = kwargs.pop('input', None) or b''
    capture_output = kwargs.pop('capture_output', False)
    stdout_target = kwargs.pop('stdout', None)
    stderr_target = kwargs.pop('stderr', None)
    if kwargs:
        raise TypeError('Unsupported Electron SSH options: ' + ', '.join(sorted(kwargs)))
    if isinstance(input_data, str):
        input_data = input_data.encode()
    milliseconds = int((timeout if timeout is not None else 30) * 1000)
    value = request('exec', command=command, input=input_data, timeoutMs=milliseconds,
                    **({'cancel_event': cancel_event} if cancel_event is not None else {}))
    stdout, stderr = value['stdout'], value['stderr']
    if stdout_target is not None:
        stdout_target.write(stdout)
    if stderr_target is not None:
        stderr_target.write(stderr)
    return subprocess.CompletedProcess(['electron-ssh', command], value['returncode'],
        stdout=stdout if capture_output else None, stderr=stderr if capture_output else None)
