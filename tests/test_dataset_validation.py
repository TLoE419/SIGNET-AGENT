"""Scientific-input review uses temporary text fixtures, never SIGNET or remote jobs."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from agent.app.chat_ui import ChatServer
from agent.runtime import hpc_files, workspace_datasets, workspace_validation
from agent.runtime.jobs import validate_dataset as parser
from agent.runtime.signet_jobs import StepError
import agent.tools.signet as signet


class DatasetValidationTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.project = Path(temporary.name).resolve()
        for item in (patch.object(signet, 'PROJECT', self.project), patch.object(parser, 'BLOCKED', ()),
                     patch.dict(os.environ, {'SIGNET_DATASETS_STATE_FILE': str(self.project / 'catalog.json')})):
            item.start()
            self.addCleanup(item.stop)
        self.ped, self.map, self.expr, self.clin = [self.project / name for name in ('study.ped', 'study.map', 'expression.txt', 'clinical.tsv')]
        self.ids = ['TCGA-AA-A00' + str(number) for number in range(1, 7)]
        self.ped.write_text(''.join(value + '-NT ' + value + '-NT 0 0 ' + str(index % 2 + 1) + ' -9 A G A A C C\n'
                                  for index, value in enumerate(self.ids)))
        self.map.write_text('1 rs1 0 101\n1 rs2 0 202\n1 rs3 0 303\n')
        self.expression_source = ('Ensembl_ID ' + ' '.join(value + '-01A' for value in self.ids) + '\n'
                                  + ''.join('ENSG000' + str(index) + '.1 ' + ' '.join(['20', '21'] * 3) + '\n' for index in range(4))
                                  + ('0 ' + ' '.join(['0'] * 6) + '\n') * 5)
        self.expr.write_text(self.expression_source)
        races = ['asian', 'black or african american', 'white'] * 2
        self.clinical_source = 'submitter_id\trace\tgender\n' + ''.join(
            value + '\t' + races[index] + '\t' + ('group-a' if index % 2 else 'group-b') + '\n'
            for index, value in enumerate(self.ids))
        self.clin.write_text(self.clinical_source)
        self.inputs = {'genotype': [str(self.ped), str(self.map)], 'expression': [str(self.expr)], 'clinical': [str(self.clin)]}

    def test_official_shape_is_warning_with_counts_hashes_and_no_private_values(self):
        before = {path: path.read_bytes() for path in (self.ped, self.map, self.expr, self.clin)}
        result = parser.validate(self.inputs)
        self.assertEqual(result['status'], 'warning')
        self.assertEqual([check['status'] for check in result['checks']], ['passed', 'warning', 'passed'])
        self.assertEqual((result['pairing']['matched_patients'], result['pairing']['clinical_matched']), (6, 6))
        self.assertEqual(result['pairing']['status'], 'passed')
        self.assertEqual(result['checks'][0]['metrics']['markers'], 3)
        self.assertEqual(result['checks'][1]['metrics']['genes'], 4)
        self.assertEqual(result['checks'][1]['issues'][0]['code'], 'expression_scale')
        self.assertNotIn(self.ids[0], json.dumps(result))
        self.assertNotIn('group-a', json.dumps(result))
        for meta in result['files']:
            path = Path(meta['path'])
            self.assertTrue(meta['complete'])
            self.assertEqual(meta['sha256'], hashlib.sha256(before[path]).hexdigest())
            self.assertEqual(path.read_bytes(), before[path])

    def test_malformed_shapes_duplicate_headers_and_missing_covariates_fail_without_echoing_data(self):
        cases = [('ped', self.ped, self.ped.read_text().replace('A G A A C C', 'A G', 1)),
                 ('expression', self.expr, self.expression_source.replace('20 21 20 21 20 21', '20 21', 1)),
                 ('duplicate', self.expr, self.expression_source.replace(self.ids[1] + '-01A', self.ids[0] + '-01A', 1)),
                 ('numeric', self.expr, self.expression_source.replace('20 21', 'PRIVATE_CELL 21', 1)),
                 ('clinical', self.clin, self.clinical_source.replace('race\tgender', 'race', 1)),
                 ('covariate', self.clin, self.clinical_source.replace('\tgroup-b\n', '\t\n', 1))]
        original = {path: path.read_text() for _, path, _ in cases}
        for label, path, source in cases:
            with self.subTest(case=label):
                path.write_text(source)
                result = parser.validate(self.inputs)
                self.assertEqual(result['status'], 'failed')
                self.assertNotIn('PRIVATE_CELL', json.dumps(result))
                path.write_text(original[path])

    def test_clinical_duplicates_crlf_and_nonstandard_gender_labels_are_tolerated(self):
        self.clin.write_bytes((self.clinical_source + self.ids[0] + '\tprivate-unused-race\tunused\n').replace('\n', '\r\n').encode())
        result = parser.validate(self.inputs)
        self.assertEqual(result['status'], 'warning')
        self.assertEqual(result['checks'][2]['status'], 'warning')
        self.assertEqual(result['checks'][2]['metrics']['duplicate_patients'], 1)
        self.assertEqual(result['pairing']['status'], 'passed')
        self.assertNotIn('private-unused-race', json.dumps(result))

    def test_pairing_reports_no_overlap_and_unmatched_counts_not_identifiers(self):
        self.expr.write_text(self.expression_source.replace('TCGA-AA-A00', 'TCGA-AA-B00'))
        result = parser.validate(self.inputs)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['pairing']['matched_patients'], 0)
        self.assertEqual(result['pairing']['unmatched_genotype'], 6)
        self.assertEqual(result['pairing']['unmatched_expression'], 6)
        self.assertNotIn('TCGA-AA-B001', json.dumps(result))
        self.expr.write_text(self.expression_source.replace(self.ids[0] + '-01A', 'PRIVATE_ID', 1))
        result = parser.validate(self.inputs)
        self.assertEqual(result['checks'][1]['metrics']['duplicate_patients'], 0)
        self.assertNotIn('ambiguous_patient', [value['code'] for value in result['pairing']['issues']])
        self.assertNotIn('PRIVATE_ID', json.dumps(result))

    def test_scan_limits_never_report_complete_or_a_full_digest(self):
        for change in ({'max_file_bytes': 1}, {'max_rows': 2}, {'max_line_bytes': 8}, {'max_total_bytes': 20}, {'max_seconds': -1}):
            with self.subTest(limit=change), patch.dict(parser.LIMITS, change):
                result = parser.validate(self.inputs)
                self.assertEqual(result['status'], 'incomplete')
                self.assertTrue(any(not meta['complete'] and meta['sha256'] is None for meta in result['files']))

    def test_file_identity_changes_invalidate_hash_and_close_init_failure(self):
        close = parser.Reader.close
        def changed(reader):
            if reader.path == str(self.expr):
                with self.expr.open('ab') as stream:
                    stream.write(b'\n')
            return close(reader)
        with patch.object(parser.Reader, 'close', changed):
            result = parser.validate(self.inputs)
        self.assertEqual(result['status'], 'incomplete')
        meta = next(meta for meta in result['files'] if meta['path'] == str(self.expr))
        self.assertFalse(meta['complete'])
        self.assertIsNone(meta['sha256'])
        stream = self.ped.open('rb')
        info = self.ped.stat()
        changed_info = SimpleNamespace(st_dev=info.st_dev + 1, st_ino=info.st_ino, st_size=info.st_size,
                                       st_mtime_ns=info.st_mtime_ns, st_ctime_ns=info.st_ctime_ns)
        with patch.object(parser, 'open', return_value=stream, create=True), patch.object(parser.os, 'fstat', return_value=changed_info):
            with self.assertRaises(parser.StopReview):
                parser.Reader(str(self.ped), 'ped', {'deadline': 0, 'bytes': 0}, [])
        self.assertTrue(stream.closed)

    def test_snapshot_guard_read_only_script_and_seed_label_guidance(self):
        record = workspace_datasets.create_dataset(['資料組', 'Dataset'], inputs=self.inputs)
        before = (self.project / 'catalog.json').read_bytes()
        def remote(script, timeout):
            self.assertEqual(timeout, 60)
            code = script('/remote/workspace')
            self.assertIn('SIGNET_DATASET_VALIDATION', code)
            self.assertIn(workspace_validation._SOURCE, code)
            return parser.validate(self.inputs)
        with patch.object(hpc_files, '_call', side_effect=remote) as call:
            report = workspace_validation.validate(record['id'], self.inputs)
        self.assertEqual(report['dataset_id'], record['id'])
        self.assertEqual(report['inputs'], self.inputs)
        self.assertEqual((self.project / 'catalog.json').read_bytes(), before)
        call.assert_called_once()
        with patch.object(hpc_files, '_call') as call:
            with self.assertRaises(StepError) as caught:
                workspace_validation.validate(record['id'], {**self.inputs, 'clinical': []})
            self.assertEqual(caught.exception.code, 'conflict')
            call.assert_not_called()
        labels = workspace_datasets.create_dataset(['範例標籤', 'Seed labels'], inputs={
            'genotype': ['study.ped', 'study.map'], 'expression': ['example_gexp'], 'clinical': ['clinical.tsv']})
        with patch.object(hpc_files, '_call', side_effect=AssertionError('Do not guess seed paths')):
            report = workspace_validation.validate(labels['id'], labels['inputs'])
        self.assertEqual(report['status'], 'failed')
        self.assertTrue(all(check['issues'][0]['code'] == 'absolute_remote_path' for check in report['checks']))
        mixed = workspace_datasets.update_dataset(labels['id'], {'expression': self.inputs['expression']})
        with patch.object(hpc_files, '_call', side_effect=AssertionError('Do not contact SSH for unsafe paths')), \
                patch.object(parser, 'Reader', side_effect=AssertionError('Do not open remote paths locally')):
            report = workspace_validation.validate(mixed['id'], mixed['inputs'])
        self.assertEqual(report['checks'][1]['status'], 'unchecked')
        self.assertEqual(report['checks'][1]['issues'][0]['code'], 'blocked_by_paths')

    def test_dataset_changed_during_remote_read_returns_conflict_without_rewriting_scientific_files(self):
        record = workspace_datasets.create_dataset(['資料組', 'Dataset'], inputs=self.inputs)
        before = self.ped.read_bytes()
        def remote(*_):
            result = parser.validate(self.inputs)
            workspace_datasets.update_dataset(record['id'], {'clinical': []})
            return result
        with patch.object(hpc_files, '_call', side_effect=remote), self.assertRaises(StepError) as caught:
            workspace_validation.validate(record['id'], self.inputs)
        self.assertEqual(caught.exception.code, 'conflict')
        self.assertEqual(self.ped.read_bytes(), before)

    def test_authenticated_route_has_exact_snapshot_body_and_no_execution_side_effect(self):
        record = workspace_datasets.create_dataset(['資料組', 'Dataset'], inputs=self.inputs)
        server = ChatServer(('127.0.0.1', 0), Mock())
        self.addCleanup(server.server_close)
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 3)
        self.addCleanup(server.shutdown)
        def post(body, authenticated=True, origin=True):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=4)
            headers = {'Content-Type': 'application/json'}
            if authenticated:
                headers['X-Chat-Token'] = server.token
            if origin:
                headers['Origin'] = f'http://127.0.0.1:{server.server_port}'
            try:
                connection.request('POST', '/signet/datasets/' + record['id'] + '/validate', json.dumps(body), headers)
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()
        with patch.object(hpc_files, '_call', side_effect=lambda *_: parser.validate(self.inputs)) as remote:
            self.assertEqual(post({'inputs': self.inputs}, authenticated=False)[0], 403)
            self.assertEqual(post({'inputs': self.inputs}, origin=False)[0], 403)
            for body in ({}, {'inputs': self.inputs, 'run': True}, {'inputs': {}}, {'inputs': []},
                         {'inputs': {**self.inputs, 'unknown': []}}):
                self.assertEqual(post(body)[0], 400)
            remote.assert_not_called()
            status, result = post({'inputs': self.inputs})
            self.assertEqual((status, result['status'], result['executed'], result['read_only']), (200, 'warning', False, True))
            remote.assert_called_once()


if __name__ == '__main__':
    unittest.main()
