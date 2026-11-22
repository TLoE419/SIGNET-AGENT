"""Exercise the isolated Codex CLI protocol with a local stand-in."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from google.genai import types

from agent.core.conversation import run_conversation
from agent.core.model_timing import ModelRequestTiming
from agent.providers.codex_client import CodexClient, DISABLED_FEATURES, SUMMARY_TOOLS


FAKE_CLI = """
import json, os, pathlib, sys, time

def emit(value):
    print(json.dumps(value), flush=True)

capture.write_text(json.dumps({'messages': json.load(sys.stdin), 'args': sys.argv[1:],
                               'env': list(os.environ), 'cwd': os.getcwd(), 'pid': os.getpid()}))
emit({'type': 'thread.started', 'thread_id': 'unpublished-thread'})
if mode == 'startup-diagnostic':
    emit({'type': 'item.completed', 'item': {'type': 'error', 'message': 'private-startup-diagnostic'}})
emit({'type': 'turn.started'})
emit({'type': 'item.completed', 'item': {'type': 'reasoning', 'text': 'unpublished-reasoning'}})
if mode == 'wait':
    time.sleep(10)
if mode == 'fail':
    print('private-stderr', file=sys.stderr)
    emit({'type': 'turn.failed', 'error': {'message': 'private-provider-detail'}})
    sys.exit(1)
if mode == 'built-in':
    emit({'type': 'item.started', 'item': {'type': 'command_execution', 'command': 'private-command'}})
    time.sleep(10)
