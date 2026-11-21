import unittest
import json
from agent.app.chat_outcome import ChatOutcome


class OutcomeTests(unittest.TestCase):
    def test_tool_failure_survives_later_success(self):
        turn = ChatOutcome()
        for value in ('failed', 'ok'):
            turn.observe('progress', f'Tool result: test; status={value}; executed=False.')
        turn.observe('answer', 'A partial result')
        self.assertEqual(turn.status, 'failed')

    def test_uncertain_and_cancelled_require_review(self):
        for value in ('unknown', 'cancelled', 'interrupted'):
            turn = ChatOutcome()
            turn.observe('progress', f'Tool result: test; status={value}; executed=unknown.')
            self.assertEqual(turn.status, 'needs_review')

    def test_model_failure_and_new_turn(self):
        turn = ChatOutcome()
        turn.observe('answer', 'Fallback notice\n\nModel request failed.')
        self.assertEqual(turn.status, 'failed')
        self.assertEqual(ChatOutcome().status, 'completed')

    def test_cancellation_answer_does_not_override_needs_review(self):
        turn = ChatOutcome()
        turn.observe('progress', 'Tool result: fixture; status=interrupted; executed=unknown.')
        turn.observe('answer', 'A tool was interrupted. Check the run status.')
        self.assertEqual(turn.status, 'needs_review')
        turn.observe('progress', 'Tool result: fixture; status=failed; executed=unknown.')
        turn.observe('answer', 'A tool was interrupted. Check the run status.')
        self.assertEqual(turn.status, 'failed')

    def test_plan_is_not_failure_or_execution(self):
        turn = ChatOutcome()
        turn.observe('progress', 'Tool result: test; status=prepared; executed=False.')
        self.assertEqual(turn.status, 'completed')
        self.assertIn('Check the analysis status for execution and verification', turn.summary())

    def test_structured_activity_and_manual_review_codes_agree(self):
        for value in ('not_ready', 'awaiting_confirmation', 'needs_review', 'unrecognized_state'):
            turn = ChatOutcome()
            turn.observe('progress', f'Tool result: fixture; status={value}; executed=False.')
            self.assertEqual(turn.status, 'needs_review')
        for value, expected in [('running', 'completed'), ('completed', 'completed'),
                                ('failed', 'failed'), ('cancelled', 'needs_review'), ('needs_review', 'needs_review')]:
            turn = ChatOutcome()
            turn.observe('progress', 'SIGNET_TOOL ' + json.dumps({'status': value}))
            self.assertEqual(turn.status, expected)
        turn.observe('progress', 'SIGNET_TOOL {malformed')
