import unittest
import json
from agent.app.chat_outcome import ChatOutcome


class OutcomeTests(unittest.TestCase):
    def test_tool_failure_survives_later_success(self):
        turn = ChatOutcome()
        for value in ('failed', 'ok'):
            turn.observe('progress', f'工具結果：test；status={value}；executed=False。')
        turn.observe('answer', 'A partial result')
        self.assertEqual(turn.status, 'failed')

    def test_uncertain_and_cancelled_require_review(self):
        for value in ('unknown', 'cancelled', 'interrupted'):
            turn = ChatOutcome()
            turn.observe('progress', f'工具結果：test；status={value}；executed=unknown。')
            self.assertEqual(turn.status, 'needs_review')

    def test_model_failure_and_new_turn(self):
        turn = ChatOutcome()
        turn.observe('answer', 'Fallback notice: 模型請求失敗')
        self.assertEqual(turn.status, 'failed')
        self.assertEqual(ChatOutcome().status, 'completed')

    def test_cancellation_answer_does_not_override_needs_review(self):
        turn = ChatOutcome()
        turn.observe('progress', '工具結果：fixture；status=interrupted；executed=unknown。')
        turn.observe('answer', '工具已中斷；請核對工作狀態。')
        self.assertEqual(turn.status, 'needs_review')
        turn.observe('progress', '工具結果：fixture；status=failed；executed=unknown。')
        turn.observe('answer', '工具已中斷；請核對工作狀態。')
        self.assertEqual(turn.status, 'failed')

    def test_plan_is_not_failure_or_execution(self):
        turn = ChatOutcome()
        turn.observe('progress', '工具結果：test；status=prepared；executed=False。')
        self.assertEqual(turn.status, 'completed')
        self.assertIn('不代表分析已執行', turn.summary())

    def test_structured_activity_and_manual_review_codes_agree(self):
        for value in ('not_ready', 'awaiting_confirmation', 'needs_review', 'unrecognized_state'):
            turn = ChatOutcome()
            turn.observe('progress', f'工具結果：fixture；status={value}；executed=False。')
            self.assertEqual(turn.status, 'needs_review')
        for value, expected in [('running', 'completed'), ('completed', 'completed'),
                                ('failed', 'failed'), ('cancelled', 'needs_review'), ('needs_review', 'needs_review')]:
            turn = ChatOutcome()
            turn.observe('progress', 'SIGNET_TOOL ' + json.dumps({'status': value}))
            self.assertEqual(turn.status, expected)
        turn.observe('progress', 'SIGNET_TOOL {malformed')
