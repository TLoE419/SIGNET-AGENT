"""Offline linked-run safety tests using the local fake scheduler."""
import json
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
