import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import signet_tools as st
from stage6_workspace import Workspace, CHAT_CONTEXT


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
            from stage6_workspace import get_visualization_workspace
            self.assertTrue(get_visualization_workspace()['active'])
        finally:
            CHAT_CONTEXT.reset(token)
        self.assertTrue(self.w.view('fresh')['active'])
        self.assertTrue(Workspace(self.server).view('fresh')['active'])
        self.assertFalse(self.w.view('another-chat')['active'])

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
                self.assertEqual(proposed['status'],'awaiting_confirmation')
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

    def test_workspace_http_guards_duplicate_and_cross_session_confirmations(self):
        import chat_ui
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
            self.assertEqual(request('/stage6.js')[0],200)
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
