import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, call, patch

import httpx
from google import genai
from google.genai import errors, types

import agent.core.conversation as main
from agent.core.model_timing import ModelRequestTiming
from test_chat import response


FALLBACK = 'gemini-3.5-flash-lite'


def unavailable(code=503):
    return errors.APIError(code, {'error': {'status': 'UNAVAILABLE', 'message': 'controlled failure'}})


def client_for(*outcomes, **attributes):
    generate = Mock(side_effect=outcomes)
    return SimpleNamespace(models=SimpleNamespace(generate_content=generate), **attributes), generate


class GeminiFallbackTest(unittest.TestCase):
    def test_actual_sdk_reuses_request_and_reports_both_model_attempts(self):
        requests = []

        def handler(request):
            requests.append(request)
            if len(requests) == 1:
                return httpx.Response(503, json={'error': {'code': 503, 'status': 'UNAVAILABLE',
                                                         'message': 'private-key private-question'}})
            return httpx.Response(200, json={'candidates': [{'content': {'role': 'model',
                                                'parts': [{'text': '完成。'}]}}]})

        events, history = [], []
        timing = ModelRequestTiming()
        options = types.HttpOptions(retry_options=types.HttpRetryOptions(attempts=1),
                                    client_args={**timing.client_args(), 'transport': httpx.MockTransport(handler)})
        with genai.Client(api_key='private-key', http_options=options) as client:
            answer = main.run_conversation(client, 'private-question', history,
                                           progress=events.append, http_timing=timing)
        self.assertEqual([r.url.path.split('/')[-1] for r in requests],
                         [main.MODEL + ':generateContent', FALLBACK + ':generateContent'])
        self.assertEqual(json.loads(requests[0].content), json.loads(requests[1].content))
        self.assertIn('完成。', answer)
        self.assertIn(FALLBACK, answer)
        self.assertEqual(len(history), 2)
        self.assertEqual(sum('觀測到 1 次 HTTP 嘗試' in e for e in events), 2)
        self.assertFalse(timing.active)
        for private in ('private-key', 'private-question'):
            self.assertNotIn(private, answer + '\n'.join(events))

    def test_fallback_after_tool_keeps_results_signatures_and_subsequent_model(self):
        first_call = types.FunctionCall(id='first', name='get_signet_settings', args={})
        second_call = types.FunctionCall(id='second', name='signet_catalog', args={})
        selected = response(calls=[first_call])
        client, generate = client_for(selected, unavailable(), response(calls=[second_call]), response('回答。'))
        history = []
        with patch.object(main, 'dispatch_tool', return_value={'status': 'ok', 'value': 7}) as dispatch:
            answer = main.run_conversation(client, '查看狀態', history)
        self.assertIn('回答。', answer)
        self.assertEqual(dispatch.call_args_list, [call('get_signet_settings', {}), call('signet_catalog', {})])
        self.assertEqual([c.kwargs['model'] for c in generate.call_args_list],
                         [main.MODEL, main.MODEL, FALLBACK, FALLBACK])
        self.assertEqual(len(history), 6)
        self.assertIs(history[1], selected.candidates[0].content)
        self.assertEqual(history[1].parts[0].thought_signature, b'original-signature')
        self.assertEqual(history[2].parts[0].function_response.id, 'first')
        self.assertEqual(history[2].parts[0].function_response.response['value'], 7)

    def test_both_models_failing_stops_after_one_fallback(self):
        client, generate = client_for(unavailable(), unavailable(504))
        history = []
        answer = main.run_conversation(client, '需求', history)
        self.assertEqual(generate.call_count, 2)
        self.assertIn(FALLBACK, answer)
        self.assertIn('504', answer)
        self.assertEqual(len(history), 1)

    def test_service_statuses_and_transport_timeouts_can_fall_back(self):
        for error in [unavailable(c) for c in (500, 502, 503, 504)] + [httpx.ReadTimeout('private timeout')]:
            with self.subTest(error=type(error).__name__, code=getattr(error, 'code', None)):
                client, generate = client_for(error, response('完成。'))
                answer = main.run_conversation(client, '需求', [])
                self.assertIn('完成。', answer)
                self.assertEqual(generate.call_args.kwargs['model'], FALLBACK)
                self.assertNotIn('private timeout', answer)

    def test_request_auth_quota_and_unexpected_errors_do_not_fall_back(self):
        for error in [unavailable(c) for c in (400, 401, 403, 404, 413, 429)] + [RuntimeError('private')]:
            with self.subTest(error=type(error).__name__, code=getattr(error, 'code', None)):
                client, generate = client_for(error)
                answer = main.run_conversation(client, '需求', [])
                self.assertEqual(generate.call_count, 1)
                self.assertNotIn(FALLBACK, answer)
                self.assertNotIn('private', answer)

    def test_other_providers_and_models_are_unchanged(self):
        for attributes in ({'model': 'other-model'}, {'model': main.MODEL, 'transport': 'cli'}):
            client, generate = client_for(unavailable(), **attributes)
            main.run_conversation(client, '需求', [])
            self.assertEqual(generate.call_count, 1)

    def test_primary_success_has_no_notice_and_next_turn_retries_primary(self):
        client, generate = client_for(unavailable(), response('第一次。'), response('第二次。'))
        history = []
        self.assertIn(FALLBACK, main.run_conversation(client, '需求', history))
        answer = main.run_conversation(client, '繼續', history)
        self.assertEqual(answer, '第二次。')
        self.assertEqual(generate.call_args.kwargs['model'], main.MODEL)

    def test_english_ui_gets_english_notice(self):
        client, _ = client_for(unavailable(), response('Done.'))
        answer = main.run_conversation(client, 'request', [], language='en')
        self.assertIn(FALLBACK, answer)
        self.assertIn('fallback', answer.lower())
        self.assertNotIn('切換', answer)

    def test_fallback_does_not_reset_tool_budget(self):
        tool_call = types.FunctionCall(id='check', name='signet_catalog', args={})
        client, generate = client_for(response(calls=[tool_call]), unavailable(),
                                     *[response(calls=[tool_call]) for _ in range(4)])
        with patch.object(main, 'dispatch_tool', return_value={'status': 'ok'}) as dispatch:
            answer = main.run_conversation(client, '需求', [])
        self.assertEqual(dispatch.call_count, main.MAX_TOOL_ROUNDS)
        self.assertEqual(generate.call_count, main.MAX_TOOL_ROUNDS + 2)
        self.assertIn('上限', answer)
        self.assertIn(FALLBACK, answer)


if __name__ == '__main__':
    unittest.main()
