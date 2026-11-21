"""Loopback-only Python API for the Electron client and standalone backend development."""
import argparse
from contextlib import ExitStack
import csv
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import select
import socket
from socketserver import TCPServer
import tempfile
import threading
from urllib.parse import urlsplit, parse_qs

from dotenv import load_dotenv
from google.genai import types

from agent.app import signet_api
from agent.app.chat_outcome import ChatOutcome, STOPPED_NOTICE
from agent.core.conversation import MODEL, run_conversation
from agent.core.model_timing import ModelRequestTiming
from agent.paths import PROJECT_ROOT
from agent.providers import PROVIDERS, create_provider_adapter
from agent.runtime import signet_jobs, workspace_genotype, workspace_context
from agent.stage6.workspace import ARCHIVED_STEP_JOBS, CHAT_CONTEXT, Workspace
from agent.tools.ui import UI_CHANNEL

ROOT = PROJECT_ROOT
BACKEND_PROVIDERS = ('none', *PROVIDERS)
TURN_MARKER = 'SIGNET_TURN '
SESSION_ID = r'[a-f0-9-]{36}'
TURN_ID = r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'


@dataclass
class _ChatTurn:
    session: str
    turn_id: str
    cancelled: threading.Event = field(default_factory=threading.Event)


class _SetupWatchCancellation:
    def __init__(self, stopped, connection):
        self.stopped, self.connection = stopped, connection

    def is_set(self):
        if self.stopped.is_set():
            return True
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable and self.connection.recv(1, socket.MSG_PEEK) == b'')
        except (OSError, ValueError):
            return True


