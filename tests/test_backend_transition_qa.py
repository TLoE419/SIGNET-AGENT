"""Adversarial integrated lifecycle probes; every scheduler/file is a temporary fixture."""
import json
import os
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from agent.app.chat_ui import ChatServer
from agent.runtime import signet_jobs as jobs, submission_recovery, workspace_genotype as workspace
from agent.runtime import workspace_rerun as rerun
import agent.tools.signet as signet
import test_signet_jobs as fixtures


class BackendTransitionQA(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.StepsTest()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.f.visualize_ready()
        signet._update(self.f.root, {'restrict.tcga.geno': '1', 'restrict.tcga': '1'})
        settings = signet._settings(self.f.root)
        snapshots = {'genotype': workspace.SNAPSHOT, 'expression': workspace.EXPRESSION_SNAPSHOT,
                     'adjust': workspace.ADJUST_SNAPSHOT, 'cis': workspace.CIS_SNAPSHOT,
                     'network': workspace.NETWORK_SNAPSHOT}
        for index, (name, snapshot) in enumerate(snapshots.items(), 1):
            record = jobs._load(self.f.root, name)
            record.update(job_id=str(100 + index), settings={key: settings[key] for key in jobs.STEPS[name].settings})
            jobs._save(self.f.root, record)
            path = self.f.root / snapshot
            saved = json.loads(path.read_text())
            saved.update(record)
            path.write_text(json.dumps(saved))
            for relative in jobs.STEPS[name].required + jobs.STEPS[name].needs:
                relative = jobs._resolve(relative, settings)
                for base in (self.f.root, self.f.remote_dir):
                    target = base / 'work' / relative
                    if not target.exists():
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_text('controlled upstream fixture\n')
        record = workspace.submit_visualize('step_test', {}, {'freq': .45, 'ntop': 1}, jobs.STEPS['visualize'].resources)
        self.f.finish_visualize(record)
        self.assertEqual(jobs.status('step_test', 'visualize', refresh=True)['state'], 'completed')

    def fresh_reader(self):
        server = ChatServer(('127.0.0.1', 0), Mock())
        self.addCleanup(server.server_close)
        return server

    def fork(self, step, name, settings=None):
        review = rerun.review('step_test', step)
        parameters = review['parameters']
        if settings is not None:
            parameters = {**parameters, 'settings': settings}
        return rerun.create('step_test', step, name, review['revision'], parameters)

    def submissions(self):
        return sum('sbatch --parsable' in call for call in self.f.calls)

    def unknown_claim_fixture(self, name):
        self.fork('network', name)
        self.f.slurm(sbatch_reply='779')
        record = rerun.submit(name, True)
        root = self.f.project / 'runs' / name
        record.pop('job_id')
        record['state'] = 'unknown'
        jobs._save(root, record)
        for command in ('squeue', 'sacct'):
            (self.f.fake / 'bin' / command).write_text('#!/bin/bash\necho "779|' + record['submission_token'] + '"\n')
        return root, record

    def test_all_six_completed_stage_forks_preserve_source_and_require_confirmation(self):
        original = {p: p.read_bytes() for p in self.f.root.rglob('*') if p.is_file()}
        for step in rerun.ORDER:
            with self.subTest(step=step):
                name = 'qa_' + step
                before = self.submissions()
                plan = self.fork(step, name)
                self.assertEqual(self.submissions(), before, 'Creating a fork must stay local')
                with self.assertRaises(jobs.StepError):
                    rerun.submit(name, False)
                self.assertEqual(self.submissions(), before)
                record = rerun.submit(name, True)
                self.assertEqual(record['state'], 'submitted')
                self.assertEqual(self.submissions(), before + 1)
                self.assertEqual(record['remote_dir'], plan['remote_dir'])
                with self.assertRaises(jobs.StepError):
                    rerun.submit(name, True)
                self.assertEqual(self.submissions(), before + 1, 'Repeated confirmation must not replay')
        self.assertEqual(original, {p: p.read_bytes() for p in original})

    def test_saved_fork_reloads_and_rejects_changed_source_before_late_confirmation(self):
        self.fork('visualize', 'qa_resume')
        before = self.submissions()
        first = self.fresh_reader().stage6.history()
        row = next(row for row in first['runs'] if row['history_id'] == 'workspace--qa_resume')
        self.assertEqual(row['status'], 'not_submitted')
        self.assertEqual(row['rerun']['source_run_id'], 'step_test')
        jobs.update_settings('step_test', {'freq': .6})
        second = self.fresh_reader().stage6.history()
        self.assertEqual(next(row for row in second['runs'] if row['history_id'] == 'workspace--qa_resume')['status'], 'not_submitted')
        with self.assertRaisesRegex(jobs.StepError, 'Source changed'):
            rerun.submit('qa_resume', True)
        self.assertEqual(self.submissions(), before)
        root = self.f.project / 'runs/qa_resume'
        self.assertFalse((root / 'steps/visualize.json').exists())
        self.assertFalse((root / '.active').exists())

    def test_edited_cis_fork_cannot_start_downstream_early_and_keeps_new_alpha(self):
        review = rerun.review('step_test', 'cis')
        parameters = review['parameters']
        settings = {**parameters['settings'], 'alpha.cis': .01}
        self.fork('cis', 'qa_cis', settings)
        before = self.submissions()
        with self.assertRaisesRegex(jobs.StepError, 'Complete the reviewed rerun'):
            jobs.submit('qa_cis', 'network', {})
        self.assertEqual(self.submissions(), before)
        record = rerun.submit('qa_cis', True)
        self.f.remote_dir = Path(record['remote_dir'])
        self.f.finish_cis('0.01')
        self.assertEqual(jobs.status('qa_cis', 'cis', refresh=True)['state'], 'completed')
        review = workspace.review_network('qa_cis')
        self.assertTrue(review['ready'], review['issues'])
        self.assertEqual(review['source_cis_alpha'], '0.01')
        network = workspace.submit_network('qa_cis', {}, review['settings'], review['resources'])
        self.assertEqual(network['state'], 'submitted')
        config = (self.f.remote_dir / 'work/config.ini').read_text()
        self.assertIn('signet_all.sig.pValue_0.01', config)
        self.assertEqual(jobs._load(self.f.root, 'cis')['settings']['alpha.cis'], '0.05')

    def test_unknown_fork_survives_fresh_readers_and_only_explicit_recovery_adopts(self):
        self.fork('network', 'qa_unknown')
        self.f.slurm(sbatch_reply='777')
        record = rerun.submit('qa_unknown', True)
        root = self.f.project / 'runs/qa_unknown'
        remote = Path(record['remote_dir'])
        record.pop('job_id')
        record['state'] = 'unknown'
        jobs._save(root, record)
        marker = remote / 'steps/network.job'
        marker.unlink()
        for command in ('squeue', 'sacct'):
            (self.f.fake / 'bin' / command).write_text('#!/bin/bash\necho "777|' + record['submission_token'] + '"\n')
        before = self.submissions()
        for _ in range(2):
            row = next(row for row in self.fresh_reader().stage6.history()['runs'] if row['history_id'] == 'workspace--qa_unknown')
            self.assertEqual(row['jobs']['network']['state'], 'unknown')
        self.assertEqual(jobs.status('qa_unknown', 'network', refresh=True)['state'], 'unknown')
        self.assertEqual(self.submissions(), before)
        with self.assertRaises(jobs.StepError):
            rerun.submit('qa_unknown', True)
        review = submission_recovery.reconcile('qa_unknown', 'network', expected_attempt=1, expected_job_id=None, action='review')
        self.assertEqual(review['recovery']['outcome'], 'adopt')
        self.assertFalse(marker.exists(), 'Review cannot repair or submit')
        adopted = submission_recovery.reconcile('qa_unknown', 'network', expected_attempt=1, expected_job_id=None, action='adopt', confirmed=True)
        self.assertTrue(adopted['applied'])
        self.assertEqual((adopted['record']['state'], adopted['record']['job_id']), ('submitted', '777'))
        self.assertEqual(marker.read_text(), '777\n')
        with self.assertRaises(jobs.StepError):
            submission_recovery.reconcile('qa_unknown', 'network', expected_attempt=1, expected_job_id=None, action='adopt', confirmed=True)
        self.assertEqual(self.submissions(), before)

    @unittest.skipUnless(hasattr(os, 'fork'), 'Crash probe requires an isolated local child process')
    def test_recovered_terminal_job_can_continue_after_submitter_process_crash(self):
        self.fork('network', 'qa_crash')
        self.f.slurm(sbatch_reply='778')
        child = os.fork()
        if child == 0:
            original_shell = jobs._shell
            def crash_after_fake_accept(script, **kwargs):
                result = original_shell(script, **kwargs)
                if 'sbatch --parsable' in script:
                    os._exit(17)
                return result
            try:
                with patch.object(jobs, '_shell', side_effect=crash_after_fake_accept):
                    rerun.submit('qa_crash', True)
            finally:
                os._exit(99)
        _, status = os.waitpid(child, 0)
        self.assertEqual(os.WEXITSTATUS(status), 17)
        root = self.f.project / 'runs/qa_crash'
        record = jobs._load(root, 'network')
        remote = Path(record['remote_dir'])
        self.assertEqual(record['state'], 'submitting')
        for command in ('squeue', 'sacct'):
            (self.f.fake / 'bin' / command).write_text('#!/bin/bash\necho "778|' + record['submission_token'] + '"\n')
        submission_recovery.reconcile('qa_crash', 'network', expected_attempt=1, expected_job_id=None, action='review')
        adopted = submission_recovery.reconcile('qa_crash', 'network', expected_attempt=1, expected_job_id=None, action='adopt', confirmed=True)
        self.assertTrue(adopted['applied'])
        self.assertFalse((root / '.active').exists())
        with self.assertRaisesRegex(jobs.StepError, 'still active'):
            jobs.update_settings('qa_crash', {'freq': .6})
        for command in ('squeue', 'sacct'):
            (self.f.fake / 'bin' / command).write_text('#!/bin/bash\n' + fixtures.FAKE_SLURM[command] + '\n')
        for relative in jobs.STEPS['network'].required:
            destination = remote / 'work' / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((self.f.root / 'work' / relative).read_bytes())
        (remote / 'steps/network.done').write_text('0 2026-11-17T17:00:00-08:00\n')
        self.f.slurm(squeue='', sacct='COMPLETED')
        self.assertEqual(jobs.status('qa_crash', 'network', refresh=True)['state'], 'completed')
        review = workspace.review_visualize('qa_crash', .45, 1)
        self.assertTrue(review['ready'], review['issues'])
        try:
            continued = workspace.submit_visualize('qa_crash', {}, review['settings'], review['resources'])
        except jobs.StepError as error:
            self.fail('Confirmed recovered terminal job cannot continue after its submitter died: ' + str(error))
        self.assertEqual(continued['state'], 'submitted')

    def test_recovery_preserves_legacy_nonregular_foreign_and_live_operation_claims(self):
        root, record = self.unknown_claim_fixture('qa_claim_guards')
        path = root / '.active'
        sentinel = root / 'unrelated'
        sentinel.write_text('preserve unrelated file')
        for kind in ('legacy', 'symlink', 'directory', 'fifo', 'live', 'alive_unlocked', 'foreign_attempt'):
            with self.subTest(kind=kind):
                descriptor = None
                if kind == 'legacy':
                    path.touch()
                elif kind == 'symlink':
                    path.symlink_to(sentinel)
                elif kind == 'directory':
                    path.mkdir()
                elif kind == 'fifo':
                    os.mkfifo(path)
                else:
                    descriptor = jobs._create_submission_claim(root, 'network', 2 if kind == 'foreign_attempt' else 1, record['submission_token'])
                    if kind != 'live':
                        os.close(descriptor)
                        descriptor = None
                try:
                    for action in ('review', 'adopt'):
                        if kind == 'symlink':
                            with self.assertRaises(jobs.StepError):
                                submission_recovery.reconcile(root.name, 'network', expected_attempt=1, expected_job_id=None, action=action, confirmed=action == 'adopt')
                        else:
                            with patch.object(jobs.os, 'kill', side_effect=ProcessLookupError if kind == 'foreign_attempt' else os.kill):
                                result = submission_recovery.reconcile(root.name, 'network', expected_attempt=1, expected_job_id=None, action=action, confirmed=action == 'adopt')
                            self.assertEqual(result['recovery']['outcome'], 'unresolved')
                            self.assertFalse(result['applied'])
                            self.assertEqual(result['record']['state'], 'unknown')
                    self.assertTrue(path.exists() or path.is_symlink())
                    self.assertEqual(sentinel.read_text(), 'preserve unrelated file')
                finally:
                    if descriptor is not None:
                        jobs._release_submission_claim(root, descriptor)
                    else:
                        path.rmdir() if kind == 'directory' else path.unlink()

    def test_recovery_cannot_release_replacement_claim_after_review(self):
        root, record = self.unknown_claim_fixture('qa_claim_race')
        path = root / '.active'
        descriptor = jobs._create_submission_claim(root, 'network', 1, record['submission_token'])
        os.close(descriptor)
        kept = os.open(path, os.O_RDONLY)
        self.addCleanup(os.close, kept)
        original = path.read_bytes()
        original_inode = path.stat().st_ino
        def replace_claim(*args):
            path.unlink()
            path.write_bytes(original)
            return True
        with patch.object(jobs.os, 'kill', side_effect=ProcessLookupError):
            result = submission_recovery.reconcile(root.name, 'network', expected_attempt=1, expected_job_id=None, action='review')
            self.assertEqual(result['recovery']['outcome'], 'adopt')
            with patch.object(submission_recovery, '_confirm_job_marker', side_effect=replace_claim):
                result = submission_recovery.reconcile(root.name, 'network', expected_attempt=1, expected_job_id=None, action='adopt', confirmed=True)
        self.assertFalse(result['applied'])
        self.assertEqual(result['record']['state'], 'unknown')
        self.assertEqual(result['recovery']['outcome'], 'unresolved')
        self.assertNotEqual(path.stat().st_ino, original_inode)
        self.assertEqual(path.read_bytes(), original)

    def test_finishing_submission_does_not_unlink_a_replacement_legacy_claim(self):
        self.fork('network', 'qa_claim_finish')
        root = self.f.project / 'runs/qa_claim_finish'
        path = root / '.active'
        original_shell = jobs._shell
        def replace_after_accept(script, **kwargs):
            result = original_shell(script, **kwargs)
            if 'sbatch --parsable' in script:
                path.unlink()
                path.write_text('new legacy owner')
            return result
        with patch.object(jobs, '_shell', side_effect=replace_after_accept):
            result = rerun.submit('qa_claim_finish', True)
        self.assertEqual(result['state'], 'submitted')
        self.assertEqual(path.read_text(), 'new legacy owner')
