import json
import unittest
from unittest.mock import patch

import httpx
from google.genai import types

import main
from groq_provider import GROQ_MODEL, GroqClient, RequestPacer, groq_messages, rate_limit_delay, tool_schema
from signet_tools import SIGNET_TOOLS, signet_catalog
from tools import PROJECT


def completion(text=None, calls=None, finish=None):
    return {'choices':[{'finish_reason':finish or ('tool_calls' if calls else 'stop'),
                        'message':{'content':text, 'tool_calls':calls or []}}],
            'usage':{'prompt_tokens':20, 'completion_tokens':10}}


def call(arguments='{}', identifier='call-1'):
    return {'id':identifier, 'type':'function',
            'function':{'name':'signet_catalog', 'arguments':arguments}}


class GroqTest(unittest.TestCase):
    def test_over_budget_declarations_fall_back_to_evidence_only_without_losing_history(self):
        text = '既有研究條件：全部染色體，尚未同意品質門檻。' * 200
        contents = [types.Content(role='user', parts=[types.Part(text=text)])]
        with self.client([(200, completion('根據現有證據回答。'))]) as client:
            result = client.generate_content(model=GROQ_MODEL, contents=contents, config=main.config)
        self.assertEqual(result.text, '根據現有證據回答。')
        self.assertNotIn('tools', self.requests[0])
        self.assertEqual(self.requests[0]['messages'][1]['content'], text)
        self.assertIn('No new tools', self.requests[0]['messages'][0]['content'])
        self.assertEqual(contents[0].parts[0].text, text)

    def test_evidence_only_fallback_cannot_execute_a_hallucinated_tool(self):
        text = '既有研究條件：全部染色體，尚未同意品質門檻。' * 200
        with self.client([(200, completion(calls=[call()]))]) as client:
            with patch.object(main, 'dispatch_tool') as dispatch:
                answer = main.run_conversation(client, text, [])
        dispatch.assert_not_called()
        self.assertIn('模型請求失敗', answer)

    def test_budget_stops_before_network_and_preserves_long_user_conditions(self):
        conditions = '研究條件不能刪除：甲乙丙丁戊己庚辛壬癸。' * 2000
        history = []
        with self.client([]) as client:
            answer = main.run_conversation(client, conditions, history)
        self.assertEqual(self.requests, [])
        self.assertIn('未送出模型請求', answer)
        self.assertNotIn('輸入「繼續」', answer)
        self.assertEqual(history[0].parts[0].text, conditions)

    def test_large_tool_result_stops_without_replaying_or_losing_evidence(self):
        result = {'status': 'failed', 'executed': 'unknown',
                  'error': '必要的完整錯誤證據，不能截斷。' * 2000}
        history = []
        with self.client([(200, completion(calls=[call()]))]) as client:
            with patch.object(main, 'dispatch_tool', return_value=result) as dispatch:
                answer = main.run_conversation(client, '查詢', history)
        self.assertIn('未送出模型請求', answer)
        self.assertEqual(len(self.requests), 1)
        dispatch.assert_called_once()
        self.assertEqual(history[-1].parts[0].function_response.response, result)

    def test_repeated_evidence_uses_a_reference_but_changed_states_remain(self):
        history = [types.Content(role='user', parts=[types.Part(text='只查看，不執行')])]
        for index, result in enumerate([{'status': 'failed', 'executed': 'unknown'},
                                        {'status': 'failed', 'executed': 'unknown'},
                                        {'status': 'prepared', 'executed': False}]):
            history.extend([
                types.Content(role='model', parts=[types.Part(function_call=types.FunctionCall(
                    id=str(index), name='get_signet_settings', args={'run_id': 'demo'}))]),
                types.Content(role='user', parts=[types.Part(function_response=types.FunctionResponse(
                    id=str(index), name='get_signet_settings', response=result))]),
            ])
        sent = groq_messages(history, 'rules')
        results = [item for item in sent if item['role'] == 'tool']
        reference = json.loads(results[1]['content'])['same_result_as_message']
        self.assertIs(sent[reference], results[0])
        self.assertEqual(json.loads(results[2]['content']), {'status': 'prepared', 'executed': False})
        self.assertEqual([item['tool_call_id'] for item in results], ['0', '1', '2'])
        self.assertEqual(history[4].parts[0].function_response.response['executed'], 'unknown')

    def test_summary_only_answer_is_repaired_with_no_tools_available(self):
        summary = '【決策摘要】\n選擇原因：查詢。\n資訊依據：工具。\n尚缺資訊：無。'
        with self.client([(200, completion(calls=[call()])), (200, completion(summary)),
                          (200, completion('可做關聯分析，需要基因型及表現量。'))]) as client:
            with patch.object(main, 'dispatch_tool', return_value=signet_catalog()) as dispatch:
                answer = main.run_conversation(client, '介紹分析與資料需求', [])
        self.assertIn('需要基因型', answer)
        self.assertNotIn('tools', self.requests[-1])
        self.assertNotIn('parallel_tool_calls', self.requests[-1])
        dispatch.assert_called_once()

    def test_history_preserves_assistant_references_user_and_tool_evidence(self):
        user_text = '使用者明確要求保留的參數' * 100
        assistant_text = '不必要的延伸說明' * 200
        history = [types.Content(role='user', parts=[types.Part(text=user_text)]),
                   types.Content(role='model', parts=[types.Part(text=assistant_text)]),
                   types.Content(role='model', parts=[types.Part(text='舊決策摘要' * 100),
                       types.Part(function_call=types.FunctionCall(id='kept', name='get_signet_settings', args={'run_id':'demo'}))]),
                   types.Content(role='user', parts=[types.Part(function_response=types.FunctionResponse(
                       id='kept', name='get_signet_settings', response={'status':'ok', 'settings':{'cohort':'TCGA'}}))])]
        sent = groq_messages(history, main.config.system_instruction)
        self.assertEqual(sent[1]['content'], user_text)
        self.assertEqual(sent[2]['content'], assistant_text)
        self.assertIsNone(sent[3]['content'])
        self.assertEqual(sent[3]['tool_calls'][0]['id'], 'kept')
        self.assertEqual(json.loads(sent[4]['content'])['settings']['cohort'], 'TCGA')
        self.assertEqual(history[1].parts[0].text, assistant_text)

    def test_output_then_input_limit_recovers_without_repeating_tool(self):
        responses = [(429, {'error':{'message':'Rate limit reached on OTPM. Please try again in 20.7s.'}}),
                     (200, completion(calls=[call()])),
                     (429, {'error':{'message':'Rate limit reached on ITPM. Please try again in 128.571428ms.'}}),
                     (200, completion('完整回答'))]
        with self.client(responses) as client:
            with patch.object(main, 'dispatch_tool', return_value=signet_catalog()) as dispatch:
                result = main.run_conversation(client, '介紹目前可以做的分析', [])
        self.assertEqual(result, '完整回答')
        dispatch.assert_called_once()
        self.assertEqual(len(self.requests), 4)
        self.assertEqual(self.requests[0], self.requests[1])
        self.assertEqual(self.requests[2], self.requests[3])

    def test_quota_waits_30_seconds_even_without_a_short_service_delay(self):
        for message, seconds in [('Please try again in 20.7s.', 30),
                                 ('Please try again in 128.571428ms.', 30),
                                 ('Please try again in 2h.', 30),
                                 ('Quota exhausted', 30),
                                 ('Request too large; reduce input size.', None)]:
            response = httpx.Response(429, json={'error':{'message':message}})
            self.assertEqual(rate_limit_delay(response), seconds)
        self.assertEqual(rate_limit_delay(httpx.Response(429, headers={'retry-after':'3'})), 30)
        self.assertEqual(rate_limit_delay(httpx.Response(429, headers={'retry-after':'nan'})), 30)
        self.assertIsNone(rate_limit_delay(httpx.Response(503, headers={'retry-after':'3'})))
        self.assertIsNone(rate_limit_delay(httpx.Response(413)))

    def test_repeated_quota_errors_keep_waiting_until_success(self):
        rejected = (429, {'error':{'message':'Please try again in 20.7s.'}})
        with self.client([rejected]*5 + [(200, completion('額度恢復後完成'))]) as client:
            result = main.run_conversation(client, '查詢', [])
        self.assertEqual(result, '額度恢復後完成')
        self.assertEqual(len(self.requests), 6)
        self.assertEqual(self.send_times, [0, 30, 60, 90, 120, 150])

    def test_success_has_no_delay_and_quota_cooldown_is_shared_and_interruptible(self):
        now = [0.0]
        sent = []
        pacer = RequestPacer(clock=lambda:now[0], sleep=lambda seconds:now.__setitem__(0, now[0]+seconds))
        def handle(request):
            sent.append(now[0])
            return httpx.Response(200, json=completion('完成'))
        for _ in range(2):
            with GroqClient('fake-test-key', pacer=pacer, transport=httpx.MockTransport(handle)) as client:
                main.run_conversation(client, '測試', [])
        self.assertEqual(sent, [0, 0])
        pacer.defer(30)
        with GroqClient('fake-test-key', pacer=pacer, transport=httpx.MockTransport(handle)) as client:
            main.run_conversation(client, '測試', [])
        self.assertEqual(sent, [0, 0, 30])
        pacer.stopped.set()
        with self.assertRaises(KeyboardInterrupt):
            pacer.wait()

    def test_oversized_input_is_not_retried(self):
        with self.client([(413, {'error':{'message':'Request too large'}})]) as client:
            answer = main.run_conversation(client, '測試', [])
        self.assertIn('413', answer)
        self.assertEqual(len(self.requests), 1)

    def test_text_length_limit_keeps_partial_answer_without_executing_tools(self):
        with self.client([(200, completion('已完成的部分說明', finish='length'))]) as client:
            with patch.object(main, 'dispatch_tool') as dispatch:
                result = main.run_conversation(client, '介紹需要的資料', [])
        self.assertIn('已完成的部分說明', result)
        self.assertIn('長度上限', result)
        dispatch.assert_not_called()

    def test_rate_limit_after_tool_waits_and_resends_only_model_request(self):
        from model_timing import ModelRequestTiming
        responses = [(200, completion(calls=[call()])),
                     (429, {'error':{'message':'Rate limit reached on input tokens per minute (ITPM): Limit 7000, Used 3341, Requested 3674. Please try again in 128.571428ms.'}}),
                     (200, completion('已依工具結果完成說明。'))]
        history, events = [], []
        with self.client(responses) as client:
            with patch.object(main, 'dispatch_tool', return_value=signet_catalog()) as dispatch:
                result = main.run_conversation(client, '介紹分析能力', history, progress=events.append,
                                               http_timing=ModelRequestTiming())
        self.assertEqual(result, '已依工具結果完成說明。')
        dispatch.assert_called_once()
        self.assertEqual(len(self.requests), 3)
        self.assertEqual(self.requests[1], self.requests[2])
        self.assertTrue(self.pauses)
        self.assertIn('等待', '\n'.join(events))

    def client(self, responses):
        self.requests = []
        self.send_times = []
        self.pauses = []
        now = [0.0]
        def sleep(seconds):
            self.pauses.append(seconds)
            now[0] += seconds
        pacer = RequestPacer(clock=lambda:now[0], sleep=sleep)
        queue = iter(responses)
        def handle(request):
            self.requests.append(json.loads(request.content))
            self.send_times.append(now[0])
            status, payload = next(queue)
            return httpx.Response(status, json=payload)
        return GroqClient('fake-test-key', transport=httpx.MockTransport(handle), pacer=pacer)

    def test_all_tools_have_required_and_optional_typed_schemas(self):
        schemas = [tool_schema(function) for function in main.config.tools]
        self.assertEqual(len(schemas), 25)
        configure = next(x['function'] for x in schemas if x['function']['name'] == 'configure_signet')
        self.assertEqual(configure['parameters']['required'], ['run_id'])
        self.assertEqual(configure['parameters']['properties']['nchr'], {'type':'integer', 'default':22})
        combine = next(x['function'] for x in schemas if x['function']['name'] == 'combine_covariates')
        self.assertEqual(combine['parameters']['properties']['additional_covariates'],
                         {'type':'array', 'items':{'type':'string'}, 'default':None})
        files = next(x['function'] for x in schemas if x['function']['name'] == 'list_files')
        self.assertEqual(files['parameters']['properties']['folder'].get('enum'), [str(PROJECT)])

    def test_tool_round_trip_preserves_ids_context_and_public_text(self):
        summary = '【決策摘要】選擇原因：查詢能力。資訊依據：使用者問題。尚缺資訊：尚無。'
        responses = [(200, completion(summary, [call()])), (200, completion('查詢完成。')),
                     (200, completion('接續上一輪。'))]
        history, events = [], []
        with self.client(responses) as client, patch.object(main, 'dispatch_tool', return_value=signet_catalog()) as dispatch:
            self.assertEqual(main.run_conversation(client, '查詢能力', history, progress=events.append), '查詢完成。')
            self.assertEqual(main.run_conversation(client, '繼續', history), '接續上一輪。')
        dispatch.assert_called_once_with('signet_catalog', {})
        messages = self.requests[1]['messages']
        self.assertEqual(messages[-2]['tool_calls'][0]['id'], 'call-1')
        self.assertEqual(messages[-1]['tool_call_id'], 'call-1')
        self.assertEqual(messages[-1]['role'], 'tool')
        compact = json.loads(messages[-1]['content'])
        self.assertNotIn('scripts', compact)
        self.assertEqual(compact['all_tools_including_list_files'], 25)
        self.assertTrue(compact['scripts_omitted'])
        self.assertIn('scripts', history[2].parts[0].function_response.response)
        self.assertIn(GROQ_MODEL, events[0])
        self.assertIn('選擇原因', '\n'.join(events))
        self.assertEqual(self.requests[2]['messages'][-1], {'role':'user', 'content':'繼續'})
        self.assertEqual(self.send_times, [0, 0, 0])
        self.assertEqual(self.pauses, [])

    def test_non_catalog_evidence_is_not_truncated(self):
        result = {'status':'unavailable', 'executed':False, 'missing_dependencies':['Rscript'], 'value':'x'*2000}
        content = types.Content(role='user', parts=[types.Part(function_response=types.FunctionResponse(
            id='a', name='expression_tcga', response=result))])
        sent = groq_messages([content], 'rules')
        self.assertEqual(json.loads(sent[-1]['content']), result)

    def test_hidden_thought_parts_are_not_sent_as_public_text(self):
        content = types.Content(role='model', parts=[types.Part(text='PRIVATE', thought=True),
                                                     types.Part(text='公開摘要')])
        sent = groq_messages([content], 'rules')
        self.assertEqual(sent[-1]['content'], '公開摘要')
        self.assertNotIn('PRIVATE', str(sent))

    def test_api_error_keeps_model_status_and_redacts_groq_key(self):
        responses = [(401, {'error':{'message':'Invalid credential fake-test-key'}})]
        with self.client(responses) as client, patch.dict('os.environ', {'GROQ_API_KEY':'fake-test-key'}):
            answer = main.run_conversation(client, '你好', [])
        self.assertIn('401', answer)
        self.assertIn('UNAUTHENTICATED', answer)
        self.assertIn(GROQ_MODEL, answer)
        self.assertNotIn('fake-test-key', answer)
        self.assertEqual(len(self.requests), 1)

    def test_malformed_or_incomplete_calls_never_execute(self):
        cases = [completion(), completion(calls=[call('not-json')]), completion(calls=[call('[]')]),
                 completion(calls=[call(), call()]), completion(calls=[call()], finish='length')]
        for payload in cases:
            with self.subTest(payload=payload), self.client([(200, payload)]) as client:
                with patch.object(main, 'dispatch_tool') as dispatch:
                    answer = main.run_conversation(client, '查詢', [])
                dispatch.assert_not_called()
                self.assertIn('模型請求失敗', answer)


if __name__ == '__main__':
    unittest.main()
