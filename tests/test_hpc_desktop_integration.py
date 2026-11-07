import subprocess
import unittest
from unittest.mock import patch
from agent.runtime import hpc, ssh_transport

CONFIG = {'root':'/chosen/workspace', 'source':'/chosen/workspace/software/pinned',
          'image':'/chosen/workspace/images/signet.sif','executor':'/opt/singularity/bin/singularity',
          'runtimeModule':'singularity/3.9.4','partition':'lab_queue','workRoot':'/chosen/workspace/runs'}

class DesktopHpcIntegrationTest(unittest.TestCase):
    def test_reference_job_uses_selected_root_and_partition(self):
        output=b'@@workspace_path\t/chosen/workspace\n@@gtf\tstarted\n@@gtf_job\t42\n'
        with patch.object(ssh_transport,'available',return_value=True), patch.object(ssh_transport,'setup_environment',return_value=CONFIG), patch.object(ssh_transport,'remote',return_value=subprocess.CompletedProcess([],0,output,b'')) as remote:
            result=hpc.start_step('gtf')
        self.assertEqual(result['job_id'],'42')
        script=remote.call_args.kwargs['input'].decode()
        for expected in ('W="/chosen/workspace"','S="/chosen/workspace/software/pinned"','I="/chosen/workspace/images/signet.sif"','--partition=lab_queue',"signet_load_module singularity/3.9.4",'D="/chosen/workspace/.signet-agent/steps"'):
            self.assertIn(expected,script)
        self.assertNotIn('module load apptainer',script)
        self.assertNotIn('/pub/$USER/signet-agent',script)

    def test_unconfigured_environment_cannot_submit_reference_jobs(self):
        with patch.object(ssh_transport,'available',return_value=True), patch.object(ssh_transport,'setup_environment',side_effect=ssh_transport.SshRemoteError('Connect SSH')), patch.object(ssh_transport,'remote') as remote:
            self.assertEqual(hpc.start_step('ref')['status'],'not_ready')
        remote.assert_not_called()

    def test_reference_job_does_not_need_a_verified_container(self):
        draft={**CONFIG,'executor':'','partition':''}
        output=b'@@workspace_path\t/chosen/workspace\n@@ref\tstarted\n@@ref_job\t7\n'
        with patch.object(ssh_transport,'available',return_value=True), patch.object(ssh_transport,'environment',side_effect=AssertionError('verification is not required')), patch.object(ssh_transport,'setup_environment',return_value=draft), patch.object(ssh_transport,'remote',return_value=subprocess.CompletedProcess([],0,output,b'')) as remote:
            self.assertEqual(hpc.start_step('ref')['job_id'],'7')
        self.assertIn('--partition=free',remote.call_args.kwargs['input'].decode())

    def test_saved_desktop_root_cannot_be_overridden_by_environment_variable(self):
        with patch.dict('os.environ', {'SIGNET_HPC_WORKSPACE':'/wrong/workspace'}), patch.object(ssh_transport,'environment',return_value=CONFIG):
            self.assertEqual(hpc.workspace(), CONFIG['root'])

    def test_log_uses_configured_workspace_namespace(self):
        token=hpc._CONFIG.set(CONFIG)
        try:self.assertIn('D="/chosen/workspace/.signet-agent/steps"', hpc._log_script('gtf', CONFIG['root']))
        finally:hpc._CONFIG.reset(token)

    def test_moved_runtime_module_helper_can_be_read(self):
        self.assertIn('signet_load_module',ssh_transport.runtime_module_prelude(CONFIG))

    def test_preparation_uses_verified_source_not_a_second_clone(self):
        token=hpc._CONFIG.set(CONFIG)
        try:
            script=hpc._prepare_script(CONFIG['root'])
            self.assertIn('S="/chosen/workspace/software/pinned"',script)
            self.assertIn('$S/example/geno/example.ped',script)
        finally:hpc._CONFIG.reset(token)
