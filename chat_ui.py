"""Loopback-only chat UI over the existing conversation loop; no new dependencies."""
import argparse
import html
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

from main import MODEL, run_conversation
from model_timing import ModelRequestTiming
from llm_providers import PROVIDERS, create_provider_adapter
from stage6_workspace import Workspace, CHAT_CONTEXT

ROOT = Path(__file__).resolve().parent


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
        assets = {'/': ('index.html', 'text/html; charset=utf-8'),
                  '/chat.js': ('chat.js', 'text/javascript; charset=utf-8'),
                  '/i18n.js': ('i18n.js', 'text/javascript; charset=utf-8'),
                  '/chat.css': ('chat.css', 'text/css; charset=utf-8'),
                  '/ssh.js': ('ssh.js', 'text/javascript; charset=utf-8'),
                  '/ssh.css': ('ssh.css', 'text/css; charset=utf-8'),
                  '/ssh-ui.js': ('../electron/build/ssh-ui.js', 'text/javascript; charset=utf-8'),
                  '/stage6.js': ('stage6.js', 'text/javascript; charset=utf-8'),
                  '/vendor/vis-network.min.js': ('vendor/vis-network.min.js', 'text/javascript; charset=utf-8')}
        url = urlsplit(self.path)
        if url.path in ('/stage6', '/stage6/file'):
            return self.stage6_get(url)
        if url.path not in assets:
            return self._error(404, '找不到頁面。')
        filename, content_type = assets[url.path]
        try:
            body = (ROOT / 'web' / filename).read_text()
        except FileNotFoundError:
            return self._error(404, '找不到頁面。')
        if url.path == '/':
            if not self.server.turn_lock.acquire(blocking=False):
                return self._error(409, '回合仍在執行，請保留原頁面等待完成。')
            try:
                query = parse_qs(url.query)
                session = query.get('session', [None])[0]
                saved = list(dict.fromkeys([*self.server.histories, *self.server.stage6.sessions]))
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
            body = body.replace('__TOKEN__', self.server.token).replace('__MODEL__', html.escape(self.server.model_label))
            body = body.replace('__INITIAL_CHAT__', json.dumps(initial, ensure_ascii=False).replace('<', '\\u003c'))
        self._headers(200, content_type)
        self.wfile.write(body.encode())

    def do_POST(self):
        origin = f'http://127.0.0.1:{self.server.server_port}'
        if (not self._local_request() or self.headers.get('Origin') != origin
                or not secrets.compare_digest(self.headers.get('X-Chat-Token', ''), self.server.token)):
            return self._error(403, '請從本機聊天頁面送出。')
        if self.path.startswith('/stage6/'):
            return self.stage6_post()
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

            def emit(kind, message):
                nonlocal connected
                if kind in ('progress', 'error', 'done'):
                    events.append(message)
                if connected:
                    try:
                        self.wfile.write((json.dumps({'type': kind, 'text': message}, ensure_ascii=False) + '\n').encode())
                        self.wfile.flush()
                    except OSError:
                        # Keep recording actual results if the browser disconnects; never replay tools.
                        connected = False

            try:
                timing = ModelRequestTiming()
                with self.server.client_factory(timing) as client:
                    context_token = CHAT_CONTEXT.set((self.server.stage6, session))
                    try:
                        answer = run_conversation(client, text.strip(), history,
                                              progress=lambda message: emit('progress', message), http_timing=timing,
                                                  language=language)
                    finally:
                        CHAT_CONTEXT.reset(context_token)
                emit('workspace', self.server.stage6.view(session))
                emit('answer', answer)
            except Exception:
                emit('error', '回合發生非預期錯誤；操作狀態可能未知，請核對工作狀態後再繼續。')
            emit('done', '回合結束；分析是否成功請以工具狀態與回答為準。')
        finally:
            try:
                self.server.save_state()
            finally:
                self.server.turn_lock.release()


    def json_response(self, value, status=200):
        data = json.dumps(value).encode()
        self._headers(status, 'application/json; charset=utf-8', len(data))
        self.wfile.write(data)

    def stage6_get(self, url):
        query = parse_qs(url.query)
        session = query.get('session', [''])[0]
        if not re.fullmatch(r'[a-f0-9-]{36}', session):
            return self._error(400, 'Invalid session.')
        try:
            if url.path == '/stage6':
                if not secrets.compare_digest(self.headers.get('X-Chat-Token', ''), self.server.token):
                    return self._error(403, 'Workspace token required.')
                return self.json_response(self.server.stage6.view(session))
            if url.path == '/stage6/file':
                import signet_tools as st
                from stage6_workspace import load_run
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
            if not isinstance(session, str) or not re.fullmatch(r'[a-f0-9-]{36}', session):
                raise ValueError('Invalid session.')
            if not self.server.turn_lock.acquire(blocking=False):
                return self._error(409, 'A conversation turn or visualization is running.')
            locked = True
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


def create_server(provider='codex', port=8880, state_file=ROOT / '.chat-state.json'):
    """Build the same local service for the browser CLI or the optional desktop host."""
    if provider not in PROVIDERS:
        raise ValueError('Unsupported model provider.')
    load_dotenv(ROOT / '.env')
    configured = create_provider_adapter(provider, gemini_model=MODEL)
    from signet_tools import source_path
    for message in configured.startup_messages:
        print(message, flush=True)
    if not source_path().is_dir():
        print('科學來源尚未準備；可聊天與查詢工具目錄。分析前請執行 python scripts/setup_source.py。', flush=True)
    return ChatServer(('127.0.0.1', port), configured.create_client,
                      model_label=configured.label, state_file=state_file,
                      stop_provider=configured.stop)


def main():
    parser = argparse.ArgumentParser(description='啟動 SIGNET 本機聊天介面。')
    parser.add_argument('--port', type=int, default=8880)
    parser.add_argument('--provider', choices=PROVIDERS, default='codex')
    parser.add_argument('--state-file', type=Path, default=ROOT / '.chat-state.json')
    args = parser.parse_args()
    with create_server(args.provider, args.port, args.state_file) as server:
        print(f'SIGNET 聊天介面：http://127.0.0.1:{server.server_port}', flush=True)
        print('僅供本機使用；送出訊息會呼叫模型服務。Ctrl+C 結束；進行中的工具會等待完成。', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            server.stop_provider()


if __name__ == '__main__':
    main()
