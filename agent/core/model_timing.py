"""Observe synchronous HTTP timings without reading message bodies or recording credential headers."""
import time


class ModelRequestTiming:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.active = False
        self.attempts = []

    def client_args(self):
        return {'event_hooks': {'request': [self.on_request], 'response': [self.on_response]}}

    def begin(self, report):
        self.report = report
        self.started = self.clock()
        self.attempts = []
        self.active = True

    def on_request(self, request):
        if not self.active:
            return
        attempt = {'number': len(self.attempts)+1, 'started': self.clock(), 'starts': {},
                   'durations': {}, 'sent': None, 'headers': None, 'ended': None, 'status': None}
        self.attempts.append(attempt)
        request.extensions['signet_timing'] = attempt
        length = request.headers.get('content-length', '')
        if length.isascii() and length.isdigit():
            attempt['request_bytes'] = int(length)
        previous_trace = request.extensions.get('trace')

        def trace(event, info):
            # Trace metadata can contain URLs, certificates or exceptions; never retain it.
            self._trace(attempt, event)
            if previous_trace is not None:
                previous_trace(event, info)

        request.extensions['trace'] = trace
        self.report(f"底層 HTTP 嘗試 {attempt['number']} 開始（本輪 +{attempt['started']-self.started:.2f} 秒）；不輸出網址、原始標頭或請求內容。")
        if 'request_bytes' in attempt:
            self.report(f"HTTP 嘗試 {attempt['number']}：請求本文大小={attempt['request_bytes']} 位元組（僅讀取長度欄位）。")

    def _trace(self, attempt, event):
        operation, phase = event.rsplit('.', 1)
        operation = operation.rsplit('.', 1)[-1]
        now = self.clock()
        if phase == 'started':
            attempt['starts'][operation] = now
        elif phase == 'complete':
            start = attempt['starts'].pop(operation, None)
            if start is not None and operation in ('connect_tcp', 'start_tls'):
                attempt['durations'][operation] = attempt['durations'].get(operation, 0) + now-start
            if operation == 'send_request_body':
                attempt['sent'] = now
                self.report(f"HTTP 嘗試 {attempt['number']}：請求資料已送出，等待回應標頭。")
            elif operation == 'receive_response_body':
                attempt['ended'] = now
        elif phase == 'failed':
            attempt['ended'] = now
            self.report(f"HTTP 嘗試 {attempt['number']}：傳輸階段失敗（{operation}）；未輸出例外內容。")

    def on_response(self, response):
        if not self.active:
            return
        attempt = response.request.extensions.get('signet_timing')
        if attempt is None:
            return
        attempt['headers'] = self.clock()
        attempt['status'] = response.status_code
        self.report(f"HTTP 嘗試 {attempt['number']}：收到回應標頭，狀態碼={response.status_code}，已用 {attempt['headers']-attempt['started']:.2f} 秒；這不是單獨的服務排隊時間。")

    def finish(self, response=None):
        elapsed = self.clock()-self.started
        self.active = False
        if not self.attempts:
            self.report('底層計時：未觀測到 HTTP 嘗試；可能尚未進入傳輸、使用其他傳輸路徑，或目前為模擬模型。')
            return
        self.report(f'底層計時：觀測到 {len(self.attempts)} 次 HTTP 嘗試；模型方法總耗時 {elapsed:.2f} 秒。')
        self.report(f"方法開始至首次 HTTP 嘗試={self.attempts[0]['started']-self.started:.2f} 秒（套件前置處理，尚未由這次 HTTP 送出）。")
        for index, attempt in enumerate(self.attempts):
            parts = []
            for operation, label in (('connect_tcp', 'TCP 連線'), ('start_tls', 'TLS 握手')):
                if operation in attempt['durations']:
                    parts.append(f"{label}={attempt['durations'][operation]:.2f} 秒")
            if not parts:
                parts.append('未觀測新連線計時，可能重用連線或傳輸未提供事件')
            if attempt['sent'] is not None and attempt['headers'] is not None:
                parts.append(f"送出至回應標頭={attempt['headers']-attempt['sent']:.2f} 秒（含網路、服務等待與運算，無法分拆）")
            if attempt['headers'] is not None and attempt['ended'] is not None:
                parts.append(f"標頭至回應讀完={max(0,attempt['ended']-attempt['headers']):.2f} 秒")
            self.report(f"HTTP 嘗試 {attempt['number']} 分段：" + '；'.join(parts) + '。')
            if index and self.attempts[index-1]['ended'] is not None:
                gap = attempt['started']-self.attempts[index-1]['ended']
                self.report(f'再次送出前間隔={gap:.2f} 秒（含套件處理與可能的重試退避，不能視為純睡眠時間）。')
        if self.attempts[-1]['ended'] is not None:
            self.report(f"最後傳輸事件至模型方法結束={max(0,self.started+elapsed-self.attempts[-1]['ended']):.2f} 秒（含回應解析等本機處理）。")
        if len(self.attempts)>1:
            self.report('多次 HTTP 嘗試可能是套件重試或轉址；請對照前一次狀態碼，不能僅依次數判定重試。')
        metadata = getattr(response, 'usage_metadata', None)
        if metadata is not None:
            counts = []
            for key, label in (('prompt_token_count','輸入'),('candidates_token_count','輸出'),('thoughts_token_count','內部思考'),('cached_content_token_count','快取')):
                value = getattr(metadata, key, None)
                if type(value) is int:
                    counts.append(f'{label}={value}')
            if counts:
                self.report('服務回報的 token 數：' + '，'.join(counts) + '；僅為數量，不能換算各階段耗時，也不顯示思考內容。')
