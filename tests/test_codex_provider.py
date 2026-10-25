import json
import io
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch, MagicMock

import main
import chat_ui
from codex_provider import CodexClient, CodexCLIError, DISABLED_FEATURES, STOP
from google.genai import types
from tools import PROJECT


FAKE = '''#!/usr/bin/env python3
import json, os, sys, time
payload = json.load(sys.stdin)
mode = os.environ.get('FAKE_MODE', 'answer')
with open(os.environ['FAKE_CAPTURE'], 'w') as out:
    json.dump({'payload': payload, 'argv': sys.argv, 'keys_present': [k for k in
        ['OPENAI_API_KEY','CODEX_API_KEY','GROQ_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY'] if k in os.environ]}, out)
def emit(event): print(json.dumps(event), flush=True)
emit({'type': 'thread.started', 'thread_id': 'test-only'})
emit({'type': 'turn.started'})
emit({'type': 'item.completed', 'item': {'type': 'reasoning', 'text': 'PRIVATE-REASONING'}})
if mode == 'timeout': time.sleep(5)
if mode == 'built-in':
    emit({'type': 'item.started', 'item': {'type': 'command_execution', 'command': 'must-not-run'}})
    time.sleep(5)
if mode == 'fail':
    print('fake-secret-credential', file=sys.stderr)
    emit({'type': 'turn.failed', 'error': {'message': 'fake-secret-credential'}})
    sys.exit(1)
answer = {'answer': '已連線。', 'decision_summary': '', 'tool_calls': []}
if mode == 'loop':
    if payload['messages'][-1]['role'] != 'tool':
        folder = next(t for t in payload['available_tools'] if t['function']['name'] == 'list_files')['function']['parameters']['properties']['folder']['enum'][0]
        answer = {'answer': '', 'decision_summary': '【決策摘要】\\n選擇原因：查詢檔案。\\n資訊依據：使用者要求。\\n尚缺資訊：無。',
                  'tool_calls': [{'name': 'list_files', 'arguments_json': json.dumps({'folder': folder})}]}
    else:
        answer['answer'] = '找到範例檔案；僅確認路徑。'
if mode == 'badargs': answer = {'answer': '', 'decision_summary': '', 'tool_calls': [{'name': 'list_files', 'arguments_json': '[]'}]}
if mode == 'unknown': answer = {'answer': '', 'decision_summary': '', 'tool_calls': [{'name': 'run_shell', 'arguments_json': '{}'}]}
if mode == 'mixed': answer = {'answer': '已執行', 'decision_summary': '', 'tool_calls': [{'name': 'list_files', 'arguments_json': '{}'}]}
emit({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': json.dumps(answer)}})
emit({'type': 'turn.completed', 'usage': {'input_tokens': 30, 'output_tokens': 10}})
'''


