"""Retry history is a read-only projection of saved per-attempt snapshots."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import agent.tools.signet as signet
from agent.runtime import workspace_history as history


class WorkspaceAttemptsTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.project = Path(temporary.name).resolve()
        for item in (patch.object(signet, 'PROJECT', self.project),
                     patch.dict(os.environ, {'SIGNET_HISTORY_STATE_FILE': str(self.project / 'history.json')}),
                     patch('agent.runtime.ssh_transport.remote', side_effect=AssertionError('History cannot query HPC')),
                     patch.object(signet, '_settings', side_effect=AssertionError('Current configuration is not historical evidence'))):
            item.start()
            self.addCleanup(item.stop)
        self.root = self.project / 'runs/study'
        self.write(self.root / 'manifest.json', {'cohort': 'TCGA'})
        self.base = {'datasets': [], 'runs': []}

    @staticmethod
    def write(path, record):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record))

    def record(self, number=1, state='failed', **fields):
        return {'run_id': 'study', 'step': 'expression', 'state': state,
                **({'attempt': number} if number != 1 else {}),
                'job_id': str(700 + number), 'settings': {'restrict.tcga': str(number)},
                'inputs': {'gexp.file': f'/saved/attempt{number}.tsv'},
                'resources': {'cpus': number}, 'options': {'saved': number},
                'submitted_at': f'2026-11-17T10:00:0{number}-0800',
                'history': [{'state': state, 'at': f'2026-11-17T10:01:0{number}-0800'}], **fields}

    def row(self):
        return history.merge(self.base)['runs'][0]

    def test_all_attempts_keep_exact_snapshots_and_only_saved_result_evidence(self):
        first = self.record(1, required_outputs=['res/rest/expression'], missing_outputs=['res/rest/expression'],
                            failure_hints=['saved failure'], exit_code='1', reason='Original failure')
        second = self.record(2, state='cancelled', reason='Confirmed cancelled')
        current = self.record(3, state='completed', required_outputs=['res/rest/expression'],
                              outputs=['work/res/rest/expression'], missing_outputs=[], failure_hints=[], exit_code='0')
        for name, record in (('expression.attempt1.json', first), ('expression.attempt2.json', second),
                             ('expression.json', current)):
            self.write(self.root / 'steps' / name, record)
        # A currently present result does not replace the first attempt's missing-output observation.
        output = self.root / 'work/res/rest/expression'
        output.parent.mkdir(parents=True)
        output.write_text('new mutable result')
        originals = {path: path.read_bytes() for path in self.root.rglob('*') if path.is_file()}
        row = self.row()
        attempts = row['attempts']['expression']
        self.assertEqual([entry['number'] for entry in attempts], [1, 2, 3])
        self.assertEqual([entry['current'] for entry in attempts], [False, False, True])
        self.assertEqual([entry['record'] for entry in attempts], [first, second, current])
        self.assertEqual([entry['result']['status'] for entry in attempts],
                         ['recorded_failed', 'recorded_cancelled', 'recorded_completed'])
        self.assertEqual(attempts[0]['result']['outputs'], [{'path': 'res/rest/expression', 'status': 'missing'}])
        self.assertEqual(attempts[2]['result']['outputs'], [{'path': 'res/rest/expression', 'status': 'downloaded'}])
        self.assertEqual(row['jobs']['expression'], current)
        self.assertEqual(originals, {path: path.read_bytes() for path in originals})
        original_revision = row['revision']
        self.write(self.root / 'steps/expression.attempt1.json', {**first, 'reason': 'Edited evidence'})
        self.assertNotEqual(self.row()['revision'], original_revision)

    def test_missing_and_foreign_archives_are_visible_without_borrowing_fields(self):
        self.write(self.root / 'steps/expression.json', self.record(4))
        self.write(self.root / 'steps/expression.attempt1.json', self.record(1))
        self.write(self.root / 'steps/expression.attempt3.json', self.record(3))
        self.write(self.root / 'steps/expression.attempt5.json', self.record(5, run_id='foreign'))
        entries = self.row()['attempts']['expression']
        self.assertEqual([entry['number'] for entry in entries], [1, 2, 3, 4, 5])
        self.assertEqual(entries[1]['availability'], 'missing')
        self.assertEqual(entries[4]['availability'], 'invalid')
        for entry in (entries[1], entries[4]):
            self.assertIsNone(entry['record'])
            self.assertEqual(entry['result'], {'status': 'not_recorded', 'outputs': []})

    def test_latest_uses_raw_step_not_the_merged_review_and_absent_execution_is_not_invented(self):
        raw = self.record(1)
        del raw['settings']
        self.write(self.root / 'steps/expression.json', raw)
        self.base['runs'] = [{'source': 'live', 'run_id': 'study', 'dataset_id': None,
                              'jobs': {'expression': {**raw, 'settings': {'restrict.tcga': '999'}}}}]
        entry = self.row()['attempts']['expression'][0]
        self.assertEqual(entry['record'], raw)
        self.assertNotIn('settings', entry['record'])
        (self.root / 'steps/expression.json').unlink()
        self.base['runs'][0]['jobs']['expression']['state'] = 'not_submitted'
        self.assertEqual(self.row()['attempts'], {})

    def test_current_implicit_first_number_is_not_used_when_archived_siblings_exist(self):
        self.write(self.root / 'steps/expression.json', self.record(1))
        self.assertEqual(self.row()['attempts']['expression'][0]['number'], 1)
        self.write(self.root / 'steps/expression.attempt1.json', self.record(1))
        current = next(entry for entry in self.row()['attempts']['expression'] if entry['current'])
        self.assertIsNone(current['number'])
        self.assertEqual(current['availability'], 'recorded')
        self.assertTrue(current['issues'])

    def test_archive_snapshot_never_reads_same_named_workspace_attempts(self):
        self.write(self.root / 'steps/expression.json', self.record(3))
        self.write(self.root / 'steps/expression.attempt1.json', self.record(1))
        archived = {'state': 'completed', 'settings': {'restrict.tcga': 'archive-only'}, 'job_id': 'old-archive'}
        self.base['runs'] = [{'source': 'archive', 'run_id': 'study', 'dataset_id': None,
                              'jobs': {'expression': archived}}]
        rows = {row['source']: row for row in history.merge(self.base)['runs']}
        entry = rows['archive']['attempts']['expression'][0]
        self.assertIsNone(entry['number'])
        self.assertEqual(entry['record'], archived)
        self.assertEqual(entry['record_file'], 'verification.json#jobs.expression')
        self.assertEqual(len(rows['recorded']['attempts']['expression']), 3)

    def test_bad_archives_remain_invalid_and_do_not_crash_or_expose_foreign_snapshots(self):
        self.write(self.root / 'steps/expression.json', self.record(4))
        damaged = self.root / 'steps/expression.attempt1.json'
        damaged.write_text('{broken')
        foreign = self.record(2, step='genotype')
        self.write(self.root / 'steps/expression.attempt2.json', foreign)
        outside = self.project / 'outside.json'
        self.write(outside, self.record(3))
        (self.root / 'steps/expression.attempt3.json').symlink_to(outside)
        entries = self.row()['attempts']['expression']
        self.assertEqual([entry['availability'] for entry in entries], ['invalid'] * 3 + ['recorded'])
        self.assertTrue(all(entry['record'] is None for entry in entries[:3]))
        old_revision = self.row()['revision']
        damaged.write_text('{another broken record')
        self.assertNotEqual(self.row()['revision'], old_revision)

    def test_attempt_only_folder_retains_prior_snapshots_and_a_missing_current_gap(self):
        self.write(self.root / 'steps/expression.attempt1.json', self.record(1))
        row = self.row()
        self.assertEqual(row['status'], 'recorded')
        self.assertEqual(row['jobs'], {})
        entries = row['attempts']['expression']
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]['availability'], 'recorded')
        self.assertIsNone(entries[1]['number'])
        self.assertTrue(entries[1]['current'])
        self.assertEqual(entries[1]['availability'], 'missing')

    def test_invalid_numbers_and_nested_events_are_bounded_and_unavailable(self):
        for fields in ({'attempt': True}, {'attempt': 1.5}, {'attempt': 10**100},
                       {'history': [None]}, {'history': [{'state': 'failed', 'at': {}}]},
                       {'outputs': [None]}):
            with self.subTest(fields=fields):
                self.write(self.root / 'steps/expression.json', self.record(2, **fields))
                entries = self.row()['attempts']['expression']
                self.assertEqual(len(entries), 1)
                self.assertEqual(entries[0]['availability'], 'invalid')
                self.assertIsNone(entries[0]['record'])

    def test_refused_submission_never_borrows_the_previous_attempt_job_id(self):
        previous = self.record(1)
        refused = self.record(2, previous_job_id='701', reason='Submission failed before a job ID was returned.')
        refused.pop('job_id')
        self.write(self.root / 'steps/expression.attempt1.json', previous)
        self.write(self.root / 'steps/expression.json', refused)
        entry = self.row()['attempts']['expression'][-1]
        self.assertEqual(entry['record'], refused)
        self.assertNotIn('job_id', entry['record'])
        self.assertEqual(entry['result'], {'status': 'recorded_failed', 'outputs': []})

    def test_archive_unknown_number_is_entry_limitation_without_repeated_run_errors(self):
        self.base['runs'] = [{'source': 'archive', 'run_id': 'study', 'dataset_id': None,
                              'jobs': {'expression': {'state': 'completed'}, 'genotype': {'state': 'completed'}}}]
        row = next(row for row in history.merge(self.base)['runs'] if row['source'] == 'archive')
        self.assertEqual(row['issues'], [])
        self.assertTrue(row['attempts']['expression'][0]['issues'])


if __name__ == '__main__':
    unittest.main()
