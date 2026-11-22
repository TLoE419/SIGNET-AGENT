"""Conservative turn outcomes; completion refers to chat, never scientific validity."""
import json
import re
from agent.core.tool_status import activity_status

STOPPED_NOTICE = 'Response stopped.'


class ChatOutcome:
    def __init__(self):
        self.status = 'completed'

    def observe(self, kind, text):
        status = None
        if kind == 'error':
            status = 'needs_review'
        elif kind == 'progress':
            if text.startswith('SIGNET_TOOL '):
                try:
                    value = json.loads(text[12:]).get('status')
                except (ValueError, AttributeError):
                    value = None
                if isinstance(value, str) and value in {'failed', 'cancelled', 'needs_review'}:
                    status = 'failed' if value == 'failed' else 'needs_review'
            else:
                match = re.match(r'^Tool result: .*; status=([^;]+);', text)
                if match:
                    value = activity_status(match[1])
                    if value != 'completed':
                        status = 'failed' if value == 'failed' else 'needs_review'
        elif kind == 'answer' and re.search(r'^(?:A tool was interrupted|Stopped waiting for the model)', text, re.MULTILINE):
            status = 'needs_review'
        elif kind == 'answer' and re.search(r'^(?:Model request failed|The estimated input is|The model did not return complete content|'
                                                  r'The model did not produce a valid answer|The answer repair returned tool calls|'
                                                  r'Tool-round limit reached|Too many tool calls)', text, re.MULTILINE):
            status = 'failed'
        if status and self.status != 'failed':
            self.status = status

    def summary(self):
        return {'completed': 'Turn finished. Check the analysis status for execution and verification.',
                'failed': 'Turn failed. Partial answers and tool activity were retained.',
                'cancelled': STOPPED_NOTICE,
                'needs_review': 'Turn needs review. Partial output was retained. Check the run status before retrying.'}[self.status]
