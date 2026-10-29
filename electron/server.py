"""Desktop-owned launcher; HTTP handlers and scientific execution stay in agent.app.chat_ui.

stdin is a parent-owned control pipe. EOF requests graceful shutdown even if
Electron crashes. stdout carries lifecycle events only; application logs use stderr.
No control or shutdown endpoints are added to the browser's HTTP API.
"""
import argparse
import json
from pathlib import Path
import signal
import sys
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def serve(server, control, events):
    def emit(event, **values):
        try:
            events.write(json.dumps({'event': event, **values}) + '\n')
            events.flush()
        except (BrokenPipeError, OSError):
            pass  # The parent may have died; still drain and close the service.

    def shutdown():
        server.shutdown()

    def watch_parent():
        # Only the owner has this pipe. An invalid message also closes the service.
        control.readline(4096)
        emit('stopping')
        shutdown()

    # BaseServer.shutdown must run in another thread. If EOF arrives before
    # serve_forever starts, shutdown waits until the loop observes the request.
    watcher = threading.Thread(target=watch_parent, daemon=True)
    watcher.start()
    emit('ready', port=server.server_port)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        # Non-daemon request threads finish and checkpoint their own results.
        server.server_close()
        # Stage 6 confirmation starts a separate worker; wait for its save too.
        with server.turn_lock:
            server.save_state()
        emit('stopped')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--provider', choices=('codex', 'gemini', 'groq'), default='codex')
    parser.add_argument('--state-file', type=Path, required=True)
    args = parser.parse_args()
    events = sys.stdout
    sys.stdout = sys.stderr
    from agent.app.chat_ui import create_server
    args.state_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    server = create_server(args.provider, port=0, state_file=args.state_file)
    # A graceful signal follows the same drain path as closing the owner pipe.
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    serve(server, sys.stdin, events)


if __name__ == '__main__':
    main()