emit({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': json.dumps(answer)}})
emit({'type': 'turn.completed'})
"""


class CodexProviderTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.capture = Path(directory.name) / 'capture.json'
        self.executable = Path(directory.name) / 'fake-codex'

    def client(self, *, mode='answer', answer=None, **kwargs):
        self.executable.write_text(
            f'#!{sys.executable}\nimport pathlib\ncapture = pathlib.Path({str(self.capture)!r})\n'
            f'mode = {mode!r}\nanswer = {answer or {"answer": "Connected.", "decision_summary": "", "tool_calls": []}!r}\n'
            + FAKE_CLI,
            encoding='utf-8',
        )
        self.executable.chmod(0o700)
        return CodexClient(executable=str(self.executable), **kwargs)

    def test_cli_receives_safe_summary_in_a_private_workspace_without_app_credentials(self):
        result = types.FunctionResponse(id='test-call', name='get_workspace_report', response={
            'status': 'completed', 'summary': {'rows': 12, 'sample_ids': ['private-sample-id']},
            'stdout_log': 'private-raw-log', 'file': '/private/dataset.tsv',
        })
        history = [types.Content(role='user', parts=[types.Part(function_response=result)])]
        events = []
        timing = ModelRequestTiming()
        with patch.dict(os.environ, {key: 'private-environment' for key in (
            'OPENAI_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'SIGNET_SSH_BROKER', 'SIGNET_SSH_BROKER_TOKEN',
        )}), self.client(timing=timing) as client:
            answer = run_conversation(client, 'Check the run.', history, progress=events.append, http_timing=timing)

        self.assertEqual(answer, 'Connected.')
        captured = json.loads(self.capture.read_text())
        prompt = json.dumps(captured['messages'])
        for private in ('private-sample-id', 'private-raw-log', 'dataset.tsv', 'unpublished-reasoning'):
            self.assertNotIn(private, prompt + '\n'.join(events))
        summary = next(message for message in captured['messages']['messages'] if message['role'] == 'tool')
        self.assertEqual(json.loads(summary['content'])['summary'], {'rows': 12})
        self.assertTrue(all(key in {'PATH', 'TMPDIR', 'NO_COLOR', 'HOME', 'CODEX_HOME', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING'}
                            for key in captured['env']))
        self.assertSetEqual({tool['function']['name'] for tool in captured['messages']['available_tools']}, SUMMARY_TOOLS)
        cwd = Path(captured['cwd'])
        self.assertTrue(cwd.name.startswith('signet-codex-'))
        self.assertFalse(cwd.exists())
        for expected in ('--ignore-user-config', '--ignore-rules', '--strict-config', '--ephemeral',
                         'default_permissions="signet-chat"', 'permissions.signet-chat.network.enabled=false',
                         'permissions.signet-chat.filesystem={":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny"}',
                         'approval_policy="never"', 'mcp_servers={}', 'web_search="disabled"', *DISABLED_FEATURES):
            self.assertIn(expected, captured['args'])
        self.assertNotIn('--sandbox', captured['args'])

    def test_rejects_builtin_tools_and_raw_diagnostics_without_dispatch(self):
        unsafe = {
            'answer': '', 'decision_summary': '',
            'tool_calls': [{'name': 'get_workspace_report',
                            'arguments_json': '{"run_id":"private-actual-run-id","stage":3}'}],
        }
        for mode, response in [('built-in', None), ('fail', None), ('answer', unsafe)]:
            with self.subTest(mode=mode), self.client(mode=mode, answer=response) as client, \
                    patch('agent.core.conversation.dispatch_tool') as dispatch:
                events = []
                answer = run_conversation(client, 'Check.', [], progress=events.append)
                self.assertIn('Model request failed', answer)
                for private in ('private-provider-detail', 'private-command', 'private-stderr', 'private-actual-run-id'):
                    self.assertNotIn(private, answer + '\n'.join(events))
                dispatch.assert_not_called()

    def test_response_can_propose_an_existing_read_only_summary(self):
        response = {'answer': '', 'decision_summary': 'Read the catalog.',
                    'tool_calls': [{'name': 'signet_catalog', 'arguments_json': '{}'}]}
        with self.client(answer=response) as client:
            from agent.core.conversation import config
            result = client.generate_content(model=client.model, contents=[], config=config)
        self.assertEqual(result.text, 'Read the catalog.')
        self.assertEqual((result.function_calls[0].name, result.function_calls[0].args), ('signet_catalog', {}))

    def test_ignores_completed_startup_diagnostic_but_keeps_the_verified_answer(self):
        events = []
        with self.client(mode='startup-diagnostic') as client:
            answer = run_conversation(client, 'Check.', [], progress=events.append)
        self.assertEqual(answer, 'Connected.')
        self.assertNotIn('private-startup-diagnostic', '\n'.join(events))

    def test_cancellation_reaps_the_running_cli_and_no_tool_is_dispatched(self):
        cancelled = threading.Event()
        timing = ModelRequestTiming(cancel_requested=cancelled.is_set)
        answer = []
        history = []
        with self.client(mode='wait', timing=timing) as client, \
                patch('agent.core.conversation.dispatch_tool') as dispatch:
            worker = threading.Thread(target=lambda: answer.append(run_conversation(
                client, 'Stop now.', history, http_timing=timing, cancel_requested=cancelled.is_set)))
            worker.start()
            try:
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline and not self.capture.exists():
                    time.sleep(0.01)
                self.assertTrue(self.capture.exists())
            finally:
                cancelled.set()
                worker.join(3)
            self.assertFalse(worker.is_alive())
            dispatch.assert_not_called()
        self.assertEqual(answer, [''])
        self.assertEqual(history[0].parts[0].text, 'Stop now.')
        with self.assertRaises(ProcessLookupError):
            os.kill(json.loads(self.capture.read_text())['pid'], 0)

    def test_deadline_also_applies_when_the_cli_never_reads_large_input(self):
        self.executable.write_text(f'#!{sys.executable}\nimport time\ntime.sleep(10)\n', encoding='utf-8')
        self.executable.chmod(0o700)
        with CodexClient(executable=str(self.executable), timeout=0.1) as client:
            started = time.monotonic()
            answer = run_conversation(client, 'question ' * 130_000, [])
            self.assertLess(time.monotonic() - started, 3)
        self.assertIn('Codex CLI response timed out', answer)