class ChatServer(ThreadingHTTPServer):
    daemon_threads = False

    def __init__(self, address, client_factory, model_label=MODEL, state_file=None, *, stop_provider=None):
        self.client_factory = client_factory
        self.model_label = model_label
        self.stop_provider = stop_provider or (lambda: None)
        self.token = secrets.token_urlsafe(32)
        self.histories = {}
        self.events = {}
        self.state_file = Path(state_file) if state_file else None
        self.pending_history = []
        self.active_session = None
        self.deleted_sessions = set()
        if self.state_file and self.state_file.exists():
            state = json.loads(self.state_file.read_text())
            self.token = state['token']
            self.events = state.get('events', {})
            self.active_session = state.get('active_session')
            self.histories = {key: [types.Content.model_validate(item) for item in value]
                              for key, value in state.get('histories', {}).items()}
            self.pending_history = [types.Content.model_validate(item)
                                    for item in state.get('pending_history', [])]
            self.deleted_sessions = set(state.get('deleted_sessions', []))
        # Scientific tools share local runs, so serialize turns across browser tabs.
        self.turn_lock = threading.Lock()
        self.chat_turn_lock = threading.Lock()
        self.chat_turn = None
        self.setup_watch_stop = threading.Event()
        self.stage6 = Workspace(self)
        super().__init__(address, ChatHandler)

    def shutdown(self):
        # Waiting for setup notifications must not delay chat checkpoints or app quit.
        self.setup_watch_stop.set()
        super().shutdown()

    def server_bind(self):
        # The loopback service needs no reverse DNS, which can stall on offline hosts.
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    def visible_messages(self, session):
        fallback_models = {}
        stopped_after = set()
        for turn in self.events.get(session, []):
            if not isinstance(turn, list):
                continue
            marker = next((line for line in reversed(turn)
                           if isinstance(line, str) and line.startswith(TURN_MARKER)), None)
            if marker is None:
                continue
            try:
                metadata = json.loads(marker[len(TURN_MARKER):])
            except ValueError:
                continue
            if not isinstance(metadata, dict):
                continue
            index, model = metadata.get('assistant_index'), metadata.get('model_fallback')
            if (type(index) is int and index >= 0 and isinstance(model, str)
                    and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,127}', model)):
                fallback_models[index] = model
            stopped_index = metadata.get('stopped_after')
            if metadata.get('status') == 'cancelled' and type(stopped_index) is int and stopped_index >= 0:
                stopped_after.add(stopped_index)
        messages = []
        for index, item in enumerate(self.histories.get(session, [])):
            if not any(part.function_call or part.function_response for part in item.parts or []):
                text = '\n'.join(part.text for part in item.parts or [] if part.text and not part.thought)
                if text and not text.startswith('服務更新續接資料：'):
                    message = {'role': 'user' if item.role == 'user' else 'assistant', 'text': text}
                    if item.role == 'model' and index in fallback_models:
                        message['model_fallback'] = fallback_models[index]
                    messages.append(message)
            if index in stopped_after:
                messages.append({'role': 'notice', 'text': STOPPED_NOTICE})
        return messages

    def save_state(self):
        if self.state_file:
            state = {'token': self.token,
                     'active_session': self.active_session,
                     'events': self.events,
                     'histories': {key: [item.model_dump(mode='json', exclude_none=True) for item in value]
                                   for key, value in self.histories.items()},
                     'pending_history': [item.model_dump(mode='json', exclude_none=True)
                                         for item in self.pending_history],
                     'deleted_sessions': sorted(self.deleted_sessions)}
            temporary = self.state_file.with_suffix('.tmp')
            with open(temporary, 'w', opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
                json.dump(state, stream, ensure_ascii=False)
            os.chmod(temporary, 0o600)
            temporary.replace(self.state_file)

    def delete_session(self, session):
        """Remove one saved conversation while the caller holds both state locks."""
        workspace = self.stage6
        has_workspace = session in workspace.sessions
        if session in self.deleted_sessions:
            return True
        if session not in self.histories and session not in self.events and not has_workspace:
            return False
        previous = self.histories.copy(), self.events.copy(), workspace.sessions.copy(), self.active_session
        path = workspace.path if has_workspace else None
        with ExitStack() as transaction:
            backup = None
            if path and path.exists():
                # Keep the old checkpoint available for an atomic restore if chat persistence fails.
                folder = transaction.enter_context(tempfile.TemporaryDirectory(dir=path.parent, prefix='.chat-delete-'))
                backup = Path(folder) / path.name
                os.link(path, backup)
            self.histories.pop(session, None)
            self.events.pop(session, None)
            workspace.sessions.pop(session, None)
            if self.active_session == session:
                self.active_session = None
            self.deleted_sessions.add(session)
            workspace_saved = False
            try:
                if has_workspace:
                    workspace.save()
                    workspace_saved = True
                self.save_state()
            except (OSError, TypeError, ValueError):
                self.histories, self.events, workspace.sessions, self.active_session = previous
                self.deleted_sessions.remove(session)
                if workspace_saved and path:
                    if backup:
                        backup.replace(path)
                    else:
                        path.unlink(missing_ok=True)
                raise
        return True


class ChatHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def _local_request(self):
        return self.headers.get('Host') == f'127.0.0.1:{self.server.server_port}'

    def _headers(self, status, content_type, length=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        if length is not None:
            self.send_header('Content-Length', str(length))
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()

    def _error(self, status, message):
        body = json.dumps({'error': message}, ensure_ascii=False).encode()
        self._headers(status, 'application/json; charset=utf-8', len(body))
        self.wfile.write(body)

    def do_GET(self):
        if not self._local_request():
            return self._error(403, 'Only the local interface is allowed.')
        url = urlsplit(self.path)
        if url.path.startswith('/stage6/result-preview/') or url.path == '/stage6/result-download':
            return signet_api.serve_result_asset(self, url)
        if url.path.startswith('/signet/'):
            # Responses name the user's runs and HPC3 paths, so reads need the page token too.
            if not secrets.compare_digest(self.headers.get('X-Chat-Token', ''), self.server.token):
                return self._error(403, 'Page token required.')
            return signet_api.handle(self, 'GET', url)
        if url.path == '/stage/results':
            return self.archived_stage_results_get(url)
        if url.path == '/stage3/results':
            return self.stage3_results_get(url)
        if url.path == '/stage6/results':
            return self.stage6_results_get(url)
        if url.path == '/stage6/history':
            return self.stage6_history_get(url)
        if url.path in ('/stage6', '/stage6/file'):
            return self.stage6_get(url)
        if url.path != '/bootstrap':
            return self._error(404, 'API endpoint not found.')
        if not self.server.turn_lock.acquire(blocking=False):
            return self._error(409, 'A turn is still running. Keep the original page open until it finishes.')
        try:
            query = parse_qs(url.query)
            session = query.get('session', [None])[0]
            saved = list(dict.fromkeys([*self.server.histories, *self.server.stage6.sessions]))
            saved = [key for key in saved if re.fullmatch(SESSION_ID, key) and key not in self.server.deleted_sessions]
            if session is None and query.get('new') != ['1']:
                active = self.server.active_session
                histories = [key for key in self.server.histories if key in saved]
                session = active if active in saved else next(reversed(histories or saved), None)
            initial = {'sessions': []}
            for key in reversed(saved):
                messages = self.server.visible_messages(key)
                title = next((item['text'] for item in messages if item['role'] == 'user'), key[:8])
                initial['sessions'].append({'session': key, 'title': ' '.join(title.split())[:80]})
            if session is not None:
                if session not in saved:
                    return self._error(404, 'Conversation not found.')
                initial.update(session=session, messages=self.server.visible_messages(session),
                               events=self.server.events.get(session, []))
                if self.server.active_session != session:
                    self.server.active_session = session
                    self.server.save_state()
        finally:
            self.server.turn_lock.release()
        body = json.dumps({'token': self.server.token, 'model': self.server.model_label,
                           'initial': initial}, ensure_ascii=False).encode()
        self._headers(200, 'application/json; charset=utf-8', len(body))
        self.wfile.write(body)

    def _app_request(self):
        """A state-changing request from this app's page: local Host, the app's Origin and the page token."""
        origin = f'http://127.0.0.1:{self.server.server_port}'
        return (self._local_request() and self.headers.get('Origin') == origin
                and secrets.compare_digest(self.headers.get('X-Chat-Token', ''), self.server.token))

    def do_PATCH(self):
        # Run settings and current dataset selections use the authenticated SIGNET API.
        if not self._app_request():
            return self._error(403, 'Send requests from the local chat page.')
        url = urlsplit(self.path)
        if not url.path.startswith('/signet/'):
            return self._error(404, 'Operation not found.')
        return signet_api.handle(self, 'PATCH', url)

    def do_DELETE(self):
        if not self._app_request():
            return self._error(403, 'Send requests from the local chat page.')
        url = urlsplit(self.path)
        if url.path.startswith('/signet/'):
            return signet_api.handle(self, 'DELETE', url)
        match = re.fullmatch(rf'/chat/({SESSION_ID})', self.path)
        if not match:
            return self._error(404, 'Conversation not found.')
        busy = 'A conversation turn or visualization is running. Try again when it finishes.'
        if not self.server.turn_lock.acquire(blocking=False):
            return self._error(409, busy)
        session = match[1]
        try:
            workspace_lock = self.server.stage6.lock
            if not workspace_lock.acquire(blocking=False):
                return self._error(409, busy)
            try:
                deleted = self.server.delete_session(session)
            finally:
                workspace_lock.release()
        except (OSError, TypeError, ValueError):
            return self._error(500, 'Could not save the conversation deletion. Try again.')
        finally:
            self.server.turn_lock.release()
        if not deleted:
            return self._error(404, 'Conversation not found.')
        return self.json_response({'deleted': session})

    def do_POST(self):
        if not self._app_request():
            return self._error(403, 'Send requests from the local chat page.')
        if self.path.startswith('/signet/'):
            return signet_api.handle(self, 'POST', urlsplit(self.path))
        if self.path.startswith('/stage6/'):
            return self.stage6_post()
        if self.path.startswith('/hpc/'):
            return self.hpc_post()
        if self.path == '/chat/cancel':
            return self.cancel_chat_turn()
        if self.path != '/chat':
            return self._error(404, 'Operation not found.')
        try:
            self.connection.settimeout(10)
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 32768:
                raise ValueError()
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError()
            text, session = payload.get('text'), payload.get('session')
            if (not isinstance(text, str) or not text.strip() or len(text) > 8000
                    or not isinstance(session, str) or not re.fullmatch(SESSION_ID, session)):
                raise ValueError()
        except (ValueError, OSError):
            return self._error(400, 'Invalid message. Enter 1–8000 characters.')
        turn_id = payload.get('turn_id')
        if 'turn_id' in payload and (not isinstance(turn_id, str) or not re.fullmatch(TURN_ID, turn_id)):
            return self._error(400, 'Invalid chat turn identifier.')
        if self.server.client_factory is None:
            return self._error(503, 'Set up a model in Settings to send chat messages.')
        try:
            validated_context = workspace_context.validate(payload.get('workspace_context'), self.server.stage6.history)
        except (ValueError, KeyError, TypeError, OSError):
            return self._error(400, 'Workspace selection changed or is invalid; reselect the dataset/run and send again.')
        if not self.server.turn_lock.acquire(blocking=False):
            return self._error(409, 'Another turn is running. Wait for it to finish; closing the page does not cancel tools.')
        turn = _ChatTurn(session, turn_id) if turn_id else None
        try:
            if session in self.server.deleted_sessions:
                return self._error(404, 'Conversation not found.')
            self.server.active_session = session
            if session not in self.server.histories and self.server.pending_history:
                self.server.histories[session] = self.server.pending_history
                self.server.pending_history = []
            history = self.server.histories.setdefault(session, [])
            history_start = len(history)
            events = []
            self.server.events.setdefault(session, []).append(events)
            if turn is not None:
                with self.server.chat_turn_lock:
                    self.server.chat_turn = turn
            self.connection.settimeout(None)
            self._headers(200, 'application/x-ndjson; charset=utf-8')
            connected = True
            outcome = ChatOutcome()
            fallback_model = None
            assistant_index = None

            def emit(kind, message):
                nonlocal connected
                outcome.observe(kind, message)
                if kind in ('progress', 'error', 'done'):
                    events.append(message)
                if connected:
                    try:
                        self.wfile.write((json.dumps({'type': kind, 'text': message, **({'status': outcome.status} if kind == 'done' else {})}, ensure_ascii=False) + '\n').encode())
                        self.wfile.flush()
                    except OSError:
                        # Keep recording actual results if the browser disconnects; never replay tools.
                        connected = False

            def model_fallback(model):
                nonlocal fallback_model
                fallback_model = model
                emit('model_fallback', {'model': model})

            def display_workspace_action(request):
                if turn is None or not turn.cancelled.is_set():
                    if 'workspace_action' in request:
                        emit('workspace_action', request['workspace_action'])
                    else:
                        emit('ui', request)

            if turn is not None:
                emit('turn_started', {'turn_id': turn_id})
            cancel_requested = turn.cancelled.is_set if turn is not None else None
            answer = None
            try:
                timing = ModelRequestTiming(cancel_requested=cancel_requested)
                with self.server.client_factory(timing) as client:
                    context_token = CHAT_CONTEXT.set((self.server.stage6, session))
                    # Panel requests from show_panel go straight to this page as they happen.
                    ui_token = UI_CHANNEL.set(display_workspace_action)
                    try:
                        answer = run_conversation(
                            client, text.strip(), history, progress=lambda message: emit('progress', message),
                            http_timing=timing, workspace_context=validated_context, on_model_fallback=model_fallback,
                            **({'cancel_requested': cancel_requested} if turn is not None else {}))
                    finally:
                        UI_CHANNEL.reset(ui_token)
                        CHAT_CONTEXT.reset(context_token)
            except Exception:
                answer = None
            stopped = self._finish_chat_turn(turn)
            if stopped:
                if (len(history) > history_start and history[-1].role == 'model'
                        and not any(part.function_call for part in history[-1].parts or [])):
                    history.pop()
                if len(history) == history_start:
                    history.append(types.Content(role='user', parts=[types.Part.from_text(text=text.strip())]))
                outcome.status = 'cancelled'
            elif answer is not None:
                try:
                    # Failure returns have no final model content; retain their public answer on reload.
                    if not history or history[-1].role != 'model' or any(part.function_call for part in history[-1].parts or []):
                        history.append(types.Content(role='model', parts=[types.Part.from_text(text=answer)]))
                    if len(history) > history_start:
                        assistant_index = len(history) - 1
                    emit('workspace', self.server.stage6.view(session))
                    emit('answer', answer)
                except Exception:
                    answer = None
            if answer is None and not stopped:
                emit('error', 'Unexpected turn error. Operation status may be unknown; check the run status before continuing.')
            if not connected and not stopped:
                outcome.status = 'needs_review'
            marker = {'status': outcome.status}
            if stopped:
                marker['stopped_after'] = len(history) - 1
            if assistant_index is not None and fallback_model is not None:
                marker.update(assistant_index=assistant_index, model_fallback=fallback_model)
            events.append(TURN_MARKER + json.dumps(marker))
            emit('done', outcome.summary())
        finally:
            try:
                self._finish_chat_turn(turn)
                self.server.save_state()
            finally:
                self.server.turn_lock.release()

    def _finish_chat_turn(self, turn):
        if turn is None:
            return False
        with self.server.chat_turn_lock:
            if self.server.chat_turn is turn:
                self.server.chat_turn = None
            return turn.cancelled.is_set()

    def cancel_chat_turn(self):
        try:
            self.connection.settimeout(10)
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 512:
                raise ValueError()
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError()
            session, turn_id = payload.get('session'), payload.get('turn_id')
            if (not isinstance(session, str) or not re.fullmatch(SESSION_ID, session)
                    or not isinstance(turn_id, str) or not re.fullmatch(TURN_ID, turn_id)):
                raise ValueError()
        except (ValueError, OSError):
            return self._error(400, 'Invalid chat turn identifier.')
        with self.server.chat_turn_lock:
            turn = self.server.chat_turn
            found = turn is not None and (turn.session, turn.turn_id) == (session, turn_id)
            if found:
                turn.cancelled.set()
        if not found:
            return self._error(404, 'This chat turn is no longer active.')
        return self.json_response({'status': 'cancellation_requested', 'turn_id': turn_id})


    def json_response(self, value, status=200):
        data = json.dumps(value).encode()
        self._headers(status, 'application/json; charset=utf-8', len(data))
        self.wfile.write(data)

    def hpc_post(self):
        """Workflow-panel buttons call one HPC3 tool directly; the click is the user's approval."""
        if self.path.startswith('/hpc/files/'):
            return self.hpc_files_post()
        from agent.tools import hpc as hpc_tools
        from agent.runtime import hpc
        from agent.runtime.hpc import STEPS
        log_actions = {f'/hpc/log/{step}': (lambda step=step: hpc_tools.read_hpc_setup_log(step))
                       for step in STEPS}
        actions = {'/hpc/check': hpc_tools.check_hpc_environment,
                   '/hpc/watch': None,
                   '/hpc/workspace': hpc_tools.create_hpc_workspace,
                   '/hpc/signet': hpc_tools.install_signet_source,
                   '/hpc/container': hpc_tools.download_signet_container,
                   **log_actions}
        action = actions.get(self.path)
        if self.path not in actions:
            return self._error(404, 'Operation not found.')
        try:
            size = int(self.headers.get('Content-Length', '0') or 0)
        except ValueError:
            size = -1
        if not 0 <= size <= 1024:
            return self._error(400, 'Invalid request length.')
        self.connection.settimeout(10)
        raw = self.rfile.read(size)  # Each path is one fixed action, without user-supplied log paths.
        if self.path == '/hpc/watch':
            try:
                body = json.loads(raw or b'{}')
            except ValueError:
                return self._error(400, 'Provide only a setup notification cursor.')
            if (not isinstance(body, dict) or set(body) != {'cursor'}
                    or not isinstance(body['cursor'], str) or not re.fullmatch(r'[a-f0-9]{64}', body['cursor'])):
                return self._error(400, 'Provide only a setup notification cursor.')
            # The wait observes fixed setup metadata; it never submits or installs work.
            cancellation = _SetupWatchCancellation(self.server.setup_watch_stop, self.connection)
            result = hpc.watch_setup(body['cursor'], cancel_event=cancellation)
            if not cancellation.is_set():
                return self.json_response(result)
            return
        if self.path in log_actions:
            try:
                body = json.loads(raw or b'{}')
            except ValueError:
                return self._error(400, 'The log request must be an empty JSON object.')
            if body != {}:
                return self._error(400, 'The log request must be an empty JSON object.')
        return self.json_response(action())

    def hpc_files_post(self):
        """The desktop file window. Paths stay on this route and never join the conversation."""
        from agent.runtime import hpc_files
        try:
            size = int(self.headers.get('Content-Length', '0') or 0)
        except ValueError:
            size = -1
        inspection = self.path == '/hpc/files/inspect'
        if not 0 <= size <= (hpc_files.MAX_INSPECT_BODY if inspection else 4096):
            return self._error(400, 'Invalid request length.')
        self.connection.settimeout(10)
        try:
            body = json.loads(self.rfile.read(size) or b'{}')
        except ValueError:
            body = None
        if not isinstance(body, dict):
            return self._error(400, 'Invalid request.')
        if inspection:
            if (set(body) != {'paths'} or not isinstance(body['paths'], list)
                    or not 1 <= len(body['paths']) <= hpc_files.MAX_INSPECT_PATHS):
                return self._error(400, 'Provide only a paths list containing between 1 and 128 files.')
            return self.json_response(hpc_files.inspect(body['paths']))
        actions = {'/hpc/files/shortcuts': hpc_files.shortcuts,
                   '/hpc/files/list': lambda: hpc_files.list_folder(body.get('path'))}
        action = actions.get(self.path)
        if action is None:
            return self._error(404, 'Operation not found.')
        return self.json_response(action())

    def archived_stage_results_get(self, url):
        if not secrets.compare_digest(self.headers.get('X-Chat-Token', ''), self.server.token):
            return self._error(403, 'Workspace token required.')
        query = parse_qs(url.query, keep_blank_values=True)
        if (set(query) - {'run', 'stage', 'source'} or len(query.get('run', [])) != 1 or not query['run'][0]
                or len(query.get('stage', [])) != 1 or query['stage'][0] not in ARCHIVED_STEP_JOBS
                or ('source' in query and query['source'] not in (['live'], ['archive']))):
            return self._error(400, 'Provide a run ID and stage number (1, 2, 4, or 5).')
        run_id, stage = query['run'][0], query['stage'][0]
        try:
            result = (workspace_genotype.completed_result(run_id, stage) if query.get('source') == ['live']
                      else self.server.stage6.archived_stage_result(run_id, stage))
        except signet_jobs.StepError as error:
            return self._error(signet_api.STATUS.get(error.code, 502), str(error))
        except (OSError, ValueError, KeyError, TypeError, OverflowError):
            return self._error(404, 'No readable archived result for this stage.')
        return self.json_response(result)

    def stage3_results_get(self, url):
        if not secrets.compare_digest(self.headers.get('X-Chat-Token', ''), self.server.token):
            return self._error(403, 'Workspace token required.')
        query = parse_qs(url.query, keep_blank_values=True)
        if (set(query) - {'run', 'source'} or len(query.get('run', [])) != 1 or not query['run'][0]
                or ('source' in query and query['source'] not in (['live'], ['archive']))):
            return self._error(400, 'Provide a single run ID and an optional live or archive source.')
        try:
            if query.get('source') == ['live']:
                from agent.runtime import workspace_adjustment
                result = workspace_adjustment.completed_result(query['run'][0])
            else:
                result = self.server.stage6.archived_stage3(query['run'][0])
        except signet_jobs.StepError as error:
            return self._error(signet_api.STATUS.get(error.code, 502), str(error))
        except (OSError, ValueError, KeyError, TypeError, OverflowError):
            return self._error(404, 'No readable archived Stage 3 result for this run.')
        return self.json_response(result)

    def stage6_results_get(self, url):
        if not secrets.compare_digest(self.headers.get('X-Chat-Token', ''), self.server.token):
            return self._error(403, 'Workspace token required.')
        query = parse_qs(url.query, keep_blank_values=True)
        if not query:
            return self.json_response({'runs': self.server.stage6.completed_runs()})
        if (set(query) - {'run', 'source'} or len(query.get('run', [])) != 1
                or ('source' in query and query['source'] not in (['archive'], ['live'], ['recorded']))):
            return self._error(400, 'Provide a single run ID and, optionally, the archive, live or recorded source.')
        try:
            return self.json_response(self.server.stage6.completed_result(
                query['run'][0], archive_only=query.get('source') == ['archive'],
                live_only=query.get('source') == ['live'], recorded_only=query.get('source') == ['recorded']))
        except (OSError, ValueError, KeyError, TypeError, OverflowError, csv.Error):
            return self._error(400, 'No readable completed Stage 6 result for this run.')

    def stage6_history_get(self, url):
        if not secrets.compare_digest(self.headers.get('X-Chat-Token', ''), self.server.token):
            return self._error(403, 'Workspace token required.')
        if url.query:
            return self._error(400, 'The Stage 6 history does not accept query parameters.')
        try:
            result = self.server.stage6.history()
        except signet_jobs.StepError as error:
            return self._error(signet_api.STATUS.get(error.code, 500), str(error))
        return self.json_response(result)

    def stage6_get(self, url):
        query = parse_qs(url.query)
        session = query.get('session', [''])[0]
        if not re.fullmatch(SESSION_ID, session):
            return self._error(400, 'Invalid session.')
        try:
            if url.path == '/stage6':
                if not secrets.compare_digest(self.headers.get('X-Chat-Token', ''), self.server.token):
                    return self._error(403, 'Workspace token required.')
                with self.server.stage6.lock:
                    if session in self.server.deleted_sessions:
                        return self._error(404, 'Conversation not found.')
                    value = self.server.stage6.view(session)
                return self.json_response(value)
            if url.path == '/stage6/file':
                import agent.tools.signet as st
                from agent.stage6.workspace import load_run
                run = query.get('run', [''])[0]
                name = query.get('name', [''])[0]
                if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', name):
                    raise ValueError('Invalid result filename.')
                root, _, _ = load_run(run)
                path = st._no_links(root / 'work/res/resv' / name)
                if not path.is_file():
                    return self._error(404, 'Output file not found.')
                data = path.read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Disposition', 'attachment; filename="' + name + '"')
                self.send_header('Content-Security-Policy', "sandbox; default-src 'none'")
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            return self._error(404, 'Unknown workspace operation.')
        except (OSError, ValueError, KeyError) as exc:
            return self._error(400, str(exc))

    def stage6_post(self):
        self.connection.settimeout(10)
        locked = False
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 32768:
                raise ValueError('Invalid request length.')
            payload = json.loads(self.rfile.read(size))
            session = payload.get('session', '')
            if not isinstance(session, str) or not re.fullmatch(SESSION_ID, session):
                raise ValueError('Invalid session.')
            if not self.server.turn_lock.acquire(blocking=False):
                return self._error(409, 'A conversation turn or visualization is running.')
            locked = True
            if session in self.server.deleted_sessions:
                return self._error(404, 'Conversation not found.')
            if self.path == '/stage6/select':
                value = self.server.stage6.select(session, payload.get('run_id', ''))
            elif self.path == '/stage6/compare':
                value = self.server.stage6.compare(session, payload.get('proposal_id', ''))
            elif self.path == '/stage6/cancel':
                value = self.server.stage6.cancel(session, payload.get('proposal_id', ''))
            elif self.path == '/stage6/confirm':
                proposal = self.server.stage6.approve(session, payload.get('proposal_id', ''))
                self.server.histories.setdefault(session, [])
                self.server.save_state()
                worker = threading.Thread(target=self.server.stage6.execute, args=(session, proposal))
                worker.start()
                locked = False  # The worker releases this lock after saving results, even on failure.
                return self.json_response({'status': 'running', 'run_id': proposal['run_id']}, 202)
            else:
                return self._error(404, 'Unknown workspace operation.')
            return self.json_response(value)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            return self._error(400, str(exc))
        finally:
            if locked:
                self.server.turn_lock.release()


def create_server(provider='none', port=8880, state_file=ROOT / '.chat-state.json'):
    """Build the Python API for Electron or standalone backend development."""
    if provider not in BACKEND_PROVIDERS:
        raise ValueError('Unsupported model provider.')
    load_dotenv(ROOT / '.env')
    from agent.tools.signet import source_path
    if not source_path().is_dir():
        print('The analysis source is not installed. Run python scripts/setup_source.py before starting analysis.', flush=True)
    if provider == 'none':
        return ChatServer(('127.0.0.1', port), None,
                          model_label='Chat not configured', state_file=state_file)
    configured = create_provider_adapter(provider, gemini_model=MODEL)
    return ChatServer(('127.0.0.1', port), configured.create_client,
                      model_label=configured.label, state_file=state_file,
                      stop_provider=configured.stop)


def main():
    parser = argparse.ArgumentParser(description='Start the local SIGNET backend.')
    parser.add_argument('--port', type=int, default=8880)
    parser.add_argument('--provider', choices=BACKEND_PROVIDERS, default='none')
    parser.add_argument('--state-file', type=Path, default=ROOT / '.chat-state.json')
    args = parser.parse_args()
    with create_server(args.provider, args.port, args.state_file) as server:
        print(f'SIGNET backend: http://127.0.0.1:{server.server_port}', flush=True)
        print('Local access only. Sending a message contacts the model service. Press Ctrl+C to exit after running tools finish.', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            server.stop_provider()


if __name__ == '__main__':
    main()
