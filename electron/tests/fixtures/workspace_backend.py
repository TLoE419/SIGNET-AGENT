"""Run the desktop backend against one persistent, isolated workspace fixture."""

import json
import os
from pathlib import Path
import runpy
import shlex
import subprocess
import sys

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))


def install_file_fixture():
    """Exercise production metadata scripts only within the native test's files."""
    from agent.runtime import hpc, hpc_files

    root = Path(os.environ['SIGNET_WORKSPACE_TEST_FILES']).resolve()
    trace = Path(os.environ['SIGNET_WORKSPACE_TEST_FILE_CALLS'])
    hpc_files._UNREADABLE_ON_COMPUTE = (str(root / 'blocked'),)
    places = [{'label': 'Home', 'path': str(root / 'home')},
              {'label': 'Personal (/pub)', 'path': str(root / 'cohorts')}]
    hpc_files._shortcuts_script = lambda: hpc_files._python(
        "result = " + repr({'status': 'ok', 'shortcuts': places}) + "\n")

    def local_metadata(build, timeout):
        script = build(str(root))
        if 'python3 - ' not in script or " <<'SIGNET_PY'\n" not in script:
            return {'status': 'failed', 'error': 'Only fixture file metadata commands are allowed.'}
        prelude, body = script.split(" <<'SIGNET_PY'\n", 1)
        command = prelude.rsplit('\n', 1)[-1]
        if not command.startswith('python3 - '):
            return {'status': 'failed', 'error': 'The fixture accepts only Python metadata commands.'}
        body, end = body.split('\nSIGNET_PY', 1)
        arguments = shlex.split(command)[2:]
        if end.strip() or any(not Path(value).resolve().is_relative_to(root) for value in arguments):
            return {'status': 'failed', 'error': 'File metadata requests must stay in the fixture folder.'}
        if any(token in body for token in ('subprocess', 'exec(', 'open(', 'os.remove', 'os.unlink',
                                           'os.mkdir', 'os.rename', 'shutil')):
            return {'status': 'failed', 'error': 'The fixture permits names and metadata only.'}
        kind = 'inspect' if 'import stat' in body else 'list' if arguments else 'shortcuts'
        with trace.open('a') as stream:
            stream.write(json.dumps({'kind': kind, 'paths': arguments}) + '\n')
        completed = subprocess.run([sys.executable, '-', *arguments], input=body + '\n', text=True,
                                   capture_output=True, timeout=min(timeout, 10))
        values = hpc._parse(completed.stdout.encode())
        if completed.returncode or 'result' not in values:
            return {'status': 'failed', 'error': 'The fixture file metadata command failed.'}
        return json.loads(values['result'])

    hpc_files._call = local_metadata


def main():
    server = REPO / 'electron/main/backend/server.py'
    if sys.argv[1:3] != ['-u', str(server)]:
        raise ValueError('Expected the desktop backend command.')

    import agent.tools.signet as signet
    from agent.app import chat_ui

    signet.PROJECT = Path(os.environ['SIGNET_WORKSPACE_TEST_PROJECT'])
    install_file_fixture()
    metadata = Path(os.environ['SIGNET_WORKSPACE_TEST_BACKEND'])
    original_create_server = chat_ui.create_server

    def create_server(*args, **kwargs):
        previous = json.loads(metadata.read_text()) if metadata.exists() else {'starts': []}
        # Reuse the test-only port so the same native renderer can reload after
        # replacing Python without changing production launcher behavior.
        kwargs['port'] = previous.get('port', 0)
        instance = original_create_server(*args, **kwargs)
        metadata.write_text(json.dumps({'port': instance.server_port,
                                        'starts': [*previous['starts'], os.getpid()]}))
        return instance

    chat_ui.create_server = create_server
    sys.argv = [str(server), *sys.argv[3:]]
    runpy.run_path(str(server), run_name='__main__')


if __name__ == '__main__':
    main()
