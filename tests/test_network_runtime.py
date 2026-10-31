import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from unittest.mock import Mock

import network_runtime as net
import network_worker as worker
import signet_runtime as vm
import signet_tools as st


class NetworkTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name).resolve()
        self.patch = patch.object(st, 'PROJECT', self.project)
        self.patch.start()
        (self.project / 'data').mkdir()
        st.configure_signet('network_test')
        self.root = self.project / 'runs/network_test'
        contents = ['1 2\n3 4\n5 6\n', '0 1\n1 0\n2 1\n',
                    '1 1 .01\n2 2 .02\n', 'g1\ng2\n', 'g1 1 1 2\ng2 1 3 4\n']
        self.args = {'run_id': 'network_test', 'bootstraps': 1,
                     'markers_per_gene': 3, 'correlation': .3}
        for key, content in zip(['expression', 'genotype', 'significant_pairs', 'gene_names', 'gene_positions'], contents):
            path = self.project / 'data' / key
            path.write_text(content)
            self.args[key] = str(path)

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_dispatch_validates_required_parameters_and_matrix_indices_before_network(self):
        args = dict(self.args)
        del args['bootstraps']
        self.assertEqual(st.dispatch_tool('submit_network', args)['status'], 'invalid')
        Path(self.args['significant_pairs']).write_text('1 3 .01\n')
        with patch.object(net, 'preflight') as preflight:
            self.assertEqual(st.dispatch_tool('submit_network', self.args)['status'], 'invalid')
            preflight.assert_not_called()
        self.assertFalse((self.root / '.active').exists())
        self.assertFalse((self.root / 'network.json').exists())

    def test_async_submission_bundle_is_scoped_and_replay_blocked(self):
        (self.project / '.env').write_text('PRIVATE')
        (self.root / 'work/script/.extra-secret').write_text('PRIVATE')
        ok = subprocess.CompletedProcess([], 0, stdout=b'')
        with patch.object(net, 'preflight', return_value=True), patch.object(vm, 'remote', return_value=ok) as remote:
            result = st.dispatch_tool('submit_network', self.args)
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(result['executed'], 'unknown')
        payload = remote.call_args_list[0].kwargs['input']
        with tarfile.open(fileobj=io.BytesIO(payload)) as archive:
            self.assertEqual(sum(p.startswith('inputs/') for p in archive.getnames()), 5)
            self.assertNotIn('.env', archive.getnames())
            self.assertFalse(any('.extra-secret' in path for path in archive.getnames()))
            self.assertIn('network_worker.py', archive.getnames())
            template = archive.extractfile('work/script/network/template.sub.ori').read()
            self.assertIn(b'#SBATCH --mem=4G', template)
            self.assertIn(b'time bash qsub', archive.extractfile('work/script/network/bts1gensub.sh').read())
            config = archive.extractfile('work/config.ini').read()
            self.assertIn(b'queue = local', config)
            self.assertNotIn(str(self.project).encode(), config)
        st._verify_source(self.root / 'work')
        self.assertEqual(st.dispatch_tool('submit_network', self.args)['status'], 'invalid')

    def test_uncertain_launch_never_replays_and_queries_do_not_launch(self):
        ok = subprocess.CompletedProcess([], 0, stdout=b'')
        with patch.object(net, 'preflight', return_value=True), patch.object(vm, 'remote', side_effect=[ok, subprocess.TimeoutExpired('ssh', 15)]):
            self.assertEqual(st.dispatch_tool('submit_network', self.args)['status'], 'unknown')
        active = subprocess.CompletedProcess([], 0, stdout=json.dumps({'status':'running','executed':True,'jobs':{}}).encode())
        with patch.object(vm, 'remote', return_value=active) as remote:
            self.assertEqual(st.dispatch_tool('get_network_status', {'run_id':'network_test'})['status'], 'running')
        self.assertEqual(remote.call_count, 1)
        self.assertTrue(remote.call_args.args[0].startswith('cat '))

    def test_exit_zero_requires_independent_output_verification_and_preserves_logs(self):
        ok = subprocess.CompletedProcess([], 0, stdout=b'')
        with patch.object(net, 'preflight', return_value=True), patch.object(vm, 'remote', return_value=ok):
            st.dispatch_tool('submit_network', self.args)
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
            data = b'partial\n'
            info = tarfile.TarInfo('work/res/resn/partial'); info.size=len(data)
            archive.addfile(info, io.BytesIO(data))
        state = {'status':'process_completed','executed':True,'returncode':0,'jobs':{}}
        with patch.object(vm, 'remote', side_effect=[subprocess.CompletedProcess([],0,stdout=json.dumps(state).encode()),
                subprocess.CompletedProcess([],0,stdout=buffer.getvalue())]), patch.object(net,'verify',side_effect=ValueError('missing output')):
            result = st.dispatch_tool('get_network_status', {'run_id':'network_test'})
        self.assertEqual(result['status'], 'verification_failed')
        self.assertTrue(result['collected'])
        with patch.object(vm, 'remote') as remote:
            self.assertEqual(net.status(self.root), result)
            remote.assert_not_called()

    def test_job_ownership_is_directory_bounded_and_cancellation_is_not_completion(self):
        remote = Path('/tmp/signet-agent-network/network_test')
        self.assertIsNotNone(worker.owned_job('JobId=4 JobState=RUNNING ExitCode=0:0 WorkDir='+str(remote / 'work/tmp/tmpn/stage1'), remote))
        self.assertIsNone(worker.owned_job('JobId=4 WorkDir='+str(remote)+'-other/work', remote))
        save = {'remote_directory':str(remote),'status':'running','executed':True}
        net.save(self.root, save)
        with patch.object(vm,'remote',side_effect=[subprocess.CompletedProcess([],0), subprocess.CompletedProcess([],0,
                stdout=b'{"status":"running","executed":true}')]) as request:
            result = net.status(self.root, cancel=True)
        self.assertEqual(result['status'],'running')
        self.assertTrue(result['cancellation_requested'])
        self.assertIn('/cancel', request.call_args_list[0].args[0])

    def test_actual_existing_verifier_accepts_complete_bootstraps_and_rejects_wrong_mean(self):
        root = self.root / 'work'
        files = {'res/resn/signet_Afreq':'1\n', 'res/resn/signet_CoeffMat0':'.5\n',
                 'res/resn/signet_net.genepos':'g1 1 1 2\n', 'tmp/tmpn/net.genepos':'g1 1 1 2\n',
                 'tmp/tmpn/nety':'1\n2\n', 'tmp/tmpn/netx':'1\n2\n'}
        for stage in (1,2):
            files[f'tmp/tmpn/stage{stage}/params.txt'] = 'Rscript fixture.r\n'
            files[f'tmp/tmpn/stage{stage}/params1.txt.completed'] = 'Rscript fixture.r\n'
        for b in (0,1):
            files[f'tmp/tmpn/stage1/output/ypre{b}']='1\n2\n'
            files[f'tmp/tmpn/stage2/output/AdjMat{b}']='1\n'
            files[f'tmp/tmpn/stage2/output/CoeffMat{b}']='.5\n'
        for name, content in files.items():
            path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(content)
        net.save(self.root, {'parameters':{'nboots':'1'}})
        state={'jobs':{'1':{'JobState':'COMPLETED','ExitCode':'0:0'}}}
        self.assertEqual(net.verify(self.root, state)['status'],'verified_actual_run')
        (root/'res/resn/signet_Afreq').write_text('.5\n')
        with self.assertRaises(ValueError):
            net.verify(self.root, state)

    def test_supervisor_cancels_only_owned_jobs_and_confirms_terminal_state(self):
        cancelled=[]
        def command(argv):
            if argv[0]=='squeue':
                # Preflight is empty; a foreign job can appear after this controller starts.
                return '' if not process.called else '3\n4\n'
            if argv[:3]==['scontrol','show','job']:
                job=argv[3]
                folder=self.root/'work/tmp/tmpn/stage1' if job=='3' else self.project/'foreign'
                state='CANCELLED' if job in cancelled else 'RUNNING'
                return f'JobId={job} JobState={state} ExitCode=0:0 WorkDir={folder}'
            if argv[0]=='scancel':
                cancelled.append(argv[1]);return ''
            self.fail(argv)
        child=Mock(pid=900001)
        child.poll.return_value=None
        with patch.object(worker,'command',side_effect=command), patch.object(worker.subprocess,'Popen',return_value=child) as process, \
                patch.object(worker.time,'sleep',side_effect=lambda _: (self.root/'cancel').touch()), \
                patch.object(worker.os,'killpg') as kill:
            worker.run(self.root)
        state=json.loads((self.root/'state.json').read_text())
        self.assertEqual(state['status'],'cancelled')
        self.assertEqual(cancelled,['3'])
        self.assertEqual(set(state['jobs']),{'3'})
        kill.assert_called_once()
        self.assertEqual(kill.call_args.args[0],child.pid)


class RemoteEnvironmentDirectoryTest(unittest.TestCase):
    def test_worker_accepts_configured_shared_directory_and_rejects_another_run_root(self):
        with tempfile.TemporaryDirectory() as directory:
            work_root = Path(directory) / 'runs'
            folder = work_root / 'network' / 'run-1'
            folder.mkdir(parents=True)
            (folder / 'runtime.json').write_text(json.dumps({'workRoot': str(work_root)}))
            self.assertTrue(worker.valid_runtime_directory(folder))
            (folder / 'runtime.json').write_text(json.dumps({'workRoot': str(Path(directory) / 'other')}))
            self.assertFalse(worker.valid_runtime_directory(folder))


if __name__ == '__main__':
    unittest.main()
