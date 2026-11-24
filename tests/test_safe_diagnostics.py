"""Synthetic checks of the boundary between private reviews and model reports."""
import json
import unittest
from unittest.mock import patch

from agent.runtime import step_report
from agent.tools import workspace
import test_signet_jobs as fixtures


class SafeDiagnosticsTest(unittest.TestCase):
    def test_clinical_unknown_counts_have_no_category_values_or_private_text(self):
        review = {'columns': ['submitter_id', 'race', 'gender', 'PRIVATE-COLUMN'],
                  'rows': 12, 'matched': 10, 'clinical_matched': 9,
                  'unrecognized_race': {'PRIVATE-PATIENT-CATEGORY': 5},
                  'needs_choice': ['PRIVATE-PATIENT-CATEGORY'], 'retained': 4, 'excluded': 0,
                  'gender_groups': 2, 'race': {'PRIVATE-PATIENT-CATEGORY': 5},
                  'issues': ['PRIVATE-PATIENT: fix this'], 'source': '/PRIVATE-PATH/file.tsv'}
        result = step_report.safe_clinical_review(review)
        self.assertEqual(result['unknown_race_count'], 5)
        self.assertEqual(result['unhandled_race_count'], 5)
        self.assertEqual(result['needs_choice_count'], 1)
        self.assertEqual(result['gender_group_count'], 2)
        self.assertEqual({issue['code'] for issue in result['diagnostics']},
                         {'clinical_coverage', 'clinical_race_choice_required'})
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_missing_columns_do_not_fabricate_covariate_or_coverage_counts(self):
        result = step_report.safe_clinical_review({'columns': ['race'], 'matched': 0,
            'clinical_matched': 0, 'missing_gender': 2, 'gender_groups': 1, 'races_after': {}})
        self.assertEqual([entry['code'] for entry in result['diagnostics']], ['clinical_columns'])
        self.assertNotIn('clinical_matched', result)
        self.assertNotIn('missing_gender', result)
        self.assertNotIn('unknown_race_count', result)

    def test_clinical_checks_report_measured_group_problems(self):
        result = step_report.safe_clinical_review({'columns': ['submitter_id', 'race', 'gender'],
            'matched': 0, 'missing_gender': 2, 'gender_groups': 1, 'races_after': {}})
        codes = {entry['code'] for entry in result['diagnostics']}
        self.assertTrue({'clinical_pairing_empty', 'clinical_missing_gender', 'clinical_gender_groups'} <= codes)

    def test_missing_clinical_review_is_unavailable_instead_of_zero_counts(self):
        self.assertEqual(step_report.safe_clinical_review(None), {'available': False})
        result = step_report.safe_clinical_review({'issues': ['PRIVATE unrecognized failure']})
        self.assertNotIn('matched', result)
        self.assertEqual(result['diagnostics'][0]['code'], 'stage_input_review_required')
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_invalid_numbers_and_unknown_fields_do_not_cross_the_boundary(self):
        result = step_report.safe_clinical_review({'rows': True, 'matched': -1,
            'retained': 2 ** 60, 'excluded': 'PRIVATE',
            'unrecognized_race': {'PRIVATE': 'PRIVATE'}, 'private': 'PRIVATE'})
        for key in ('rows', 'matched', 'retained', 'excluded'):
            self.assertNotIn(key, result)
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_dataset_report_keeps_stage_status_counts_and_drops_details(self):
        result = step_report.safe_input_validation({'status': 'warning',
            'inputs': {'clinical': ['/PRIVATE/source']},
            'checks': [{'kind': 'clinical', 'paths': ['/PRIVATE/source'], 'status': 'passed',
                'metrics': {'rows': 20, 'missing_race': 5, 'private': 'PRIVATE'},
                'issues': [{'code': 'PRIVATE-CODE', 'message': 'PRIVATE', 'line': 8}]}],
            'pairing': {'status': 'passed', 'matched_patients': 10, 'private': 'PRIVATE'},
            'stage_readiness': {'1': {'status': 'ready', 'issues': []},
                '3': {'status': 'needs_review', 'issues': [{'code': 'clinical_race_choice_required',
                      'severity': 'needs_review', 'stage': 3, 'message': 'PRIVATE', 'count': 5}]}}})
        self.assertEqual(result['scope'], 'preliminary_before_qc')
        self.assertEqual(result['checks'][0]['metrics']['missing_race'], 5)
        self.assertEqual(result['stage_readiness']['3']['status'], 'needs_review')
        self.assertEqual(result['checks'][0]['issues'][0]['code'], 'unclassified_input_issue')
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertNotIn('line', result['checks'][0]['issues'][0])

    def test_malformed_diagnostic_objects_fail_closed(self):
        result = step_report.safe_input_validation({'checks': [{'kind': 'clinical',
            'issues': [{'code': ['PRIVATE'], 'message': 'PRIVATE'}, None]}],
            'pairing': 'PRIVATE', 'stage_readiness': {'3': 'PRIVATE'}})
        self.assertEqual(result['checks'][0]['issues'][0]['code'], 'unclassified_input_issue')
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_failure_types_do_not_claim_to_identify_the_patient_or_covariate(self):
        for text, code in [('number of levels differs', 'classification_count_mismatch'),
            ('contrasts can be applied only to factors with 2 or more levels', 'insufficient_covariate_groups'),
            ('NA/NaN/Inf', 'invalid_numeric_values'),
            ('non-conformable arguments', 'matrix_shape_mismatch'),
            ('cannot allocate vector', 'resource_memory_limit')]:
            with self.subTest(code=code):
                result = step_report.failure_summary({'state': 'failed',
                    'failure_hints': ['Error in /PRIVATE/patient: ' + text]})
                self.assertEqual(result['classifications'][0], code)
                self.assertIn(code, step_report.FAILURE_CODES)
                self.assertEqual(result['next_action'], 'inspect_private_diagnostics')
                self.assertNotIn('PRIVATE', json.dumps(result))

    def test_unknown_failure_stays_unknown_and_private(self):
        result = step_report.failure_summary({'state': 'failed',
            'failure_hints': ['PRIVATE completely new failure'], 'reason': 'PRIVATE'})
        self.assertEqual(result['classifications'], ['unclassified_failure'])
        self.assertEqual(result['evidence'], 'unclassified')
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_runtime_collects_a_known_error_even_with_zero_exit_and_present_outputs(self):
        fixture = fixtures.StepsTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        jobs = workspace.jobs
        jobs.submit('step_test', 'expression', fixture.inputs)
        fixture.finish_job(err='Error: cannot allocate vector of size PRIVATE\n')
        saved = jobs.status('step_test', 'expression', refresh=True)
        self.assertEqual(saved['state'], 'failed')
        self.assertEqual(saved['exit_code'], '0')
        public = step_report.failure_summary(saved)
        self.assertIn('resource_memory_limit', public['classifications'])
        # The masked log tail is the only place log text reaches the model.
        self.assertEqual(public['log_tail'][-1], 'Error: cannot allocate vector of size PRIVATE')
        self.assertNotIn('PRIVATE', json.dumps({key: value for key, value in public.items() if key != 'log_tail'}))

    def test_model_validation_tool_calls_controlled_checker_without_analysis(self):
        with patch('agent.runtime.workspace_validation._saved', return_value={'inputs': {'clinical': ['/PRIVATE']}}), \
                patch('agent.runtime.workspace_validation.validate', return_value={'status': 'warning',
                    'pairing': {'status': 'passed', 'matched_patients': 509}}) as validate, \
                patch.object(workspace.jobs, 'submit') as submit:
            result = workspace.get_workspace_validation('fixture')
        validate.assert_called_once_with('fixture', {'clinical': ['/PRIVATE']})
        submit.assert_not_called()
        self.assertFalse(result['executed'])
        self.assertEqual(result['validation']['pairing']['matched_patients'], 509)
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_model_stage3_proposal_has_safe_clinical_summary(self):
        result = workspace._public_review({'ready': False, 'issues': ['PRIVATE'],
            'clinical': {'matched': 514, 'clinical_matched': 514,
                'unrecognized_race': {'PRIVATE': 5}, 'needs_choice': ['PRIVATE']}}, 3)
        self.assertEqual(result['clinical']['unknown_race_count'], 5)
        self.assertEqual(result['diagnostics'][0]['code'], 'clinical_race_choice_required')
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_valid_clinical_summary_does_not_hide_other_review_blockers(self):
        result = workspace._public_review({'ready': False, 'issues': ['PRIVATE environment failure'],
            'clinical': {'columns': ['submitter_id', 'race', 'gender'], 'matched': 5,
                'clinical_matched': 5, 'gender_groups': 2,
                'races_after': {'asian': 1, 'black or african american': 2, 'white': 2}}}, 3)
        self.assertEqual(result['diagnostics'][0]['code'], 'stage_input_review_required')
        self.assertNotIn('PRIVATE', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
