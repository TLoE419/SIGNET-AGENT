import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import agent.tools.signet as st
from agent.stage6.workspace import Workspace


class WorkspaceTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.project = Path(temporary.name).resolve()
        project = patch.object(st, 'PROJECT', self.project)
        project.start()
        self.addCleanup(project.stop)
        self.root = self.project / 'runs/baseline'
        (self.root / 'work/res/resv').mkdir(parents=True)
        (self.root / 'manifest.json').write_text('{}')
        (self.root / 'work/config.ini').write_text(
            'freq=1\nntop=1\nresv=' + str(self.root / 'work/res/resv/signet') + '\n')
        (self.root / 'visualization.json').write_text(json.dumps({'status': 'verified_completed'}))
        (self.root / 'work/res/resv/signet_edgelist_1.txt').write_text(
            'source_gene_symbol,target_gene_symbol,frequency,coefficient\nA,B,1,0.5\nB,A,1,0.5\n')
        self.server = SimpleNamespace(state_file=self.project / '.chat-state.json')
        self.w = Workspace(self.server)
        self.w.sessions['s1'] = {'baseline': 'baseline'}
        self.w.path.write_text(json.dumps(self.w.sessions))

    def test_completed_results_are_read_only_and_include_archived_exports(self):
        from agent.app.chat_ui import ChatServer
        import http.client

        archive = self.project / 'data/stage6-results/archived'
        archive.mkdir(parents=True)
        report = {'run': 'archived', 'jobs': {'visualize': {
            'state': 'completed', 'settings': {'freq': '0.45', 'ntop': '1'}}},
            'graph': {'connections': 2, 'genes': 3, 'subnetworks': 1, 'displayed': 1}}
        metadata = archive / 'verification.json'
        metadata.write_text(json.dumps(report))
        edges = archive / 'signet_edgelist_0.45.txt'
        edges.write_text('source_gene_symbol,target_gene_symbol,frequency,coefficient\n'
                         'MEGF6,B,0.45,0.25\nB,C,0.9,-0.5\n')
        saved = self.w.path.read_bytes()
        with ChatServer(('127.0.0.1', 0), Mock()) as server:
            server.stage6 = self.w
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            def request(path, authenticated=True):
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                try:
                    headers = {'X-Chat-Token': server.token} if authenticated else {}
                    conn.request('GET', '/stage6/results' + path, headers=headers)
                    response = conn.getresponse()
                    return response.status, json.loads(response.read())
                finally:
                    conn.close()

            try:
                self.assertEqual(request('', authenticated=False)[0], 403)
                self.assertEqual(request('?run=archived', authenticated=False)[0], 403)
                status, listing = request('')
                self.assertEqual(status, 200)
                self.assertEqual([run['run_id'] for run in listing['runs']], ['baseline', 'archived'])
                self.assertEqual(request('?run=baseline')[1]['graph']['counts']['connections'], 2)
                status, result = request('?run=archived')
                self.assertEqual(status, 200)
                self.assertEqual(result['source'], 'archive')
                self.assertEqual(result['graph']['counts'], report['graph'])
                self.assertEqual(result['graph']['edges'][0], {
                    'source': 'MEGF6', 'target': 'B', 'frequency': 0.45, 'coefficient': 0.25})
                self.assertEqual(request('?run=../archived')[0], 400)
                status, error = request('?run=missing')
                self.assertEqual(status, 400)
                self.assertEqual(error, {'error': 'No readable completed Stage 6 result for this run.'})
                self.assertEqual(request('?run=archived&run=baseline')[0], 400)
                self.assertEqual(self.w.path.read_bytes(), saved)
                self.assertEqual(set(self.w.sessions), {'s1'})
                self.assertEqual([run['run_id'] for run in self.w.available()], ['baseline'])
                report['graph']['connections'] = 1
                metadata.write_text(json.dumps(report))
                self.assertEqual(request('?run=archived')[0], 400)
                valid_report = metadata.read_text()
                del report['graph']
                metadata.write_text(json.dumps(report))
                self.assertEqual(request('?run=archived')[0], 400)
                self.assertEqual([run['run_id'] for run in request('')[1]['runs']], ['baseline'])
                metadata.write_text(valid_report)
                edges.unlink()
                edges.symlink_to(self.root / 'work/res/resv/signet_edgelist_1.txt')
                self.assertEqual(request('?run=archived')[0], 400)
                self.assertEqual([run['run_id'] for run in request('')[1]['runs']], ['baseline'])
            finally:
                server.shutdown()
                thread.join()


    def test_archived_history_joins_by_dataset_and_uses_frozen_inputs(self):
        from agent.app.chat_ui import ChatServer
        import http.client

        def write_json(path, value):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(value), encoding='utf-8')

        catalog_path = self.project / 'data/datasets/chromosome-one.json'
        current = {'genotype': ['new.ped', 'new.map'], 'expression': ['expression.tsv'],
                   'clinical': ['current-clinical.tsv']}
        recorded = {'genotype': ['original.ped', 'original.map'], 'expression': ['expression.tsv'],
                    'clinical': []}
        dataset = {'id': 'chromosome-one', 'name': ['第一號染色體', 'Chromosome one'], 'inputs': current}
        empty = {'id': 'unrun', 'name': ['待執行', 'Unrun'], 'inputs': {}}
        write_json(catalog_path, dataset)
        write_json(catalog_path.with_name('unrun.json'), empty)
        write_json(catalog_path.with_name('wrong-id.json'), empty)
        catalog_path.with_name('linked.json').symlink_to(catalog_path)

        archive = self.project / 'data/stage6-results/baseline'
        snapshot = {'run_id': 'baseline', 'dataset_id': 'chromosome-one',
                    'name': ['封存執行', 'Archived run'], 'inputs': recorded}
        report = {'run': 'baseline', 'jobs': {'visualize': {
            'job_id': '1234', 'state': 'completed', 'settings': {'freq': '0.45', 'ntop': '1'}}},
            'graph': {'connections': 1, 'genes': 2, 'subnetworks': 1, 'displayed': 1}}
        metadata = archive / 'history.json'
        write_json(metadata, snapshot)
        write_json(archive / 'verification.json', report)
        (archive / 'signet_edgelist_0.45.txt').write_text(
            'source_gene_symbol,target_gene_symbol,frequency,coefficient\nMEGF6,B,0.45,0.25\n')
        write_json(archive.with_name('missing-output') / 'history.json',
                   {**snapshot, 'run_id': 'missing-output'})
        write_json(archive.with_name('no-dataset') / 'history.json',
                   {**snapshot, 'run_id': 'no-dataset', 'dataset_id': 'missing'})
        write_json(archive.with_name('no-dataset') / 'verification.json', {**report, 'run': 'no-dataset'})
        (archive.with_name('no-dataset') / 'signet_edgelist_0.45.txt').write_bytes(
            (archive / 'signet_edgelist_0.45.txt').read_bytes())

        saved_state = self.w.path.read_bytes()
        with ChatServer(('127.0.0.1', 0), Mock()) as server:
            server.stage6 = self.w
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            def request(path, authenticated=True):
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                try:
                    headers = {'X-Chat-Token': server.token} if authenticated else {}
                    conn.request('GET', path, headers=headers)
                    response = conn.getresponse()
                    return response.status, json.loads(response.read())
                finally:
                    conn.close()

            try:
                self.assertEqual(request('/stage6/history', authenticated=False)[0], 403)
                self.assertEqual(request('/stage6/history?dataset=chromosome-one')[0], 400)
                status, history = request('/stage6/history')
                self.assertEqual(status, 200)
                self.assertEqual(history['datasets'], [dataset, {
                    **empty, 'inputs': {'genotype': [], 'expression': [], 'clinical': []},
                }])
                runs = {run['history_id']: run for run in history['runs']}
                self.assertEqual(set(runs), {'archive--baseline', 'archive--missing-output',
                                             'archive--no-dataset', 'recorded--baseline'})
                expected = {
                    **snapshot, 'jobs': report['jobs'], 'graph': report['graph'],
                    'frequency': 0.45, 'top_networks': 1, 'status': 'completed', 'source': 'archive',
                }
                self.assertEqual({key: runs['archive--baseline'][key] for key in expected}, expected)
                self.assertEqual(runs['archive--baseline']['association']['status'], 'recorded')
                self.assertEqual(runs['archive--no-dataset']['dataset_id'], 'missing')
                self.assertEqual(runs['archive--missing-output']['status'], 'unknown')
                self.assertFalse(runs['archive--missing-output']['capabilities']['stage6_graph'])
                self.assertIsNone(runs['recorded--baseline']['dataset_id'])
                self.assertEqual(request('/stage6/results?run=baseline')[1]['graph']['counts']['connections'], 2)
                status, archived = request('/stage6/results?run=baseline&source=archive')
                self.assertEqual(status, 200)
                self.assertEqual(archived['graph']['counts'], report['graph'])
                self.assertEqual(archived['graph']['edges'][0]['source'], 'MEGF6')
                self.assertEqual(request('/stage6/results?run=baseline&source=unknown')[0], 400)
                self.assertEqual(request('/stage6/results?run=baseline&source=archive&source=archive')[0], 400)

                dataset['inputs']['genotype'] = ['replacement.ped', 'replacement.map']
                write_json(catalog_path, dataset)
                refreshed = request('/stage6/history')[1]
                self.assertEqual(refreshed['datasets'][0]['inputs']['genotype'], ['replacement.ped', 'replacement.map'])
                self.assertEqual(next(run for run in refreshed['runs']
                                      if run['history_id'] == 'archive--baseline')['inputs'], recorded)
                self.assertEqual(json.loads(metadata.read_text()), snapshot)
                self.assertEqual(json.loads((archive / 'verification.json').read_text()), report)
                self.assertEqual(self.w.path.read_bytes(), saved_state)
                self.assertEqual(set(self.w.sessions), {'s1'})
            finally:
                server.shutdown()
                thread.join()

    def test_recorded_history_graph_requires_saved_settings_and_never_reads_current_config(self):
        from agent.stage6.workspace import recorded_completed_result
        with self.assertRaises(ValueError):
            recorded_completed_result('baseline')
        for malformed in ([], {'status': 'verified_completed', 'settings': {'freq': 1, 'ntop': float('inf')}}):
            (self.root / 'visualization.json').write_text(json.dumps(malformed))
            with self.assertRaises(ValueError):
                recorded_completed_result('baseline')
        saved = {'status': 'verified_completed', 'settings': {'freq': '1', 'ntop': '1'}}
        (self.root / 'visualization.json').write_text(json.dumps(saved))
        with patch.object(st, '_settings', side_effect=AssertionError('Current settings are not historical evidence')):
            result = recorded_completed_result('baseline')
            selected = self.w.completed_result('baseline', recorded_only=True)
        self.assertEqual(result['frequency'], 1)
        self.assertEqual(result['source'], 'recorded')
        self.assertEqual(result['graph']['counts']['connections'], 2)
        self.assertEqual(selected, result)
        saved['settings']['resv'] = str(self.project / 'outside/signet')
        (self.root / 'visualization.json').write_text(json.dumps(saved))
        with self.assertRaises(ValueError):
            recorded_completed_result('baseline')
