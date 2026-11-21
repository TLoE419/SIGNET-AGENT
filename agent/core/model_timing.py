"""Observe synchronous HTTP timings without reading message bodies or recording credential headers."""
import time


class ModelRequestTiming:
    def __init__(self, clock=time.monotonic, *, cancel_requested=None):
        self.clock = clock
        self.cancel_requested = cancel_requested
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
        if self.cancel_requested is not None and self.cancel_requested():
            raise KeyboardInterrupt()
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
        self.report(f"HTTP attempt {attempt['number']} started (+{attempt['started']-self.started:.2f} s this turn). URLs, raw headers and request content stay hidden.")
        if 'request_bytes' in attempt:
            self.report(f"HTTP attempt {attempt['number']}: request body size={attempt['request_bytes']} bytes (length header only).")

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
                self.report(f"HTTP attempt {attempt['number']}: sent the request, waiting for response headers.")
            elif operation == 'receive_response_body':
                attempt['ended'] = now
        elif phase == 'failed':
            attempt['ended'] = now
            self.report(f"HTTP attempt {attempt['number']}: transport failed ({operation}). Exception details stay hidden.")

    def on_response(self, response):
        if not self.active:
            return
        attempt = response.request.extensions.get('signet_timing')
        if attempt is None:
            return
        attempt['headers'] = self.clock()
        attempt['status'] = response.status_code
        self.report(f"HTTP attempt {attempt['number']}: received headers, status={response.status_code}, elapsed {attempt['headers']-attempt['started']:.2f} s. The elapsed time includes more than service queueing.")

    def finish(self, response=None):
        elapsed = self.clock()-self.started
        self.active = False
        if not self.attempts:
            self.report('Transport timing: no HTTP attempt observed. The client may use another transport, a mock, or have stopped before the network request.')
            return
        attempts = len(self.attempts)
        noun = 'attempt' if attempts == 1 else 'attempts'
        self.report(f'Transport timing: observed {attempts} HTTP {noun}. Total model call: {elapsed:.2f} s.')
        self.report(f"Time before the first HTTP attempt: {self.attempts[0]['started']-self.started:.2f} s (client preparation before sending).")
        for index, attempt in enumerate(self.attempts):
            parts = []
            for operation, label in (('connect_tcp', 'TCP connection'), ('start_tls', 'TLS handshake')):
                if operation in attempt['durations']:
                    parts.append(f"{label}={attempt['durations'][operation]:.2f} s")
            if not parts:
                parts.append('no new connection timing (connection reuse or missing transport events)')
            if attempt['sent'] is not None and attempt['headers'] is not None:
                parts.append(f"send to response headers={attempt['headers']-attempt['sent']:.2f} s (combined network, service wait and processing)")
            if attempt['headers'] is not None and attempt['ended'] is not None:
                parts.append(f"headers to response complete={max(0,attempt['ended']-attempt['headers']):.2f} s")
            self.report(f"HTTP attempt {attempt['number']} timing: " + '; '.join(parts) + '.')
            if index and self.attempts[index-1]['ended'] is not None:
                gap = attempt['started']-self.attempts[index-1]['ended']
                self.report(f'Gap before retry={gap:.2f} s (client processing and possible retry delay).')
        if self.attempts[-1]['ended'] is not None:
            self.report(f"Final transport event to model return={max(0,self.started+elapsed-self.attempts[-1]['ended']):.2f} s (includes response parsing).")
        if len(self.attempts)>1:
            self.report('Multiple HTTP attempts may include redirects or retries. Check the preceding response status.')
        metadata = getattr(response, 'usage_metadata', None)
        if metadata is not None:
            counts = []
            for key, label in (('prompt_token_count','input'),('candidates_token_count','output'),('thoughts_token_count','reasoning'),('cached_content_token_count','cached')):
                value = getattr(metadata, key, None)
                if type(value) is int:
                    counts.append(f'{label}={value}')
            if counts:
                self.report('Service-reported token counts: ' + ', '.join(counts) + '. Counts do not measure elapsed time or reveal reasoning content.')
