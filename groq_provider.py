"""Translate Groq chat completions into the existing controlled conversation loop."""
import inspect
import json
import math
import os
import threading
import time
from types import SimpleNamespace

import httpx
from google.genai import errors, types
from tools import PROJECT
from context_budget import compact_evidence, check_budget, ContextBudgetError

GROQ_MODEL = 'qwen/qwen3.8-27b'


def rate_limit_delay(response):
    if response.status_code != 429:
        return None
    try:
        message = response.json().get('error', {}).get('message', '')
        if isinstance(message, str) and 'request too large' in message.lower():
            return None
    except (ValueError, TypeError, AttributeError):
        pass
    return 30


class RequestPacer:
    """Share only 429 cooldowns across clients and browser conversations in this process."""
    def __init__(self, clock=None, sleep=None):
        self.clock = clock or time.monotonic
        self.sleep = sleep or time.sleep
        self.next_send = 0
        self.lock = threading.Lock()
        self.stopped = threading.Event()

    def defer(self, seconds):
        with self.lock:
            self.next_send = max(self.next_send, self.clock() + seconds)

    def wait(self, report=None):
        with self.lock:
            while True:
                if self.stopped.is_set():
                    raise KeyboardInterrupt()
                remaining = self.next_send - self.clock()
                if remaining <= 0:
                    return
                if report is not None:
                    report(f'額度等待：收到 429，剩餘 {math.ceil(remaining)} 秒後重送；已完成工具不重跑。')
                self.sleep(min(1, remaining))


REQUEST_PACER = RequestPacer()


def tool_schema(function):
    kinds = {str:'string', int:'integer', float:'number', bool:'boolean'}
    properties, required = {}, []
    for name, parameter in inspect.signature(function).parameters.items():
        properties[name] = ({'type':'array', 'items':{'type':'string'}}
                            if parameter.annotation == list[str] else {'type': kinds[parameter.annotation]})
        if parameter.default is inspect.Parameter.empty:
            required.append(name)
        else:
            properties[name]['default'] = parameter.default
    if function.__name__ == 'list_files':
        properties['folder']['enum'] = [str(PROJECT)]
    return {'type':'function', 'function':{
        'name':function.__name__, 'description':(inspect.getdoc(function) or '').split('\n\n')[0],
        'parameters':{'type':'object', 'properties':properties, 'required':required}}}


def groq_messages(contents, instruction):
    messages = [{'role':'system', 'content':instruction}]
    evidence_seen = {}
    for content in contents:
        parts = content.parts or []
        public = '\n'.join(part.text for part in parts if part.text and not part.thought)
        calls = [part.function_call for part in parts if part.function_call]
        results = [part.function_response for part in parts if part.function_response]
        if content.role == 'model':
            # Public summaries are already visible in the UI; native calls retain the protocol context.
            if calls:
                public = ''
            message = {'role':'assistant', 'content':public or None}
            if calls:
                message['tool_calls'] = [{'id':call.id, 'type':'function', 'function':{
                    'name':call.name, 'arguments':json.dumps(call.args or {}, ensure_ascii=False)}} for call in calls]
            messages.append(message)
        else:
            if public:
                messages.append({'role':'user', 'content':public})
            for result in results:
                evidence = result.response
                if result.name == 'list_files' and 'files' in evidence:
                    evidence = {**evidence, '_evidence_scope':
                                'Paths only. Contents, format, completeness and emptiness were NOT checked.'}
                if result.name == 'signet_catalog' and 'scripts' in evidence:
                    # File-by-file hashes dominate the free quota; keep full evidence in local history.
                    evidence = {key:value for key, value in evidence.items() if key != 'scripts'}
                    evidence = {**evidence, 'scripts_omitted':True, 'full_inventory':'signet_inventory.json'}
                evidence = compact_evidence(evidence)
                encoded = json.dumps(evidence, ensure_ascii=False, separators=(',', ':'))
                key = (result.name, encoded)
                if key in evidence_seen:
                    encoded = json.dumps({'same_result_as_message': evidence_seen[key]}, separators=(',', ':'))
                else:
                    evidence_seen[key] = len(messages)
                messages.append({'role':'tool', 'tool_call_id':result.id,
                                 'content':encoded})
    if any('same_result_as_message' in (message.get('content') or '') or '_path_prefixes' in (message.get('content') or '')
           or 'files_by_directory' in (message.get('content') or '') for message in messages[1:]):
        messages[0]['content'] += (
            ' Wire encoding: _path_prefixes maps aliases to full path prefixes; expand them exactly. '
            'files_by_directory lists ALL files as directory + / + filename, sorted globally, not a sample. '
            'same_files_as reuses the filename list of another directory; keep the new directory prefix. '
            'same_result_as_message refers to identical earlier tool evidence by zero-based message index; '
            'reuse that evidence, never repeat the operation. No file contents were validated by listing paths.')
    return messages


