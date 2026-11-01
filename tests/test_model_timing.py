from types import SimpleNamespace
import unittest
from unittest.mock import patch

import httpx
from google import genai
from google.genai import errors, types
import agent.core.conversation as main
from agent.core.model_timing import ModelRequestTiming


class ModelTimingTest(unittest.TestCase):
    def sdk_request(self, timing, statuses, retry=None):
        requests=[]
        def handler(request):
            requests.append(request)
            status=statuses[len(requests)-1]
            if status != 200:
                return httpx.Response(status,json={'error':{'code':status,'status':'UNAVAILABLE','message':'controlled failure'}})
            return httpx.Response(200,json={'candidates':[{'content':{'role':'model','parts':[{'text':'controlled answer'}]}}],
                                           'usageMetadata':{'promptTokenCount':12,'candidatesTokenCount':4,'thoughtsTokenCount':8}})
        options=types.HttpOptions(client_args={**timing.client_args(),'transport':httpx.MockTransport(handler)},retry_options=retry)
        client=genai.Client(api_key='fake-timing-key',http_options=options)
        return client,requests

    def test_actual_sdk_default_sends_one_attempt_and_no_retry(self):
        timing=ModelRequestTiming()
        events=[]
        with self.sdk_request(timing,[503])[0] as client:
            timing.begin(events.append)
            with self.assertRaises(errors.ServerError):
                client.models.generate_content(model=main.MODEL,contents='SECRET-PROMPT',config=main.config)
            timing.finish()
        self.assertEqual(len(timing.attempts),1)
        self.assertIn('狀態碼=503','\n'.join(events))
        self.assertNotIn('fake-timing-key','\n'.join(events))
        self.assertNotIn('SECRET-PROMPT','\n'.join(events))

    def test_actual_sdk_explicit_retry_is_observable_without_real_network(self):
        timing=ModelRequestTiming()
        events=[]
        client,requests=self.sdk_request(timing,[503,200],types.HttpRetryOptions(attempts=2,initial_delay=.001,max_delay=.001,jitter=.001))
        with client:
            timing.begin(events.append)
            result=client.models.generate_content(model=main.MODEL,contents='controlled prompt',config=main.config)
            timing.finish(result)
        self.assertEqual(len(requests),2)
        self.assertEqual(len(timing.attempts),2)
        joined='\n'.join(events)
        self.assertIn('狀態碼=503',joined)
        self.assertIn('狀態碼=200',joined)
        self.assertIn('觀測到 2 次',joined)
        self.assertIn('內部思考=8',joined)
        self.assertIn('不能換算',joined)

    def test_segments_and_between_attempt_gap_are_measured_not_inferred(self):
        now=[0.0]
        timing=ModelRequestTiming(clock=lambda:now[0])
        events=[]
        timing.begin(events.append)
        request=httpx.Request('POST','https://example.invalid',headers={'Authorization':'SECRET'})
        timing.on_request(request)
        trace=request.extensions['trace']
        trace('connection.connect_tcp.started',{'host':'SECRET-HOST'})
        now[0]=2
        trace('connection.connect_tcp.complete',{'return_value':'SECRET-CERT'})
        trace('connection.start_tls.started',{})
        now[0]=3
        trace('connection.start_tls.complete',{})
        now[0]=4
        trace('http11.send_request_body.complete',{})
        now[0]=14
        timing.on_response(httpx.Response(503,request=request))
        now[0]=16
        trace('http11.receive_response_body.complete',{})
        now[0]=20
        second=httpx.Request('POST','https://example.invalid')
        timing.on_request(second)
        now[0]=21
        timing.on_response(httpx.Response(200,request=second))
        now[0]=22
        second.extensions['trace']('http11.receive_response_body.complete',{})
        timing.finish()
        joined='\n'.join(events)
        for expected in ('TCP 連線=2.00 秒','TLS 握手=1.00 秒','送出至回應標頭=10.00 秒','標頭至回應讀完=2.00 秒','再次送出前間隔=4.00 秒','無法分拆'):
            self.assertIn(expected,joined)
        self.assertNotIn('SECRET',joined)
        self.assertNotIn('example.invalid',joined)

    def test_connect_failure_and_no_http_are_not_reported_as_server_wait(self):
        now=[0.0]
        timing=ModelRequestTiming(clock=lambda:now[0])
        events=[]
        timing.begin(events.append)
        timing.finish()
        self.assertIn('未觀測到 HTTP','\n'.join(events))
        events.clear()
        timing.begin(events.append)
        request=httpx.Request('POST','https://example.invalid')
        timing.on_request(request)
        now[0]=3
        request.extensions['trace']('connection.connect_tcp.failed',{'exception':RuntimeError('SECRET')})
        timing.finish()
        joined='\n'.join(events)
        self.assertIn('connect_tcp',joined)
        self.assertNotIn('送出至回應標頭=',joined)
        self.assertNotIn('SECRET',joined)

    def test_conversation_reports_transport_timings_on_api_failure(self):
        timing=ModelRequestTiming()
        events=[]
        with self.sdk_request(timing,[503])[0] as client:
            result=main.run_conversation(client,'controlled prompt',[],progress=events.append,http_timing=timing)
        self.assertIn('503',result)
        self.assertFalse(timing.active)
        self.assertIn('觀測到 1 次 HTTP 嘗試','\n'.join(events))

    def test_conversation_reports_transport_and_usage_on_success(self):
        timing=ModelRequestTiming()
        events=[]
        with self.sdk_request(timing,[200])[0] as client:
            result=main.run_conversation(client,'controlled prompt',[],progress=events.append,http_timing=timing)
        self.assertEqual(result,'controlled answer')
        self.assertIn('輸入=12','\n'.join(events))
        self.assertIn('請求本文大小=','\n'.join(events))
        self.assertNotIn('controlled prompt','\n'.join(events))


if __name__=='__main__':
    unittest.main()
