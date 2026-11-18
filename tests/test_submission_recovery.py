"""Offline recovery evidence tests, including real login script execution in fixtures."""
from unittest.mock import patch
import test_signet_jobs as fixtures
from agent.runtime import signet_jobs as jobs, submission_recovery as recovery


class RecoveryTest(fixtures.StepsTest):
    # Inherit fixture helpers, not the unrelated test suite.
    def uncertain(self, receipt='accepted 12345', candidates='12345', marker='12345'):
        record = jobs.submit('step_test', 'expression', self.inputs)
        record.pop('job_id', None)
        record['state'] = 'unknown'
        jobs._save(self.root, record)
        (self.remote_dir / f'steps/expression.submission.{record["submission_token"]}').write_text(receipt + '\n')
        job = self.remote_dir / 'steps/expression.job'
        job.write_text(marker) if marker else job.unlink(missing_ok=True)
        for command in ('squeue', 'sacct'):
            path = self.fake / 'bin' / command
            path.write_text('#!/bin/bash\n' + ''.join(f"echo '{id}|{record['submission_token']}'\n" for id in candidates.split()))
        return record

    def call(self, action='review', **kwargs):
        return recovery.reconcile('step_test', 'expression', expected_attempt=1,
                                  expected_job_id=None, action=action, **kwargs)

    def test_review_and_adopt_never_submits(self):
        self.uncertain()
        before = len(self.calls)
        self.assertEqual(self.call()['recovery']['outcome'], 'adopt')
        self.assertEqual(jobs.status('step_test', 'expression', True)['state'], 'unknown')
        result = self.call('adopt', confirmed=True)
        self.assertTrue(result['applied'])
        self.assertEqual(result['record']['job_id'], '12345')
        self.assertEqual(len(result['record']['submission_checks']), 2)
        self.assertFalse(any('sbatch --parsable' in call or 'scancel ' in call for call in self.calls[before:]))

    def test_prepared_receipt_with_unique_scheduler_comment_can_adopt(self):
        self.uncertain('prepared', marker='')
        self.assertEqual(self.call()['recovery']['outcome'], 'adopt')

    def test_missing_or_multiple_scheduler_evidence_stays_blocked(self):
        self.uncertain(candidates='12345 67890')
        self.assertEqual(self.call()['recovery']['outcome'], 'unresolved')
        self.assertFalse(self.call('adopt', confirmed=True)['applied'])
        self.assertEqual(jobs._load(self.root, 'expression')['state'], 'unknown')

    def test_explicit_rejection_requires_review_then_unlocks_normal_retry_only(self):
        self.uncertain('rejected', candidates='', marker='')
        self.assertFalse(self.call('unsubmitted', confirmed=True)['applied'])
        self.assertEqual(self.call()['recovery']['outcome'], 'unsubmitted')
        result = self.call('unsubmitted', confirmed=True)
        self.assertTrue(result['applied'])
        self.assertEqual(result['record']['state'], 'failed')
        self.assertNotIn('job_id', result['record'])
        for command in ('squeue', 'sacct'):
            (self.fake / 'bin' / command).write_text('#!/bin/bash\n' + fixtures.FAKE_SLURM[command] + '\n')
        # A later explicit normal submission gets a new attempt and preserves the receipt.
        retried = jobs.submit('step_test', 'expression', self.inputs)
        self.assertEqual(retried['attempt'], 2)
        self.assertNotEqual(retried['submission_token'], result['record']['submission_token'])
        self.assertTrue((self.root / 'steps/expression.attempt1.json').is_file())

    def test_empty_scheduler_is_never_proof_of_non_submission(self):
        self.uncertain('prepared', candidates='', marker='')
        self.assertEqual(self.call()['recovery']['outcome'], 'unresolved')

    def test_query_failure_and_foreign_owner_remain_unresolved(self):
        self.uncertain()
        (self.fake / 'bin/sacct').write_text('#!/bin/bash\nexit 1\n')
        self.assertEqual(self.call()['recovery']['outcome'], 'unresolved')
        (self.remote_dir / '.owner').write_text('foreign')
        self.assertEqual(self.call()['recovery']['outcome'], 'unresolved')

    def test_changed_target_and_missing_confirmation_are_rejected(self):
        self.uncertain()
        with self.assertRaises(jobs.StepError):
            recovery.reconcile('step_test', 'expression', expected_attempt=2, expected_job_id=None, action='review')
        with self.assertRaises(jobs.StepError):
            self.call('adopt')
        self.assertEqual(jobs._load(self.root, 'expression')['state'], 'unknown')

    def test_review_does_not_authorize_changed_evidence(self):
        self.uncertain()
        self.call()
        with patch.object(recovery, '_probe', return_value=('adopt', '67890', {})):
            self.assertFalse(self.call('adopt', confirmed=True)['applied'])

    def test_real_remote_rejection_receipt_survives_lost_reply(self):
        (self.fake / 'bin/sbatch').write_text('#!/bin/bash\nexit 1\n')
        shell = jobs._shell
        def lose_reply(script, **kwargs):
            result = shell(script, **kwargs)
            if 'sbatch --parsable' in script:
                raise OSError('lost after remote refusal')
            return result
        with patch.object(jobs, '_shell', side_effect=lose_reply):
            record = jobs.submit('step_test', 'expression', self.inputs)
        self.assertEqual(record['state'], 'unknown')
        self.assertEqual(self.call()['recovery']['outcome'], 'unsubmitted')
        self.assertTrue(self.call('unsubmitted', confirmed=True)['applied'])

    def test_foreign_markers_old_jobs_and_incomplete_queries_cannot_unlock(self):
        record = self.uncertain()
        for values in (
            {'receipt': 'accepted 12345', 'marker': '67890', 'candidates': '12345'},
            {'receipt': 'rejected', 'marker': '', 'candidates': '12345'},
            {'receipt': 'rejected'},
        ):
            with self.subTest(values=values), patch.object(jobs, '_shell', return_value=(0, values, [])):
                self.assertEqual(recovery._probe(self.root, record)[0], 'unresolved')
        record['previous_job_id'] = '12345'
        self.assertEqual(recovery._probe(self.root, record)[0], 'unresolved')

    def test_legacy_attempt_requires_manual_external_investigation(self):
        self.uncertain()
        record = jobs._load(self.root, 'expression')
        record.pop('submission_token')
        jobs._save(self.root, record)
        self.assertEqual(self.call()['recovery']['outcome'], 'unresolved')

# unittest discovers inherited test methods too; this module runs only new cases.
for name in list(vars(fixtures.StepsTest)):
    if name.startswith('test_') and name not in vars(RecoveryTest):
        setattr(RecoveryTest, name, None)
