"""Original export delivery uses local completed fixtures, never SSH or model calls."""
import http.client
import io
import json
from pathlib import Path
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.parse import urlsplit
from zipfile import ZipFile

from agent.app.chat_ui import ChatServer
from agent.runtime.signet_jobs import StepError
from agent.stage6 import result_assets
from agent.stage6.workspace import Workspace
import test_workspace_visualization as fixtures


class Stage6ResultAssetsTest(unittest.TestCase):
    def setUp(self):
        fixtures.WorkspaceVisualizationTest.setUp(self)
        self.workspace = Workspace(SimpleNamespace(state_file=None))
        self.assets = result_assets.ResultAssets(self.workspace)
        self.html = 'signet_top1_freq0.45.html'
        self.pdf = 'signet_circular_top1_freq0.45.pdf'
        self.widget = 'signet_top1_freq0.45_files'
        (self.directory / self.html).write_text(f'<html><head><script src="{self.widget}/htmlwidgets.js"></script></head><body>live widget</body></html>')
        (self.directory / self.widget).mkdir()
        (self.directory / self.widget / 'htmlwidgets.js').write_text('window.fixtureOriginalWidget=true;')
        (self.directory / self.widget / 'widget.css').write_text('body{color:black}')
        (self.directory / self.widget / 'secret.txt').write_text('not an export dependency')
        (self.directory / 'clinical.txt').write_text('must never be delivered')
        (self.directory / 'signet_top2_freq0.45.html').write_text('not requested')
        no_ssh = patch('agent.runtime.ssh_transport.remote', side_effect=AssertionError('Original exports are local'))
        no_ssh.start(); self.addCleanup(no_ssh.stop)

    def row(self, source='live'):
        return next(row for row in self.workspace.history()['runs'] if row['source'] == source)

    def metadata(self, source='live'):
        row = self.row(source)
        return self.assets.metadata(row['history_id'], row['record_identity'])

    def ticket(self, result):
        return urlsplit(result['url']).query.removeprefix('ticket=')

    def test_original_widget_dependencies_and_pdf_are_an_exact_allowlist(self):
        data = self.metadata()
        self.assertEqual((data['history_id'], data['source'], data['run_id']), ('workspace--' + self.run_id, 'live', self.run_id))
        self.assertEqual(len(data['previews']), 1)
        self.assertEqual(data['plots'][0]['pdf'], self.pdf)
        self.assertIsNone(data['plots'][0]['url'])
        match = result_assets.PREVIEW_PATH.fullmatch(data['previews'][0]['url'])
        body, content_type, csp = self.assets.preview(match['ticket'], self.html, 'http://127.0.0.1:1234')
        self.assertIn(b'live widget', body)
        self.assertIn('text/html', content_type)
        self.assertIn('sandbox allow-scripts;', csp)
        self.assertNotIn('allow-same-origin', csp)
        self.assertIn("connect-src 'none'", csp)
        self.assertIn("form-action 'none'", csp)
        self.assertNotIn("script-src 'self'", csp)
        self.assertEqual(self.assets.preview(match['ticket'], self.widget + '/htmlwidgets.js', 'http://127.0.0.1:1234')[0], b'window.fixtureOriginalWidget=true;')
        for name in ('clinical.txt', self.widget + '/secret.txt', '../manifest.json', self.pdf, 'signet_top2_freq0.45.html'):
            with self.subTest(name=name), self.assertRaises(StepError):
                self.assets.preview(match['ticket'], name, 'http://127.0.0.1:1234')

    def test_zip_and_individual_pdf_are_one_use_and_exclude_unrelated_files(self):
        row = self.row()
        issued = self.assets.issue_download(row['history_id'], row['record_identity'])
        data, filename, content_type = self.assets.download(self.ticket(issued))
        self.assertEqual(content_type, 'application/zip')
        self.assertIn('workspace-' + self.run_id, filename)
        with ZipFile(io.BytesIO(data)) as archive:
            self.assertIn(self.html, archive.namelist())
            self.assertIn(self.widget + '/htmlwidgets.js', archive.namelist())
            self.assertIn(self.pdf, archive.namelist())
            self.assertNotIn('clinical.txt', archive.namelist())
            self.assertNotIn(self.widget + '/secret.txt', archive.namelist())
            self.assertNotIn('signet_top2_freq0.45.html', archive.namelist())
        with self.assertRaises(StepError):
            self.assets.download(self.ticket(issued))
        issued = self.assets.issue_download(row['history_id'], row['record_identity'], self.pdf)
        data, filename, content_type = self.assets.download(self.ticket(issued))
        self.assertEqual((filename, content_type, data), (self.pdf, 'application/pdf', (self.directory / self.pdf).read_bytes()))
        for invalid in ('clinical.txt', '../secret.pdf', 'signet_circular_top2_freq0.45.pdf'):
            with self.subTest(invalid=invalid), self.assertRaises(StepError):
                self.assets.issue_download(row['history_id'], row['record_identity'], invalid)

    def dashboard(self, **changes):
        """The shape jsonlite::write_json gives the objects netshiny.R exports on HPC3."""
        data = {'version': 1, 'frequency': 0.45, 'ntop': 1, 'summary': {'subnetworks': 3, 'genes': 5, 'edges': 4},
                'top_nodes': [{'gene': 'MEGF6', 'degree': 3, 'subnetwork': 1}, {'gene': 'B', 'degree': 1}],
                'ppi': [{'Protein 1': 'MEGF6', 'Protein 2': 'B', 'Combined Score': 912}],
                'subnetworks': [{'number': 1, 'genes': 3, 'edges': 2, 'enrichment_terms': False, 'modularity_groups': 2,
                                 'pathway': [{'description': 'Cell cycle, Term: GO:1', 'p_value': 0.0001, 'text': 'Related genes: MEGF6,B'}],
                                 'table': [{'source gene': 'MEGF6', 'source chr': '1', 'source start': 100, 'source end': 200,
                                            'target gene': 'B', 'target chr': '1', 'target start': 300, 'target end': 400,
                                            'coef': 0.5}]}]}
        data.update(changes)
        (self.directory / 'signet_dashboard_freq0.45.json').write_text(json.dumps(data))

    def test_dashboard_export_is_read_with_its_network_pages_and_figure_reasons(self):
        self.dashboard()
        lib = self.directory / 'signet_dashboard_freq0.45_files'
        lib.mkdir()
        (lib / 'vis.js').write_text('window.vis=true;')
        (lib / 'notes.txt').write_text('not a dependency')
        for criterion in ('enrichment', 'modularity'):
            (self.directory / f'signet_dashboard_freq0.45_top1_{criterion}.html').write_text(
                f'<html><head><script src="signet_dashboard_freq0.45_files/vis.js"></script></head><body>{criterion}</body></html>')
        (self.directory / 'signet_enrich_KEGG_info_top1_freq0.45.txt').write_text('category@term\nNA@NA\n')
        (self.directory / 'signet_enrich_Process_info_top1_freq0.45.txt').write_text('category@term\nProcess@GO:1\nProcess@GO:2\n')
        data = self.metadata()['dashboard']
        self.assertTrue(data['available'])
        self.assertEqual(data['summary'], {'subnetworks': 3, 'genes': 5, 'edges': 4})
        self.assertEqual(data['top_nodes'], [{'gene': 'MEGF6', 'degree': 3, 'subnetwork': 1}, {'gene': 'B', 'degree': 1, 'subnetwork': None}])
        self.assertEqual(data['ppi'], [{'protein1': 'MEGF6', 'protein2': 'B', 'score': 912}])
        entry = data['subnetworks'][0]
        self.assertEqual(entry['table']['rows'], [['MEGF6', '1', 100, 200, 'B', '1', 300, 400]])
        self.assertEqual(entry['pathway'][0]['text'], 'Related genes: MEGF6,B')
        self.assertEqual(entry['missing'], {
            'enrichment_radar': {'code': 'too_few', 'category': 'KEGG', 'count': 0, 'minimum': 4},
            'enrichment_hist': {'code': 'too_few', 'category': 'Process', 'count': 2, 'minimum': 5}})
        page = result_assets.PREVIEW_PATH.fullmatch(entry['networks']['modularity'])
        body, _, csp = self.assets.preview(page['ticket'], page['name'], 'http://127.0.0.1:1234')
        self.assertIn(b'modularity', body)
        self.assertIn(b"signetGenes", body)
        self.assertIn(result_assets._SCRIPT_HASH, csp)
        self.assertEqual(self.assets.preview(page['ticket'], 'signet_dashboard_freq0.45_files/vis.js', 'http://127.0.0.1:1234')[0], b'window.vis=true;')
        for name in ('signet_dashboard_freq0.45.json', 'signet_dashboard_freq0.45_files/notes.txt'):
            with self.subTest(name=name), self.assertRaises(StepError):
                self.assets.preview(page['ticket'], name, 'http://127.0.0.1:1234')
        row = self.row()
        archive, _, _ = self.assets.download(self.ticket(self.assets.issue_download(row['history_id'], row['record_identity'])))
        with ZipFile(io.BytesIO(archive)) as files:
            self.assertIn('signet_dashboard_freq0.45.json', files.namelist())
            self.assertIn('signet_dashboard_freq0.45_top1_enrichment.html', files.namelist())
            self.assertIn('signet_enrich_Process_info_top1_freq0.45.txt', files.namelist())
            self.assertNotIn('signet_dashboard_freq0.45_files/notes.txt', files.namelist())

    def test_dashboard_reports_why_it_is_unavailable(self):
        data = self.metadata()['dashboard']
        self.assertEqual((data['available'], data['reason']), (False, {'code': 'not_exported'}))
        self.assertEqual(data['subnetworks'][0]['networks'], {'enrichment': None, 'modularity': None})
        self.assertEqual(data['subnetworks'][0]['missing']['enrichment_radar'], {'code': 'not_recorded', 'category': 'KEGG'})
        (self.directory / 'signet_dashboard_freq0.45.error.txt').write_text('Error in visNetwork(...):\n  could not find function\n')
        data = self.metadata()['dashboard']
        self.assertEqual(data['reason'], {'code': 'export_failed', 'detail': 'Error in visNetwork(...): could not find function'})
        for broken in ({'summary': {'subnetworks': 'three', 'genes': 5, 'edges': 4}}, {'subnetworks': []}, {'ppi': 'none'}):
            with self.subTest(broken=broken):
                self.dashboard(**broken)
                data = self.metadata()['dashboard']
                self.assertEqual((data['available'], data['reason'], data['top_nodes']), (False, {'code': 'invalid'}, []))
                self.assertNotIn('table', data['subnetworks'][0])

    def test_changed_identity_and_artifact_cannot_be_replayed(self):
        row = self.row(); issued = self.assets.issue_download(row['history_id'], row['record_identity'])
        (self.directory / self.pdf).write_text('changed after the user reviewed the result')
        with self.assertRaises(StepError):
            self.assets.download(self.ticket(issued))
        issued = self.assets.issue_download(row['history_id'], row['record_identity'])
        self.job_path.write_text(json.dumps({**self.job, 'job_id': 'different'}))
        with self.assertRaises(StepError):
            self.assets.download(self.ticket(issued))
        with self.assertRaises(StepError):
            self.assets.metadata(row['history_id'], row['record_identity'], row['revision'])

    def test_tickets_expire_and_current_source_cannot_be_substituted_by_same_run_name(self):
        archive = self.project / 'data/stage6-results' / self.run_id; archive.mkdir(parents=True)
        (archive / 'verification.json').write_text(json.dumps({'run': self.run_id, 'jobs': {'visualize': {'state': 'completed', 'settings': self.settings}},
            'graph': {'genes': 5, 'connections': 4, 'subnetworks': 2, 'displayed': 1}}))
        (archive / self.edge_path.name).write_bytes(self.edge_path.read_bytes())
        (archive / self.html).write_text('<html><head></head><body>archive widget</body></html>')
        data = self.metadata('archive'); match = result_assets.PREVIEW_PATH.fullmatch(data['previews'][0]['url'])
        self.assertIn(b'archive widget', self.assets.preview(match['ticket'], self.html, 'http://127.0.0.1:1234')[0])
        self.assertNotEqual(self.row()['record_identity'], self.row('archive')['record_identity'])
        with self.assertRaises(StepError):
            self.assets.metadata(self.row()['history_id'], self.row('archive')['record_identity'])
        with patch.object(self.assets, 'clock', return_value=self.assets.clock() + result_assets.PREVIEW_TTL + 1):
            with self.assertRaises(StepError):
                self.assets.preview(match['ticket'], self.html, 'http://127.0.0.1:1234')

    def test_links_are_rejected_and_missing_optional_outputs_are_not_synthesized(self):
        row = self.row()
        (self.directory / self.widget / 'htmlwidgets.js').unlink()
        (self.directory / self.widget / 'htmlwidgets.js').symlink_to(self.directory / 'clinical.txt')
        with self.assertRaises(StepError):
            self.assets.metadata(row['history_id'], row['record_identity'])
        (self.directory / self.widget / 'htmlwidgets.js').unlink()
        data = self.metadata()
        self.assertIsNone(data['thresholds'])
        self.assertTrue(all(plot['url'] is None for plot in data['plots']))
        matrix = self.root / 'work/res/resn/signet_Afreq'; matrix.parent.mkdir()
        matrix.write_text('0,0.8,0.9\n0.85,0,1\n0.95,0,0\n')
        self.assertEqual(self.metadata()['thresholds'], [
            {'cutoff': .8, 'genes': 3, 'connections': 5}, {'cutoff': .85, 'genes': 3, 'connections': 4},
            {'cutoff': .9, 'genes': 3, 'connections': 3}, {'cutoff': .95, 'genes': 3, 'connections': 2},
            {'cutoff': 1, 'genes': 2, 'connections': 1}])
        matrix.write_text('0,nan\n1,0\n')
        self.assertIsNone(self.metadata()['thresholds'])

    def test_limits_nonregular_files_and_download_expiry_fail_closed(self):
        row = self.row()
        with patch.object(result_assets, 'MAX_FILE', 10):
            with self.assertRaises(StepError):
                self.metadata()
        with patch.object(result_assets, 'MAX_TOTAL', 10):
            with self.assertRaises(StepError):
                self.metadata()
        with patch.object(result_assets, 'MAX_FILES', 1):
            with self.assertRaises(StepError):
                self.metadata()
        original = self.directory / self.pdf
        original.unlink()
        import os
        os.mkfifo(original)
        with self.assertRaises(StepError):
            self.assets.metadata(row['history_id'], row['record_identity'])
        original.unlink(); original.write_text('Restored original PDF fixture')
        issued = self.assets.issue_download(row['history_id'], row['record_identity'])
        with patch.object(self.assets, 'clock', return_value=self.assets.clock() + result_assets.DOWNLOAD_TTL + 1):
            with self.assertRaises(StepError):
                self.assets.download(self.ticket(issued))

    def test_rectangular_target_by_cis_gene_matrix_retains_original_cutoff_counts(self):
        matrix = self.root / 'work/res/resn/signet_Afreq'; matrix.parent.mkdir()
        matrix.write_text('0,0.8\n0.85,1\n0.95,0.9\n')
        self.assertEqual(self.metadata()['thresholds'], [
            {'cutoff': .8, 'genes': 3, 'connections': 5}, {'cutoff': .85, 'genes': 3, 'connections': 4},
            {'cutoff': .9, 'genes': 3, 'connections': 3}, {'cutoff': .95, 'genes': 3, 'connections': 2},
            {'cutoff': 1, 'genes': 1, 'connections': 1}])
        matrix.write_text('0,0.8,0.9\n0.85,1,0.95\n')
        self.assertIsNone(self.metadata()['thresholds'])

    def test_http_grants_require_token_and_origin_but_allow_exact_ticket_subresources(self):
        server = ChatServer(('127.0.0.1', 0), Mock())
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(thread.join); self.addCleanup(server.shutdown)
        origin = f'http://127.0.0.1:{server.server_port}'
        row = self.row(); route = '/signet/history/' + row['history_id'] + '/stage6/assets'
        def call(method, path, body=None, headers=None):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=10)
            try:
                connection.request(method, path, body=json.dumps(body) if body is not None else None,
                    headers=headers or {})
                response = connection.getresponse(); return response.status, dict(response.getheaders()), response.read()
            finally:
                connection.close()
        self.assertEqual(call('GET', route + '?identity=' + row['record_identity'])[0], 403)
        headers = {'X-Chat-Token': server.token, 'Origin': origin, 'Content-Type': 'application/json'}
        status, _, body = call('GET', route + '?identity=' + row['record_identity'], headers=headers)
        self.assertEqual(status, 200); metadata = json.loads(body)
        status, response_headers, body = call('GET', metadata['previews'][0]['url'])
        self.assertEqual(status, 200)
        self.assertEqual(response_headers['Cache-Control'], 'no-store')
        self.assertIn('sandbox allow-scripts', response_headers['Content-Security-Policy'])
        self.assertEqual(call('POST', route + '/download', {'identity': row['record_identity']}, {'X-Chat-Token': server.token})[0], 403)
        status, _, body = call('POST', route + '/download', {'identity': row['record_identity'], 'asset': self.pdf}, headers)
        self.assertEqual(status, 200); download = json.loads(body)['url']
        status, response_headers, body = call('GET', download)
        self.assertEqual(status, 200)
        self.assertEqual(response_headers['Content-Type'], 'application/pdf')
        self.assertIn('attachment;', response_headers['Content-Disposition'])
        self.assertEqual(call('GET', download)[0], 404)
