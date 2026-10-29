"""Private request client for the Electron-owned SSH connection.

The renderer cannot access this Unix socket. Electron passes its path and a
per-launch token only to the Python child process it owns.
"""
import json
import os
import socket
import subprocess


MAX_PAYLOAD = 1024 * 1024 * 1024


class SshRemoteError(OSError):
    """A safe failure returned by the authenticated Electron broker."""


def available():
    return bool(os.environ.get('SIGNET_SSH_BROKER') and os.environ.get('SIGNET_SSH_BROKER_TOKEN'))


def request(action, **values):
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
        stream = connection.makefile('rb')
        response_header = stream.readline(65537)
        if not response_header.endswith(b'\n') or len(response_header) > 65536:
            raise OSError('Electron SSH transport returned an invalid response.')
        reply = json.loads(response_header)
        if not reply.get('ok'):
            error = reply.get('error') or {}
            raise SshRemoteError(error.get('message') or 'SSH operation failed.')
        value = reply['value']
        stdout_length, stderr_length = value.get('stdoutLength'), value.get('stderrLength')
        if (not isinstance(stdout_length, int) or not isinstance(stderr_length, int) or
                stdout_length < 0 or stderr_length < 0 or stdout_length + stderr_length > MAX_PAYLOAD):
            raise OSError('Electron SSH transport returned invalid output lengths.')
        stdout, stderr = stream.read(stdout_length), stream.read(stderr_length)
        if len(stdout) != stdout_length or len(stderr) != stderr_length or stream.read(1):
            raise OSError('Electron SSH transport response was truncated or malformed.')
    except SshRemoteError:
        raise
    except (socket.timeout, OSError, ValueError, KeyError, TypeError) as error:
        raise OSError('Electron SSH transport is unavailable.') from error
    finally:
        connection.close()
    return {**value, 'stdout': stdout, 'stderr': stderr}


def remote(command, **kwargs):
    if not isinstance(command, str) or not command:
        raise ValueError('A non-empty remote command is required.')
    timeout = kwargs.pop('timeout', None)
    input_data = kwargs.pop('input', None) or b''
    capture_output = kwargs.pop('capture_output', False)
    stdout_target = kwargs.pop('stdout', None)
    stderr_target = kwargs.pop('stderr', None)
    if kwargs:
        raise TypeError('Unsupported Electron SSH options: ' + ', '.join(sorted(kwargs)))
    if isinstance(input_data, str):
        input_data = input_data.encode()
    milliseconds = int((timeout if timeout is not None else 30) * 1000)
    value = request('exec', command=command, input=input_data, timeoutMs=milliseconds)
    stdout, stderr = value['stdout'], value['stderr']
    if stdout_target is not None:
        stdout_target.write(stdout)
    if stderr_target is not None:
        stderr_target.write(stderr)
    return subprocess.CompletedProcess(['electron-ssh', command], value['returncode'],
        stdout=stdout if capture_output else None, stderr=stderr if capture_output else None)
