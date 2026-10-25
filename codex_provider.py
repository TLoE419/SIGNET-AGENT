"""Use the signed-in Codex CLI as a decision-only model for controlled SIGNET tools."""
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import tomllib
from types import SimpleNamespace
import uuid

from google.genai import types

from groq_provider import groq_messages, tool_schema

STOP = threading.Event()
DISABLED_FEATURES = ('shell_tool', 'unified_exec', 'apps', 'plugins', 'computer_use',
                     'browser_use', 'multi_agent', 'memories', 'view_image', 'code_mode_host')


class CodexCLIError(RuntimeError):
    def __init__(self, message):
        self.public_message = message
        super().__init__(message)


def configured_model():
    if os.environ.get('SIGNET_CODEX_MODEL'):
        return os.environ['SIGNET_CODEX_MODEL']
    path = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'config.toml'
    try:
        value = tomllib.loads(path.read_text()).get('model')
        return value if isinstance(value, str) else None
    except (OSError, ValueError):
        return None


def response_schema(names):
    return {'type': 'object', 'additionalProperties': False,
            'properties': {
                'answer': {'type': 'string'}, 'decision_summary': {'type': 'string'},
                'tool_calls': {'type': 'array', 'maxItems': 8, 'items': {
                    'type': 'object', 'additionalProperties': False,
                    'properties': {'name': {'type': 'string', 'enum': names or ['__no_tools_available__']},
                                   'arguments_json': {'type': 'string'}},
                    'required': ['name', 'arguments_json']}}},
            'required': ['answer', 'decision_summary', 'tool_calls']}


