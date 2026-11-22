from contextlib import contextmanager
import http.client
import json
import threading
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

import httpx
import agent.app.chat_ui as chat_ui
from agent.core.conversation import FALLBACK_MODEL, MODEL
from test_chat import client_for, response
from google.genai import errors, types


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

    def request(self, path='/bootstrap', payload=None, headers=None, *, method=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        try:
            body = json.dumps(payload) if payload is not None else None
            conn.request(method or ('POST' if body is not None else 'GET'), path, body=body, headers=headers or {})
            result = conn.getresponse()
            return result.status, result.read().decode()
        finally:
            conn.close()

    def post(self, text='你好', session=None, headers=None):
        return self.request('/chat', {'text': text, 'session': session or self.session}, headers or {
            'Origin': self.origin, 'X-Chat-Token': self.server.token})

    def delete(self, session=None, headers=None):
        if headers is None:
            headers = {'Origin': self.origin, 'X-Chat-Token': self.server.token}
        return self.request('/chat/' + (self.session if session is None else session), headers=headers, method='DELETE')

    def test_workspace_context_validated_before_agent(self):
        catalog = {'datasets': [{'id': 'cohort-a'}], 'runs': [
            {'history_id': 'archive--same', 'source': 'archive', 'run_id': 'same', 'dataset_id': 'cohort-a'}]}
        context = dict(version=1, dataset_id='cohort-a', history_id='archive--same', stage=6, selected_genes=['MEGF6'])
        payload = {'text': 'Which run?', 'session': self.session, 'workspace_context': context}
        headers = {'Origin': self.origin, 'X-Chat-Token': self.server.token}
        with patch.object(self.server.stage6, 'history', return_value=catalog), patch.object(chat_ui, 'run_conversation', return_value='Selected archive') as run:
            status, body = self.request('/chat', payload, headers)
            self.assertEqual(status, 200)
            self.assertEqual(run.call_args.kwargs['workspace_context'], dict(context, source='archive', run_id='same'))
            context['history_id'] = 'workspace--same'
            run.reset_mock()
            self.assertEqual(self.request('/chat', payload, headers)[0], 400)
            run.assert_not_called()
            payload.pop('workspace_context')
            self.assertEqual(self.request('/chat', payload, headers)[0], 200)
            self.assertIsNone(run.call_args.kwargs['workspace_context'])

    def test_assets_and_no_arbitrary_file_access(self):
        status, html = self.request()
        self.assertEqual(status, 200)
        self.assertIn(self.server.token, html)
        self.assertNotIn('__MODEL__', html)
        self.server.model_label = 'Groq / qwen/qwen3.8-27b'
        self.assertIn(self.server.model_label, self.request()[1])
        for path in ['/', '/chat.css', '/chat.js', '/ssh-ui.js']:
            self.assertEqual(self.request(path)[0], 404)
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

    def test_chat_can_stop_before_the_model_is_called_and_restore_the_notice(self):
        turn_id = 'a2345678-1234-1234-1234-123456789abc'
        headers = {'Origin': self.origin, 'X-Chat-Token': self.server.token}
        key = {'session': self.session, 'turn_id': turn_id}
        client_preparing, release_client = threading.Event(), threading.Event()
        next_client, model_requests = client_for(response('Next answer.'))

        @contextmanager
        def factory(timing):
            client_preparing.set()
            if not release_client.wait(5):
                raise RuntimeError('Test did not release the client.')
            yield next_client

        self.server.client_factory = factory
        with tempfile.TemporaryDirectory() as directory:
            self.server.state_file = Path(directory) / 'chat.json'
            connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
            try:
                connection.request('POST', '/chat', json.dumps({**key, 'text': 'Stop here.'}), headers)
                stream = connection.getresponse()
                self.assertEqual(stream.status, 200)
                self.assertEqual(json.loads(stream.readline()), {'type': 'turn_started', 'text': {'turn_id': turn_id}})
                self.assertTrue(client_preparing.wait(3))
                self.assertEqual(self.request('/chat/cancel', key, {'Origin': self.origin})[0], 403)
                self.assertEqual(self.request('/chat/cancel', {**key, 'turn_id': 'bad'}, headers)[0], 400)
                self.assertEqual(self.request('/chat/cancel', {**key, 'session': turn_id}, headers)[0], 404)
                self.assertEqual(self.request('/chat/cancel', {**key, 'turn_id': self.session}, headers)[0], 404)
                for _ in range(2):
                    status, body = self.request('/chat/cancel', key, headers)
                    self.assertEqual((status, json.loads(body)),
                                     (200, {'status': 'cancellation_requested', 'turn_id': turn_id}))
                self.assertEqual(self.post('Still stopping.')[0], 409)
                release_client.set()
                self.assertEqual([json.loads(line) for line in stream], [
                    {'type': 'done', 'status': 'cancelled', 'text': 'Response stopped.'},
                ])
            finally:
                release_client.set()
                connection.close()
            self.assertEqual(self.request('/chat/cancel', key, headers)[0], 404)
            self.assertFalse(model_requests)
            self.assertEqual(self.post('Next question.')[0], 200)
            self.assertEqual([content.parts[0].text for content in model_requests[0]], ['Stop here.', 'Next question.'])
            restored = chat_ui.ChatServer(('127.0.0.1', 0), factory, state_file=self.server.state_file)
            try:
                self.assertEqual(restored.visible_messages(self.session), [
                    {'role': 'user', 'text': 'Stop here.'}, {'role': 'notice', 'text': 'Response stopped.'},
                    {'role': 'user', 'text': 'Next question.'}, {'role': 'assistant', 'text': 'Next answer.'},
                ])
            finally:
                restored.server_close()

    def test_stopping_while_waiting_on_the_model_prevents_fallback_or_tool_dispatch(self):
        turn_id = 'a2345678-1234-1234-1234-123456789abc'
        opened, release_model = threading.Event(), threading.Event()
        headers = {'Origin': self.origin, 'X-Chat-Token': self.server.token}
        key = {'session': self.session, 'turn_id': turn_id}

        def fail_after_cancellation(*args, **kwargs):
            opened.set()
            if not release_model.wait(5):
                raise RuntimeError('Test did not release the model.')
            raise httpx.ReadTimeout('test-only timeout')

        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        with patch.object(self.client.models, 'generate_content', side_effect=fail_after_cancellation) as generate:
            try:
                connection.request('POST', '/chat', json.dumps({**key, 'text': 'Question'}), headers)
                stream = connection.getresponse()
                self.assertTrue(opened.wait(3))
                self.assertEqual(self.request('/chat/cancel', key, headers)[0], 200)
                release_model.set()
                events = [json.loads(line) for line in stream]
            finally:
                release_model.set()
                connection.close()
        generate.assert_called_once()
        self.assertFalse(any(event['type'] in ('model_fallback', 'answer') for event in events))
        self.assertEqual(events[-1]['status'], 'cancelled')

    def test_stopping_waits_for_current_tool_and_keeps_a_complete_tool_record(self):
        turn_id = 'a2345678-1234-1234-1234-123456789abc'
        headers = {'Origin': self.origin, 'X-Chat-Token': self.server.token}
        key = {'session': self.session, 'turn_id': turn_id}
        started, release_tool = threading.Event(), threading.Event()
        tool_calls = [
            types.FunctionCall(id='started-tool', name='signet_catalog', args={}),
            types.FunctionCall(id='later-tool', name='show_panel', args={}),
        ]
        self.client, model_requests = client_for(response(calls=tool_calls), response('Next answer.'))
        retained = {'status': 'ok', 'executed': True}

        def dispatch(*args):
            started.set()
            if not release_tool.wait(5):
                raise RuntimeError('Test did not release the tool.')
            return retained

        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        with patch('agent.core.conversation.dispatch_tool', side_effect=dispatch) as run_tool:
            try:
                connection.request('POST', '/chat', json.dumps({**key, 'text': 'Question'}), headers)
                stream = connection.getresponse()
                self.assertTrue(started.wait(3))
                self.assertEqual(self.request('/chat/cancel', key, headers)[0], 200)
                self.assertEqual(self.post('Still stopping.')[0], 409)
                release_tool.set()
                events = [json.loads(line) for line in stream]
            finally:
                release_tool.set()
                connection.close()
        run_tool.assert_called_once_with('signet_catalog', {})
        self.assertEqual(len(model_requests), 1)
        self.assertEqual(events[-1]['status'], 'cancelled')
        results = [part.function_response for part in self.server.histories[self.session][-1].parts]
        self.assertEqual([part.id for part in results], ['started-tool', 'later-tool'])
        self.assertEqual(results[0].response, retained)
        self.assertEqual((results[1].response['status'], results[1].response['executed']), ('skipped', False))
        self.assertEqual(self.server.visible_messages(self.session), [
            {'role': 'user', 'text': 'Question'}, {'role': 'notice', 'text': 'Response stopped.'},
        ])
        self.assertEqual(self.post('Next question.')[0], 200)
        self.assertEqual(len(model_requests), 2)
        self.assertEqual([part.function_response.id for part in model_requests[-1][-2].parts],
                         ['started-tool', 'later-tool'])
        self.assertEqual(self.server.visible_messages(self.session)[-2:], [
            {'role': 'user', 'text': 'Next question.'}, {'role': 'assistant', 'text': 'Next answer.'},
        ])

    def test_without_model_history_and_analysis_remain_available_but_chat_is_blocked(self):
        previous = types.Content(role='user', parts=[types.Part.from_text(text='Saved question')])
        self.server.histories[self.session] = [previous]
        self.server.client_factory = None
        headers = {'Origin': self.origin, 'X-Chat-Token': self.server.token}
        self.assertEqual(self.request('/signet/catalog', headers=headers)[0], 200)
        status, body = self.request(f'/bootstrap?session={self.session}')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['initial']['messages'], [
            {'role': 'user', 'text': 'Saved question'},
        ])
        status, body = self.post('No configured model')
        self.assertEqual(status, 503)
        self.assertIn('Set up a model in Settings', body)
        self.assertEqual(self.server.histories[self.session], [previous])
        self.assertFalse(self.server.events)
        self.assertFalse(self.requests)

    def test_gemini_fallback_streams_metadata_and_saves_it_on_only_the_matching_answer(self):
        tool = types.FunctionCall(id='catalog', name='signet_catalog', args={})
        error = errors.ServerError(503, {'error': {'status': 'UNAVAILABLE', 'message': 'busy'}})
        self.client, self.requests = client_for(response('Earlier answer.'), response(calls=[tool]), error,
                                                response('Fallback answer.'), response('Next answer.'))
        with tempfile.TemporaryDirectory() as directory:
            self.server.state_file = Path(directory) / 'chat.json'
            with patch('agent.core.conversation.dispatch_tool', return_value={'status': 'ok', 'executed': False}) as dispatch:
                first_status, first_body = self.post('Earlier question')
                status, body = self.post('Query the catalog')
                next_status, next_body = self.post('Next question')
                dispatch.assert_called_once_with('signet_catalog', {})
            self.assertEqual((first_status, status, next_status), (200, 200, 200))
            events = [json.loads(line) for line in body.splitlines()]
            fallback = {'type': 'model_fallback', 'text': {'model': FALLBACK_MODEL}}
            self.assertEqual([event for event in events if event['type'] == 'model_fallback'], [fallback])
            index = events.index(fallback)
            self.assertIn('Model fallback', events[index - 1]['text'])
            fallback_request = next(i for i, event in enumerate(events) if event['type'] == 'progress'
                                    and event['text'].startswith('Model request ')
                                    and f'model={FALLBACK_MODEL}' in event['text'])
            self.assertLess(index, fallback_request)
            answer = next(event['text'] for event in events if event['type'] == 'answer')
            self.assertEqual(answer,
                             f'**Model fallback:** `{MODEL}` is unavailable (HTTP 503); this turn uses '
                             f'`{FALLBACK_MODEL}`. Completed tools will not be rerun.\n\nFallback answer.')
            self.assertNotIn('"type": "model_fallback"', first_body + next_body)
            self.assertEqual(len(self.requests), 5)
            self.assertNotIn(FALLBACK_MODEL, str(self.requests[-1]))

            with chat_ui.ChatServer(('127.0.0.1', 0), self.server.client_factory,
                                    state_file=self.server.state_file) as restored:
                turns = restored.events[self.session]
                self.assertTrue(any('Model fallback' in event for event in turns[1]))
                marker = next(event for event in turns[1] if event.startswith(chat_ui.TURN_MARKER))
                self.assertEqual(json.loads(marker[len(chat_ui.TURN_MARKER):]),
                                 {'status': 'completed', 'assistant_index': 5, 'model_fallback': FALLBACK_MODEL})
                self.assertEqual(restored.visible_messages(self.session), [
                    {'role': 'user', 'text': 'Earlier question'},
                    {'role': 'assistant', 'text': 'Earlier answer.'},
                    {'role': 'user', 'text': 'Query the catalog'},
                    {'role': 'assistant', 'text': 'Fallback answer.', 'model_fallback': FALLBACK_MODEL},
                    {'role': 'user', 'text': 'Next question'},
                    {'role': 'assistant', 'text': 'Next answer.'},
                ])

    def test_sessions_are_isolated(self):
        self.post('第一個研究')
        self.post('另一個研究', 'abcdefab-1234-1234-1234-123456789abc')
        self.assertEqual(len(self.requests[1]), 1)
        self.assertEqual(self.requests[1][0].parts[0].text, '另一個研究')

    def test_delete_one_saved_conversation_persists_and_blocks_stale_requests(self):
        with tempfile.TemporaryDirectory() as folder:
            self.server.state_file = Path(folder) / 'state.json'
            self.server.stage6.path = Path(folder) / '.stage6-workspace.json'
            other = 'abcdefab-1234-1234-1234-123456789abc'
            self.server.active_session = other
            self.server.histories = {self.session: [types.Content(role='user', parts=[types.Part.from_text(text='Delete me')])], other: []}
            self.server.events = {self.session: [['Delete this event']], other: [['Keep this event']]}
            self.server.pending_history = [types.Content(role='user', parts=[types.Part.from_text(text='Unclaimed legacy conversation')])]
            self.server.stage6.sessions = {
                self.session: {'baseline': None, 'comparison': None, 'proposals': [{'status': 'pending'}]},
                other: {'baseline': None, 'comparison': None, 'proposals': []},
            }
            self.server.save_state()
            self.server.stage6.path.write_text(json.dumps(self.server.stage6.sessions))

            status, body = self.delete()
            self.assertEqual((status, json.loads(body)), (200, {'deleted': self.session}))
            self.assertEqual(self.request('/bootstrap?session=' + self.session)[0], 404)
            self.assertEqual(self.post('Stale follow-up')[0], 404)
            headers = {'Origin': self.origin, 'X-Chat-Token': self.server.token}
            self.assertEqual(self.request('/stage6?session=' + self.session, headers=headers)[0], 404)
            self.assertEqual(self.request('/stage6/select', {'session': self.session}, headers)[0], 404)
            status, body = self.delete()
            self.assertEqual((status, json.loads(body)), (200, {'deleted': self.session}))
            self.assertNotIn('Delete me', self.server.state_file.read_text())
            self.assertNotIn('Delete this event', self.server.state_file.read_text())
            self.assertIn(self.session, self.server.stage6.path.read_text(), 'Retired scientific checkpoints are never rewritten by chat deletion')
            self.assertEqual(self.requests, [])
            with chat_ui.ChatServer(('127.0.0.1', 0), self.server.client_factory,
                                    state_file=self.server.state_file) as restored:
                self.assertEqual(restored.active_session, other)
                self.assertEqual(restored.histories, {other: []})
                self.assertEqual(restored.events, {other: [['Keep this event']]})
                self.assertEqual(restored.pending_history, self.server.pending_history)
                self.assertEqual(restored.stage6.sessions, {}, 'Retired execution state is not restored')
                self.assertEqual(restored.deleted_sessions, {self.session})

    def test_delete_requires_local_auth_and_rejects_busy_or_unknown_sessions(self):
        self.server.histories[self.session] = []
        for headers in [{'Origin': 'https://example.com', 'X-Chat-Token': self.server.token},
                        {'Origin': self.origin},
                        {'Origin': self.origin, 'X-Chat-Token': self.server.token, 'Host': 'evil.example'}]:
            self.assertEqual(self.delete(headers=headers)[0], 403)
        self.assertEqual(self.delete('invalid')[0], 404)
        self.assertEqual(self.delete('abcdefab-1234-1234-1234-123456789abc')[0], 404)
        with self.server.turn_lock:
            self.assertEqual(self.delete()[0], 409)
        with self.server.stage6.lock:
            self.assertEqual(self.delete()[0], 409)
        self.assertIn(self.session, self.server.histories)
        self.assertEqual(self.server.deleted_sessions, set())

    def test_delete_legacy_stage_only_session_and_roll_back_on_save_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            self.server.state_file = Path(folder) / 'state.json'
            self.server.stage6.path = Path(folder) / '.stage6-workspace.json'
            self.server.active_session = self.session
            workspace = {'baseline': None, 'comparison': None, 'proposals': []}
            self.server.stage6.sessions[self.session] = workspace
            self.server.save_state()
            self.server.stage6.path.write_text(json.dumps(self.server.stage6.sessions))
            before = [path.read_bytes() for path in (self.server.state_file, self.server.stage6.path)]

            for target, method in ((self.server, 'save_state'),):
                with self.subTest(method=method), patch.object(target, method, side_effect=OSError('private state path')):
                    status, body = self.delete()
                    self.assertEqual(status, 500)
                    self.assertNotIn('private state path', body)
                    self.assertEqual(self.server.active_session, self.session)
                    self.assertEqual(self.server.stage6.sessions, {self.session: workspace})
                    self.assertEqual(self.server.deleted_sessions, set())
                    self.assertEqual([path.read_bytes() for path in (self.server.state_file, self.server.stage6.path)], before)
            self.assertEqual(self.delete()[0], 200)
            self.assertIsNone(self.server.active_session)
            self.assertEqual(self.server.stage6.sessions, {})
            self.assertEqual(self.initial_chat(self.request('/bootstrap')[1])['sessions'], [])

    def test_public_failure_answer_and_outcome_survive_saved_reload(self):
        self.client, _ = client_for(RuntimeError('PRIVATE-FAILURE'))
        with tempfile.TemporaryDirectory() as directory:
            self.server.state_file = Path(directory) / 'chat.json'
            status, body = self.post('Inspect the saved result')
            self.assertEqual(status, 200)
            events = [json.loads(line) for line in body.splitlines()]
            answer = next(event['text'] for event in events if event['type'] == 'answer')
            self.assertEqual(events[-1]['status'], 'failed')
            self.assertIn('Model request failed', answer)
            restored = chat_ui.ChatServer(('127.0.0.1', 0), self.server.client_factory, state_file=self.server.state_file)
            try:
                self.assertEqual(restored.visible_messages(self.session)[-1], {'role': 'assistant', 'text': answer})
                self.assertIn('SIGNET_TURN {"status": "failed"}', restored.events[self.session][0])
                self.assertNotIn('PRIVATE-FAILURE', self.server.state_file.read_text())
            finally:
                restored.server_close()

    def test_workspace_proposal_streams_one_validated_action_and_needs_review(self):
        from agent.tools import workspace as tools
        self.client, _ = client_for(response(calls=[types.FunctionCall(name='propose_workspace_stage', args={'run_id': 'fixture', 'stage': 2})]), response('Review the manual form.'))
        state = {'job': {'job_id': '42', 'attempt': 1}, 'history_id': 'workspace--fixture', 'stage': 2}
        with patch.object(tools, 'get_workspace_stage', return_value=state), \
                patch.object(tools.workspace, 'review_expression', return_value={'ready': True}), \
                patch.object(self.server.stage6, 'history', return_value={'runs': [{'history_id': 'workspace--fixture'}]}), \
                patch.object(tools.jobs, 'submit') as submit:
            status, body = self.post('Review the next stage')
        events = [json.loads(line) for line in body.splitlines()]
        self.assertEqual(status, 200)
        self.assertEqual([event['text'] for event in events if event['type'] == 'workspace_action'],
                         [{'version': 1, 'action': 'view_stage', 'history_id': 'workspace--fixture', 'stage': 2}])
        self.assertEqual(events[-1]['status'], 'needs_review')
        submit.assert_not_called()

    def test_legacy_language_is_accepted_without_changing_english_or_user_text(self):
        payload = {'text': '原本的問題', 'session': self.session, 'language': 'zh-Hant'}
        headers = {'Origin': self.origin, 'X-Chat-Token': self.server.token}
        with patch.object(chat_ui, 'run_conversation', return_value='回答') as run:
            self.assertEqual(self.request('/chat', payload, headers)[0], 200)
        self.assertNotIn('language', run.call_args.kwargs)
        self.assertEqual(run.call_args.args[1], '原本的問題')

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
        status, page = self.request('/bootstrap?session=' + self.session)
        self.assertEqual(status, 200)
        data = page
        initial = json.loads(data)['initial']
        self.assertEqual(initial['session'], self.session)
        self.assertEqual(len(initial['messages']), 2)
        self.assertIn(unsafe, initial['messages'][1]['text'])
        self.assertNotIn('PRIVATE-THOUGHT', data)
        self.assertNotIn('工具公開說明', data)
        self.assertNotIn('內部備份', data)
        self.assertEqual(initial['events'], [['工具查詢完成，未執行分析。']])
        self.assertEqual(self.request('/bootstrap?session=bad')[0], 404)

    def initial_chat(self, page):
        return json.loads(page)['initial']

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
            fresh = self.initial_chat(self.request('/bootstrap?new=1')[1])
            self.assertNotIn('session', fresh)
            self.assertNotIn('messages', fresh)
            self.assertEqual(len(fresh['sessions']), 2)
            run.assert_not_called()
        self.server.turn_lock.acquire()
        try:
            self.assertEqual(self.request('/bootstrap?session=' + older)[0], 409)
        finally:
            self.server.turn_lock.release()

    def test_last_viewed_conversation_survives_restart_without_replay(self):
        with tempfile.TemporaryDirectory() as folder:
            self.server.state_file = Path(folder) / 'state.json'
            other = 'abcdefab-1234-1234-1234-123456789abc'
            self.server.histories = {self.session: [types.Content(role='user', parts=[types.Part.from_text(text='Saved question')])], other: []}
            self.server.events[self.session] = [['Saved work; do not replay']]
            self.request('/bootstrap?session=' + self.session)
            with chat_ui.ChatServer(('127.0.0.1', 0), self.server.client_factory,
                                    state_file=self.server.state_file) as restored:
                runner = threading.Thread(target=restored.serve_forever, daemon=True)
                runner.start()
                try:
                    conn = http.client.HTTPConnection('127.0.0.1', restored.server_port, timeout=3)
                    conn.request('GET', '/bootstrap')
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
        with patch('agent.core.conversation.dispatch_tool', return_value={'status': 'prepared', 'executed': False}):
            status, body = self.post('有哪些分析？')
        self.assertEqual(status, 200)
        events = [json.loads(line) for line in body.splitlines()]
        self.assertTrue(any('status=prepared; executed=False' in event['text'] for event in events))
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

        def run(client, text, history, progress, http_timing, workspace_context=None, *, on_model_fallback=None, context=''):

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
