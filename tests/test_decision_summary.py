import unittest
from unittest.mock import patch

from google.genai import errors, types
import agent.core.conversation as main
from test_chat import client_for, response


SUMMARY = '【決策摘要】\n選擇原因：先使用 signet_catalog 查詢前處理工具。\n資訊依據：使用者希望了解前處理需要的資料，目前還沒有工具結果。\n尚缺資訊：資料群組與輸入路徑。'


class DecisionSummaryTest(unittest.TestCase):
    def test_text_tool_markup_is_not_a_final_answer_or_an_executable_call(self):
        markup = '<tool_call>\n<function=list_files>\n<parameter=folder>\n/tmp\n</parameter>\n</function>\n</tool_call>'
        client, requests = client_for(response(markup), response('已找到範例檔案；內容尚未驗證。'))
        with patch.object(main, 'dispatch_tool') as dispatch:
            answer = main.run_conversation(client, 'data 裡沒有嗎', [])
        dispatch.assert_not_called()
        self.assertEqual(len(requests), 2)
        self.assertIn('已找到範例檔案', answer)

    def test_summary_only_final_answer_is_repaired_without_repeating_tools(self):
        first = self.planned_response()
        client, requests = client_for(first, response(SUMMARY), response('可做關聯分析；需要基因型與表現量資料。'))
        original = client.models.generate_content
        configs = []
        def generate(**kwargs):
            configs.append(kwargs['config'])
            return original(**kwargs)
        client.models.generate_content = generate
        with patch.object(main, 'dispatch_tool', return_value={'status': 'ok'}) as dispatch:
            answer = main.run_conversation(client, '有哪些分析？', [])
        self.assertIn('可做關聯分析', answer)
        dispatch.assert_called_once()
        self.assertEqual(len(requests), 3)
        self.assertEqual(configs[-1].tools, [])
        self.assertEqual(requests[-1], requests[-2])

    def test_summary_repair_is_bounded_and_not_reported_as_completed(self):
        client, requests = client_for(response(SUMMARY), response(SUMMARY))
        events = []
        answer = main.run_conversation(client, '有哪些分析？', [], progress=events.append)
        self.assertEqual(len(requests), 2)
        self.assertIn('未產生有效回答', answer)
        self.assertNotIn('模型完成文字回答。', events)

    def test_summary_filter_keeps_real_answer_and_code_examples(self):
        client, _ = client_for(response(SUMMARY + '\n\n可做關聯分析。'))
        self.assertEqual(main.run_conversation(client, '有哪些分析？', []), '可做關聯分析。')
        example = '```text\n' + SUMMARY + '\n```'
        client, _ = client_for(response(example))
        self.assertEqual(main.run_conversation(client, '顯示格式', []), example)

    def planned_response(self, summary=SUMMARY):
        call=types.FunctionCall(id='summary-call',name='signet_catalog',args={})
        result=response(calls=[call])
        if summary:
            result.candidates[0].content.parts.insert(0,types.Part.from_text(text=summary))
        return result

    def test_public_summary_precedes_execution_and_preserves_complete_model_content(self):
        first=self.planned_response()
        client,requests=client_for(first,response('請提供資料群組。'))
        events=[]
        def dispatch(*args):
            events.append('DISPATCH')
            return {'status':'ok'}
        with patch.object(main,'dispatch_tool',side_effect=dispatch):
            main.run_conversation(client,'前處理需要什麼資料',[],progress=events.append)
        for field in ('選擇原因：','資訊依據：','尚缺資訊：'):
            index=next(i for i,text in enumerate(events) if field in text)
            self.assertLess(index,events.index('DISPATCH'))
        self.assertIs(requests[1][1],first.candidates[0].content)
        self.assertEqual(requests[1][1].parts[1].thought_signature,b'original-signature')
        self.assertEqual(requests[1][2].role,'user')
        self.assertEqual(requests[1][2].parts[0].function_response.id,'summary-call')

    def test_thought_parts_are_never_shown_as_summary(self):
        first=self.planned_response()
        first.candidates[0].content.parts.insert(0,types.Part(text='PRIVATE-INTERNAL-TEXT',thought=True))
        client,_=client_for(first,response('查詢完成'))
        events=[]
        with patch.object(main,'dispatch_tool',return_value={'status':'ok'}):
            main.run_conversation(client,'前處理',[],progress=events.append)
        self.assertNotIn('PRIVATE-INTERNAL-TEXT','\n'.join(events))
        self.assertIn('選擇原因：','\n'.join(events))

    def test_missing_summary_is_reported_without_inventing_explanation(self):
        first=self.planned_response(None)
        client,_=client_for(first,response('查詢完成'))
        events=[]
        with patch.object(main,'dispatch_tool',return_value={'status':'ok'}) as dispatch:
            main.run_conversation(client,'前處理',[],progress=events.append)
            dispatch.assert_called_once()
        self.assertIn('模型未提供公開說明','\n'.join(events))
        self.assertNotIn('選擇原因：','\n'.join(events))

    def test_incomplete_summary_is_labeled_and_credentials_are_redacted(self):
        first=self.planned_response('選擇原因：查看工具。api_key=fake-summary-secret\x1b[31m')
        client,_=client_for(first,response('查詢完成'))
        events=[]
        with patch.dict('os.environ',{'GEMINI_API_KEY':'fake-summary-secret'}),patch.object(main,'dispatch_tool',return_value={'status':'ok'}):
            main.run_conversation(client,'前處理',[],progress=events.append)
        joined='\n'.join(events)
        self.assertIn('摘要欄位不完整',joined)
        self.assertNotIn('fake-summary-secret',joined)
        self.assertNotIn('\x1b',joined)

    def test_first_request_failure_cannot_produce_a_decision_summary(self):
        client,_=client_for(errors.ServerError(503,{'error':{'status':'UNAVAILABLE','message':'Service busy'}}))
        events=[]
        with patch.object(main,'dispatch_tool') as dispatch:
            result=main.run_conversation(client,'前處理',[],progress=events.append)
            dispatch.assert_not_called()
        self.assertIn('503',result)
        self.assertNotIn('決策摘要','\n'.join(events))

    def test_each_round_can_update_its_summary_using_prior_results(self):
        first=self.planned_response()
        second=self.planned_response('【決策摘要】\n選擇原因：重新查詢工具。\n資訊依據：上一輪查詢成功。\n尚缺資訊：資料路徑。')
        client,_=client_for(first,second,response('完成'))
        events=[]
        with patch.object(main,'dispatch_tool',return_value={'status':'ok'}):
            main.run_conversation(client,'前處理',[],progress=events.append)
        self.assertEqual(sum('決策摘要（模型提供' in x for x in events),2)
        self.assertIn('資訊依據：上一輪查詢成功。','\n'.join(events))


if __name__=='__main__':
    unittest.main()
