"""Chat tools follow the Analysis forms: gene-level Stage 6 results, failure evidence and labeled outputs."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import agent.core.conversation as conversation
from agent.core.model_privacy import safe_tool_result
from agent.runtime import signet_jobs as jobs, step_report
from agent.tools import workspace as tools

EDGES = ('source_gene_symbol,source_chr,source_start,source_end,target_gene_symbol,target_chr,target_start,target_end,frequency,coefficient\n'
         'PGD,chr1,  1,  2,ENO1,chr1,3,4,1,0.4\n'
         'ENO1,chr1,  3,  4,PGD,chr1,1,2,0.9,-0.2\n'
         'CLK2,chr1,  5,  6,PGD,chr1,1,2,0.6,0.1\n'
         'TCGA-05-4244-01A,chr1,  7,  8,PGD,chr1,1,2,0.5,0.1\n')
DASHBOARD = {'summary': {'subnetworks': 1, 'genes': 3, 'edges': 3},
             'ppi': [{'Protein 1': 'PGD', 'Protein 2': 'ENO1', 'Combined Score': 903}],
             'subnetworks': [{'number': 1, 'genes': 3, 'edges': 3, 'modularity_groups': 2,
                              'pathway': [{'description': 'Glycolysis, Term: GO:0006096', 'p_value': 0.001},
                                          {'description': 'see /pub/user/file', 'p_value': 0.01}]}]}


class NetworkGenesTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name).resolve()
        resv = self.root / 'work/res/resv'
        resv.mkdir(parents=True)
        (resv / 'signet-edges.csv').write_text(EDGES)
        (resv / 'signet_dashboard_freq0.45.json').write_text(json.dumps(DASHBOARD))
        self.history = {'jobs': {'visualize': {'state': 'completed', 'settings': {'freq': '0.45', 'ntop': '1'}}}}
        run = patch.object(tools.workspace, '_workspace_run', return_value=(self.root, self.history))
        run.start()
        self.addCleanup(run.stop)

    def test_hub_genes_and_one_gene_match_the_dashboard_degree(self):
        result = tools.get_network_genes('run-1', gene='pgd', limit=2)
        self.assertEqual(result['hub_genes'][0], {'gene': 'PGD', 'degree': 4, 'targets': 1, 'regulators': 3})
        self.assertEqual(len(result['hub_genes']), 2)
        self.assertEqual([edge['gene'] for edge in result['gene']['regulated_by']], ['ENO1', 'CLK2', 'TCGA-05-4244-01A'])
        self.assertEqual(result['known_string_interactions'], [{'gene_a': 'PGD', 'gene_b': 'ENO1', 'score': 903}])

    def test_model_sees_gene_symbols_but_never_sample_ids_or_paths(self):
        public = safe_tool_result('get_network_genes', tools.get_network_genes('run-1', gene='PGD'))
        text = json.dumps(public)
        self.assertIn('"gene": "PGD"', text)
        self.assertNotIn('TCGA-05', text)
        self.assertNotIn('/pub/', text)
        self.assertEqual(public['subnetworks'][0]['enrichment_terms'], [
            {'term': 'Glycolysis, Term: GO:0006096', 'p_value': 0.001}, {'p_value': 0.01}])
        self.assertTrue(public['run_id'].startswith('modelref-'))
        self.assertIn('regulates the target gene', public['meaning'])

    def test_requires_a_completed_stage_6_and_valid_arguments(self):
        for arguments in ({'limit': 0}, {'limit': 51}, {'gene': '../x'}, {'source': 'archive'}):
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                tools.get_network_genes('run-1', **arguments)
        self.history['jobs']['visualize']['state'] = 'running'
        with self.assertRaises(jobs.StepError):
            tools.get_network_genes('run-1')

    def test_unknown_gene_is_reported_not_guessed(self):
        result = tools.get_network_genes('run-1', gene='TP53')
        self.assertEqual(result['gene'], {'gene': 'TP53', 'found': False})


class FailureEvidenceTest(unittest.TestCase):
    def test_log_lines_lose_sample_ids_and_folders(self):
        line = step_report.mask_log_line('Error in fread(/dfs6b/pub/me/runs/x/data/gexp): TCGA-05-4244-01A-01D and GTEX-1117F missing\x07')
        self.assertEqual(line, 'Error in fread(.../gexp): [sample ID] and [sample ID] missing')

    def test_accounting_keeps_the_job_line_and_the_batch_memory(self):
        accounting = step_report.parse_accounting(
            '59983303|FAILED|1:0|00:18:55||32G|hpc3-18-01;59983303.batch|FAILED|1:0|00:18:55|267472K||hpc3-18-01;'
            '59983303.extern|COMPLETED|0:0|00:18:55|||hpc3-18-01;')
        self.assertEqual(accounting, {'state': 'FAILED', 'exit_code': '1:0', 'elapsed': '00:18:55',
                                      'requested_mem_gb': 32.0, 'max_memory_mb': 261.2, 'node': 'hpc3-18-01'})
        self.assertIsNone(step_report.parse_accounting(''))

    def test_failure_report_carries_accounting_and_rejects_unmasked_lines(self):
        record = {'state': 'failed', 'slurm_state': 'FAILED',
                  'accounting': {'state': 'FAILED', 'exit_code': '1:0', 'elapsed': '00:18:55', 'node': 'hpc3-18-01'},
                  'log_tail': ['Summarizing for ultra-low-frequency variants...', 'id TCGA-05-4244-01A']}
        public = safe_tool_result('get_workspace_report', {'status': 'ok', 'failure': step_report.failure_summary(record)})
        self.assertEqual(public['failure']['accounting']['elapsed'], '00:18:55')
        self.assertEqual(public['failure']['log_tail'], ['Summarizing for ultra-low-frequency variants...', 'id [sample ID]'])

    def test_status_script_reads_accounting_and_logs_only_after_the_job_left_the_queue(self):
        record = {'step': 'cis', 'remote_dir': '/remote/run', 'job_id': '42', 'attempt': 1}
        script = jobs._status_script(record, jobs.STEPS['cis'])
        self.assertIn('if [ -z "$queue_state" ] && [ -n "$account_state" ]; then', script)
        self.assertIn('say log_tail', script)
        record = {}
        jobs._record_diagnostics(record, {'accounting': '42|FAILED|1:0|00:01:00|10M|4G|n1;',
                                          'log_tail': 'L3RtcC9ydW4vYSBUQ0dBLTA1LTQyNDQtMDFBCg=='})
        self.assertEqual(record['log_tail'], ['.../a [sample ID]'])
        self.assertEqual(record['accounting']['max_memory_mb'], 10.0)

    def test_dataset_stage_1_reports_preparation_before_imputation(self):
        record = {'step': 'genotype', 'remote_dir': '/remote/run', 'job_id': '42', 'attempt': 1,
                  'inputs': {'ped.file': '/remote/run/inputs/prepared/study.ped'}}
        script = jobs._status_script(record, jobs.STEPS['genotype'])
        self.assertIn("say progress_preparation", script)
        self.assertIn("/remote/run/inputs/frozen/expression", script)
        self.assertEqual(step_report.public_progress({'progress': {'preparation': '1 2'}}), {'preparation': '1 2'})


class Stage6SummaryTest(unittest.TestCase):
    def test_tables_are_labeled_and_figures_are_only_present(self):
        record = {'step': 'visualize', 'settings': {'freq': '0.45', 'ntop': '1'}, 'state': 'completed',
                  'required_outputs': ['res/resv/signet-edges.csv', 'res/resv/signet_top1_freq0.45_name.txt',
                                       'res/resv/signet_circular_top1_freq0.45.pdf']}
        summary = {'outputs': [{'file': 'signet-edges.csv', 'rows': 410, 'columns': 10},
                               {'file': 'signet_top1_freq0.45_name.txt', 'rows': 95, 'columns': 1},
                               {'file': 'signet_circular_top1_freq0.45.pdf', 'rows': 860, 'columns': 1}]}
        with patch.object(jobs, '_required', return_value=record['required_outputs']):
            public = safe_tool_result('get_workspace_stage', {'status': 'ok', 'job': {
                'summary': step_report.safe_summary('visualize', record, summary)}})
        self.assertEqual(public['job']['summary']['outputs'], [
            {'file': 'signet-edges.csv', 'rows': 409, 'rows_are': 'regulatory edges'},
            {'file': 'signet_top1_freq0.45_name.txt', 'rows': 95, 'rows_are': 'genes in the subnetwork'},
            {'file': 'signet_circular_top1_freq0.45.pdf', 'available': True}])


class PromptTest(unittest.TestCase):
    def test_prompt_matches_the_analysis_forms(self):
        prompt = conversation.config.system_instruction
        for text in ("Reply in the language of the user's latest message", 'under its own number',
                     'modelref- values are internal handles', 'get_network_genes', 'There are no chat cards',
                     'Review a new attempt'):
            self.assertIn(text, prompt)
        for text in ('configure_signet', 'propose_hpc3_genotype', 'Decision summary', 'in English, regardless'):
            self.assertNotIn(text, prompt)


if __name__ == '__main__':
    unittest.main()
