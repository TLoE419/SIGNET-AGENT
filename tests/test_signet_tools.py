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
import main
import signet_tools as st


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


class ToolsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name).resolve()
        self.patch_project = patch.object(st, 'PROJECT', self.project)
        self.patch_project.start()
        (self.project / 'data').mkdir()
        self.input = self.project / 'data' / 'fixture.txt'
        self.input.write_text('fixture\n')
        self.expression = self.project / 'data' / 'expression.bed'
        self.expression.write_text('#chr\tstart\tend\tgene_id\ts1\ts2\n1\t0\t1\tg1\t1\t2\n')
        self.cov = self.project / 'data' / 'covariates.txt'
        self.cov.write_text('ID\ts1\ts2\nC1\t0\t1\n')
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

    def intermediate(self, root, *paths):
        for relative in paths:
            path = root / 'work' / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('fixture\n')

    def test_inventory_and_source_hashes(self):
        self.assertEqual(len(st.INVENTORY['scripts']), 138)
        self.assertEqual(sum(x['category']=='entry' for x in st.INVENTORY['scripts']),16)
        self.assertEqual(len(st.SIGNET_TOOLS),23)
        st._verify_source()
        self.assertEqual(self.call('signet_catalog')['internal_scripts'],121)

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
            ('combine_covariates',{'run_id':'x','expression_covariates':str(self.input),'additional_covariates':'bad'}),
            ('list_files',{'folder':'/tmp'}),
        ]:
            self.assertEqual(st.dispatch_tool(name,args)['status'],'invalid',(name,args))
        self.assertEqual(st.dispatch_tool('signet_catalog',[])['status'],'invalid')

    def test_paths_and_numbers(self):
        self.configure()
        for value in ['/etc/passwd','.env',str(self.project/'data'/'../.env'),str(self.input)+';id',str(self.input)+' x']:
            self.assertEqual(self.call('expression_tcga',run_id='test',expression=value,annotation_gtf=str(self.input))['status'],'invalid')
        link = self.project / 'data' / 'linked'
        link.symlink_to(self.input)
        self.assertEqual(self.call('expression_tcga',run_id='test',expression=str(link),annotation_gtf=str(self.input))['status'],'invalid')
        for value in [float('nan'),float('inf'),-1,True]:
            self.assertEqual(self.call('prepare_visualization',run_id='test',frequencies=str(self.input),coefficients=str(self.input),gene_positions=str(self.input),frequency=value)['status'],'invalid')

    def test_every_analysis_tool_fixed_argv(self):
        f = str(self.input)
        scenarios = [
            ('genotype_tcga','TCGA',dict(ped=f,map_file=f,reference_prefix=str(self.project/'data'/'chr'),genetic_map_prefix=str(self.project/'data'/'chr')),()),
            ('genotype_gtex','GTEx',dict(vcf_before_phasing=f,vcf=f,reads=f,annotation=f,tissue='Lung'),()),
            ('expression_tcga','TCGA',dict(expression=f,annotation_gtf=f),()),
            ('expression_gtex','GTEx',dict(reads=f,tpm=f,annotation_gtf=f,tissue='Lung'),('tmp/tmpg/subjid_wb_common.txt','tmp/tmpg/GTEx_snp.vcf.gz')),
            ('adjust_tcga','TCGA',dict(clinical=f,principal_components=2),('res/resg/signet_Geno','res/resg/signet_Genotype.sampleID','res/rest/signet_gexp','res/rest/signet_gexpID')),
            ('adjust_gtex','GTEx',dict(phenotype=f,annotation=f,annotation_gtf=f,tissue='Lung'),('tmp/tmpg/GTEx_snp.vcf',)),
            ('cis_eqtl','TCGA',dict(expression=f,expression_with_pc=f,genotype=f,snp_map=f,snp_maf=f,gene_positions=f),()),
            ('prepare_network','TCGA',dict(expression=f,genotype=f,significant_pairs=f,gene_names=f,gene_positions=f,container=f),()),
            ('prepare_visualization','TCGA',dict(frequencies=f,coefficients=f,gene_positions=f),()),
            ('run_pca','TCGA',{},('res/resa/signet_new.Geno','res/resa/signet_new.Geno.map','tmp/tmpg/clean_Genotype.fam','tmp/tmpg/geno_id')),
            ('run_pca','GTEx',{},('tmp/tmpa/Geno_all_prune.ped','tmp/tmpa/Geno_all_prune.pedsnp','tmp/tmpa/Geno_all_prune.pedind')),
            ('plot_pca','TCGA',{},('tmp/tmpa/Geno.pca.evec','tmp/tmpa/Geno.eval')),
            ('combine_covariates','TCGA',dict(expression_covariates=str(self.cov),genotype_pcs=str(self.cov),additional_covariates=[str(self.cov)]),()),
            ('adjust_expression','TCGA',dict(expression_bed=str(self.expression),covariates=str(self.cov)),()),
            ('normalize_expression','GTEx',dict(tpm=f,counts=f,annotation_gtf=f,sample_lookup=f,vcf_chromosomes=f,sample_ids=f,convert_tpm=True,legacy_mode=True,normalization='qn'),()),
        ]
        for suffix in ('.gen','.map'):
            for number in range(1,23):
                (self.project/'data'/f'chr{number}{suffix}').write_text('fixture\n')
        with patch.object(st.sys,'platform','linux'), patch.object(st.shutil,'which',return_value='/fake/bin'), patch.object(st.importlib.util,'find_spec',return_value=object()), patch.object(st.subprocess,'Popen',FakeProcess):
            for i,(name,cohort,args,inputs) in enumerate(scenarios):
                root = self.configure(cohort,str(i))
                self.intermediate(root,*inputs)
                result = self.call(name,run_id=str(i),**args)
                expected = 'prepared' if name.startswith('prepare_') else 'process_completed'
                self.assertEqual(result['status'],expected,(name,result))
                self.assertEqual(result['executed'],not name.startswith('prepare_'))
                if result['executed']:
                    self.assertIn('work/res/controlled-output.txt',result['output_files'])
                    repeated = self.call(name,run_id=str(i),**args)
                    self.assertEqual(repeated['status'],'invalid',repeated)
                self.assertFalse((root / '.active').exists())
        self.assertEqual(len(FakeProcess.calls),13)

    def test_missing_dependencies_failure_timeout_and_lock(self):
        root = self.configure()
        args = dict(run_id='test',expression=str(self.input),annotation_gtf=str(self.input))
        with patch.object(st.shutil,'which',return_value=None),patch.object(st.subprocess,'Popen') as popen:
            result = self.call('expression_tcga',**args)
            self.assertEqual(result['status'],'unavailable')
            popen.assert_not_called()
        (root/'.active').write_text('locked')
        self.assertEqual(self.call('expression_tcga',**args)['status'],'invalid')
        (root/'.active').unlink()
        with patch.object(st.sys,'platform','linux'),patch.object(st.shutil,'which',return_value='/fake/bin'),patch.object(st.subprocess,'Popen',FakeProcess):
            FakeProcess.returncode=2
            self.assertEqual(self.call('expression_tcga',**args)['status'],'failed')
            self.configure(run_id='timeout')
            FakeProcess.timeout=True
            with patch.object(st.os,'killpg') as kill:
                result=self.call('expression_tcga',**{**args,'run_id':'timeout'})
                self.assertEqual(result['status'],'timed_out')
                kill.assert_called_once_with(FakeProcess.pid,signal.SIGKILL)

    def test_cloud_preparation_snapshot_and_no_execution(self):
        root=self.configure()
        f=str(self.input)
        with patch.object(st.subprocess,'Popen') as popen:
            result=self.call('prepare_network',run_id='test',expression=f,genotype=f,significant_pairs=f,
                             gene_names=f,gene_positions=f,computing='cloud',stage=2)
            self.assertEqual(result['status'],'prepared',result)
            self.assertFalse(result['executed'])
            snapshot=Path(result['settings_snapshot']).read_text()
            self.assertIn('computing = cloud',snapshot)
            self.assertIn('stage = 2',snapshot)
            self.assertTrue((root/'network.plan.json').is_file())
            popen.assert_not_called()

    @unittest.skipUnless(st.sys.platform=='darwin','Verify this macOS host preflight without scientific execution')
    def test_real_host_preflight_without_model_or_scientific_execution(self):
        self.configure()
        with patch.object(st.subprocess,'Popen') as popen:
            result=self.call('expression_tcga',run_id='test',expression=str(self.input),annotation_gtf=str(self.input))
            self.assertEqual(result['status'],'unavailable',result)
            self.assertTrue(any('Linux' in name for name in result['missing_dependencies']))
            self.assertFalse(result['executed'])
            popen.assert_not_called()

    def test_scientific_process_interrupt_cleans_up_group_and_records_state(self):
        self.configure()
        with patch.object(st.sys,'platform','linux'),patch.object(st.shutil,'which',return_value='/fake/bin'),patch.object(st.subprocess,'Popen',FakeProcess),patch.object(FakeProcess,'communicate',side_effect=[KeyboardInterrupt(),(None,None)]),patch.object(st.os,'killpg') as kill:
            result=self.call('expression_tcga',run_id='test',expression=str(self.input),annotation_gtf=str(self.input))
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

    def test_prerequisite_cohort_and_sample_order(self):
        self.configure()
        self.assertEqual(self.call('run_pca',run_id='test')['status'],'invalid')
        f=str(self.input)
        result=self.call('genotype_gtex',run_id='test',vcf_before_phasing=f,vcf=f,reads=f,annotation=f,tissue='Lung')
        self.assertEqual(result['status'],'invalid')
        self.cov.write_text('ID\ts2\ts1\nC1\t0\t1\n')
        self.assertEqual(self.call('adjust_expression',run_id='test',expression_bed=str(self.expression),covariates=str(self.cov))['status'],'invalid')

    def test_modified_run_code_and_symlinks_rejected(self):
        root=self.configure()
        (root/'work/script/adj/pca_vis.R').write_text('modified')
        result=self.call('expression_tcga',run_id='test',expression=str(self.input),annotation_gtf=str(self.input))
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
