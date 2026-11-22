"""Loopback-only Python API for the Electron client and standalone backend development."""
import argparse
import csv
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
from socketserver import TCPServer
import threading
from urllib.parse import urlsplit, parse_qs

from dotenv import load_dotenv
from google.genai import types

from agent.app import signet_api
from agent.app.chat_outcome import ChatOutcome
from agent.core.conversation import MODEL, run_conversation
from agent.core.model_timing import ModelRequestTiming
from agent.paths import PROJECT_ROOT
from agent.providers import PROVIDERS, create_provider_adapter
from agent.runtime import analysis_family, signet_jobs, workspace_genotype, workspace_context
from agent.runtime.step_proposal import CHAT_SESSION
from agent.stage6.workspace import ARCHIVED_STEP_JOBS, Workspace
from agent.tools.ui import UI_CHANNEL

ROOT = PROJECT_ROOT


def _analysis_context(session):
    """This conversation's runs and the default one, for the assistant (rebuilt every turn)."""
    try:
        return [{'run_id': run_id, 'number': label['number'], 'latest': label.get('latest', False),
                 'from_step': label.get('from_step')} for run_id, label in analysis_family.labels(session).items()]
    except OSError:
        return ''


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
        self.analysis_download_lock = threading.Lock()
        self.analysis_downloads = {}
        self.analysis_previews = {}
        if self.state_file and self.state_file.exists():
            state = json.loads(self.state_file.read_text())
            self.token = state['token']
            self.events = state.get('events', {})
            self.active_session = state.get('active_session')
            self.histories = {key: [types.Content.model_validate(item) for item in value]
                              for key, value in state.get('histories', {}).items()}
            self.pending_history = [types.Content.model_validate(item)
                                    for item in state.get('pending_history', [])]
        # Scientific tools share local runs, so serialize turns across browser tabs.
        self.turn_lock = threading.Lock()
        self.stage6 = Workspace(self)
        super().__init__(address, ChatHandler)

    def server_bind(self):
        # The loopback service needs no reverse DNS, which can stall on offline hosts.
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    def visible_messages(self, session):
        messages = []
        for item in self.histories.get(session, []):
            if any(part.function_call or part.function_response for part in item.parts or []):
                continue
            text = '\n'.join(part.text for part in item.parts or [] if part.text and not part.thought)
            if text and not text.startswith('服務更新續接資料：'):
                messages.append({'role': 'user' if item.role == 'user' else 'assistant', 'text': text})
        return messages

    def save_state(self):
        if self.state_file:
            state = {'token': self.token,
                     'active_session': self.active_session,
                     'events': self.events,
                     'histories': {key: [item.model_dump(mode='json', exclude_none=True) for item in value]
                                   for key, value in self.histories.items()},
                     'pending_history': [item.model_dump(mode='json', exclude_none=True)
                                         for item in self.pending_history]}
            temporary = self.state_file.with_suffix('.tmp')
            with open(temporary, 'w', opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
                json.dump(state, stream, ensure_ascii=False)
            os.chmod(temporary, 0o600)
            temporary.replace(self.state_file)


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
            return self._error(403, '僅允許本機介面。')
        url = urlsplit(self.path)
        if url.path == '/stage6/result-download' or url.path.startswith('/stage6/result-preview/'):
            return signet_api.serve_result_asset(self, url)
        if url.path == '/signet/result-download':
            return signet_api.download_results(self, url)
        if url.path.startswith('/signet/result-preview/'):
            return signet_api.preview_result(self, url)
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
        if url.path != '/bootstrap':
            return self._error(404, '找不到此 API。')
        if not self.server.turn_lock.acquire(blocking=False):
            return self._error(409, '回合仍在執行，請保留原頁面等待完成。')
        try:
            query = parse_qs(url.query)
            session = query.get('session', [None])[0]
            saved = list(self.server.histories)
            saved = [key for key in saved if re.fullmatch(r'[a-f0-9-]{36}', key)]
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
                    return self._error(404, '找不到這段對話。')
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
        # Run settings, conversation links and dataset selections use the authenticated SIGNET API.
        if not self._app_request():
            return self._error(403, '請從本機聊天頁面送出。')
        url = urlsplit(self.path)
        if not url.path.startswith('/signet/'):
            return self._error(404, '找不到此操作。')
        return signet_api.handle(self, 'PATCH', url)

    def do_POST(self):
        if not self._app_request():
            return self._error(403, '請從本機聊天頁面送出。')
        if self.path.startswith('/signet/'):
            return signet_api.handle(self, 'POST', urlsplit(self.path))
        if self.path.startswith('/hpc/'):
            return self.hpc_post()
        if self.path != '/chat':
            return self._error(404, '找不到此操作。')
        try:
            self.connection.settimeout(10)
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 32768:
                raise ValueError()
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError()
            text, session = payload.get('text'), payload.get('session')
            language = payload.get('language', 'en')
            if (not isinstance(text, str) or not text.strip() or len(text) > 8000
                    or not isinstance(session, str) or not re.fullmatch(r'[a-f0-9-]{36}', session)
                    or language not in ('en', 'zh-Hant')):
                raise ValueError()
        except (ValueError, OSError):
            return self._error(400, '訊息格式不正確，請輸入 1 至 8000 字。')
        try:
            validated_context = workspace_context.validate(payload.get('workspace_context'), self.server.stage6.history)
        except (ValueError, KeyError, TypeError, OSError):
            return self._error(400, 'Workspace selection changed or is invalid; reselect the dataset/run and send again.'
                               if language == 'en' else '工作區選取已變更或無效；請重新選取資料組與執行後再傳送。')
        if not self.server.turn_lock.acquire(blocking=False):
            return self._error(409, '另一個回合仍在執行，請等候結束；關閉頁面不會取消工具。')
        try:
            self.server.active_session = session
            if session not in self.server.histories and self.server.pending_history:
                self.server.histories[session] = self.server.pending_history
                self.server.pending_history = []
            history = self.server.histories.setdefault(session, [])
            events = []
            self.server.events.setdefault(session, []).append(events)
            self.connection.settimeout(None)
            self._headers(200, 'application/x-ndjson; charset=utf-8')
            connected = True
            outcome = ChatOutcome()

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

            try:
                timing = ModelRequestTiming()
                with self.server.client_factory(timing) as client:
                    genotype_token = CHAT_SESSION.set(session)
                    context_token = workspace_context.CHAT_CONTEXT.set((self.server.stage6, session))
                    # Panel requests from show_panel go straight to this page as they happen.
                    ui_token = UI_CHANNEL.set(lambda request: emit('workspace_action', request['workspace_action']) if 'workspace_action' in request else emit('ui', request))
                    try:
                        answer = run_conversation(client, text.strip(), history,
                                              progress=lambda message: emit('progress', message), http_timing=timing,
                                                  language=language, context=_analysis_context(session), workspace_context=validated_context)
                    finally:
                        UI_CHANNEL.reset(ui_token)
                        CHAT_SESSION.reset(genotype_token)
                        workspace_context.CHAT_CONTEXT.reset(context_token)
                # Failure returns have no final model content; retain their public answer on reload.
                if not history or history[-1].role != 'model' or any(part.function_call for part in history[-1].parts or []):
                    history.append(types.Content(role='model', parts=[types.Part.from_text(text=answer)]))
                emit('answer', answer)
            except Exception:
                emit('error', '回合發生非預期錯誤；操作狀態可能未知，請核對工作狀態後再繼續。')
            if not connected:
                outcome.status = 'needs_review'
            events.append('SIGNET_TURN ' + json.dumps({'status': outcome.status}))
            emit('done', outcome.summary())
        finally:
            try:
                self.server.save_state()
            finally:
                self.server.turn_lock.release()


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



    def json_response(self, value, status=200):
        data = json.dumps(value).encode()
        self._headers(status, 'application/json; charset=utf-8', len(data))
        self.wfile.write(data)

    def hpc_post(self):
        """Workflow-panel buttons call one HPC3 tool directly; the click is the user's approval."""
        if self.path.startswith('/hpc/files/'):
            return self.hpc_files_post()
        from agent.tools import hpc as hpc_tools
        from agent.runtime.hpc import STEPS
        log_actions = {f'/hpc/log/{step}': (lambda step=step: hpc_tools.read_hpc_setup_log(step))
                       for step in STEPS}
        actions = {'/hpc/check': hpc_tools.check_hpc_environment,
                   '/hpc/workspace': hpc_tools.create_hpc_workspace,
                   '/hpc/signet': hpc_tools.install_signet_source,
                   '/hpc/container': hpc_tools.download_signet_container,
                   '/hpc/prepare': hpc_tools.prepare_imputation_reference,
                   **{f'/hpc/reference/{key}': (lambda key=key: hpc_tools.download_reference_file(key))
                      for key in ('ref', 'gmap', 'gtf', 'clinical')}, **log_actions}
        action = actions.get(self.path)
        if action is None:
            return self._error(404, '找不到此操作。')
        try:
            size = int(self.headers.get('Content-Length', '0') or 0)
        except ValueError:
            size = -1
        if not 0 <= size <= 1024:
            return self._error(400, 'Invalid request length.')
        self.connection.settimeout(10)
        raw = self.rfile.read(size)  # Each path is one fixed action, without user-supplied log paths.
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
        actions = {'/hpc/files/shortcuts': hpc_files.shortcuts, '/hpc/files/selected': hpc_files.selected,
                   '/hpc/files/list': lambda: hpc_files.list_folder(body.get('path')),
                   '/hpc/files/select': lambda: hpc_files.select(body.get('key'), body.get('path')),
                   '/hpc/files/clear': lambda: hpc_files.clear(body.get('key'))}
        action = actions.get(self.path)
        if action is None:
            return self._error(404, '找不到此操作。')
        return self.json_response(action())


def create_server(provider='codex', port=8880, state_file=ROOT / '.chat-state.json'):
    """Build the Python API for Electron or standalone backend development."""
    if provider not in PROVIDERS:
        raise ValueError('Unsupported model provider.')
    load_dotenv(ROOT / '.env')
    configured = create_provider_adapter(provider, gemini_model=MODEL)
    from agent.tools.signet import source_path
    for message in configured.startup_messages:
        print(message, flush=True)
    if not source_path().is_dir():
        print('科學來源尚未準備；可聊天與查詢工具目錄。分析前請執行 python scripts/setup_source.py。', flush=True)
    return ChatServer(('127.0.0.1', port), configured.create_client,
                      model_label=configured.label, state_file=state_file,
                      stop_provider=configured.stop)


def main():
    parser = argparse.ArgumentParser(description='啟動 SIGNET 本機後端 API。')
    parser.add_argument('--port', type=int, default=8880)
    parser.add_argument('--provider', choices=PROVIDERS, default='codex')
    parser.add_argument('--state-file', type=Path, default=ROOT / '.chat-state.json')
    args = parser.parse_args()
    with create_server(args.provider, args.port, args.state_file) as server:
        print(f'SIGNET 後端 API：http://127.0.0.1:{server.server_port}', flush=True)
        print('僅供本機使用；送出訊息會呼叫模型服務。Ctrl+C 結束；進行中的工具會等待完成。', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            server.stop_provider()


if __name__ == '__main__':
    main()
