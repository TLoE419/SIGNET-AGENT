import unittest
from unittest.mock import patch

from google.genai import errors, types
import agent.core.conversation as main
from test_chat import client_for, response


class DiagnosticsTest(unittest.TestCase):
    def test_service_failure_exposes_status_without_exposing_credentials(self):
        error=errors.ServerError(503,{'error':{'code':503,'status':'UNAVAILABLE','message':'Service temporarily overloaded. api_key=fake-private-key'}})
        client,_=client_for(error)
        with patch.dict('os.environ',{'GEMINI_API_KEY':'fake-private-key'}):
            result=main.run_conversation(client,'研究需求',[])
        self.assertIn('503',result)
        self.assertIn('UNAVAILABLE',result)
        self.assertIn('overloaded',result)
        self.assertNotIn('fake-private-key',result)
        self.assertIn('尚未呼叫任何工具',result)

    def test_progress_distinguishes_model_request_tool_and_followup_failure(self):
        call=types.FunctionCall(id='c1',name='get_signet_settings',args={'run_id':'private-run'})
        error=errors.ServerError(500,{'error':{'status':'INTERNAL','message':'Internal service error'}})
        client,_=client_for(response(calls=[call]),error)
        events=[]
        with patch.object(main,'dispatch_tool',return_value={'status':'ok','settings':{'value':'private-scientific-data'}}):
            result=main.run_conversation(client,'研究需求',[],progress=events.append)
        joined='\n'.join(events)
        self.assertIn('模型請求 1/5',events[0])
        self.assertIn('get_signet_settings',joined)
        self.assertIn('status=ok',joined)
        self.assertIn('模型請求 2/5',joined)
        self.assertIn('已有 1 個工具結果',result)
        self.assertNotIn('private-run',joined)
        self.assertNotIn('private-scientific-data',joined)

    def test_api_error_categories_have_actionable_hints(self):
        for code,hint in [(400,'請求格式'),(401,'金鑰權限'),(403,'金鑰權限'),(404,'模型名稱'),(429,'配額'),(500,'服務端')]:
            with self.subTest(code=code):
                error=errors.APIError(code,{'error':{'status':'TEST_STATUS','message':'Provider explanation'}})
                client,_=client_for(error)
                result=main.run_conversation(client,'request',[])
                self.assertIn(str(code),result)
                self.assertIn(hint,result)

    def test_echoed_request_tool_payloads_and_control_characters_are_redacted(self):
        history=[types.Content(role='model',parts=[types.Part(function_call=types.FunctionCall(
            name='get_signet_settings',args={'run_id':'private-run-id'}))]),
            types.Content(role='user',parts=[types.Part(function_response=types.FunctionResponse(
                name='get_signet_settings',response={'settings':{'value':'private-scientific-data'}}))])]
        error=errors.ServerError(503,{'error':{'status':'UNAVAILABLE','message':
            'busy private-run-id private-scientific-data sensitive question bearer private-token key=unloaded-key \x1b[31m'}})
        client,_=client_for(error)
        result=main.run_conversation(client,'sensitive question',history)
        for hidden in ['private-run-id','private-scientific-data','sensitive question','private-token','unloaded-key','\x1b']:
            self.assertNotIn(hidden,result)
        self.assertIn('busy',result)

    def test_trace_shows_missing_dependencies_without_dumping_result(self):
        call=types.FunctionCall(id='c1',name='expression_tcga',args={'run_id':'sample'})
        client,_=client_for(response(calls=[call]),response('環境缺少依賴。'))
        events=[]
        with patch.object(main,'dispatch_tool',return_value={'status':'unavailable','executed':False,
                         'missing_dependencies':['Rscript','Linux'], 'scientific_payload':'DO-NOT-DUMP'}):
            main.run_conversation(client,'preprocess',[],progress=events.append)
        joined='\n'.join(events)
        self.assertIn('缺少依賴：Rscript, Linux',joined)
        self.assertIn('executed=False',joined)
        self.assertNotIn('DO-NOT-DUMP',joined)

    def test_cli_progress_is_enabled_for_single_prompt(self):
        import contextlib
        import io
        import os
        import runpy
        from pathlib import Path
        client,_=client_for(response('受控回覆'))
        with patch('sys.argv',['main.py','--provider','gemini','研究需求']),patch.dict(os.environ,{'GEMINI_API_KEY':'fake-test-key'},clear=True),patch('dotenv.load_dotenv'),patch('google.genai.Client',return_value=contextlib.nullcontext(client)),patch('sys.stdout',new_callable=io.StringIO) as output:
            runpy.run_path(str(Path(main.__file__)),run_name='__main__')
        self.assertIn('[過程] 模型請求 1/5',output.getvalue())
        self.assertIn('模型完成文字回答',output.getvalue())
        self.assertNotIn('fake-test-key',output.getvalue())


if __name__=='__main__':
    unittest.main()
