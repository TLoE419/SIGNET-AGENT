"""Controlled service seams: no SSH, model calls or scientific processes."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from agent.tools import workspace as tools
from agent.tools.signet import dispatch_tool
from agent.tools.registry import ALL_TOOLS


class WorkspaceAgentTest(unittest.TestCase):
    def test_model_cannot_execute_legacy_science(self):
        names = {fn.__name__ for fn in ALL_TOOLS}
        self.assertFalse(names & tools.LEGACY_EXECUTION)
        # The chat-card tools were replaced by the Analysis forms; old saved calls are redirected there.
        self.assertFalse({'configure_signet', 'propose_hpc3_genotype'} & names)
        self.assertTrue({'get_workspace_stage', 'propose_workspace_stage', 'get_network_genes', 'get_step_report'} <= names)
        for name in ('configure_signet', 'propose_hpc3_genotype'):
            result = dispatch_tool(name, {'run_id': 'fixture'})
            self.assertEqual((result['status'], result['executed']), ('needs_review', False))
            self.assertIn('Stage 1 form', result['reason'])
        for name in tools.LEGACY_EXECUTION:
            with self.subTest(name=name), patch('subprocess.Popen') as execute:
                result = dispatch_tool(name, {'run_id': 'fixture', 'confirmed': True})
                self.assertEqual(result['status'], 'needs_review')
                self.assertFalse(result['executed'])
                execute.assert_not_called()

    def test_status_is_local_source_and_attempt_aware(self):
        history = {'dataset_id': 'fixture', 'jobs': {'expression': {
            'state': 'unknown', 'attempt': 3, 'job_id': '42', 'settings': {}, 'private': 'omit'}}}
        with patch.object(tools.workspace, '_workspace_run', return_value=('root', history)), \
                patch.object(tools.signet, '_settings', return_value={'restrict.tcga': '1'}), \
                patch.object(tools.jobs, '_shell') as remote:
            result = tools.get_workspace_stage('fixture', 2)
        self.assertEqual(result['attempt'], 3)
        self.assertEqual(result['state'], 'unknown')
        self.assertEqual(result['settings'], {'restrict.tcga': '1'})
        self.assertNotIn('private', result['job'])
        remote.assert_not_called()

    def test_all_six_proposals_reuse_manual_review_services(self):
        methods = ('review_genotype_retry', 'review_expression', 'review_adjust',
                   'review_cis', 'review_network', 'review_visualize')
        for stage, method in enumerate(methods, 1):
            state = {'job': {'job_id': '42', 'attempt': 2}, 'history_id': 'workspace--fixture', 'stage': stage}
            with self.subTest(stage=stage), patch.object(tools, 'get_workspace_stage', return_value=state), \
                    patch.object(tools.workspace, method, return_value={'ready': False, 'issues': ['missing']}) as review, \
                    patch.object(tools.jobs, 'submit') as submit:
                result = tools.propose_workspace_stage('fixture', stage)
                self.assertEqual(result['status'], 'needs_review')
                self.assertFalse(result['executed'])
                self.assertFalse(result['review']['ready'])
                self.assertEqual(result['workspace_action']['stage'], stage)
                review.assert_called_once_with('fixture', '42', 2) if stage == 1 else review.assert_called_once_with('fixture')
                submit.assert_not_called()

    def test_initial_dataset_review_and_service_errors(self):
        with patch('agent.runtime.workspace_validation._saved', return_value={'inputs': {'genotype': ['fixture']}}), \
                patch.object(tools.workspace, 'review_dataset', return_value={'ready': True}) as review:
            result = tools.propose_workspace_dataset('fixture')
            self.assertFalse(result['executed'])
            review.assert_called_once_with('fixture', {'genotype': ['fixture']})
        with patch.object(tools.workspace, '_workspace_run', side_effect=tools.jobs.StepError('not_found', 'missing')):
            result = dispatch_tool('get_workspace_stage', {'run_id': 'fixture', 'stage': 2})
            self.assertEqual(result['status'], 'invalid')
            self.assertFalse(result['executed'])

    def test_reject_foreign_sources_invalid_stages_and_changed_attempt(self):
        for stage in (0, 7, True, '1'):
            with self.assertRaises(ValueError):
                tools.get_workspace_stage('fixture', stage)
        with self.assertRaises(ValueError):
            tools.get_workspace_stage('fixture', 1, 'archive')
        with patch.object(tools, 'get_workspace_stage', side_effect=[{'job': {'attempt': 1}}, {'job': {'attempt': 2}}]), \
                patch.object(tools.workspace, 'review_expression', return_value={}):
            with self.assertRaises(ValueError):
                tools.propose_workspace_stage('fixture', 2)

    def test_first_attempt_retry_and_proposal_navigation_emit_once(self):
        from agent.runtime.workspace_context import CHAT_CONTEXT
        from agent.tools.ui import UI_CHANNEL
        history = {'dataset_id': 'fixture', 'jobs': {'genotype': {
            'step': 'genotype', 'run_id': 'fixture', 'job_id': '42', 'state': 'failed'}}}
        sent = []
        context = CHAT_CONTEXT.set((SimpleNamespace(history=lambda: {'runs': [{'history_id': 'workspace--fixture'}]}), 'session'))
        channel = UI_CHANNEL.set(sent.append)
        try:
            with patch.object(tools.workspace, '_workspace_run', return_value=('root', history)), \
                    patch.object(tools.signet, '_settings', return_value={}), \
                    patch.object(tools.workspace, 'review_genotype_retry', return_value={'ready': True}) as review, \
                    patch.object(tools.jobs, 'submit') as submit:
                result = tools.propose_workspace_stage('fixture', 1)
            review.assert_called_once_with('fixture', '42', 1)
            submit.assert_not_called()
            self.assertEqual(result['attempt'], 1)
            self.assertEqual(sent, [{'workspace_action': result['workspace_action']}])
        finally:
            UI_CHANNEL.reset(channel)
            CHAT_CONTEXT.reset(context)


if __name__ == '__main__':
    unittest.main()
