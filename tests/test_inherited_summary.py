"""Inherited summaries resolve owned sources on fake storage without submitting child work."""
from copy import deepcopy
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from agent.runtime import signet_jobs as jobs
import agent.tools.signet as signet
import test_signet_jobs as fixtures


class InheritedSummaryTest(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.StepsTest()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        (self.f.root / 'workspace-genotype.json').write_text(json.dumps({'run_id': 'step_test', 'dataset_id': 'study'}))
        jobs.submit('step_test', 'expression', self.f.inputs)
        self.f.finish_job()
        self.source = jobs.status('step_test', 'expression', refresh=True)

    def fork(self, name, parent, step='expression'):
        signet.configure_signet(name)
        root = self.f.project / 'runs' / name
        (root / 'steps').mkdir()
        (root / 'workspace-genotype.json').write_text(json.dumps({'run_id': name, 'dataset_id': 'study'}))
        (root / 'rerun.json').write_text(json.dumps({'source_run_id': parent.name, 'new_run_id': name,
                                                   'step': 'visualize' if step == 'network' else 'adjust', 'reuse': [step]}))
        original = jobs._load(parent, step)
        record = deepcopy(original)
        record.update(run_id=name, remote_dir=self.f.config['workRoot'] + '/' + name,
                      reused_from={'run_id': parent.name, 'step': step,
                                   'attempt': original.get('attempt', 1), 'job_id': original['job_id']})
        record.pop('summary', None)
        jobs._save(root, record)
        return root

    def test_uncached_multilevel_inherited_counts_use_original_guard_without_child_markers(self):
        self.source.pop('summary')
        jobs._save(self.f.root, self.source)
        child = self.fork('fork-one', self.f.root)
        grandchild = self.fork('fork-two', child)
        protected = {root / 'steps/expression.json': (root / 'steps/expression.json').read_bytes()
                     for root in (self.f.root, child)}
        start = len(self.f.calls)
        summary = jobs.ensure_summary('fork-two', 'expression')
        self.assertEqual(summary['version'], jobs.SUMMARY_VERSION)
        self.assertEqual(summary['outputs'][0]['rows'], 1)
        self.assertEqual(jobs._load(grandchild, 'expression')['summary'], summary)
        self.assertEqual(protected, {path: path.read_bytes() for path in protected})
        self.assertFalse((grandchild / 'steps/remote.owner').exists())
        self.assertFalse((Path(self.f.config['workRoot']) / 'fork-two').exists())
        scripts = '\n'.join(self.f.calls[start:])
        self.assertIn(str(self.f.remote_dir), scripts)
        self.assertNotIn('sbatch --parsable', scripts)
        self.assertNotIn('scancel', scripts)
        self.assertNotIn('tar czf', scripts)
        self.assertNotIn('PRIVATE', json.dumps(summary))

    def test_uncached_inherited_network_report_also_uses_original_source(self):
        record = deepcopy(self.source)
        record.update(step='network', settings={}, options={})
        record.pop('summary')
        jobs._save(self.f.root, record)
        (self.f.remote_dir / 'steps/network.job').write_text(record['job_id'])
        for relative in jobs.STEPS['network'].required:
            path = self.f.remote_dir / 'work' / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('0.1 0.2\n0.3 0.4\n')
        child = self.fork('network-fork', self.f.root, 'network')
        summary = jobs.ensure_summary('network-fork', 'network')
        self.assertEqual(summary['outputs'][0], {'file': 'signet_Afreq', 'rows': 2, 'columns': 2})
        self.assertFalse((child / 'steps/remote.owner').exists())

    def test_original_cached_counts_can_backfill_child_while_disconnected(self):
        child = self.fork('offline-fork', self.f.root)
        before = len(self.f.calls)
        with patch.object(jobs, '_environment', side_effect=AssertionError('No remote access for cached counts')):
            summary = jobs.ensure_summary('offline-fork', 'expression')
        self.assertEqual(summary, self.source['summary'])
        self.assertEqual(len(self.f.calls), before)
        self.assertEqual(jobs._load(child, 'expression')['summary'], summary)

    def test_cached_child_does_not_bypass_changed_source_attempt_or_dataset(self):
        child = self.fork('stale-fork', self.f.root)
        record = jobs._load(child, 'expression')
        record['summary'] = self.source['summary']
        jobs._save(child, record)
        before = len(self.f.calls)
        self.source['attempt'] = 2
        jobs._save(self.f.root, self.source)
        self.assertIsNone(jobs.ensure_summary('stale-fork', 'expression'))
        self.source['attempt'] = 1
        jobs._save(self.f.root, self.source)
        (child / 'workspace-genotype.json').write_text(json.dumps({'run_id': 'stale-fork', 'dataset_id': 'other'}))
        self.assertIsNone(jobs.ensure_summary('stale-fork', 'expression'))
        self.assertEqual(len(self.f.calls), before)

    def test_saved_model_peek_refuses_retargeted_cached_counts_without_remote_access(self):
        from agent.tools import workspace as tools
        child = self.fork('peek-fork', self.f.root)
        record = jobs._load(child, 'expression')
        record['summary'] = self.source['summary']
        jobs._save(child, record)
        history = {'dataset_id': 'study', 'jobs': {'expression': record}}
        before = len(self.f.calls)
        with patch.object(tools.workspace, '_workspace_run', return_value=(child, history)), \
                patch.object(jobs, '_environment', side_effect=AssertionError('Saved peek must not access remote environment')):
            valid = tools.get_workspace_stage('peek-fork', 2)
            self.assertTrue(valid['job']['summary']['available'])
            self.source['attempt'] = 2
            jobs._save(self.f.root, self.source)
            invalid = tools.get_workspace_stage('peek-fork', 2)
            self.assertFalse(invalid['job']['summary']['available'])
        self.assertEqual(len(self.f.calls), before)

    def test_source_change_during_counting_never_publishes_child_cache(self):
        self.source.pop('summary')
        jobs._save(self.f.root, self.source)
        child = self.fork('raced-fork', self.f.root)
        original = (child / 'steps/expression.json').read_bytes()
        compute = jobs._output_summary
        def changed_source(*args):
            result = compute(*args)
            self.source['attempt'] = 2
            jobs._save(self.f.root, self.source)
            return result
        with patch.object(jobs, '_output_summary', side_effect=changed_source):
            self.assertIsNone(jobs.ensure_summary('raced-fork', 'expression'))
        self.assertEqual((child / 'steps/expression.json').read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
