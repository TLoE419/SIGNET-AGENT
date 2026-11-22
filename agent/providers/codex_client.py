"""Use Codex only for text and proposed calls to SIGNET's summary tools."""
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import subprocess
import tempfile
import time
from types import SimpleNamespace
import uuid

from google.genai import types

from .groq_client import groq_messages, tool_schema


DISABLED_FEATURES = (
    'shell_tool', 'unified_exec', 'shell_snapshot', 'apps', 'plugins', 'remote_plugin',
    'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'image_generation',
    'multi_agent', 'multi_agent_v2', 'memories', 'hooks', 'view_image', 'code_mode_host',
    'skill_search', 'skill_mcp_dependency_install', 'request_permissions_tool', 'tool_suggest',
)
SUMMARY_TOOLS = {
    'signet_catalog', 'check_hpc_environment', 'get_workspace_stage',
    'get_workspace_report', 'get_workspace_validation',
}
MAX_EVENT_BYTES = 4 * 1024 * 1024


class CodexCLIError(RuntimeError):
    """A fixed provider message safe to show without forwarding CLI diagnostics."""


def _executable():
    return shutil.which('codex') or next(
        (path for path in ('/opt/homebrew/bin/codex', '/usr/local/bin/codex') if os.access(path, os.X_OK)), None)


def _child_environment(directory):
    environment = {'PATH': '/usr/bin:/bin', 'TMPDIR': str(directory), 'NO_COLOR': '1'}
    # Existing CLI sign-in lives under the OS user's home or their configured Codex directory.
    environment.update({key: os.environ[key] for key in ('HOME', 'CODEX_HOME', 'LANG', 'LC_ALL') if key in os.environ})
    return environment


def _command(executable, directory, schema):
    command = [
        executable, 'exec', '--ignore-user-config', '--ignore-rules', '--strict-config',
        '--skip-git-repo-check', '--ephemeral', '--json', '--color', 'never',
        '--cd', str(directory), '--output-schema', str(schema),
        '-c', 'default_permissions="signet-chat"',
        '-c', 'permissions.signet-chat.filesystem={":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny"}',
        '-c', 'permissions.signet-chat.network.enabled=false',
        '-c', 'approval_policy="never"',
        '-c', 'project_doc_max_bytes=0',
        '-c', 'mcp_servers={}',
        '-c', 'web_search="disabled"',
        '-c', 'shell_environment_policy.inherit="none"',
        '-c', 'features.skip_host_skill_discovery=true',
    ]
    for feature in DISABLED_FEATURES:
        command.extend(('--disable', feature))
    return [*command, '-']


def _response_schema(names):
    return {
        'type': 'object', 'additionalProperties': False,
        'properties': {
            'answer': {'type': 'string'}, 'decision_summary': {'type': 'string'},
            'tool_calls': {'type': 'array', 'maxItems': 8, 'items': {
                'type': 'object', 'additionalProperties': False,
                'properties': {
                    'name': {'type': 'string', 'enum': list(names) or ['__no_tools_available__']},
                    'arguments_json': {'type': 'string'},
                },
                'required': ['name', 'arguments_json'],
            }},
        },
        'required': ['answer', 'decision_summary', 'tool_calls'],
    }


