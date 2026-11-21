import unittest
from types import SimpleNamespace
from agent.tools.ui import UI_CHANNEL, navigate_workspace
from agent.stage6.workspace import CHAT_CONTEXT
from agent.tools.signet import dispatch_tool


class WorkspaceNavigationTests(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.ui = UI_CHANNEL.set(self.sent.append)
        self.context = CHAT_CONTEXT.set((SimpleNamespace(history=lambda: {'runs': [
            {'history_id': 'archive--same'}, {'history_id': 'workspace--same'}]}), 'session'))

    def tearDown(self):
        UI_CHANNEL.reset(self.ui)
        CHAT_CONTEXT.reset(self.context)

    def test_canonical_source_and_gene_forward_without_execution(self):
        result = dispatch_tool('navigate_workspace', {'action': 'select_gene', 'history_id': 'archive--same', 'stage': 6, 'gene': 'BRCA1'})
        self.assertEqual(result['status'], 'ok')
        self.assertIs(result['executed'], False)
        self.assertEqual(self.sent, [{'workspace_action': {'version': 1, 'action': 'select_gene', 'history_id': 'archive--same', 'stage': 6, 'gene': 'BRCA1'}}])
        self.assertEqual(navigate_workspace('view_stage', 'workspace--same', 2)['status'], 'ok')

    def test_rejects_foreign_malformed_and_execution_payloads(self):
        for args in [('submit', 'archive--same', 6, ''), ('view_stage', 'same', 6, ''),
                     ('view_stage', 'archive--missing', 6, ''), ('view_stage', 'archive--same', True, ''),
                     ('select_gene', 'archive--same', 3, 'BRCA1'), ('select_gene', 'archive--same', 6, '<script>')]:
            self.assertEqual(navigate_workspace(*args)['status'], 'invalid')
        self.assertEqual(self.sent, [])

    def test_no_page_is_unavailable(self):
        token = UI_CHANNEL.set(None)
        try:
            self.assertEqual(navigate_workspace('view_stage', 'archive--same', 1)['status'], 'unavailable')
        finally:
            UI_CHANNEL.reset(token)


class WorkspaceNavigationStreamTests(unittest.TestCase):
    def test_structured_action_streams_before_answer_and_channel_is_cleared(self):
        from contextlib import contextmanager
        import http.client
        import json
        import threading
        from unittest.mock import Mock
        from google.genai import types
        import agent.app.chat_ui as chat_ui
        from test_chat import client_for, response
        client, _ = client_for(response(calls=[types.FunctionCall(name='navigate_workspace', args={
            'action': 'view_stage', 'history_id': 'archive--fixture', 'stage': 3})]), response('已要求顯示結果。'))

        @contextmanager
        def factory(timing):
            yield client

        server = chat_ui.ChatServer(('127.0.0.1', 0), factory)
        server.stage6 = Mock()
        server.stage6.history.return_value = {'runs': [{'history_id': 'archive--fixture'}]}
        server.stage6.view.return_value = {}
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=10)
            conn.request('POST', '/chat', body=json.dumps({'text': '顯示第三階段', 'session': '12345678-1234-1234-1234-123456789abc'}),
                         headers={'Origin': f'http://127.0.0.1:{server.server_port}', 'X-Chat-Token': server.token})
            events = [json.loads(line) for line in conn.getresponse().read().decode().splitlines() if line.strip()]
            conn.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        kinds = [event['type'] for event in events]
        self.assertLess(kinds.index('workspace_action'), kinds.index('answer'))
        self.assertEqual(next(event['text'] for event in events if event['type'] == 'workspace_action'),
                         {'version': 1, 'action': 'view_stage', 'history_id': 'archive--fixture', 'stage': 3})
        self.assertIsNone(UI_CHANNEL.get())
        self.assertIsNone(CHAT_CONTEXT.get())
