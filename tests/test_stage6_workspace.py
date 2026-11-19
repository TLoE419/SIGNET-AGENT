import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import agent.tools.signet as st
from agent.stage6.workspace import Workspace, CHAT_CONTEXT


class WorkspaceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name).resolve()
        self.patch = patch.object(st, 'PROJECT', self.project)
        self.patch.start()
        data = self.project/'data'; data.mkdir()
        (data/'a').write_text('0,1,0.8\n1,0,0\n0.8,0,0\n')
        (data/'c').write_text('0 0.5 0.2\n0.5 0 0\n0.2 0 0\n')
        (data/'g').write_text('A chr1 1 2\nB chr1 3 4\nC chr1 5 6\n')
        self.assertEqual(st.configure_signet('baseline')['status'],'created')
        self.root=self.project/'runs/baseline'
        st._update(self.root,{'Afreq':str(data/'a'),'coef':str(data/'c'),'vis.genepos':str(data/'g'),'freq':'1','ntop':'1'})
        (self.root/'visualization.json').write_text(json.dumps({'status':'verified_completed'}))
        (self.root/'work/res/resv/signet_edgelist_1.txt').write_text('source_gene_symbol,target_gene_symbol,frequency,coefficient\nA,B,1,0.5\nB,A,1,0.5\n')
        self.server=SimpleNamespace(state_file=self.project/'.chat-state.json',histories={},events={},turn_lock=threading.Lock(),save_state=Mock())
        self.w=Workspace(self.server)
        self.w.select('s1','baseline')

    def tearDown(self):
        self.patch.stop();self.temp.cleanup()

    def test_new_chat_stays_collapsed_until_stage6_requested(self):
        fresh=self.w.view('fresh')
        self.assertFalse(fresh['active'])
        self.assertEqual(fresh['graphs'],{})
        self.assertTrue(fresh['runs'])
        token=CHAT_CONTEXT.set((self.w,'fresh'))
        try:
            from agent.stage6.workspace import get_visualization_workspace
            self.assertTrue(get_visualization_workspace()['active'])
        finally:
            CHAT_CONTEXT.reset(token)
        self.assertTrue(self.w.view('fresh')['active'])
        self.assertTrue(Workspace(self.server).view('fresh')['active'])
        self.assertFalse(self.w.view('another-chat')['active'])

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

    def test_proposal_never_executes_and_confirmation_consumed_once(self):
        with patch.object(st,'run_visualization') as run:
            p=self.w.propose('s1',.8)['proposal']
            run.assert_not_called()
            self.assertEqual(self.w.view('s1')['graphs']['baseline']['counts']['connections'],2)
            self.w.approve('s1',p['id'])
            with self.assertRaises(ValueError):self.w.approve('s1',p['id'])
            with self.assertRaises(ValueError):self.w.approve('s2',p['id'])
            run.assert_not_called()

    def test_revisions_cancellation_and_bounds(self):
        a=self.w.propose('s1',.8)['proposal']
        b=self.w.propose('s1',.9)['proposal']
        self.assertEqual(a['status'],'superseded')
        with self.assertRaises(ValueError):self.w.approve('s1',a['id'])
        self.w.cancel('s1',b['id'])
        with self.assertRaises(ValueError):self.w.approve('s1',b['id'])
        for freq,n in [(float('nan'),1),(.8,2),(.8,101),(2,1)]:
            with self.assertRaises(ValueError):self.w.propose('s1',freq,n)

    def test_partial_revision_preserves_other_pending_values_and_reset_clears_proposal(self):
        a=self.w.propose('s1',.8)['proposal']
        b=self.w.propose('s1',top_networks=1)['proposal']
        self.assertEqual(b['after']['frequency'],.8)
        self.assertEqual(a['status'],'superseded')
        result=self.w.propose('s1',1,1)
        self.assertEqual(result['status'],'unchanged')
        self.assertEqual(b['status'],'cancelled')
        self.assertFalse(result['executed'])

    def test_input_changes_invalidate_confirmation(self):
        p=self.w.propose('s1',.8)['proposal']
        (self.project/'data/a').write_text('0,1,0.9\n1,0,0\n0.9,0,0\n')
        with self.assertRaises(ValueError):self.w.approve('s1',p['id'])
        self.assertEqual(p['status'],'stale')

    def test_model_cannot_bypass_confirmation(self):
        token=CHAT_CONTEXT.set((self.w,'s1'))
        try:
            with patch.object(st,'run_visualization') as run:
                result=st.dispatch_tool('run_visualization',{})
                self.assertFalse(result['executed']);run.assert_not_called()
                proposed=st.dispatch_tool('propose_visualization_change',{'frequency':.8})
                self.assertEqual(proposed['status'], 'needs_review')
                self.assertFalse(proposed['executed'])
                self.assertIn('propose_workspace_stage', proposed['reason'])
                self.assertEqual(self.w.state('s1')['proposals'], [])
                manual = st.propose_visualization_change(frequency=.8)
                self.assertEqual(manual['status'], 'awaiting_confirmation')
                run.assert_not_called()
        finally:CHAT_CONTEXT.reset(token)

    def test_restore_does_not_replay_and_preserves_old_result(self):
        p=self.w.propose('s1',.8)['proposal']
        self.w.approve('s1',p['id'])
        restored=Workspace(self.server)
        self.assertEqual(restored.state('s1')['proposals'][0]['status'],'unknown')
        self.assertEqual(restored.view('s1')['graphs']['baseline']['counts']['connections'],2)

    def test_failed_execution_keeps_history_and_releases_lock(self):
        before=(self.root/'work/res/resv/signet_edgelist_1.txt').read_bytes()
        p=self.w.propose('s1',.8)['proposal'];self.w.approve('s1',p['id'])
        self.server.turn_lock.acquire()
        with patch.object(st,'run_visualization',return_value={'status':'failed','executed':True}):
            self.w.execute('s1',p)
        self.assertFalse(self.server.turn_lock.locked())
        self.assertEqual(p['status'],'failed')
        self.assertIsNone(self.w.state('s1')['comparison'])
        self.assertEqual((self.root/'work/res/resv/signet_edgelist_1.txt').read_bytes(),before)
        self.assertEqual(len(self.server.histories['s1']),2)

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

    def test_workspace_http_guards_duplicate_and_cross_session_confirmations(self):
        import agent.app.chat_ui as chat_ui
        import http.client
        server = chat_ui.ChatServer(('127.0.0.1',0),Mock())
        server.stage6 = self.w
        thread = threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        origin = 'http://127.0.0.1:' + str(server.server_port)
        sid='12345678-1234-1234-1234-123456789abc'
        other='abcdefab-1234-1234-1234-123456789abc'
        self.w.select(sid,'baseline')
        p=self.w.propose(sid,.8)['proposal']
        def request(path, payload=None, authenticated=True):
            conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3)
            headers={'Origin':origin,'X-Chat-Token':server.token} if authenticated else {}
            conn.request('POST' if payload else 'GET',path,json.dumps(payload) if payload else None,headers)
            response=conn.getresponse();body=response.read();conn.close()
            return response.status,body
        try:
            self.assertEqual(request('/stage6.js')[0],404)  # Frontend assets are Electron-owned.
            self.assertEqual(request('/stage6?session='+sid,authenticated=False)[0],403)
            self.assertEqual(request('/stage6/confirm',{'session':sid,'proposal_id':p['id']},False)[0],403)
            self.assertEqual(request('/stage6/confirm',{'session':other,'proposal_id':p['id']})[0],400)
            started=threading.Event()
            with patch.object(self.w,'execute',side_effect=lambda *_: started.set()) as worker:
                self.assertEqual(request('/stage6/confirm',{'session':sid,'proposal_id':p['id']})[0],202)
                self.assertTrue(started.wait(1))
                worker.assert_called_once()
            server.turn_lock.release()
            self.assertEqual(request('/stage6/confirm',{'session':sid,'proposal_id':p['id']})[0],400)
            self.assertEqual(request('/stage6/file?session='+sid+'&run=baseline&name=../config.ini')[0],400)
        finally:
            if server.turn_lock.locked():server.turn_lock.release()
            server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()
