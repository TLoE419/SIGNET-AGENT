import io
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from google.genai import types
import agent.core.conversation as main


def response(text=None, calls=None):
    parts = [types.Part(function_call=call, thought_signature=b'original-signature') for call in calls] if calls else [types.Part.from_text(text=text)]
    return SimpleNamespace(text=text, function_calls=calls or [], candidates=[SimpleNamespace(content=types.Content(role='model',parts=parts))])


def client_for(*responses):
    queue = iter(responses)
    requests = []
    def generate(**kwargs):
        requests.append(list(kwargs['contents']))
        result = next(queue)
        if isinstance(result, BaseException):
            raise result
        return result
    return SimpleNamespace(models=SimpleNamespace(generate_content=generate)), requests


class ChatTest(unittest.TestCase):
    def test_selected_language_overrides_old_history_without_mutating_global_rules(self):
        client, _ = client_for(response('English answer'))
        original = main.config.system_instruction
        with patch.object(client.models, 'generate_content', return_value=response('English answer')) as generate:
            main.run_conversation(client, '中文問題', [], language='en')
        instruction = generate.call_args.kwargs['config'].system_instruction
        self.assertIn('UI language for this turn is English', instruction)
        self.assertEqual(main.config.system_instruction, original)
        self.assertEqual(generate.call_args.kwargs['contents'][0].parts[0].text, '中文問題')

    def test_natural_language_and_cross_turn_context_without_tools(self):
        first = response('你的資料群組是哪一種？')
        second = response('了解，你使用癌症資料。')
        client, requests = client_for(first, second)
        history = []
        self.assertEqual(main.run_conversation(client,'我想研究基因型與表現量',history),first.text)
        self.assertEqual(main.run_conversation(client,'癌症資料',history),second.text)
        self.assertEqual(len(history),4)
        self.assertEqual(requests[1][0].parts[0].text,'我想研究基因型與表現量')
        self.assertIs(requests[1][1],first.candidates[0].content)
        self.assertEqual(requests[1][2].parts[0].text,'癌症資料')

    def test_autonomous_tool_selection_and_followup(self):
        call=types.FunctionCall(id='catalog-1',name='signet_catalog',args={})
        selected=response(calls=[call])
        client, requests=client_for(selected,response('請提供資料路徑。'),response('我會使用你補充的路徑。'))
        history=[]
        with patch.object(main,'dispatch_tool',return_value={'status':'ok','analysis_tools':14}) as dispatch:
            main.run_conversation(client,'我可以做哪些分析？',history)
            main.run_conversation(client,'資料在 data/sample.txt',history)
            dispatch.assert_called_once_with('signet_catalog',{})
        self.assertIs(requests[2][1],selected.candidates[0].content)
        self.assertEqual(requests[2][2].role,'user')
        self.assertEqual(requests[2][2].parts[0].function_response.id,'catalog-1')
        self.assertEqual(requests[2][1].parts[0].thought_signature,b'original-signature')
        self.assertEqual(requests[2][-1].parts[0].text,'資料在 data/sample.txt')

    def test_tool_validation_error_is_returned_to_model(self):
        call=types.FunctionCall(id='bad',name='not_a_tool',args={})
        client, requests=client_for(response(calls=[call]),response('工具不存在，尚未執行。'))
        self.assertIn('尚未執行',main.run_conversation(client,'請幫我分析'))
        result=requests[1][-1].parts[0].function_response
        self.assertEqual(result.response['status'],'invalid')
        self.assertFalse(result.response['executed'])

    def test_service_error_after_tool_preserves_results_and_hides_error_body(self):
        call=types.FunctionCall(id='query',name='signet_catalog',args={})
        client, requests=client_for(response(calls=[call]),RuntimeError('SECRET-DO-NOT-PRINT'),response('已根據先前結果繼續。'))
        history=[]
        with patch.object(main,'dispatch_tool',return_value={'status':'ok'}) as dispatch:
            failure=main.run_conversation(client,'我可以做什麼？',history)
            self.assertIn('仍保留',failure)
            self.assertNotIn('SECRET',failure)
            self.assertEqual(len(history),3)
            main.run_conversation(client,'繼續',history)
            self.assertEqual(dispatch.call_count,1)
        self.assertEqual(requests[2][2].parts[0].function_response.id,'query')
        self.assertEqual(requests[2][3].parts[0].text,'繼續')

    def test_single_mode_error_does_not_claim_persistent_history(self):
        client,_=client_for(RuntimeError('PRIVATE'))
        result=main.run_conversation(client,'需求')
        self.assertIn('單次模式不保留聊天紀錄',result)
        self.assertNotIn('仍保留',result)
        self.assertNotIn('PRIVATE',result)

    def test_service_interrupt_preserves_existing_conversation(self):
        client, _=client_for(response('需要哪些資料？'),KeyboardInterrupt(),response('繼續'))
        history=[]
        main.run_conversation(client,'研究目的',history)
        self.assertIn('中斷',main.run_conversation(client,'補充資料',history))
        self.assertEqual(len(history),3)
        self.assertEqual(main.run_conversation(client,'繼續',history),'繼續')

    def test_unexpected_tool_failure_skips_rest_and_preserves_function_ids(self):
        calls=[types.FunctionCall(id=str(i),name='signet_catalog',args={}) for i in range(3)]
        for failure in [RuntimeError('PRIVATE'),KeyboardInterrupt()]:
            with self.subTest(failure=type(failure).__name__):
                client,_=client_for(response(calls=calls))
                history=[]
                with patch.object(main,'dispatch_tool',side_effect=[{'status':'ok'},failure]) as dispatch:
                    text=main.run_conversation(client,'幫我研究',history)
                    self.assertIn('未知',text)
                    self.assertEqual(dispatch.call_count,2)
                results=history[-1].parts
                self.assertEqual([x.function_response.id for x in results],['0','1','2'])
                self.assertEqual(results[1].function_response.response['executed'],'unknown')
                self.assertFalse(results[2].function_response.response['executed'])
                self.assertNotIn('PRIVATE',str(results))

    def test_recorded_tool_interrupt_skips_remaining_calls(self):
        calls=[types.FunctionCall(id=str(i),name='signet_catalog',args={}) for i in range(2)]
        client,_=client_for(response(calls=calls))
        history=[]
        with patch.object(main,'dispatch_tool',return_value={'status':'interrupted','executed':True}) as dispatch:
            self.assertIn('中斷',main.run_conversation(client,'研究',history))
            dispatch.assert_called_once()
        self.assertEqual(history[-1].parts[0].function_response.response['status'],'interrupted')
        self.assertEqual(history[-1].parts[1].function_response.response['status'],'skipped')

    def test_limits_keep_completed_context_without_unanswered_function_calls(self):
        call=types.FunctionCall(id='loop',name='signet_catalog',args={})
        client,_=client_for(*[response(calls=[call]) for _ in range(5)],response('已停止重複呼叫。'))
        history=[]
        with patch.object(main,'dispatch_tool',return_value={'status':'ok'}) as dispatch:
            self.assertIn('上限',main.run_conversation(client,'研究',history))
            self.assertEqual(dispatch.call_count,4)
            self.assertEqual(len(history),9)
            self.assertEqual(history[-1].role,'user')
            self.assertIsNotNone(history[-1].parts[0].function_response)
            self.assertIn('停止',main.run_conversation(client,'先不要執行，說明目前狀態',history))
            self.assertEqual(dispatch.call_count,4)

    def test_missing_candidate_never_executes_tool(self):
        client,_=client_for(SimpleNamespace(function_calls=[types.FunctionCall(name='signet_catalog')],candidates=[]))
        with patch.object(main,'dispatch_tool') as dispatch:
            self.assertIn('完整內容',main.run_conversation(client,'研究',[]))
            dispatch.assert_not_called()

    def test_interactive_help_blank_and_exit_do_not_call_model(self):
        with patch('builtins.input',side_effect=['','/help','/exit']), patch('sys.stdout',new_callable=io.StringIO) as stdout, patch.object(main,'run_conversation') as run:
            main.interactive_chat(object())
            run.assert_not_called()
            self.assertIn('研究目的',stdout.getvalue())
            self.assertIn('已離開',stdout.getvalue())

    def test_interactive_eof_and_interrupt_keep_history(self):
        client,_=client_for(response('你想用哪種資料？'),response('好的'))
        with patch('builtins.input',side_effect=['我想研究',KeyboardInterrupt(),'癌症資料',EOFError()]),patch('sys.stdout',new_callable=io.StringIO) as stdout:
            main.interactive_chat(client)
            self.assertIn('對話仍保留',stdout.getvalue())
            self.assertIn('已離開',stdout.getvalue())

    def test_interactive_initial_prompt_and_quit(self):
        client,requests=client_for(response('請補充研究目的'))
        with patch('builtins.input',side_effect=['/quit']),patch('sys.stdout',new_callable=io.StringIO):
            main.interactive_chat(client,'我要開始研究')
        self.assertEqual(requests[0][0].parts[0].text,'我要開始研究')