class CodexProviderTest(unittest.TestCase):
    def setUp(self):
        STOP.clear()
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.executable = Path(self.directory.name) / 'codex-test'
        self.executable.write_text(FAKE)
        self.executable.chmod(0o700)
        self.capture = Path(self.directory.name) / 'capture.json'
        self.environment = patch.dict(os.environ, {'FAKE_CAPTURE': str(self.capture), 'FAKE_MODE': 'answer'})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.addCleanup(STOP.clear)

    def client(self, **kwargs):
        return CodexClient(executable=str(self.executable), model='test-model', **kwargs)

    def test_ui_defaults_to_codex_without_any_api_key(self):
        server = MagicMock()
        server.__enter__.return_value = server
        server.server_port = 8880
        server.serve_forever.side_effect = KeyboardInterrupt()
        with patch.dict(os.environ, {}, clear=True), patch('sys.argv', ['chat_ui.py']), \
                patch('chat_ui.load_dotenv'), patch('chat_ui.ChatServer', return_value=server) as create_server, \
                patch('codex_provider.configured_model', return_value='test-model'), \
                patch('codex_provider.CodexClient') as create_client, patch('sys.stdout', new_callable=io.StringIO):
            chat_ui.main()
            args, kwargs = create_server.call_args
            self.assertEqual(args[0], ('127.0.0.1', 8880))
            self.assertEqual(kwargs['model_label'], 'Codex CLI / test-model')
            args[1](None)
            create_client.assert_called_once_with(timing=None)

    def test_answer_keeps_22_tools_and_history_without_groq_budget_or_provider_keys(self):
        text = '不能刪除的研究條件。' * 1000
        events = []
        with patch.dict(os.environ, {key: 'fake-secret-credential' for key in
                        ('OPENAI_API_KEY','CODEX_API_KEY','GROQ_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY')}):
            with self.client(timing=SimpleNamespace(report=events.append)) as client:
                answer = main.run_conversation(client, text, [])
        self.assertEqual(answer, '已連線。')
        captured = json.loads(self.capture.read_text())
        self.assertEqual(captured['payload']['messages'][-1]['content'], text)
        self.assertEqual(len(captured['payload']['available_tools']), 25)
        self.assertEqual(captured['keys_present'], [])
        self.assertNotIn('PRIVATE-REASONING', '\n'.join(events))
        for feature in DISABLED_FEATURES:
            self.assertIn(feature, captured['argv'])
        self.assertIn('read-only', captured['argv'])
        self.assertIn('--ignore-user-config', captured['argv'])
        self.assertNotIn('--dangerously-bypass-approvals-and-sandbox', captured['argv'])

    def test_cli_contract_defers_to_selected_ui_language_even_with_chinese_history(self):
        for language, instruction in [('en', 'UI language for this turn is English'),
                                      ('zh-Hant', 'UI language for this turn is Traditional Chinese')]:
            with self.subTest(language=language), self.client() as client:
                history = [types.Content(role='user', parts=[types.Part.from_text(text='先前的中文問題')]),
                           types.Content(role='model', parts=[types.Part.from_text(text='先前的中文回答')])]
                main.run_conversation(client, '再給我一次分析參數結果', history, language=language)
                prompt = json.loads(self.capture.read_text())['payload']
                self.assertNotIn('Traditional Chinese answer', prompt['response_contract'])
                self.assertIn('language specified in the system instructions', prompt['response_contract'])
                self.assertIn(instruction, prompt['messages'][0]['content'])

    def test_real_protocol_tool_loop_still_uses_controlled_dispatch_and_matching_ids(self):
        history, events = [], []
        with patch.dict(os.environ, {'FAKE_MODE': 'loop'}), self.client() as client:
            with patch.object(main, 'dispatch_tool', return_value={'files': ['data/example/geno/example.ped']}) as dispatch:
                answer = main.run_conversation(client, '有哪些檔案？', history, progress=events.append)
        dispatch.assert_called_once_with('list_files', {'folder': str(PROJECT)})
        self.assertIn('找到範例檔案', answer)
        call = history[1].parts[1].function_call
        result = history[2].parts[0].function_response
        self.assertEqual(call.id, result.id)
        self.assertTrue(call.id.startswith('codex-'))
        self.assertTrue(any('選擇原因' in event for event in events))

    def test_invalid_or_failed_cli_responses_never_execute_tools_or_expose_raw_errors(self):
        for mode in ('badargs', 'unknown', 'mixed', 'fail', 'built-in'):
            with self.subTest(mode=mode), patch.dict(os.environ, {'FAKE_MODE': mode}), self.client() as client:
                with patch.object(main, 'dispatch_tool') as dispatch:
                    answer = main.run_conversation(client, '查詢', [])
                dispatch.assert_not_called()
                self.assertIn('模型請求失敗', answer)
                self.assertNotIn('fake-secret-credential', answer)
                self.assertIsNone(client.process)

    def test_timeout_and_stop_kill_child_without_replaying_tools(self):
        with patch.dict(os.environ, {'FAKE_MODE': 'timeout'}), self.client(timeout=0.05) as client:
            answer = main.run_conversation(client, '查詢', [])
            self.assertIn('逾時', answer)
            self.assertIsNone(client.process)
        STOP.set()
        with self.client() as client:
            answer = main.run_conversation(client, '查詢', [])
            self.assertIn('已中斷等待模型', answer)
            self.assertIsNone(client.process)


if __name__ == '__main__':
    unittest.main()
