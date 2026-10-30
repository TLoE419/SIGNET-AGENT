from contextlib import contextmanager
import http.client
import json
import threading
import unittest

from google.genai import types

import agent.app.chat_ui as chat_ui
from agent.tools.signet import dispatch_tool
from agent.tools.ui import UI_CHANNEL, show_panel
from test_chat import client_for, response


class ShowPanelToolTest(unittest.TestCase):
    def test_forwards_only_known_panels_to_the_page(self):
        sent = []
        token = UI_CHANNEL.set(sent.append)
        try:
            self.assertEqual(show_panel('workflow', True)['status'], 'ok')
            self.assertEqual(dispatch_tool('show_panel', {'panel': 'visualization', 'visible': False})['executed'], False)
            self.assertEqual(show_panel('settings', True)['status'], 'invalid')
            self.assertEqual(dispatch_tool('show_panel', {'panel': 'workflow', 'visible': 'yes'})['status'], 'invalid')
        finally:
            UI_CHANNEL.reset(token)
        self.assertEqual(sent, [{'panel': 'workflow', 'visible': True}, {'panel': 'visualization', 'visible': False}])

    def test_without_a_chat_page_nothing_is_sent(self):
        self.assertEqual(show_panel('workflow', True)['status'], 'unavailable')


class ShowPanelStreamTest(unittest.TestCase):
    """A model call to show_panel reaches the page as a 'ui' event within the same turn."""

    def test_panel_request_streams_before_the_answer(self):
        call = types.FunctionCall(name='show_panel', args={'panel': 'workflow', 'visible': True})
        client, _ = client_for(response(calls=[call]), response('已展開分析流程。'))

        @contextmanager
        def factory(timing):
            yield client

        server = chat_ui.ChatServer(('127.0.0.1', 0), factory)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            origin = f'http://127.0.0.1:{server.server_port}'
            conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=10)
            conn.request('POST', '/chat', body=json.dumps({'text': '幫我打開分析流程', 'session': '12345678-1234-1234-1234-123456789abc'}),
                         headers={'Origin': origin, 'X-Chat-Token': server.token})
            events = [json.loads(line) for line in conn.getresponse().read().decode().splitlines() if line.strip()]
            conn.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        kinds = [event['type'] for event in events]
        self.assertIn('ui', kinds)
        self.assertEqual(next(e for e in events if e['type'] == 'ui')['text'], {'panel': 'workflow', 'visible': True})
        self.assertLess(kinds.index('ui'), kinds.index('answer'))
        self.assertIsNone(UI_CHANNEL.get(), 'the channel is cleared after the turn')


if __name__ == '__main__':
    unittest.main()
