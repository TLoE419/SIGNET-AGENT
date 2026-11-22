"""Fake-only regressions for remote result ownership, measured work units and model privacy."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from agent.runtime import signet_jobs as jobs, step_report
from agent.runtime.jobs.step_inputs import gtf_problem
from agent.tools import general
from agent.tools.signet import dispatch_tool
import test_signet_jobs as fixtures


class RuntimePrivacyContracts(unittest.TestCase):
    def fixture(self):
        f = fixtures.StepsTest()
        f.setUp()
        self.addCleanup(f.doCleanups)
        downloads = patch.object(jobs, 'DOWNLOADED_STEPS', ('network', 'visualize'))
        downloads.start()
        self.addCleanup(downloads.stop)
        return f

    def test_first_four_complete_remotely_and_preserve_existing_local_archives(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            preserved = root / 'work/res/rest/signet_gexp'
            preserved.parent.mkdir(parents=True)
            preserved.write_text('private-old-archive\n')
            for name in ('genotype', 'expression', 'adjust', 'cis'):
                record = {'step': name, 'run_id': 'fixture', 'state': 'running',
                          'settings': {'alpha.cis': '0.05'}, 'history': []}
                with patch.object(jobs, '_output_summary', return_value={'version': 2, 'outputs': []}), \
                        patch.object(jobs.ssh_transport, 'remote') as remote:
                    jobs._finish(root, record, jobs.STEPS[name], '0 2026-11-18T00:00:00Z', [], [])
                self.assertEqual(record['state'], 'completed')
                self.assertEqual(record['outputs'], [])
                self.assertTrue(record['remote_outputs'])
                remote.assert_not_called()
            self.assertEqual(preserved.read_text(), 'private-old-archive\n')

    def test_reference_preparation_counts_and_provenance_survive_without_private_downloads(self):
        f = self.fixture()
        jobs.update_settings('step_test', {'restrict.tcga.geno': 1})
        record = jobs.submit('step_test', 'genotype', f.genotype_inputs())
        for relative in jobs.STEPS['genotype'].required:
            path = f.remote_dir / 'work' / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('data\n')
        metadata = f.remote_dir / 'work/res/resg/workspace-reference-preparation.json'
        metadata.write_text(json.dumps({'status': 'ok', 'chromosome': '1', 'study_samples': 5,
            'study_markers': 8, 'matched_markers': 3, 'match_rate': .375,
            'formats': {'reference': 'vcf', 'genetic_map': 'pos_chr_cm'},
            'outputs': {'ped': '/PRIVATE-ID/study.ped'}, 'source': 'PRIVATE-ID',
            'rejected': {'allele_mismatch': 5, 'PRIVATE-ID': 4}}))
        (f.remote_dir / 'steps/genotype.done').write_text('0 2026-11-18T00:00:00Z\n')
        f.slurm(squeue='', sacct='COMPLETED')
        record = jobs.status('step_test', 'genotype', refresh=True)
        self.assertEqual(record['state'], 'completed')
        self.assertEqual(record['summary']['reference_preparation']['matched_markers'], 3)
        self.assertNotIn('PRIVATE-ID', json.dumps(record['summary']))
        self.assertFalse((f.root / 'work/res/resg/workspace-reference-preparation.json').exists())
        self.assertEqual(record['summary']['version'], jobs.SUMMARY_VERSION)

    def test_remote_summary_has_counts_only_and_is_cached(self):
        f = self.fixture()
        jobs.submit('step_test', 'expression', f.inputs)
        f.finish_job()
        result = jobs.status('step_test', 'expression', refresh=True)
        self.assertEqual(result['state'], 'completed')
        self.assertFalse((f.root / 'work/res/rest/signet_gexp').exists())
        self.assertEqual(result['summary']['outputs'][0]['rows'], 1)
        before = len(f.calls)
        self.assertEqual(jobs.ensure_summary('step_test', 'expression'), result['summary'])
        self.assertEqual(len(f.calls), before)
        self.assertFalse(any('tar czf' in call for call in f.calls))

    def test_lazy_summary_refuses_changed_owner_and_environment(self):
        f = self.fixture()
        jobs.submit('step_test', 'expression', f.inputs)
        f.finish_job()
        record = jobs.status('step_test', 'expression', refresh=True)
        record.pop('summary')
        jobs._save(f.root, record)
        (f.remote_dir / '.owner').write_text('foreign')
        self.assertIsNone(jobs.ensure_summary('step_test', 'expression'))
        f.config['workRoot'] += '/another-environment'
        self.assertIsNone(jobs.ensure_summary('step_test', 'expression'))

    def test_remote_completion_does_not_bypass_guard_or_summary_failure(self):
        record = {'step': 'expression', 'state': 'validating', 'history': [],
                  'output_revalidation_requested_at': 'reviewed'}
        with patch.object(jobs, '_output_summary', side_effect=jobs.StepError('conflict', 'foreign owner')):
            jobs._finish(Path('/unused-fixture'), record, jobs.STEPS['expression'],
                         '0 2026-11-18T00:00:00Z', [], [])
        self.assertEqual(record['state'], 'validating')
        self.assertNotIn('remote_outputs', record)

    def test_stage6_downloads_keep_guarded_conflicting_archive_refusal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            step = jobs.STEPS['visualize']
            record = {'step': 'visualize', 'state': 'validating', 'history': [],
                      'output_revalidation_requested_at': 'reviewed', 'exports_completed': True, 'remote_dir': '/fixture'}
            with patch.object(jobs, '_output_summary', return_value={}), \
                    patch.object(jobs, '_output_guard', return_value='ownership_guard\\n'), \
                    patch.object(jobs, '_queue_check', return_value='stopped_guard\\n'), \
                    patch.object(jobs.ssh_transport, 'remote') as remote, \
                    patch.object(jobs, '_restore_revalidated_outputs', side_effect=ValueError('conflicting archive')):
                remote.return_value.returncode = 0
                remote.return_value.stdout = b'fake archive'
                jobs._finish(root, record, step, '0 2026-11-18T00:00:00Z', [], [])
                command = remote.call_args.kwargs['input'].decode()
                self.assertEqual(command.count('ownership_guard'), 2)
                self.assertEqual(command.count('stopped_guard'), 2)
            self.assertEqual(record['state'], 'validating')

    def test_bad_annotation_stops_before_dispatch_and_has_no_replay_ambiguity(self):
        f = self.fixture()
        f.gtf.write_text('chr1\tfixture\tgene\t1\t2\t.\t+\t.\tgene_type "protein_coding";\n')
        with self.assertRaises(jobs.StepError) as raised:
            jobs.submit('step_test', 'expression', f.inputs)
        self.assertEqual(raised.exception.code, 'invalid_request')
        self.assertFalse((f.fake / 'sbatch_args').exists())
        receipts = list((f.remote_dir / 'steps').glob('expression.submission.*'))
        self.assertEqual(len(receipts), 1)
        self.assertEqual(receipts[0].read_text(), 'not_dispatched\n')
        self.assertFalse((f.root / 'steps/expression.json').exists())

    def test_missing_family_intermediate_is_refused_before_adjust_dispatch(self):
        f = self.fixture()
        inputs = f.adjust_ready(needs=[path for path in jobs.STEPS['adjust'].needs
                                      if not path.endswith('clean_Genotype.fam')])
        with self.assertRaises(jobs.StepError) as raised:
            jobs.submit('step_test', 'adjust', inputs)
        self.assertEqual(raised.exception.code, 'invalid_request')
        self.assertIn('clean_Genotype.fam', str(raised.exception))
        self.assertFalse((f.fake / 'sbatch_args').exists())

    def test_annotation_checker_refuses_gzip_and_wrong_width(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'annotation'
            path.write_bytes(b'\x1f\x8bfixture')
            self.assertIn('uncompressed', gtf_problem(path))
            path.write_text('not a GTF\n')
            self.assertIn('9 tab-separated', gtf_problem(path))

    def progress(self, name, setup, attempt=1):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            setup(root)
            record = {'step': name, 'attempt': attempt, 'settings': {'ntop': '2'}}
            script = jobs._say() + f'D={temporary}\nqueue_state=RUNNING\naccount_state=\n' + jobs._progress_script(record)
            result = subprocess.run(['bash', '-s'], input=script, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout

    def test_measured_command_progress_matches_manifests_and_deduplicates(self):
        for name, entries in jobs.COMMAND_PROGRESS.items():
            def setup(root):
                for _, manifest, pattern in entries:
                    path = root / 'work' / manifest
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text('command a\ncommand b\n')
                    completed = path.parent / pattern.replace('[0-9]*', '0')
                    completed.write_text('command a\ncommand a\nforeign command\n')
            output = self.progress(name, setup)
            for key, _, _ in entries:
                self.assertIn(f'@@progress_{key}\t1 2', output)

    def test_expression_and_visualize_measure_real_markers(self):
        for name, folder, marker, key in (
                ('expression', 'tmpt', '.signet-normalized', 'expression_outputs'),
                ('visualize', 'tmpv', '.signet-network-1', 'subnetworks')):
            def setup(root):
                path = root / 'work/tmp' / folder / marker
                path.parent.mkdir(parents=True)
                path.touch()
            self.assertIn(f'@@progress_{key}\t1 2', self.progress(name, setup))

    def test_retry_ignores_previous_attempt_work_units(self):
        def setup(root):
            path = root / 'work/tmp/tmpg/impute_params.txt'
            path.parent.mkdir(parents=True)
            path.write_text('old command\n')
            (path.parent / 'impute_params.txt.completed').write_text('old command\n')
            os.utime(path, (1, 1))
            script = root / 'steps/genotype.sbatch'
            script.parent.mkdir()
            script.write_text('current attempt')
        self.assertNotIn('progress_', self.progress('genotype', setup, attempt=2))

    def test_stage6_auto_grace_is_bounded_and_manual_checks_do_not_reopen_it(self):
        for elapsed, manual, expected in ((0, False, 'validating'), (119, False, 'validating'),
                                           (120, False, 'failed'), (0, True, 'failed')):
            record = {'step': 'visualize', 'state': 'running', 'checked_at': 1000 + elapsed,
                      'missing_outputs_since': 1000, 'history': [], 'exports_completed': True}
            if manual:
                record['output_revalidation_requested_at'] = 'reviewed'
            jobs._finish(Path('/unused-fixture'), record, jobs.STEPS['visualize'],
                         '0 2026-11-18T00:00:00Z', ['graph'], [])
            self.assertEqual(record['state'], expected)
        record = {'step': 'visualize', 'state': 'running', 'checked_at': 1000, 'history': []}
        jobs._finish(Path('/unused-fixture'), record, jobs.STEPS['visualize'],
                     '0 2026-11-18T00:00:00Z', ['graph'], ['Execution halted'])
        self.assertEqual(record['state'], 'failed')

    def test_model_cannot_read_raw_data_old_person_results_or_run_snapshots(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary).resolve()
            for relative in ('data/subject.tsv', 'runs/fixture/work/res/rest/signet_gexp',
                             'runs/fixture/workspace-genotype.json', 'runs/fixture/steps/genotype.json'):
                path = project / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('PRIVATE-PERSON-123')
            aggregate = project / 'runs/fixture/work/res/resn/signet_Afreq'
            aggregate.parent.mkdir(parents=True)
            aggregate.write_text('0.1,0.2\n')
            with patch.object(general, 'PROJECT', project):
                for relative in ('data/subject.tsv', 'runs/fixture/work/res/rest/signet_gexp',
                                 'runs/fixture/workspace-genotype.json', 'runs/fixture/steps/genotype.json'):
                    with self.assertRaises(ValueError):
                        general.read_file(relative)
                with self.assertRaises(ValueError):
                    general.read_file(str(aggregate))
                self.assertNotIn('subject.tsv', json.dumps(general.list_files(str(project))))

    def test_table_summary_never_returns_identifier_values_or_unknown_headers(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary).resolve()
            table = project / 'data/private-person-123.tsv'
            table.parent.mkdir()
            table.write_text('patient_id\tPRIVATE-COLUMN-ID\trace\tgender\nPRIVATE-ID\tPRIVATE-VALUE\tPRIVATE-RACE-ID\tfemale\n')
            with patch.object(general, 'PROJECT', project):
                result = general.summarize_table(str(table))
            self.assertNotIn('PRIVATE', json.dumps(result))
            self.assertNotIn('private-person', json.dumps(result))
            self.assertEqual(result['rows'], 1)
            self.assertEqual(result['per_column']['gender']['values'], {'female': 1})

    def test_failure_report_explains_missing_files_and_scheduler_failures_without_raw_ids(self):
        for record, expected in (({'state': 'failed', 'failure_hints': ['cannot open PRIVATE-PERSON-123.tsv'],
                                   'exit_code': '1'}, 'missing_or_unreadable_file'),
                                  ({'state': 'failed', 'slurm_state': 'OUT_OF_MEMORY', 'reason': 'PRIVATE-PERSON-123'},
                                   'scheduler_out_of_memory')):
            result = step_report.failure_summary(record)
            self.assertEqual(result['classifications'][0], expected)
            self.assertTrue(result['reason'])
            self.assertNotIn('PRIVATE-PERSON', json.dumps(result))

    def test_model_summary_labels_matched_retained_and_instrument_dimensions(self):
        result = step_report.safe_summary('adjust', {}, {'outputs': [
            {'file': 'signet_matched.gexp', 'rows': 8, 'columns': 12},
            {'file': 'signet_new.Geno', 'rows': 8, 'columns': 6},
            {'file': 'signet_gexp.data', 'rows': 7, 'columns': 12},
            {'file': 'signet_gexp_rmpc.data', 'rows': 7, 'columns': 12},
            {'file': 'signet_geno.data', 'rows': 7, 'columns': 6}]})
        rows = {entry['file']: entry for entry in result['outputs']}
        self.assertEqual(rows['signet_matched.gexp']['rows_are'], 'matched samples')
        self.assertEqual(rows['signet_gexp.data']['rows_are'], 'retained samples')
        self.assertEqual(rows['signet_geno.data']['columns_are'], 'SNPs')
        result = step_report.safe_summary('cis', {'settings': {'alpha.cis': '0.05'}}, {'outputs': [
            {'file': 'signet_all.eQTL.data', 'rows': 7, 'columns': 24},
            {'file': 'signet_net.gexp.data', 'rows': 7, 'columns': 4}]})
        self.assertTrue(all(entry['rows_are'] == 'samples' for entry in result['outputs']))

    def test_workspace_report_tool_returns_safe_useful_failure_explanations(self):
        from agent.tools import workspace as tools
        view = {'job': {'job_id': '42'}, 'attempt': 2, 'run_id': 'fixture', 'source': 'live'}
        for record, expected in (({'state': 'failed', 'failure_hints': ['No such file or directory PRIVATE-ID'],
                                   'exit_code': '1'}, 'missing_file'),
                                  ({'state': 'failed', 'slurm_state': 'OUT_OF_MEMORY', 'reason': 'PRIVATE-ID'},
                                   'scheduler_out_of_memory')):
            with patch.object(tools, 'get_workspace_stage', return_value=view), \
                    patch.object(jobs, 'status', return_value=record), \
                    patch.object(jobs, '_root', return_value=Path('fixture')), \
                    patch.object(jobs, 'analysis_session', return_value=None), \
                    patch.object(jobs, 'run_records', return_value={'expression': record}), \
                    patch.object(step_report, '_card', return_value=None):
                result = tools.get_workspace_report('fixture', 2)
            self.assertEqual(result['failure']['classifications'][0], expected)
            self.assertTrue(result['failure']['reason'])
            self.assertNotIn('PRIVATE-ID', json.dumps(result))

    def test_legacy_settings_dispatch_and_injected_report_text_cannot_leak_ids(self):
        self.assertEqual(dispatch_tool('get_signet_settings', {'run_id': 'fixture'})['status'], 'invalid')
        record = {'settings': {}, 'progress': {'stage1': '1 2', 'PRIVATE-ID': '1 2'},
                  'reason': 'PRIVATE-ID', 'failure_hints': ['PRIVATE-ID'], 'exit_code': '1'}
        report = step_report.failure_summary(record)
        summary = step_report.safe_summary('expression', record, {'outputs': [
            {'file': 'signet_gexp', 'rows': 2, 'columns': 3, 'PRIVATE-ID': 'PRIVATE-ID'}],
            'inputs': {'gexp.file': {'file': 'PRIVATE-ID', 'rows': 8, 'columns': 3}}, 'PRIVATE-ID': 'PRIVATE-ID'})
        self.assertNotIn('PRIVATE-ID', json.dumps([report, summary]))
        known = step_report.failure_summary({'state': 'unknown', 'job_id': '42'})
        self.assertEqual(known['classifications'][0], 'scheduler_state_unknown')
        unknown = step_report.failure_summary({'state': 'unknown'})
        self.assertEqual(unknown['classifications'][0], 'submission_unconfirmed')


if __name__ == '__main__':
    unittest.main()