class CodexClient:
    model = 'Codex CLI'
    transport = 'cli'

    def __init__(self, timing=None, *, stopped=None, executable=None, timeout=120):
        self.executable = executable or _executable()
        self.models = self
        self.timing = timing
        self.stopped = stopped
        self.timeout = timeout

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def _cancelled(self):
        cancel = getattr(self.timing, 'cancel_requested', None)
        return (self.stopped is not None and self.stopped.is_set()) or (cancel is not None and cancel())

    def _report(self, message):
        report = getattr(self.timing, 'report', None)
        if report is not None:
            report(message)

    def generate_content(self, *, model, contents, config):
        if self._cancelled():
            raise KeyboardInterrupt()
        if not self.executable:
            raise CodexCLIError('Install and sign in to the Codex CLI before retrying.')
        functions = {fn.__name__: fn for fn in config.tools or [] if fn.__name__ in SUMMARY_TOOLS}
        prompt = {
            'response_contract': (
                'Return one JSON object matching the response schema. Choose either a final answer '
                'with no tool calls, or an empty answer and a short public decision summary with '
                'proposed SIGNET summary calls. The host validates and runs those calls. '
                'Only tools listed in available_tools may be proposed. '
                'Use only the supplied conversation, summaries and opaque modelref identifiers. '
                'Do not use CLI tools, files, shell commands, sign-in information or network resources.'),
            'messages': groq_messages(contents, config.system_instruction),
            'available_tools': [tool_schema(fn) for fn in functions.values()],
        }
        with tempfile.TemporaryDirectory(prefix='signet-codex-') as workspace, tempfile.TemporaryFile() as incoming:
            directory = Path(workspace).resolve()
            schema = directory / 'response.schema.json'
            schema.write_text(json.dumps(_response_schema(functions)), encoding='utf-8')
            incoming.write(json.dumps(prompt, ensure_ascii=False).encode())
            incoming.seek(0)
            self._report('Waiting for an isolated Codex CLI response.')
            if self._cancelled():
                raise KeyboardInterrupt()
            try:
                with subprocess.Popen(_command(self.executable, directory, schema), stdin=incoming,
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=directory,
                                      env=_child_environment(directory), start_new_session=True) as process:
                    try:
                        return self._response(self._read_events(process), functions)
                    finally:
                        if process.poll() is None:
                            try:
                                os.killpg(process.pid, signal.SIGKILL)
                            except ProcessLookupError:
                                pass
            except (OSError, ValueError, subprocess.TimeoutExpired) as error:
                raise CodexCLIError('The Codex CLI response could not be verified. Check Codex CLI installation and sign-in.') from error

    def _read_events(self, process):
        buffer, final, completed = b'', None, False
        deadline = time.monotonic() + self.timeout
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                if self._cancelled():
                    raise KeyboardInterrupt()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise CodexCLIError('The Codex CLI response timed out. Try again.')
                if not selector.select(timeout=min(0.2, remaining)):
                    continue
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    break
                buffer += chunk
                if len(buffer) > MAX_EVENT_BYTES:
                    raise ValueError('Oversized event')
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    event = json.loads(line)
                    if not isinstance(event, dict):
                        raise ValueError('Invalid event')
                    match event.get('type'):
                        case 'thread.started' | 'turn.started':
                            pass
                        case 'turn.failed' | 'error':
                            raise CodexCLIError('Codex CLI could not complete the request. Check CLI sign-in, usage and version.')
                        case 'turn.completed':
                            completed = True
                        case 'item.started' | 'item.updated' | 'item.completed':
                            item = event.get('item')
                            if not isinstance(item, dict):
                                raise ValueError('Invalid Codex CLI item')
                            if event['type'] == 'item.completed' and item.get('type') == 'error':
                                # Startup can report ignored config or skills without failing the turn.
                                continue
                            if item.get('type') not in ('agent_message', 'reasoning'):
                                raise CodexCLIError('The Codex CLI attempted an unavailable action. The response was discarded.')
                            if item.get('type') == 'agent_message' and event['type'] == 'item.completed':
                                final = item.get('text')
                        case _:
                            raise ValueError('Unrecognized Codex CLI event')
        if self._cancelled():
            raise KeyboardInterrupt()
        if buffer.strip() or process.wait(timeout=max(0, min(1, deadline - time.monotonic()))) != 0 or not completed or not isinstance(final, str):
            raise CodexCLIError('Codex CLI did not return a verified response. Check your CLI version and sign-in.')
        return final

    @staticmethod
    def _response(text, functions):
        value = json.loads(text)
        if not isinstance(value, dict) or set(value) != {'answer', 'decision_summary', 'tool_calls'}:
            raise ValueError('Invalid response object')
        answer, summary, calls = value['answer'], value['decision_summary'], value['tool_calls']
        if (not isinstance(answer, str) or not isinstance(summary, str) or not isinstance(calls, list)
                or len(calls) > 8 or bool(answer.strip()) == bool(calls)):
            raise ValueError('Invalid answer/call combination')
        output = summary if calls else answer
        parts = [types.Part.from_text(text=output)]
        tool_calls = []
        for call in calls:
            if (not isinstance(call, dict) or set(call) != {'name', 'arguments_json'}
                    or not isinstance(call['name'], str) or call['name'] not in functions
                    or not isinstance(call['arguments_json'], str)):
                raise ValueError('Unrecognized tool request')
            arguments = json.loads(call['arguments_json'])
            if not isinstance(arguments, dict):
                raise ValueError('Arguments must be an object')
            for key in ('run_id', 'dataset_id'):
                if key in arguments and not (isinstance(arguments[key], str)
                                              and re.fullmatch(r'modelref-[a-f0-9]{32}', arguments[key])):
                    raise ValueError('Invalid workspace reference')
            tool_calls.append(types.FunctionCall(id='codex-' + uuid.uuid4().hex, name=call['name'], args=arguments))
            parts.append(types.Part(function_call=tool_calls[-1]))
        return SimpleNamespace(text=output, function_calls=tool_calls,
                               candidates=[SimpleNamespace(content=types.Content(role='model', parts=parts))])
