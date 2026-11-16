import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from google import genai
from google.genai import types
import agent.core.conversation as main
import agent.tools.signet as st


class FakeProcess:
    returncode = 0
    pid = 987654
    calls = []
    timeout = False

    def __init__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        assert isinstance(argv, list)
        assert kwargs['start_new_session']
        assert 'GEMINI_API_KEY' not in kwargs['env']
        assert 'AWS_SECRET_ACCESS_KEY' not in kwargs['env']
        kwargs['stdout'].write(b'controlled test only\n')
        kwargs['stderr'].write(b'')
        target = Path(kwargs['env']['SIGNET_RESULT_ROOT']) / 'controlled-output.txt'
        target.write_text('fixture\n')

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def communicate(self, input=None, timeout=None):
        if timeout and self.timeout:
            raise subprocess.TimeoutExpired('fixture', timeout)
        return None, None


# On Linux the remaining local tool (cis_eqtl) runs signet in a local process; macOS sends it to the VM.
LINUX = dict(target=st.sys, attribute='platform', new='linux')


class ToolsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name).resolve()
        self.patch_project = patch.object(st, 'PROJECT', self.project)
        self.patch_project.start()
        (self.project / 'data').mkdir()
        self.input = self.project / 'data' / 'fixture.txt'
        self.input.write_text('fixture\n')
        f = str(self.input)
        self.cis = dict(expression=f, expression_with_pc=f, genotype=f, snp_map=f, snp_maf=f, gene_positions=f)
        FakeProcess.calls = []
        FakeProcess.timeout = False
        FakeProcess.returncode = 0

    def tearDown(self):
        self.patch_project.stop()
        self.temp.cleanup()

    def call(self, name, **args):
        return st.dispatch_tool(name, args)

    def configure(self, cohort='TCGA', run_id='test'):
        result = self.call('configure_signet', run_id=run_id, cohort=cohort)
        self.assertEqual(result['status'], 'created', result)
        return self.project / 'runs' / run_id

    def test_inventory_and_source_hashes(self):
        self.assertEqual(len(st.INVENTORY['scripts']), 138)
        self.assertEqual(sum(x['category']=='entry' for x in st.INVENTORY['scripts']),16)
        self.assertEqual(len(st.SIGNET_TOOLS),12)
        self.assertIn(st.propose_hpc3_genotype, st.SIGNET_TOOLS)
        st._verify_source()
        self.assertEqual(self.call('signet_catalog')['internal_scripts'],121)

    def test_local_preprocessing_tools_were_replaced_by_the_hpc3_cards(self):
        names = {fn.__name__ for fn in st.SIGNET_TOOLS}
        for removed in ('genotype_tcga', 'expression_tcga', 'adjust_tcga', 'prepare_network', 'prepare_visualization', 'run_pca'):
            self.assertNotIn(removed, names)
            self.assertEqual(self.call(removed, run_id='test')['status'], 'invalid')

    def test_catalog_describes_setup_and_six_stages_for_the_assistant(self):
        catalog = self.call('signet_catalog')
        self.assertEqual([stage['flag'] for stage in catalog['analysis_stages']], ['-g', '-t', '-a', '-c', '-n', '-v'])
        for stage in catalog['analysis_stages']:
            self.assertTrue(all(stage[key] for key in ('name', 'purpose', 'inputs', 'how_to_run')), stage)
        # SIGNET imputes only missing genotypes at the study's own SNPs (-include_snps empty).
        self.assertIn('no new SNPs', catalog['analysis_stages'][0]['purpose'])
        self.assertIn('gender', catalog['analysis_stages'][2]['inputs'])
        from agent.tools.hpc import HPC_TOOLS
        named = {step['tool'] for step in catalog['hpc3_setup']} - {None}
        self.assertTrue(named <= {fn.__name__ for fn in HPC_TOOLS}, 'every named setup tool exists')
        self.assertIn('check_hpc_environment', named)
        self.assertIn('genome_build', catalog['scope'])

    def test_all_schemas_without_network(self):
        with genai.Client(api_key='fake-schema-key') as client:
            for fn in main.config.tools:
                decl = types.FunctionDeclaration.from_callable(client=client, callable=fn)
                self.assertEqual(decl.name,fn.__name__)

    def test_settings_and_no_overwrite(self):
        root = self.configure()
        self.assertFalse((st.SOURCE / 'data').exists() and root == st.SOURCE)
        settings = self.call('get_signet_settings',run_id='test')['settings']
        self.assertEqual(settings['forcerm'],'F')
        self.assertEqual(settings['email'],'F')
        original = (root / 'work/config.ini').read_bytes()
        self.assertEqual(self.call('configure_signet',run_id='test')['status'],'invalid')
        self.assertEqual((root / 'work/config.ini').read_bytes(),original)
        self.assertEqual(self.call('configure_signet',run_id='../escape')['status'],'invalid')

    def test_dispatch_trust_boundary(self):
        for name,args in [
            ('system',{'cmd':'pwd'}),('get_signet_settings',{'run_id':'x','extra':True}),
            ('configure_signet',{'run_id':'x','ncores':True}),
            ('configure_signet',{'run_id':'x','ncores':2.5}),
            ('configure_signet',{'run_id':'x','cohort':'other'}),
            ('cis_eqtl',{'run_id':'x','expression':str(self.input)}),
            ('list_files',{'folder':'/tmp'}),
        ]:
            self.assertEqual(st.dispatch_tool(name,args)['status'],'invalid',(name,args))
        self.assertEqual(st.dispatch_tool('signet_catalog',[])['status'],'invalid')

    def test_paths_and_numbers(self):
        self.configure()
        for value in ['/etc/passwd','.env',str(self.project/'data'/'../.env'),str(self.input)+';id',str(self.input)+' x']:
            self.assertEqual(self.call('cis_eqtl',run_id='test',**{**self.cis,'expression':value})['status'],'invalid')
        link = self.project / 'data' / 'linked'
        link.symlink_to(self.input)
        self.assertEqual(self.call('cis_eqtl',run_id='test',**{**self.cis,'expression':str(link)})['status'],'invalid')
        for value in [float('nan'),float('inf'),-1,True]:
            self.assertEqual(self.call('cis_eqtl',run_id='test',alpha=value,**self.cis)['status'],'invalid')

    def test_local_tool_fixed_argv_and_no_repeat(self):
        root = self.configure()
        with patch.object(**LINUX), patch.object(st.shutil,'which',return_value='/fake/bin'), patch.object(st.subprocess,'Popen',FakeProcess):
            result = self.call('cis_eqtl',run_id='test',**self.cis)
            self.assertEqual(result['status'],'process_completed',result)
            self.assertTrue(result['executed'])
            self.assertIn('work/res/controlled-output.txt',result['output_files'])
            self.assertEqual(FakeProcess.calls[0][0][1:],[str(root/'work/signet'),'-c'])
            self.assertEqual(self.call('cis_eqtl',run_id='test',**self.cis)['status'],'invalid')
            self.assertFalse((root / '.active').exists())
        self.assertEqual(len(FakeProcess.calls),1)

    def test_missing_dependencies_failure_timeout_and_lock(self):
        root = self.configure()
        args = dict(run_id='test',**self.cis)
        with patch.object(**LINUX):
            with patch.object(st.shutil,'which',return_value=None),patch.object(st.subprocess,'Popen') as popen:
                result = self.call('cis_eqtl',**args)
                self.assertEqual(result['status'],'unavailable')
                popen.assert_not_called()
            (root/'.active').write_text('locked')
            self.assertEqual(self.call('cis_eqtl',**args)['status'],'invalid')
            (root/'.active').unlink()
            with patch.object(st.shutil,'which',return_value='/fake/bin'),patch.object(st.subprocess,'Popen',FakeProcess):
                FakeProcess.returncode=2
                self.assertEqual(self.call('cis_eqtl',**args)['status'],'failed')
                self.configure(run_id='timeout')
                FakeProcess.timeout=True
                with patch.object(st.os,'killpg') as kill:
                    result=self.call('cis_eqtl',**{**args,'run_id':'timeout'})
                    self.assertEqual(result['status'],'timed_out')
                    kill.assert_called_once_with(FakeProcess.pid,signal.SIGKILL)

    def test_scientific_process_interrupt_cleans_up_group_and_records_state(self):
        self.configure()
        with patch.object(**LINUX),patch.object(st.shutil,'which',return_value='/fake/bin'),patch.object(st.subprocess,'Popen',FakeProcess),patch.object(FakeProcess,'communicate',side_effect=[KeyboardInterrupt(),(None,None)]),patch.object(st.os,'killpg') as kill:
            result=self.call('cis_eqtl',run_id='test',**self.cis)
            self.assertEqual(result['status'],'interrupted')
            self.assertTrue(result['executed'])
            kill.assert_called_once_with(FakeProcess.pid,signal.SIGKILL)
        settings=self.call('get_signet_settings',run_id='test')
        self.assertEqual(settings['operations'][0]['status'],'interrupted')

    def test_recorded_status_queries_do_not_infer_success(self):
        root=self.configure()
        (root/'partial.json').write_text(json.dumps({'operation':'partial','status':'starting','executed':False}))
        (root/'failed.json').write_text(json.dumps({'operation':'failed','status':'failed','executed':True,'returncode':2}))
        (root/'network.plan.json').write_text(json.dumps({'operation':'network'}))
        result=self.call('get_signet_settings',run_id='test')
        operations={x['operation']:x for x in result['operations']}
        self.assertEqual(operations['partial']['executed'],'unknown')
        self.assertEqual(operations['failed']['status'],'failed')
        self.assertFalse(operations['network']['executed'])
        self.assertEqual(operations['network']['status'],'prepared')

    def test_modified_run_code_and_symlinks_rejected(self):
        root=self.configure()
        (root/'work/script/adj/pca_vis.R').write_text('modified')
        result=self.call('cis_eqtl',run_id='test',**self.cis)
        self.assertEqual(result['status'],'invalid')
        (root/'work/config.ini').unlink()
        (root/'work/config.ini').symlink_to(self.input)
        self.assertEqual(self.call('get_signet_settings',run_id='test')['status'],'invalid')