class GroqClient:
    def __init__(self, api_key, timing=None, model=None, transport=None, pacer=None):
        self.model = model or os.environ.get('GROQ_MODEL', GROQ_MODEL)
        self.models = self
        self.timing = timing
        self.pacer = pacer if pacer is not None else REQUEST_PACER
        self.http = httpx.Client(base_url='https://api.groq.com/openai/v1/',
                                 headers={'Authorization':f'Bearer {api_key}'},
                                 timeout=60, transport=transport,
                                 **(timing.client_args() if timing else {}))

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.http.close()

    def generate_content(self, *, model, contents, config):
        body = {
            'model':self.model, 'messages':groq_messages(contents, config.system_instruction),
            'max_completion_tokens':768,
            'reasoning_effort':'none' if self.model.startswith('qwen/') else 'low',
        }
        if config.tools:
            body.update(tools=[tool_schema(function) for function in config.tools], parallel_tool_calls=False)
        answer_instruction = {'role': 'user', 'content':
            '[Application response-format instruction; not a new research decision.] '
            'Answer the latest research question directly using available evidence. '
            'Do not write XML, tool_call/function/parameter tags or tool requests. '
            'If information is missing, say so; do not invent it or claim any new operation.'}
        if not config.tools:
            body['messages'].append(answer_instruction)
        try:
            count = check_budget(body, self.model)
        except ContextBudgetError:
            if not body.get('tools'):
                raise
            # Preserve every message and result; only remove optional new-call capability.
            body.pop('tools')
            body.pop('parallel_tool_calls', None)
            body['messages'][0]['content'] += (
                ' No new tools are available in this request because of the input budget. '
                'Answer the current question from existing evidence only. If evidence is insufficient '
                'or a new operation is required, state that limitation; never invent inputs, '
                'claim execution or treat proposed defaults as user approval.')
            body['messages'].append(answer_instruction)
            count = check_budget(body, self.model)
            if self.timing is not None and self.timing.report is not None:
                self.timing.report('輸入精簡：保留全部對話與工具證據，本輪改為文字整理，不啟動新工具。')
        if self.timing is not None and self.timing.report is not None:
            self.timing.report(f'輸入大小檢查：精簡後估算 {count} 詞元；安全預算 5200。完整紀錄保留於本機。')
        # A rejected model request has no tool execution; resend that request only.
        while True:
            report = self.timing.report if self.timing is not None else None
            self.pacer.wait(report)
            response = self.http.post('chat/completions', json=body)
            delay = rate_limit_delay(response)
            if delay is None:
                break
            response.close()
            if report is not None:
                report('額度等待：額度仍不足，30 秒後重送同一份模型請求；已完成工具不重跑。')
            self.pacer.defer(delay)
        if response.is_error:
            try:
                explanation = response.json().get('error', {}).get('message', '')
            except (ValueError, AttributeError):
                explanation = ''
            status = {400:'INVALID_ARGUMENT', 401:'UNAUTHENTICATED', 403:'PERMISSION_DENIED',
                      404:'NOT_FOUND', 413:'REQUEST_TOO_LARGE', 429:'RESOURCE_EXHAUSTED', 500:'INTERNAL', 503:'UNAVAILABLE'}
            raise errors.APIError(response.status_code, {'error':{
                'status':status.get(response.status_code, 'UNKNOWN'),
                'message':explanation if isinstance(explanation, str) else ''}})
        payload = response.json()
        choice = payload['choices'][0]
        message = choice['message']
        allowed = {tool['function']['name'] for tool in body.get('tools', [])}
        if any(call.get('function', {}).get('name') not in allowed for call in message.get('tool_calls') or []):
            raise ValueError('Model requested a tool not offered in this request; no tools were executed.')
        partial_text = (choice.get('finish_reason') == 'length' and message.get('content')
                        and not message.get('tool_calls'))
        if choice.get('finish_reason') not in ('stop', 'tool_calls') and not partial_text:
            raise ValueError('Incomplete model response; no tools were executed.')
        text = message.get('content') or ''
        if partial_text:
            text += '\n\n> 本次回答已達長度上限，以上僅為部分說明。可指定想了解的階段繼續詢問。'
        parts = [types.Part.from_text(text=text)] if text else []
        identifiers = set()
        for call in message.get('tool_calls') or []:
            arguments = json.loads(call['function']['arguments'])
            identifier = call['id']
            if not isinstance(arguments, dict) or not identifier or identifier in identifiers:
                raise ValueError('Invalid tool arguments or identifiers; no tools were executed.')
            identifiers.add(identifier)
            parts.append(types.Part(function_call=types.FunctionCall(
                id=identifier, name=call['function']['name'], args=arguments)))
        content = types.Content(role='model', parts=parts)
        if not parts:
            raise ValueError('Empty model response; no tools were executed.')
        usage = payload.get('usage') or {}
        return SimpleNamespace(text=text,
            function_calls=[part.function_call for part in parts if part.function_call],
            candidates=[SimpleNamespace(content=content)],
            usage_metadata=SimpleNamespace(prompt_token_count=usage.get('prompt_tokens'),
                                           candidates_token_count=usage.get('completion_tokens')))