class CodexClient:
    transport = 'cli'

    def __init__(self, timing=None, model=None, executable=None, timeout=180):
        self.executable = executable or shutil.which('codex')
        if not self.executable:
            raise CodexCLIError('找不到 Codex 命令列，請先安裝並執行 codex login。')
        self.selected_model = model or configured_model()
        self.model = self.selected_model or 'Codex 預設模型'
        self.models = self
        self.timing = timing
        self.timeout = timeout
        self.process = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self._stop_process()

    def _stop_process(self):
        process = self.process
        if process is not None:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            process.wait()
            for pipe in (process.stdin, process.stdout):
                if pipe is not None and not pipe.closed:
                    pipe.close()
            self.process = None

    def _report(self, message):
        report = getattr(self.timing, 'report', None)
        if report:
            report(message)

    def generate_content(self, *, model, contents, config):
        functions = {function.__name__: function for function in config.tools or []}
        prompt = {
            'response_contract': (
                'You are the decision-only backend for a SIGNET chat UI. Do not use any CLI, '
                'shell, filesystem, browser, plugin, MCP or built-in tools. Only return the '
                'schema-constrained object. Available SIGNET tools below are descriptions, '
                'not tools for you to execute. The host validates and executes requested calls. '
                'Either set answer to a concise answer in the language specified in the system instructions '
                '(regardless of the language of the user message or conversation history) and tool_calls=[], '
                'or set answer="" and request up to eight named tools with arguments_json '
                'containing a JSON object. For calls, decision_summary is a short public '
                'explanation in that same requested language, never private reasoning. '
                'Never put XML tool tags in answer. '
                'Tool evidence is authoritative; prior assistant proposals are not user approval.'),
            'messages': groq_messages(contents, config.system_instruction),
            'available_tools': [tool_schema(function) for function in functions.values()],
        }
        with tempfile.TemporaryDirectory(prefix='signet-codex-') as directory, tempfile.TemporaryFile() as errors:
            schema = Path(directory) / 'response.schema.json'
            schema.write_text(json.dumps(response_schema(list(functions))))
            command = [self.executable, 'exec', '--ignore-user-config', '--sandbox', 'read-only',
                       '--skip-git-repo-check', '--ephemeral', '--json', '--color', 'never',
                       '--cd', directory, '--output-schema', str(schema)]
            if self.selected_model:
                command.extend(['--model', self.selected_model])
            for feature in DISABLED_FEATURES:
                command.extend(['--disable', feature])
            command.append('-')
            # Use existing CLI sign-in, never a provider key loaded from the project's .env.
            environment = {key: value for key, value in os.environ.items() if key not in {
                'OPENAI_API_KEY', 'CODEX_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'}}
            final, usage, completed = None, {}, False
            started = time.monotonic()
            self._report('Codex 命令列：使用既有登入，僅產生回答或受控工具請求。')
            try:
                self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                                stderr=errors, cwd=directory, env=environment,
                                                start_new_session=True)
                self.process.stdin.write(json.dumps(prompt, ensure_ascii=False).encode())
                self.process.stdin.close()
                buffer = b''
                with selectors.DefaultSelector() as selector:
                    selector.register(self.process.stdout, selectors.EVENT_READ)
                    while selector.get_map():
                        if STOP.is_set():
                            raise KeyboardInterrupt()
                        if time.monotonic() - started > self.timeout:
                            raise CodexCLIError('Codex 命令列等待逾時；已停止本次模型請求，未執行新工具。')
                        if not selector.select(timeout=0.5):
                            continue
                        chunk = os.read(self.process.stdout.fileno(), 65536)
                        if not chunk:
                            selector.unregister(self.process.stdout)
                            break
                        buffer += chunk
                        if len(buffer) > 4 * 1024 * 1024:
                            raise CodexCLIError('Codex 回覆格式異常；未執行新工具。')
                        while b'\n' in buffer:
                            line, buffer = buffer.split(b'\n', 1)
                            event = json.loads(line)
                            if not isinstance(event, dict):
                                raise ValueError('Invalid event')
                            kind = event.get('type')
                            if kind == 'turn.started':
                                self._report('Codex 命令列：正在處理目前問題。')
                            elif kind == 'turn.failed':
                                raise CodexCLIError('Codex 回合失敗；請確認命令列登入與帳號用量，未執行新工具。')
                            elif kind == 'turn.completed':
                                completed, usage = True, event.get('usage') or {}
                            elif kind in ('item.started', 'item.completed'):
                                item = event.get('item') or {}
                                if item.get('type') == 'agent_message' and kind == 'item.completed':
                                    final = item.get('text')
                                elif item.get('type') not in ('agent_message', 'reasoning', 'todo_list', 'error'):
                                    raise CodexCLIError('Codex 嘗試使用未允許的內建工具；已停止，本次不分派 SIGNET 工具。')
                if buffer.strip():
                    raise ValueError('Incomplete event stream')
                if self.process.wait(timeout=5) != 0 or not completed or not final:
                    raise CodexCLIError('Codex 命令列未完成有效回覆；請用 codex login status 檢查登入。')
                result = self._response(final, functions, usage)
                self._report(f'Codex 命令列：結構化回覆已驗證（{time.monotonic()-started:.2f} 秒）。')
                return result
            except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
                raise CodexCLIError('Codex 命令列傳輸或回覆格式無效；未執行新工具。') from exc
            finally:
                self._stop_process()

    @staticmethod
    def _response(text, functions, usage):
        value = json.loads(text)
        if not isinstance(value, dict) or set(value) != {'answer', 'decision_summary', 'tool_calls'}:
            raise ValueError('Invalid response object')
        answer, summary, calls = value['answer'], value['decision_summary'], value['tool_calls']
        if (not isinstance(answer, str) or not isinstance(summary, str) or not isinstance(calls, list)
                or len(calls) > 8 or bool(answer.strip()) == bool(calls)):
            raise ValueError('Invalid answer/call combination')
        parts = [types.Part(text=summary if calls else answer)]
        for call in calls:
            if (not isinstance(call, dict) or set(call) != {'name', 'arguments_json'}
                    or not isinstance(call['name'], str) or call['name'] not in functions
                    or not isinstance(call['arguments_json'], str)):
                raise ValueError('Unrecognized tool request')
            arguments = json.loads(call['arguments_json'])
            if not isinstance(arguments, dict):
                raise ValueError('Arguments must be an object')
            parts.append(types.Part(function_call=types.FunctionCall(
                id='codex-' + uuid.uuid4().hex, name=call['name'], args=arguments)))
        content = types.Content(role='model', parts=parts)
        return SimpleNamespace(text=summary if calls else answer,
                               function_calls=[part.function_call for part in parts if part.function_call],
                               candidates=[SimpleNamespace(content=content)],
                               usage_metadata=SimpleNamespace(prompt_token_count=usage.get('input_tokens'),
                                                              candidates_token_count=usage.get('output_tokens')))