class ConversationTest(unittest.TestCase):
    def response(self, call=None, text=None):
        content=types.Content(role='model',parts=[types.Part(function_call=call,thought_signature=b'preserve-me')] if call else [types.Part.from_text(text=text)])
        return SimpleNamespace(function_calls=[call] if call else [],text=text,candidates=[SimpleNamespace(content=content)])

    def test_history_signatures_and_user_role(self):
        call=types.FunctionCall(id='test-call',name='signet_catalog',args={})
        first=self.response(call)
        histories=[]
        def generate(**kwargs):
            histories.append(list(kwargs['contents']))
            return first if len(histories)==1 else self.response(text='done')
        client=SimpleNamespace(models=SimpleNamespace(generate_content=generate))
        self.assertEqual(main.run_conversation(client,'catalog'),'done')
        self.assertIs(histories[1][1],first.candidates[0].content)
        self.assertEqual(histories[1][1].parts[0].thought_signature,b'preserve-me')
        result=histories[1][2]
        self.assertEqual(result.role,'user')
        self.assertEqual(result.parts[0].function_response.id,'test-call')
        self.assertEqual(result.parts[0].function_response.name,'signet_catalog')

    def test_round_limit_no_extra_execution(self):
        call=types.FunctionCall(id='x',name='signet_catalog',args={})
        client=SimpleNamespace(models=SimpleNamespace(generate_content=lambda **kwargs:self.response(call)))
        with patch.object(main,'dispatch_tool',return_value={}) as dispatch:
            self.assertIn('上限',main.run_conversation(client,'repeat'))
            self.assertEqual(dispatch.call_count,4)

    def test_too_many_calls_no_execution(self):
        response=self.response(types.FunctionCall(id='x',name='signet_catalog',args={}))
        response.function_calls*=9
        client=SimpleNamespace(models=SimpleNamespace(generate_content=lambda **kwargs:response))
        with patch.object(main,'dispatch_tool') as dispatch:
            self.assertIn('上限',main.run_conversation(client,'repeat'))
            dispatch.assert_not_called()


if __name__=='__main__':
    unittest.main()