class CliTest(unittest.TestCase):
    def run_entry(self, arguments, answers=()):
        import contextlib
        import os
        from pathlib import Path
        import runpy
        client,requests=client_for(response('受控回覆'))
        with patch('sys.argv',['main.py',*arguments]), patch.dict(os.environ,{'GEMINI_API_KEY':'fake-cli-test-key'},clear=True), patch('dotenv.load_dotenv') as dotenv, patch('google.genai.Client',return_value=contextlib.nullcontext(client)), patch('agent.providers.codex_client.CodexClient',return_value=contextlib.nullcontext(client)) as codex, patch('builtins.input',side_effect=answers), patch('sys.stdout',new_callable=io.StringIO) as stdout:
            runpy.run_path(str(Path(main.__file__)),run_name='__main__')
            dotenv.assert_called_once()
            if '--provider' not in arguments:
                codex.assert_called_once()
        return requests,stdout.getvalue()

    def test_single_prompt_remains_compatible(self):
        requests,stdout=self.run_entry(['我想了解','需要哪些資料'])
        self.assertEqual(len(requests),1)
        self.assertEqual(requests[0][0].parts[0].text,'我想了解 需要哪些資料')
        self.assertIn('受控回覆',stdout)
        self.assertNotIn('你 >',stdout)

    def test_no_arguments_enters_chat_and_quits(self):
        requests,stdout=self.run_entry([],['/exit'])
        self.assertEqual(requests,[])
        self.assertIn('直接描述',stdout)

    def test_chat_flag_initial_prompt_and_exit(self):
        requests,stdout=self.run_entry(['--chat','我要研究'],['/exit'])
        self.assertEqual(requests[0][0].parts[0].text,'我要研究')
        self.assertIn('已離開',stdout)

    def test_gemini_can_still_be_selected_explicitly(self):
        requests, stdout = self.run_entry(['--provider', 'gemini', '研究需求'])
        self.assertEqual(len(requests), 1)
        self.assertIn('受控回覆', stdout)


if __name__=='__main__':
    unittest.main()
