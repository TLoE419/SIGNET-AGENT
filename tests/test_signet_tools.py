import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from google import genai
from google.genai import types
import agent.core.conversation as main
import agent.tools.signet as st
from agent.tools.registry import ALL_TOOLS
from agent.tools.workspace import LEGACY_EXECUTION


class ToolsTest(unittest.TestCase):
    def call(self, name, **arguments):
        return st.dispatch_tool(name, arguments)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name).resolve()
        self.patch_project = patch.object(st, 'PROJECT', self.project)
        self.patch_project.start()
        (self.project / 'data').mkdir()
        self.input = self.project / 'data' / 'fixture.txt'
        self.input.write_text('fixture\n')

    def tearDown(self):
        self.patch_project.stop()
        self.temp.cleanup()

    def configure(self, cohort='TCGA', run_id='test'):
        result = st.configure_signet(run_id=run_id, cohort=cohort)
        self.assertEqual(result['status'], 'created', result)
        return self.project / 'runs' / run_id

    def test_inventory_and_source_hashes(self):
        self.assertEqual(len(st.INVENTORY['scripts']), 138)
        self.assertEqual(sum(x['category']=='entry' for x in st.INVENTORY['scripts']),16)
        self.assertEqual(len(st.SIGNET_TOOLS),5)
        self.assertIn(st.propose_hpc3_genotype, st.SIGNET_TOOLS)
        st._verify_source()
        self.assertEqual(st.signet_catalog()['internal_scripts'],121)

    def test_local_execution_tools_were_replaced_by_the_hpc3_cards(self):
        # Every SIGNET step runs on HPC3 after a confirmation card; the model cannot run one itself.
        names = {fn.__name__ for fn in st.SIGNET_TOOLS}
        for removed in ('genotype_tcga', 'expression_tcga', 'adjust_tcga', 'prepare_network', 'prepare_visualization',
                        'run_pca', 'cis_eqtl', 'submit_network', 'get_network_status', 'cancel_network',
                        'run_visualization', 'get_visualization_workspace', 'propose_visualization_change'):
            self.assertNotIn(removed, names)
            self.assertEqual(self.call(removed, run_id='test')['status'],
                             'needs_review' if removed in LEGACY_EXECUTION | {'get_visualization_workspace', 'propose_visualization_change'} else 'invalid')

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
        settings = st.get_signet_settings(run_id='test')['settings']
        self.assertEqual(settings['forcerm'],'F')
        self.assertEqual(settings['email'],'F')
        original = (root / 'work/config.ini').read_bytes()
        self.assertEqual(st.configure_signet(run_id='test')['status'],'invalid')
        self.assertEqual((root / 'work/config.ini').read_bytes(),original)
        self.assertEqual(st.configure_signet(run_id='../escape')['status'],'invalid')

    def test_dispatch_trust_boundary(self):
        for name,args in [
            ('system',{'cmd':'pwd'}),('get_signet_settings',{'run_id':'x','extra':True}),
            ('get_workspace_stage',{'run_id':'x','stage':True}),
            ('get_workspace_stage',{'run_id':'x','stage':2.5}),
            ('get_workspace_stage',{'run_id':'x','stage':2,'source':True}),
            ('configure_signet',{'run_id':'x','ncores':True}),
            ('configure_signet',{'run_id':'x','ncores':2.5}),
            ('configure_signet',{'run_id':'x','cohort':'other'}),
            ('list_files',{'folder':'/tmp'}),
        ]:
            self.assertEqual(st.dispatch_tool(name,args)['status'],'invalid',(name,args))
        self.assertEqual(st.dispatch_tool('signet_catalog',[])['status'],'invalid')

    def test_legacy_model_dispatch_requires_manual_review_without_effects(self):
        self.assertFalse({function.__name__ for function in ALL_TOOLS} & LEGACY_EXECUTION)
        before = {path: path.read_bytes() for path in self.project.rglob('*') if path.is_file()}
        with patch('subprocess.Popen') as popen:
            for name in LEGACY_EXECUTION:
                with self.subTest(name=name):
                    result = st.dispatch_tool(name, {'run_id': 'blocked', 'confirmed': True})
                    self.assertEqual(result['status'], 'needs_review')
                    self.assertFalse(result['executed'])
            popen.assert_not_called()
        self.assertEqual(before, {path: path.read_bytes() for path in self.project.rglob('*') if path.is_file()})
        self.assertFalse((self.project / 'runs').exists())

    def test_recorded_status_queries_do_not_infer_success(self):
        root=self.configure()
        (root/'partial.json').write_text(json.dumps({'operation':'partial','status':'starting','executed':False}))
        (root/'failed.json').write_text(json.dumps({'operation':'failed','status':'failed','executed':True,'returncode':2}))
        (root/'network.plan.json').write_text(json.dumps({'operation':'network'}))
        result=st.get_signet_settings(run_id='test')
        operations={x['operation']:x for x in result['operations']}
        self.assertEqual(operations['partial']['executed'],'unknown')
        self.assertEqual(operations['failed']['status'],'failed')
        self.assertFalse(operations['network']['executed'])
        self.assertEqual(operations['network']['status'],'prepared')

    def test_modified_run_code_and_symlinks_rejected(self):
        root=self.configure()
        (root/'work/script/adj/pca_vis.R').write_text('modified')
        with self.assertRaises(ValueError):
            st._verify_source(root/'work')
        (root/'work/config.ini').unlink()
        (root/'work/config.ini').symlink_to(self.input)
        self.assertEqual(st.get_signet_settings(run_id='test')['status'],'invalid')


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
