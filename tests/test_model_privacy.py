"""Capture outbound requests using synthetic sentinel records; no external model is called."""
import copy
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from google.genai import types

from agent.core import conversation
from agent.core.model_privacy import model_contents, safe_tool_result
from agent.providers.groq_client import groq_messages

PRIVATE = 'PRIVATE-PERSON-123'


def answer(text='Reviewed the safe summary.'):
    content = types.Content(role='model', parts=[types.Part.from_text(text=text)])
    return SimpleNamespace(text=text, function_calls=[], candidates=[SimpleNamespace(content=content)])


def call(name, args):
    fn = types.FunctionCall(id='call1', name=name, args=args)
    content = types.Content(role='model', parts=[types.Part(function_call=fn)])
    return SimpleNamespace(text='', function_calls=[fn], candidates=[SimpleNamespace(content=content)])


class ModelPrivacyTest(unittest.TestCase):
    def test_chat_confirmation_status_is_public_without_exposing_run_names(self):
        result = safe_tool_result('propose_hpc3_genotype', {
            'status': 'awaiting_confirmation', 'executed': False, 'run_id': PRIVATE})
        self.assertEqual(result['status'], 'awaiting_confirmation')
        self.assertFalse(result['executed'])
        self.assertNotIn(PRIVATE, json.dumps(result))

    def test_current_tool_evidence_is_projected_for_each_provider_transport(self):
        for transport in ('cli', 'gemini', 'groq'):
            with self.subTest(transport=transport):
                queue = iter([call('get_workspace_report', {'run_id': 'fixture', 'stage': 3}), answer()])
                requests = []
                def generate(**kwargs):
                    requests.append(copy.deepcopy(kwargs['contents']))
                    return next(queue)
                client = SimpleNamespace(transport=transport, models=SimpleNamespace(generate_content=generate))
                evidence = {'status': 'ok', 'state': 'completed', 'run_id': 'fixture', 'stage': 3,
                    'summary': {'outputs': [{'file': 'signet_gexp.data', 'rows': 509, 'columns': 95,
                        'private': PRIVATE}], 'raw_rows': [PRIVATE]}, 'log_tail': [PRIVATE],
                    'content': PRIVATE, 'reason': PRIVATE, 'sample_ids': [PRIVATE]}
                history = []
                with patch.object(conversation, 'dispatch_tool', return_value=evidence):
                    conversation.run_conversation(client, 'Explain this analysis.', history)
                serialized = json.dumps([part.model_dump(mode='json') for part in requests[1]], ensure_ascii=False)
                self.assertNotIn(PRIVATE, serialized)
                result = requests[1][-1].parts[0].function_response.response
                self.assertEqual(result['summary']['outputs'][0]['rows'], 509)
                self.assertEqual(history[-2].parts[0].function_response.response['content'], PRIVATE)
                # API and CLI adapters share the projected messages and cannot recover stripped fields.
                self.assertNotIn(PRIVATE, json.dumps(groq_messages(requests[1], 'Fixed instructions')))

    def test_restored_history_cannot_replay_private_tools_prose_arguments_or_attachments(self):
        old = [types.Content(role='user', parts=[types.Part.from_text(text='Keep chromosome 1.')]),
            types.Content(role='model', parts=[types.Part(function_call=types.FunctionCall(
                id='old', name='read_file', args={'path': '/data/' + PRIVATE}))]),
            types.Content(role='user', parts=[types.Part(function_response=types.FunctionResponse(
                id='old', name='read_file', response={'status': 'ok', 'content': PRIVATE}))]),
            types.Content(role='model', parts=[types.Part.from_text(text='The sample is ' + PRIVATE)]),
            types.Content(role='user', parts=[types.Part(inline_data=types.Blob(mime_type='image/png', data=PRIVATE.encode()))])]
        before = [item.model_dump(mode='json') for item in old]
        sent = []
        client = SimpleNamespace(models=SimpleNamespace(generate_content=lambda **kwargs: (sent.extend(kwargs['contents']) or answer())))
        conversation.run_conversation(client, 'Continue with safe statistics.', old,
            workspace_context={'dataset_id': 'fixture', 'stage': 3, 'selected_genes': [PRIVATE], 'private': PRIVATE})
        serialized = json.dumps([item.model_dump(mode='json') for item in sent])
        self.assertNotIn(PRIVATE, serialized)
        self.assertIn('Keep chromosome 1.', serialized)
        self.assertEqual([item.model_dump(mode='json') for item in old[:-2]], before)

    def test_mixed_text_and_tool_parts_cannot_smuggle_file_payloads(self):
        parts = [types.Part(text='User intent remains.', inline_data=types.Blob(
            mime_type='text/plain', data=PRIVATE.encode())),
            types.Part(function_call=types.FunctionCall(id='safe', name='get_workspace_report',
                args={'run_id': 'fixture', 'stage': 3}), inline_data=types.Blob(
                    mime_type='text/plain', data=PRIVATE.encode()))]
        projected = model_contents([types.Content(role='user', parts=[parts[0]]),
                                    types.Content(role='model', parts=[parts[1]])])
        self.assertIn('User intent remains.', str(projected))
        for item in projected:
            for part in item.parts:
                self.assertIsNone(part.inline_data)
                self.assertIsNone(part.file_data)
        self.assertNotIn(PRIVATE, json.dumps([item.model_dump(mode='json') for item in projected]))

    def test_legacy_visualization_tools_redirect_to_manual_stage_review(self):
        from agent.tools.registry import ALL_TOOLS
        from agent.tools.signet import dispatch_tool
        names = {fn.__name__ for fn in ALL_TOOLS}
        for name in ('get_visualization_workspace', 'propose_visualization_change'):
            self.assertNotIn(name, names)
            result = dispatch_tool(name, {})
            self.assertEqual(result['status'], 'needs_review')
            self.assertFalse(result['executed'])
            self.assertIn('propose_workspace_stage', result['reason'])

    def test_execution_identifiers_use_stable_opaque_references_and_roundtrip_services(self):
        from agent.tools import workspace
        from agent.tools.signet import dispatch_tool
        from agent.core.model_privacy import resolve_model_references
        run = PRIVATE + '_run'
        dataset = PRIVATE + '_dataset'
        history = {'dataset_id': dataset, 'jobs': {'expression': {
            'state': 'completed', 'job_id': '42', 'attempt': 1}}}
        with patch.object(workspace.workspace, '_workspace_run', return_value=('root', history)) as lookup, \
                patch.object(workspace.signet, '_settings', return_value={}):
            first = dispatch_tool('get_workspace_stage', {'run_id': run, 'stage': 2})
            second = dispatch_tool('get_workspace_stage', {'run_id': first['run_id'], 'stage': 2})
        self.assertNotIn(PRIVATE, json.dumps([first, second]))
        self.assertEqual(first['run_id'], second['run_id'])
        self.assertEqual(resolve_model_references({'run_id': first['run_id']})['run_id'], run)
        self.assertEqual(resolve_model_references({'dataset_id': first['dataset_id']})['dataset_id'], dataset)
        self.assertEqual(lookup.call_args.args, (run,))
        # Aliasing is request evidence only: the original service record is unchanged.
        self.assertEqual(history['dataset_id'], dataset)

    def test_system_workspace_context_does_not_disclose_private_execution_names(self):
        from agent.core.model_privacy import model_workspace_context
        selection = {'dataset_id': PRIVATE + '_dataset', 'run_id': PRIVATE + '_run',
                     'history_id': 'workspace--' + PRIVATE, 'source': 'live', 'stage': 3,
                     'selected_genes': [PRIVATE]}
        sent = []
        client = SimpleNamespace(models=SimpleNamespace(generate_content=lambda **kwargs:
            (sent.append(kwargs['config'].system_instruction) or answer())))
        conversation.run_conversation(client, 'Review the current stage.', [], workspace_context=selection)
        self.assertNotIn(PRIVATE, sent[0])
        for key in ('dataset_id', 'run_id', 'history_id'):
            self.assertIn(model_workspace_context(selection)[key], sent[0])

    def test_reference_navigation_keeps_canonical_ui_payload_and_rejects_foreign_history(self):
        from agent.runtime.workspace_context import CHAT_CONTEXT
        from agent.tools.ui import UI_CHANNEL
        from agent.tools.signet import dispatch_tool
        identity = 'workspace--' + PRIVATE
        reference = safe_tool_result('get_workspace_stage', {'history_id': identity})['history_id']
        foreign = safe_tool_result('get_workspace_stage', {'history_id': 'workspace--foreign'})['history_id']
        sent = []
        context = CHAT_CONTEXT.set((SimpleNamespace(history=lambda: {'runs': [{'history_id': identity}]}), 'session'))
        channel = UI_CHANNEL.set(sent.append)
        try:
            result = dispatch_tool('navigate_workspace', {'action': 'view_stage', 'history_id': reference, 'stage': 3})
            rejected = dispatch_tool('navigate_workspace', {'action': 'view_stage', 'history_id': foreign, 'stage': 3})
        finally:
            UI_CHANNEL.reset(channel)
            CHAT_CONTEXT.reset(context)
        self.assertEqual(sent[0]['workspace_action']['history_id'], identity)
        self.assertEqual(len(sent), 1)
        self.assertEqual(result['workspace_action']['history_id'], reference)
        self.assertNotIn(PRIVATE, json.dumps(result))
        self.assertEqual(rejected['status'], 'invalid')

    def test_stale_and_exhausted_references_fail_closed_without_runtime_calls(self):
        from agent.core import model_privacy
        from agent.tools.signet import dispatch_tool
        from agent.tools import workspace
        with patch.object(workspace.workspace, '_workspace_run') as lookup:
            result = dispatch_tool('get_workspace_stage', {'run_id': 'modelref-' + '0' * 32, 'stage': 3})
        self.assertEqual(result['status'], 'invalid')
        self.assertEqual(result['error_code'], 'stale_reference')
        lookup.assert_not_called()
        with patch.object(model_privacy, 'MAX_REFERENCES', 0):
            clean = safe_tool_result('get_workspace_stage', {'run_id': 'fresh_private_run_limit'})
        self.assertNotIn('run_id', clean)
        self.assertNotIn('fresh_private_run_limit', json.dumps(clean))

    def test_exceptions_never_echo_private_messages_and_counts_are_not_blanket_removed(self):
        from agent.tools.signet import dispatch_tool
        from agent.tools import workspace
        with patch.object(workspace.workspace, '_workspace_run', side_effect=ValueError(PRIVATE)):
            result = dispatch_tool('get_workspace_stage', {'run_id': 'fixture', 'stage': 3})
        self.assertNotIn(PRIVATE, json.dumps(result))
        self.assertEqual(result['error_code'], 'invalid_request')
        value = {'status': 'ok', 'stage': 3, 'review': {'clinical': {'matched': 509,
            'unknown_race_count': 5, 'race': {PRIVATE: 5}, 'columns': [PRIVATE],
            'diagnostics': [{'code': 'clinical_race_choice_required', 'stage': 3,
                            'severity': 'needs_review', 'count': 5, 'message': PRIVATE}]}}}
        clean = safe_tool_result('propose_workspace_stage', value)
        self.assertNotIn(PRIVATE, json.dumps(clean))
        self.assertEqual(clean['review']['clinical']['unknown_race_count'], 5)
        self.assertEqual(clean['review']['clinical']['diagnostics'][0]['code'], 'clinical_race_choice_required')

    def test_validation_and_setup_reports_keep_only_typed_statistics_and_fixed_labels(self):
        value = {'status': 'ok', 'dataset_id': 'fixture', 'validation': {'available': True,
            'checks': [{'kind': 'clinical', 'status': 'warning', 'paths': [PRIVATE],
                        'metrics': {'rows': 585, 'missing_race': 5, PRIVATE: 2},
                        'issues': [{'code': 'missing_covariates', 'stage': 3, 'severity': 'needs_review', 'message': PRIVATE}]}],
            'stage_readiness': {'1': {'status': 'ready'}, '3': {'status': 'needs_review'}},
            'pairing': {'matched_patients': 509, 'missing_race': 5, 'sample_ids': [PRIVATE]}}}
        clean = safe_tool_result('get_workspace_validation', value)
        self.assertNotIn(PRIVATE, json.dumps(clean))
        self.assertEqual(clean['validation']['stage_readiness']['1']['status'], 'ready')
        self.assertEqual(clean['validation']['pairing']['missing_race'], 5)
        setup = safe_tool_result('check_hpc_environment', {'status': 'ok', 'ready': False,
            'workspace': PRIVATE, 'checks': [{'item': 'slurm', 'status': 'missing', 'detail': PRIVATE}]})
        self.assertEqual(setup['checks'], [{'item': 'slurm', 'status': 'missing'}])
        self.assertNotIn(PRIVATE, json.dumps(setup))
        log = safe_tool_result('read_hpc_setup_log', {'status': 'ok', 'step': 'clinical', 'lines': ['cannot open ' + PRIVATE]})
        self.assertEqual(log['failure']['classifications'], ['missing_or_unreadable_file'])
        self.assertEqual(safe_tool_result('read_hpc_setup_log', log), log)
        for lines in ([], ['Download complete.'], [PRIVATE]):
            normal = safe_tool_result('read_hpc_setup_log', {'status': 'ok', 'lines': lines})
            self.assertNotIn('failure', normal)
            self.assertEqual(normal['diagnostic_status'], 'no_recognized_error')
            self.assertEqual(safe_tool_result('read_hpc_setup_log', normal), normal)
            self.assertNotIn(PRIVATE, json.dumps(normal))

    def test_arbitrary_error_fields_categorical_values_and_filenames_do_not_escape(self):
        clean = safe_tool_result('summarize_table', {'status': 'ok', 'rows': 2,
            'columns': ['race', PRIVATE], 'per_column': {'race': {'blank': 0,
            'values': {'asian': 1, PRIVATE: 1}}, PRIVATE: {'values': {PRIVATE: 1}}},
            'error': PRIVATE, 'images': [PRIVATE], 'stdout': PRIVATE})
        self.assertEqual(clean['per_column']['race']['values'], {'asian': 1})
        self.assertNotIn(PRIVATE, json.dumps(clean))
        files = safe_tool_result('list_files', {'files': [PRIVATE]})
        self.assertEqual(files['file_count'], 1)
        self.assertEqual(safe_tool_result('list_files', files), files)
        catalog = safe_tool_result('signet_catalog', {'status': 'ok', 'scripts': [PRIVATE]})
        self.assertNotIn(PRIVATE, json.dumps(catalog))


if __name__ == '__main__':
    unittest.main()


class LinkedAnalysisContextTest(unittest.TestCase):
    def test_linked_run_context_keeps_latest_selection_without_private_names(self):
        from agent.core.model_privacy import model_analysis_context, resolve_model_references
        source = [{'run_id': PRIVATE, 'number': 2, 'latest': True, 'from_step': 'adjust',
                   'changes': [{'before': PRIVATE}], 'reason': PRIVATE}]
        projected = model_analysis_context(source)
        self.assertNotIn(PRIVATE, json.dumps(projected))
        self.assertEqual(projected[0]['number'], 2)
        self.assertTrue(projected[0]['latest'])
        self.assertEqual(projected[0]['from_step'], 'adjust')
        self.assertEqual(resolve_model_references({'run_id': projected[0]['run_id']})['run_id'], PRIVATE)
        captured = []
        def generate(**kwargs):
            captured.append(kwargs['config'].system_instruction)
            return answer()
        client = SimpleNamespace(models=SimpleNamespace(generate_content=generate))
        conversation.run_conversation(client, 'Use the latest analysis.', [], context=source)
        self.assertNotIn(PRIVATE, captured[0])
        self.assertIn('"latest": true', captured[0])
