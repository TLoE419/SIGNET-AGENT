"""Local chat web service: assets, request protection, streaming and saved conversations."""
from contextlib import contextmanager
import http.client
import json
import threading
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

import chat_ui
from test_chat import client_for, response
from google.genai import types


class ChatUITest(unittest.TestCase):
    def setUp(self):
        self.client, self.requests = client_for(response('第一輪'), response('第二輪'))

        @contextmanager
        def factory(timing):
            yield self.client

        self.server = chat_ui.ChatServer(('127.0.0.1', 0), factory)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f'http://127.0.0.1:{self.server.server_port}'
        self.session = '12345678-1234-1234-1234-123456789abc'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path='/', payload=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        try:
            body = json.dumps(payload) if payload is not None else None
            conn.request('POST' if body is not None else 'GET', path, body=body, headers=headers or {})
            result = conn.getresponse()
            return result.status, result.read().decode()
        finally:
            conn.close()

    def post(self, text='你好', session=None, headers=None):
        return self.request('/chat', {'text': text, 'session': session or self.session}, headers or {
            'Origin': self.origin, 'X-Chat-Token': self.server.token})

    def test_assets_and_no_arbitrary_file_access(self):
        status, html = self.request()
        self.assertEqual(status, 200)
        self.assertIn(self.server.token, html)
        self.assertNotIn('__MODEL__', html)
        self.server.model_label = 'Groq / qwen/qwen3.8-27b'
        self.assertIn(self.server.model_label, self.request()[1])
        # Every shipped script, including the HPC3 card, is served; nothing else is.
        for path in ['/chat.css', '/chat.js', '/hpc3.js']:
            self.assertEqual(self.request(path)[0], 200)
        for path in ['/.env', '/../main.py', '/signet_inventory.json']:
            self.assertEqual(self.request(path)[0], 404)

    def test_stream_has_progress_answer_done_and_preserves_context(self):
        status, body = self.post()
        self.assertEqual(status, 200)
        events = [json.loads(line) for line in body.splitlines()]
        self.assertEqual(events[0]['type'], 'progress')
        self.assertEqual(events[-2], {'type': 'answer', 'text': '第一輪'})
        self.assertEqual(events[-1]['type'], 'done')
        self.post('繼續')
        self.assertEqual(len(self.requests[1]), 3)

    def test_sessions_are_isolated(self):
        self.post('第一個研究')
        self.post('另一個研究', 'abcdefab-1234-1234-1234-123456789abc')
        self.assertEqual(len(self.requests[1]), 1)
        self.assertEqual(self.requests[1][0].parts[0].text, '另一個研究')

    def test_language_selection_is_validated_and_forwarded_without_changing_history(self):
        payload = {'text': '原本的問題', 'session': self.session, 'language': 'zh-Hant'}
        headers = {'Origin': self.origin, 'X-Chat-Token': self.server.token}
        with patch.object(chat_ui, 'run_conversation', return_value='回答') as run:
            self.assertEqual(self.request('/chat', payload, headers)[0], 200)
        self.assertEqual(run.call_args.kwargs['language'], 'zh-Hant')
        self.assertEqual(run.call_args.args[1], '原本的問題')
        payload['language'] = 'invalid'
        self.assertEqual(self.request('/chat', payload, headers)[0], 400)

    def test_resume_page_restores_only_visible_messages_and_escapes_script_data(self):
        unsafe = '</script><img src=x onerror=alert(1)>'
        self.server.histories[self.session] = [
            types.Content(role='user', parts=[types.Part.from_text(text='原問題')]),
            types.Content(role='model', parts=[types.Part(text='PRIVATE-THOUGHT', thought=True),
                                               types.Part.from_text(text='- **用途：**說明' + unsafe)]),
            types.Content(role='model', parts=[types.Part.from_text(text='工具公開說明'),
                types.Part(function_call=types.FunctionCall(name='signet_catalog', args={}))]),
            types.Content(role='user', parts=[types.Part.from_text(text='服務更新續接資料：內部備份')])]
        self.server.events[self.session] = [['工具查詢完成，未執行分析。']]
        status, page = self.request('/?session=' + self.session)
        self.assertEqual(status, 200)
        data = page.split('id="initial-chat">')[1].split('</script>')[0]
        initial = json.loads(data)
        self.assertEqual(initial['session'], self.session)
        self.assertEqual(len(initial['messages']), 2)
        self.assertIn(unsafe, initial['messages'][1]['text'])
        self.assertNotIn(unsafe, data)
        self.assertNotIn('PRIVATE-THOUGHT', data)
        self.assertNotIn('工具公開說明', data)
        self.assertNotIn('內部備份', data)
        self.assertEqual(initial['events'], [['工具查詢完成，未執行分析。']])
        self.assertEqual(self.request('/?session=bad')[0], 404)

    def initial_chat(self, page):
        return json.loads(page.split('id="initial-chat">')[1].split('</script>')[0])

    def test_legacy_history_is_restored_and_new_chat_is_explicit(self):
        older = self.session
        latest = 'abcdefab-1234-1234-1234-123456789abc'
        for session, text in [(older, 'Earlier question'), (latest, 'Latest question')]:
            self.server.histories[session] = [types.Content(role='user', parts=[types.Part.from_text(text=text)])]
        with patch.object(chat_ui, 'run_conversation') as run:
            initial = self.initial_chat(self.request()[1])
            self.assertEqual(initial['session'], latest)
            self.assertEqual(initial['messages'][0]['text'], 'Latest question')
            self.assertEqual({item['session'] for item in initial['sessions']}, {older, latest})
            fresh = self.initial_chat(self.request('/?new=1')[1])
            self.assertNotIn('session', fresh)
            self.assertNotIn('messages', fresh)
            self.assertEqual(len(fresh['sessions']), 2)
            run.assert_not_called()
        self.server.turn_lock.acquire()
        try:
            self.assertEqual(self.request('/?session=' + older)[0], 409)
        finally:
            self.server.turn_lock.release()

    def test_last_viewed_conversation_survives_restart_without_replay(self):
        with tempfile.TemporaryDirectory() as folder:
            self.server.state_file = Path(folder) / 'state.json'
            other = 'abcdefab-1234-1234-1234-123456789abc'
            self.server.histories = {self.session: [types.Content(role='user', parts=[types.Part.from_text(text='Saved question')])], other: []}
            self.server.events[self.session] = [['Saved work; do not replay']]
            self.request('/?session=' + self.session)
            with chat_ui.ChatServer(('127.0.0.1', 0), self.server.client_factory,
                                    state_file=self.server.state_file) as restored:
                runner = threading.Thread(target=restored.serve_forever, daemon=True)
                runner.start()
                try:
                    conn = http.client.HTTPConnection('127.0.0.1', restored.server_port, timeout=3)
                    conn.request('GET', '/')
                    response = conn.getresponse()
                    self.assertEqual(response.status, 200)
                    initial = self.initial_chat(response.read().decode())
                    conn.close()
                    self.assertEqual(initial['session'], self.session)
                    self.assertEqual(initial['messages'][0]['text'], 'Saved question')
                    self.assertEqual(initial['events'], [['Saved work; do not replay']])
                    self.assertEqual(self.requests, [])
                finally:
                    restored.shutdown()
                    runner.join(3)

    def test_new_chat_beyond_32_preserves_existing_history_and_events(self):
        for index in range(32):
            session = f'{index:08x}-0000-0000-0000-000000000000'
            self.server.histories[session] = [types.Content(role='user', parts=[types.Part.from_text(text=f'Saved {index}')])]
            self.server.events[session] = [[f'Existing event {index}']]
        existing = dict(self.server.histories)
        status, body = self.post('New conversation after 32 saved chats')
        self.assertEqual(status, 200, body)
        self.assertEqual(len(self.server.histories), 33)
        for session, history in existing.items():
            self.assertEqual(self.server.histories[session], history)
            self.assertTrue(self.server.events[session][0][0].startswith('Existing event'))
        self.assertEqual(self.server.active_session, self.session)
        self.assertEqual(len(self.requests), 1)

    def test_checkpoint_retains_token_full_tool_results_and_session_isolation(self):
        with tempfile.TemporaryDirectory() as folder:
            self.server.state_file = Path(folder) / 'state.json'
            call = types.FunctionCall(id='saved-tool', name='signet_catalog', args={})
            self.server.histories[self.session] = [
                types.Content(role='user', parts=[types.Part.from_text(text='原始條件')]),
                types.Content(role='model', parts=[types.Part(function_call=call)]),
                types.Content(role='user', parts=[types.Part(function_response=types.FunctionResponse(
                    id='saved-tool', name='signet_catalog', response={'status':'unavailable', 'executed':False}))])]
            self.server.save_state()
            with chat_ui.ChatServer(('127.0.0.1', 0), self.server.client_factory,
                                    state_file=self.server.state_file) as restored:
                self.assertEqual(restored.token, self.server.token)
                self.assertEqual(restored.histories[self.session][-1].parts[0].function_response.response,
                                 {'status':'unavailable', 'executed':False})
                self.assertEqual(restored.histories[self.session][1].parts[0].function_call.id, 'saved-tool')
            self.assertEqual(self.server.state_file.stat().st_mode & 0o777, 0o600)

    def test_visible_transcript_migration_is_claimed_once(self):
        self.server.pending_history = [types.Content(role='user', parts=[types.Part.from_text(text='先前可見對話')])]
        self.post('繼續')
        self.assertEqual(self.requests[0][0].parts[0].text, '先前可見對話')
        self.assertEqual(self.server.pending_history, [])
        self.post('另一頁', session='abcdefab-1234-1234-1234-123456789abc')
        self.assertEqual(len(self.requests[1]), 1)

    def test_cross_origin_missing_token_and_rebinding_are_rejected(self):
        for headers in [{'Origin': 'https://example.com', 'X-Chat-Token': self.server.token},
                        {'Origin': self.origin},
                        {'Origin': self.origin, 'X-Chat-Token': self.server.token, 'Host': 'evil.example'}]:
            self.assertEqual(self.post(headers=headers)[0], 403)
        self.assertEqual(self.request(headers={'Host': 'evil.example'})[0], 403)
        self.assertEqual(self.requests, [])

    def test_invalid_input_and_concurrent_turn_are_rejected(self):
        for text in ['', ' ', 'x' * 8001, 42]:
            self.assertEqual(self.post(text)[0], 400)
        self.server.turn_lock.acquire()
        try:
            self.assertEqual(self.post()[0], 409)
        finally:
            self.server.turn_lock.release()
        self.assertEqual(self.requests, [])

    def test_real_loop_tool_events_and_second_model_response(self):
        call = types.FunctionCall(id='catalog', name='signet_catalog', args={})
        self.client, self.requests = client_for(response(calls=[call]), response('已查詢能力，尚未執行分析。'))
        with patch('main.dispatch_tool', return_value={'status': 'prepared', 'executed': False}):
            status, body = self.post('有哪些分析？')
        self.assertEqual(status, 200)
        events = [json.loads(line) for line in body.splitlines()]
        self.assertTrue(any('status=prepared；executed=False' in event['text'] for event in events))
        self.assertEqual(events[-2]['text'], '已查詢能力，尚未執行分析。')
        self.assertEqual(len(self.requests), 2)

    def test_unexpected_error_is_safe_and_releases_turn_lock(self):
        with patch.object(chat_ui, 'run_conversation', side_effect=RuntimeError('PRIVATE-KEY')):
            status, body = self.post()
        self.assertEqual(status, 200)
        self.assertIn('"type": "error"', body)
        self.assertNotIn('PRIVATE', body)
        self.assertFalse(self.server.turn_lock.locked())

    def test_progress_arrives_before_answer_and_disconnect_does_not_replay(self):
        release = threading.Event()
        finished = threading.Event()

        def run(client, text, history, progress, http_timing, language):
            self.assertEqual(language, 'en')
            progress('工具正在執行')
            release.wait(3)
            history.append('已記錄工具結果')
            finished.set()
            return '回答'

        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        with patch.object(chat_ui, 'run_conversation', side_effect=run) as run_mock:
            try:
                conn.request('POST', '/chat', json.dumps({'text':'查詢', 'session':self.session}),
                             {'Origin': self.origin, 'X-Chat-Token': self.server.token})
                result = conn.getresponse()
                event = json.loads(result.readline())
                self.assertEqual(event, {'type':'progress', 'text':'工具正在執行'})
                self.assertFalse(finished.is_set())
                result.close()
                conn.close()
            finally:
                release.set()
            self.assertTrue(finished.wait(3))
            self.assertEqual(self.server.histories[self.session], ['已記錄工具結果'])
            self.assertEqual(run_mock.call_count, 1)


if __name__ == '__main__':
    unittest.main()
