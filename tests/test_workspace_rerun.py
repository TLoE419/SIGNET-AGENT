"""Offline linked-run safety tests using the local fake scheduler."""
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess
import threading
import unittest
from unittest.mock import patch
import test_signet_jobs as fixtures
from agent.runtime import workspace_rerun as rerun
from agent.runtime import signet_jobs as jobs
import agent.tools.signet as signet


class RerunTest(unittest.TestCase):
    setUp = fixtures.StepsTest.setUp
    remote = fixtures.StepsTest.remote
    slurm = fixtures.StepsTest.slurm
    finish_job = fixtures.StepsTest.finish_job

    def completed(self):
        record = jobs.submit('step_test', 'expression', self.inputs)
        from pathlib import Path
        self.remote_dir = Path(record['remote_dir'])
        self.finish_job()
        jobs.status('step_test', 'expression', refresh=True)
        return rerun.review('step_test', 'expression')

    def test_fork_preserves_source_and_requires_separate_confirmation(self):
        preview = self.completed()
        before = {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with patch.object(jobs, '_shell', side_effect=AssertionError('create must stay local')):
            plan = rerun.create('step_test', 'expression', 'branch_run', preview['revision'], preview['parameters'])
        self.assertEqual(plan['invalidated'], ['expression', 'adjust', 'cis', 'network', 'visualize'])
        self.assertFalse((self.project / 'runs/branch_run/steps/expression.json').exists())
        self.assertEqual(before, {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob('*') if p.is_file()})
        with self.assertRaises(jobs.StepError):
            rerun.submit('branch_run', False)
        result = rerun.submit('branch_run', True)
        self.assertEqual(result['state'], 'submitted')
        with self.assertRaises(jobs.StepError):
            rerun.submit('branch_run', True)

    def test_stale_review_and_invalid_edits_do_not_create_run(self):
        preview = self.completed()
        for revision, params in [('stale', preview['parameters']), (preview['revision'], {**preview['parameters'], 'settings': {'restrict.tcga': 99}})]:
            with self.assertRaises(jobs.StepError):
                rerun.create('step_test', 'expression', 'refused', revision, params)
        self.assertFalse((self.project / 'runs/refused').exists())

    def test_dependency_graph_and_required_intermediate(self):
        self.assertEqual(set(rerun.ancestors('visualize')), {'genotype', 'expression', 'adjust', 'cis', 'network'})
        self.completed()
        for name in ('genotype', 'adjust'):
            step = jobs.STEPS[name]
            jobs._save(self.root, {'step': name, 'run_id': 'step_test', 'state': 'completed',
                'inputs': {}, 'settings': {key: signet._settings(self.root)[key] for key in step.settings}, 'resources': step.resources})
        preview = rerun.review('step_test', 'adjust')
        self.assertIn('tmp/tmpg/impute/impute_Genotype.sizes', preview['required_files'])
        self.assertEqual(set(preview['reuse']), {'genotype', 'expression'})
        rerun.create('step_test', 'adjust', 'adjust_branch', preview['revision'], preview['parameters'])
        root = self.project / 'runs/adjust_branch'
        directory = str(self.remote_dir.parent / 'adjust_branch')
        token = jobs._owner(root, directory)
        jobs._upload(root, directory, token)
        with self.assertRaises(jobs.StepError):
            rerun.stage_remote(root, directory, token)
        self.assertFalse((root / 'steps/reuse-ready').exists())
        self.assertFalse((root / 'steps/adjust.json').exists())
        self.assertTrue((root / 'steps/genotype.json').exists())
        with self.assertRaises(jobs.StepError):
            jobs.revalidate('adjust_branch', 'genotype', expected_job_id='1', expected_attempt=1)

    def test_all_six_stages_offer_editable_parameters(self):
        self.completed()
        signet._update(self.root, {'memory': '32', 'walltime': '4:00:00', 'ncores': '16'})
        settings = signet._settings(self.root)
        for name in rerun.ORDER:
            step = jobs.STEPS[name]
            jobs._save(self.root, {'step': name, 'run_id': 'step_test', 'state': 'completed',
                'inputs': {}, 'settings': {key: settings[key] for key in step.settings}, 'resources': step.resources})
        for name in rerun.ORDER:
            preview = rerun.review('step_test', name)
            self.assertIn(name, preview['invalidated'])
            self.assertNotIn(name, preview['reuse'])
            self.assertEqual(set(preview['parameters']['settings']), set(jobs.STEPS[name].settings))
            rerun.create('step_test', name, 'fork_' + name, preview['revision'], preview['parameters'])

    def test_compatible_upstream_and_intermediates_are_copied_to_owned_new_run(self):
        self.completed()
        for name in ('genotype', 'adjust'):
            step = jobs.STEPS[name]
            jobs._save(self.root, {'step': name, 'run_id': 'step_test', 'state': 'completed',
                'inputs': {}, 'settings': {key: signet._settings(self.root)[key] for key in step.settings}, 'resources': step.resources})
        preview = rerun.review('step_test', 'adjust')
        for relative in preview['required_files']:
            path = self.remote_dir / 'work' / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('upstream data')
        intermediate = self.remote_dir / 'work/tmp/tmpg/impute/additional_file'
        intermediate.write_text('needed intermediate')
        rerun.create('step_test', 'adjust', 'compatible', preview['revision'], preview['parameters'])
        root = self.project / 'runs/compatible'
        directory = str(self.remote_dir.parent / 'compatible')
        token = jobs._owner(root, directory)
        jobs._upload(root, directory, token)
        rerun.stage_remote(root, directory, token)
        from pathlib import Path
        self.assertEqual((Path(directory) / 'work/tmp/tmpg/impute/additional_file').read_text(), 'needed intermediate')
        self.assertTrue((root / 'steps/reuse-ready').exists())
        self.assertEqual(intermediate.read_text(), 'needed intermediate')
        self.assertEqual((Path(directory) / '.owner').read_text().strip(), token)
        self.assertNotEqual(token, json.loads((self.root / 'steps/remote.owner').read_text())['token'])
        with patch.object(jobs, '_shell', side_effect=AssertionError('must not overwrite reused files again')):
            rerun.stage_remote(root, directory, token)

    def test_dataset_retry_fork_remaps_frozen_inputs_and_history_identity(self):
        from agent.runtime import workspace_inputs, workspace_genotype
        self.completed()
        settings = signet._settings(self.root)
        record = {'step': 'genotype', 'run_id': 'step_test', 'state': 'completed', 'attempt': 2,
            'inputs': workspace_inputs.step_inputs(str(self.remote_dir), 2),
            'settings': {key: settings[key] for key in jobs.STEPS['genotype'].settings},
            'resources': jobs.STEPS['genotype'].resources, 'remote_dir': str(self.remote_dir)}
        jobs._save(self.root, record)
        snapshot = {**record, 'mode': 'dataset', 'dataset_id': 'data-one', 'dataset_name': ['資料', 'Data'],
            'submitted_at': '2026-11-01', 'source_inputs': {'genotype': ['ped', 'map'], 'expression': ['gexp'], 'clinical': ['clinical']}}
        (self.root / 'workspace-genotype.json').write_text(json.dumps(snapshot))
        preview = rerun.review('step_test', 'genotype')
        plan = rerun.create('step_test', 'genotype', 'dataset_fork', preview['revision'], preview['parameters'])
        self.assertEqual(plan['frozen_source'], 'inputs/attempt2')
        new_root = self.project / 'runs/dataset_fork'
        new_directory = str(self.remote_dir.parent / 'dataset_fork')
        self.assertEqual(plan['parameters']['inputs'], workspace_inputs.step_inputs(new_directory))
        jobs._save(new_root, {**record, 'run_id': 'dataset_fork', 'attempt': 1, 'state': 'pending',
            'inputs': plan['parameters']['inputs'], 'remote_dir': new_directory})
        history = workspace_genotype.run_history(new_root)
        self.assertEqual(history['run_id'], 'dataset_fork')
        self.assertEqual(history['dataset_id'], 'data-one')
        self.assertEqual(history['status'], 'pending')
        self.assertEqual(history['rerun']['source_run_id'], 'step_test')
        self.assertEqual(history['frozen_inputs']['genotype'], workspace_inputs.frozen_paths(new_directory)['genotype'])

    def test_edited_stage_settings_are_isolated_and_incompatible_pair_is_refused(self):
        preview = self.completed()
        edited = {**preview['parameters'], 'settings': {'restrict.tcga': 2}}
        rerun.create('step_test', 'expression', 'edited', preview['revision'], edited)
        self.assertEqual(signet._settings(self.project / 'runs/edited')['restrict.tcga'], '2')
        self.assertEqual(signet._settings(self.root)['restrict.tcga'], 'no')
        settings = signet._settings(self.root)
        jobs._save(self.root, {'step': 'genotype', 'run_id': 'step_test', 'state': 'completed',
            'inputs': {}, 'settings': {key: settings[key] for key in jobs.STEPS['genotype'].settings},
            'resources': jobs.STEPS['genotype'].resources})
        signet._update(self.root, {'restrict.tcga.geno': '1'})
        genotype = jobs._load(self.root, 'genotype')
        genotype['settings']['restrict.tcga.geno'] = '1'
        jobs._save(self.root, genotype)
        preview = rerun.review('step_test', 'expression')
        with self.assertRaises(jobs.StepError):
            rerun.create('step_test', 'expression', 'incompatible', preview['revision'], edited)
        self.assertFalse((self.project / 'runs/incompatible').exists())

    def test_source_operations_wait_until_checked_remote_copy_finishes(self):
        preview = self.completed()
        rerun.create('step_test', 'expression', 'locked_copy', preview['revision'], preview['parameters'])
        root = self.project / 'runs/locked_copy'
        directory = str(self.remote_dir.parent / 'locked_copy')
        token = jobs._owner(root, directory)
        jobs._upload(root, directory, token)
        copying, release, requested, changed = (threading.Event() for _ in range(4))
        def copy(script, **kwargs):
            copying.set()
            self.assertTrue(release.wait(3))
            return 0, {}, []
        def change_source():
            requested.set()
            jobs.update_settings('step_test', {'restrict.tcga': 2})
            changed.set()
        with ThreadPoolExecutor(max_workers=2) as pool, patch.object(jobs, '_shell', side_effect=copy):
            pending_copy = pool.submit(rerun.stage_remote, root, directory, token)
            try:
                self.assertTrue(copying.wait(3))
                pending_change = pool.submit(change_source)
                self.assertTrue(requested.wait(3))
                self.assertFalse(changed.wait(.2), 'Source changed while its checked copy was in progress')
            finally:
                release.set()
            pending_copy.result(timeout=3)
            pending_change.result(timeout=3)
        self.assertTrue(changed.is_set())
        self.assertTrue((root / 'steps/reuse-ready').exists())


class DatasetForkRetryTest(unittest.TestCase):
    def setUp(self):
        from test_dataset_runs import DatasetRunTest
        self.c = DatasetRunTest()
        self.c.setUp()
        self.addCleanup(self.c.doCleanups)
        self.f = self.c.f

    def failed_fork(self):
        from agent.runtime import workspace_genotype as workspace, workspace_inputs
        record = self.c.submit(self.c.review())
        source = self.f.project / 'runs/custom-study'
        remote = Path(record['remote_dir'])
        prepared = subprocess.run(['bash', '-s'], input=workspace_inputs.stage_command(
            workspace_inputs.staging_plan(source, str(remote))).encode(), capture_output=True)
        self.assertEqual(prepared.returncode, 0, prepared.stderr.decode())
        output = remote / 'work/res/resg'
        (output / 'signet_Geno').write_text('0 1 2\n' * 6)
        (output / 'signet_Genotype.sampleID').write_text('\n'.join('TCGA-AA-A00' + str(n) + '-NT' for n in range(1, 7)) + '\n')
        (remote / 'steps/genotype.done').write_text('0 2026-11-17T10:00:00-08:00\n')
        self.f.slurm(squeue='', sacct='COMPLETED')
        self.assertEqual(jobs.status('custom-study', 'genotype', refresh=True)['state'], 'completed')
        # Retain independent completed expression evidence; no expression analysis is executed.
        expression = {'run_id': 'custom-study', 'step': 'expression', 'state': 'completed', 'job_id': '333',
            'remote_dir': str(remote), 'submitted_at': jobs._now(),
            'inputs': {'gexp.file': str(remote / 'inputs/frozen/expression'), 'pmap.file': str(remote / 'inputs/frozen/annotation')},
            'settings': {'restrict.tcga': '2'}, 'resources': jobs._resources(jobs.STEPS['expression'], None)}
        signet._update(source, expression['settings'])
        jobs._save(source, expression)
        (source / workspace.EXPRESSION_SNAPSHOT).write_text(json.dumps({**expression, 'dataset_id': self.c.dataset['id']}))
        for relative in jobs.STEPS['expression'].required:
            path = remote / 'work' / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('inherited expression fixture\n')
        self.originals = {p: p.read_bytes() for p in source.rglob('*') if p.is_file()}
        preview = rerun.review('custom-study', 'genotype')
        rerun.create('custom-study', 'genotype', 'dataset_fork', preview['revision'], preview['parameters'])
        self.root = self.f.project / 'runs/dataset_fork'
        self.f.slurm(sbatch_reply='444')
        first = rerun.submit('dataset_fork', True)
        self.remote = Path(first['remote_dir'])
        self.assertNotIn('SIGNET_DATASET_STAGE', (self.remote / 'steps/genotype.sbatch').read_text())
        self.f.slurm(squeue='', sacct='FAILED')
        self.assertEqual(jobs.status('dataset_fork', 'genotype', refresh=True)['state'], 'failed')
        return first

    def test_failed_dataset_fork_retries_with_fresh_reviewed_attempt_inputs(self):
        from agent.runtime import workspace_datasets, workspace_genotype as workspace, workspace_inputs
        self.failed_fork()
        initial = (self.root / workspace.SNAPSHOT).read_bytes()
        frozen = {p: p.read_bytes() for p in (self.remote / 'inputs').rglob('*') if p.is_file()}
        workspace_datasets.update_dataset(self.c.dataset['id'], {'expression': ['/different/expression']})
        review = workspace.review_genotype_retry('dataset_fork', '444', 1)
        self.assertTrue(review['ready'], review['issues'])
        self.assertEqual(review['source_inputs'], self.c.inputs)
        self.assertEqual(review['inputs'], workspace_inputs.step_inputs(str(self.remote), 2))
        self.f.slurm(sbatch_reply='555')
        second = workspace.submit_genotype_retry('dataset_fork', review['inputs'], review['settings'],
            review['resources'], review['review_token'], '444', 1, True)
        self.assertEqual((second['attempt'], second['job_id']), (2, '555'))
        self.assertIn('SIGNET_DATASET_STAGE', (self.remote / 'steps/genotype.sbatch').read_text())
        self.assertTrue(set(workspace_inputs.REQUIRED).issubset(second['required_outputs']))
        # Execute only the tiny fixture input preparation, never the scientific batch body.
        prepared = subprocess.run(['bash', '-s'], input=workspace_inputs.stage_command(
            workspace_inputs.staging_plan(self.root, str(self.remote))).encode(), capture_output=True)
        self.assertEqual(prepared.returncode, 0, prepared.stderr.decode())
        self.assertEqual((self.remote / 'inputs/attempt2/frozen/expression').read_bytes(), self.c.paths['expression.txt'].read_bytes())
        self.assertTrue((self.remote / 'inputs/attempt2/prepared/ref/chr2.gen').is_file())
        self.assertEqual(frozen, {path: path.read_bytes() for path in frozen})
        self.assertEqual(initial, (self.root / workspace.SNAPSHOT).read_bytes())
        self.assertEqual(self.originals, {path: path.read_bytes() for path in self.originals})
        self.assertTrue((self.root / 'steps/genotype.attempt1.json').is_file())
        self.assertTrue((self.remote / 'steps/genotype.attempt1.results/workspace-inputs.json').is_file())

    def test_only_exact_inherited_expression_is_exempt_from_downstream_guard(self):
        from agent.runtime import workspace_genotype as workspace
        self.failed_fork()
        inherited = self.root / workspace.EXPRESSION_SNAPSHOT
        saved = inherited.read_bytes()
        inherited.write_bytes(saved + b'\n')
        before = len(self.f.calls)
        with self.assertRaisesRegex(jobs.StepError, 'later stage'):
            workspace.review_genotype_retry('dataset_fork', '444', 1)
        self.assertEqual(len(self.f.calls), before)
        inherited.write_bytes(saved)
        (self.root / 'workspace-expression.review1.json').write_text('{}')
        with self.assertRaisesRegex(jobs.StepError, 'later stage'):
            workspace.review_genotype_retry('dataset_fork', '444', 1)

    def test_changed_original_source_keeps_failed_fork_blocked(self):
        from agent.runtime import workspace_genotype as workspace
        self.failed_fork()
        initial = (self.root / workspace.SNAPSHOT).read_bytes()
        self.c.paths['expression.txt'].write_text('changed source data')
        review = workspace.review_genotype_retry('dataset_fork', '444', 1)
        self.assertFalse(review['ready'])
        self.assertIn('source changed', ' '.join(review['issues']))
        self.assertEqual(initial, (self.root / workspace.SNAPSHOT).read_bytes())
        self.assertFalse((self.root / 'workspace-genotype.review2.json').exists())
