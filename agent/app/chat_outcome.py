"""Conservative turn outcomes; completion refers to chat, never scientific validity."""
import re


class ChatOutcome:
    def __init__(self):
        self.status = 'completed'

    def observe(self, kind, text):
        status = None
        if kind == 'error':
            status = 'needs_review'
        elif kind == 'progress':
            match = re.search(r'工具結果：.*；status=([^；]+)；', text)
            if match:
                value = match[1]
                if value in {'error', 'failed', 'verification_failed', 'timeout', 'timed_out', 'invalid', 'blocked', 'unavailable'}:
                    status = 'failed'
                elif value in {'unknown', 'interrupted', 'cancelled', 'needs_review', 'skipped'}:
                    status = 'needs_review'
        elif kind == 'answer' and re.search(r'模型請求失敗|精簡後輸入估算|模型未回傳完整內容|模型未產生有效回答|模型補答時|已達工具呼叫輪數|單輪工具呼叫|工具已中斷|已中斷等待模型', text):
            status = 'failed'
        if status and (self.status == 'completed' or status == 'needs_review'):
            self.status = status

    def summary(self):
        return {'completed': '回合結束；不代表分析已執行或通過驗證。',
                'failed': '回合失敗；部分回答與工具紀錄已保留。',
                'needs_review': '回合需要確認；部分輸出已保留，請核對工作狀態，勿直接重送。'}[self.status]
