"""Run the desktop backend against one persistent, isolated workspace fixture."""

import json
import os
from pathlib import Path
import runpy
import sys

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))


def main():
    server = REPO / 'electron/main/backend/server.py'
    if sys.argv[1:3] != ['-u', str(server)]:
        raise ValueError('Expected the desktop backend command.')

    import agent.tools.signet as signet
    from agent.app import chat_ui

    signet.PROJECT = Path(os.environ['SIGNET_WORKSPACE_TEST_PROJECT'])
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
