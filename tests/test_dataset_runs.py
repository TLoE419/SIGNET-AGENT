"""Dataset-owned runs reuse the production step service against a local fake HPC folder."""
import json
import gzip
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from agent.runtime import hpc, ssh_transport, workspace_datasets, workspace_genotype as workspace, workspace_inputs, workspace_validation
from agent.runtime.jobs import stage_dataset
import agent.runtime.signet_jobs as jobs
import test_signet_jobs as step_fixtures


class DatasetRunTest(unittest.TestCase):
    def setUp(self):
        self.f = step_fixtures.StepsTest()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        config = {**self.f.config, 'revision': hpc.SOURCE_INVENTORY['revision']}
        item = patch.object(ssh_transport, 'setup_environment', return_value=config)
        item.start()
        self.addCleanup(item.stop)
        # Local temporary folders stand in for shared HPC storage, including on Linux CI.
        for module, name in ((workspace_validation, '_SOURCE'), (workspace_inputs, '_REVIEW')):
            source = getattr(module, name).replace("BLOCKED = ('/tmp', '/var/tmp', '/dev/shm', '/run')", 'BLOCKED = ()')
            item = patch.object(module, name, source)
            item.start()
            self.addCleanup(item.stop)
        self.files = self.f.hpc / 'outside-selected-study'
        self.files.mkdir()
        ids = ['TCGA-AA-A00' + str(n) for n in range(1, 7)]
        self.paths = {name: self.files / name for name in ('study.ped', 'study.map', 'expression.txt', 'clinical.tsv', 'reference.vcf', 'genetic-map.txt', 'annotation.gtf')}
        self.paths['study.ped'].write_text(''.join(value + '-NT ' + value + '-NT 0 0 1 -9 A G A A C C\n' for value in ids))
        self.paths['study.map'].write_text('2 rs1 0 101\n2 rs2 0 202\n2 rs3 0 303\n')
        self.paths['expression.txt'].write_text('Ensembl_ID ' + ' '.join(value + '-01A' for value in ids) + '\n'
            + ''.join('ENSG' + str(n) + '.1 ' + ' '.join(['20'] * 6) + '\n' for n in range(4))
            + ('0 ' + ' '.join(['0'] * 6) + '\n') * 5)
        self.paths['clinical.tsv'].write_text('submitter_id\trace\tgender\n' + ''.join(
            value + '\t' + ['asian', 'black or african american', 'white'][n % 3] + '\t' + ['female', 'male'][n % 2] + '\n'
            for n, value in enumerate(ids)))
        self.paths['reference.vcf'].write_text('##fileformat=VCFv4.2\n#CHROM POS ID REF ALT QUAL FILTER INFO FORMAT D1\n'
            + '\n'.join('2\t' + str(pos) + '\trs' + str(n) + '\t' + ref + '\t' + alt + '\t.\tPASS\t.\tGT\t0/1'
                         for n, (pos, ref, alt) in enumerate(((101, 'A', 'G'), (202, 'A', 'G'), (303, 'C', 'T')), 1)) + '\n')
        self.paths['genetic-map.txt'].write_text('pos chr cM\n0 2 0\n1000 2 1\n')
        self.paths['annotation.gtf'].write_text('chr2\tfixture\tgene\t1\t2\t.\t+\t.\ttranscript_type \"protein_coding\";\n')
        selected = self.f.hpc / 'ws/refdata/selected.tsv'
        selected.write_text(''.join(key + '\t' + str(self.paths[name]) + '\n' for key, name in (
            ('ref', 'reference.vcf'), ('gmap', 'genetic-map.txt'), ('gtf', 'annotation.gtf'))))
        self.inputs = {'genotype': [str(self.paths['study.ped']), str(self.paths['study.map'])],
                       'expression': [str(self.paths['expression.txt'])], 'clinical': [str(self.paths['clinical.tsv'])]}
        self.dataset = workspace_datasets.create_dataset(['自訂資料', 'Custom study'], inputs=self.inputs)

    def review(self):
        return workspace.review_dataset(self.dataset['id'], self.inputs)

    def submit(self, review, run_id='custom-study', **changes):
        body = {'run_id': run_id, 'inputs': review['inputs'], 'settings': review['settings'],
                'resources': review['resources'], 'review_token': review['review_token'], 'acknowledge_warnings': True}
        body.update(changes)
        return workspace.submit_dataset(self.dataset['id'], **body)

    def test_stage1_review_reports_a_dataset_validation_timeout(self):
        with patch.object(ssh_transport, 'remote', side_effect=TimeoutError('Slow remote storage')):
            with self.assertRaises(jobs.StepError) as caught:
                self.review()
        self.assertEqual(caught.exception.code, 'read_timeout')
        self.assertFalse((self.f.fake / 'sbatch_args').exists())

    def test_review_submit_freeze_and_frozen_continuation_ignore_later_catalog_changes(self):
        review = self.review()
        self.assertTrue(review['ready'], review['issues'])
        self.assertEqual(review['settings']['restrict.tcga.geno'], 2)
        self.assertTrue(review['warnings'])
        self.assertEqual(self.review()['review_token'], review['review_token'])
        record = self.submit(review)
        root = self.f.project / 'runs/custom-study'
        directory = Path(record['remote_dir'])
        self.assertEqual(record['inputs']['ped.file'], str(directory / 'inputs/prepared/study.ped'))
        self.assertEqual(len(record['required_outputs']), 4)
        batch = directory / 'steps/genotype.sbatch'
        self.assertEqual(subprocess.run(['bash', '-n', str(batch)]).returncode, 0)
        self.assertIn('SIGNET_DATASET_STAGE', batch.read_text())
        self.assertIn('bash ./signet -g', batch.read_text())
        plan = workspace_inputs.staging_plan(root, str(directory))
        with patch.object(stage_dataset, 'PREPARE_SOURCE', workspace_inputs._PREPARE_SOURCE, create=True):
            stage_dataset.stage(plan)
        manifest = json.loads((directory / 'work/res/resg/workspace-inputs.json').read_text())
        self.assertEqual(manifest['dataset_id'], self.dataset['id'])
        self.assertEqual(manifest['preparation']['matched_markers'], 3)
        self.assertTrue((directory / 'inputs/prepared/ref/chr2.gen').is_file())
        self.assertFalse((directory / 'inputs/prepared/ref/chr1.gen').exists())
        for role in ('expression', 'clinical', 'annotation'):
            self.assertTrue((directory / 'inputs/frozen' / role).is_file())
        (directory / 'work/res/resg/signet_Geno').write_text('0 1 2\n' * 6)
        ids = ['TCGA-AA-A00' + str(n) for n in range(1, 7)]
        (directory / 'work/res/resg/signet_Genotype.sampleID').write_text('\n'.join(value + '-NT' for value in ids) + '\n')
        (directory / 'steps/genotype.done').write_text('0 2026-11-17T10:00:00-08:00\n')
        self.f.slurm(squeue='', sacct='COMPLETED')
        self.assertEqual(jobs.status('custom-study', 'genotype', refresh=True)['state'], 'completed')
        snapshot = (root / workspace.SNAPSHOT).read_bytes()
        workspace_datasets.update_dataset(self.dataset['id'], {'expression': ['/different/expression'], 'clinical': ['/different/clinical']})
        (self.f.hpc / 'ws/refdata/selected.tsv').write_text('gtf\t/different/annotation\n')
        expression = workspace.review_expression('custom-study')
        self.assertTrue(expression['frozen'])
        self.assertEqual(expression['inputs'], {'gexp.file': str(directory / 'inputs/frozen/expression'),
                                                'pmap.file': str(directory / 'inputs/frozen/annotation')})
        self.assertEqual(expression['settings'], {'restrict.tcga': 2})
        history = workspace.run_history(root)
        self.assertEqual(history['dataset_id'], self.dataset['id'])
        self.assertEqual(history['input_mode'], 'dataset')
        self.assertEqual(history['inputs'], self.inputs)
        self.assertEqual(history['reference_preparation']['matched_markers'], 3)
        self.assertEqual((root / workspace.SNAPSHOT).read_bytes(), snapshot)
        with self.assertRaises(jobs.StepError):
            workspace.review_adjust('custom-study', '/different/clinical')

    def custom_references(self):
        return {key: str(self.paths[name]) for key, name in
                (('ref', 'reference.vcf'), ('gmap', 'genetic-map.txt'), ('gtf', 'annotation.gtf'))}

    def test_dataset_reference_overrides_bind_review_freeze_annotation_and_history(self):
        custom = {}
        for key, original in self.custom_references().items():
            target = self.files / ('selected-' + Path(original).name)
            target.write_bytes(Path(original).read_bytes())
            custom[key] = str(target)
        workspace_datasets.update_dataset(self.dataset['id'], references=custom)
        (self.f.hpc / 'ws/refdata/selected.tsv').write_text('ref\t/missing/environment-reference\ngmap\t/missing/environment-map\ngtf\t/missing/environment-annotation\n')
        review = self.review()
        self.assertTrue(review['ready'], review['issues'])
        self.assertEqual(review['reference_choices'], custom)
        expected = dict(zip(('reference', 'genetic_map', 'annotation'), (custom['ref'], custom['gmap'], custom['gtf'])))
        self.assertEqual(review['reference_sources'], expected)
        self.assertEqual(review['reference_compatibility']['study_genome_build'], 'unverified')
        record = self.submit(review)
        root = self.f.project / 'runs/custom-study'
        directory = Path(record['remote_dir'])
        snapshot = (root / workspace.SNAPSHOT).read_bytes()
        with patch.object(stage_dataset, 'PREPARE_SOURCE', workspace_inputs._PREPARE_SOURCE, create=True):
            stage_dataset.stage(workspace_inputs.staging_plan(root, str(directory)))
        self.assertEqual((directory / 'inputs/frozen/annotation').read_bytes(), Path(custom['gtf']).read_bytes())
        (directory / 'work/res/resg/signet_Geno').write_text('0 1 2\n' * 6)
        ids = ['TCGA-AA-A00' + str(n) for n in range(1, 7)]
        (directory / 'work/res/resg/signet_Genotype.sampleID').write_text('\n'.join(value + '-NT' for value in ids) + '\n')
        (directory / 'steps/genotype.done').write_text('0 2026-11-17T10:00:00-08:00\n')
        self.f.slurm(squeue='', sacct='COMPLETED')
        self.assertEqual(jobs.status('custom-study', 'genotype', refresh=True)['state'], 'completed')
        workspace_datasets.update_dataset(self.dataset['id'], references=self.custom_references())
        expression = workspace.review_expression('custom-study')
        self.assertEqual(expression['inputs']['pmap.file'], str(directory / 'inputs/frozen/annotation'))
        history = workspace.run_history(root)
        self.assertEqual(history['reference_sources'], expected)
        self.assertEqual((root / workspace.SNAPSHOT).read_bytes(), snapshot)

    def test_partial_reference_override_inherits_other_environment_roles(self):
        custom_gtf = self.files / 'custom-annotation.gtf'
        custom_gtf.write_bytes(self.paths['annotation.gtf'].read_bytes())
        workspace_datasets.update_dataset(self.dataset['id'], references={'gtf': str(custom_gtf)})
        review = self.review()
        self.assertTrue(review['ready'], review['issues'])
        self.assertEqual(review['reference_sources'], {'reference': str(self.paths['reference.vcf']),
            'genetic_map': str(self.paths['genetic-map.txt']), 'annotation': str(custom_gtf)})
        before = review['review_token']
        custom_gtf.write_text(custom_gtf.read_text() + '# changed after review\n')
        with self.assertRaises(jobs.StepError):
            self.submit(review)
        self.assertFalse((self.f.fake / 'sbatch_args').exists())
        self.assertNotEqual(self.review()['review_token'], before)

    def test_explicit_genome_build_disagreement_is_blocked_without_claiming_full_compatibility(self):
        reference = self.paths['reference.vcf']
        reference.write_text(reference.read_text().replace('##fileformat=VCFv4.2\n',
                                                         '##fileformat=VCFv4.2\n##reference=GRCh38\n'))
        annotation = self.paths['annotation.gtf']
        body = annotation.read_text()
        annotation.write_text('#!genome-build GRCh37\n' + body)
        review = self.review()
        self.assertFalse(review['ready'])
        self.assertIn('different genome builds', ' '.join(review['issues']))
        self.assertEqual(review['reference_compatibility']['reference_annotation_build'], 'mismatch')
        annotation.write_text('#!genome-build GRCh38\n' + body)
        review = self.review()
        self.assertTrue(review['ready'], review['issues'])
        self.assertEqual(review['reference_compatibility']['reference_annotation_build'], 'consistent')
        self.assertEqual(review['reference_compatibility']['study_genome_build'], 'unverified')
        self.assertTrue(any('do not establish full genome-build compatibility' in warning for warning in review['warnings']))

    def test_dataset_annotation_reuses_stage2_format_guard_before_stage1_submission(self):
        annotation = self.paths['annotation.gtf']
        original = annotation.read_bytes()
        cases = (('uncollapsed', original.replace(b'transcript_type', b'gene_type'), 'not collapsed'),
                 ('gzip', gzip.compress(original), 'uncompressed GTF'),
                 ('not-gtf', b'not an annotation table\n', '9 tab-separated'))
        workspace_datasets.update_dataset(self.dataset['id'], references={'gtf': str(annotation)})
        for label, content, message in cases:
            with self.subTest(label=label):
                annotation.write_bytes(content)
                review = self.review()
                self.assertFalse(review['ready'])
                self.assertIn(message, ' '.join(review['issues']))
                with self.assertRaises(jobs.StepError):
                    self.submit(review)
                self.assertFalse((self.f.fake / 'sbatch_args').exists())
        annotation.write_bytes(original)
        self.assertTrue(self.review()['ready'])

    def test_reference_selection_changes_invalidate_tokens_even_when_effective_path_is_same(self):
        original = self.review()
        workspace_datasets.update_dataset(self.dataset['id'], references=self.custom_references())
        explicit = self.review()
        self.assertEqual(explicit['reference_sources'], original['reference_sources'])
        self.assertNotEqual(explicit['review_token'], original['review_token'])
        with self.assertRaises(jobs.StepError):
            self.submit(original)
        self.assertFalse((self.f.fake / 'sbatch_args').exists())
        references = workspace_inputs._references
        changed = False
        def change_during_review(config, overrides=None):
            nonlocal changed
            result = references(config, overrides)
            if not changed:
                changed = True
                workspace_datasets.update_dataset(self.dataset['id'], references={'gtf': None})
            return result
        with patch.object(workspace_inputs, '_references', side_effect=change_during_review), self.assertRaises(jobs.StepError) as caught:
            self.review()
        self.assertEqual(caught.exception.code, 'conflict')
        self.assertFalse((self.f.fake / 'sbatch_args').exists())

    def test_declared_genome_build_mismatch_is_blocked_without_guessing_unknown_builds(self):
        reference = self.paths['reference.vcf']
        reference.write_text(reference.read_text().replace('##fileformat=VCFv4.2', '##fileformat=VCFv4.2\n##reference=GRCh38'))
        annotation = self.paths['annotation.gtf']
        annotation.write_text('#!genome-build GRCh37\n' + annotation.read_text())
        review = self.review()
        self.assertFalse(review['ready'])
        self.assertEqual(review['reference_compatibility']['reference_annotation_build'], 'mismatch')
        self.assertIn('different genome builds', ' '.join(review['issues']))
        annotation.write_text(annotation.read_text().replace('GRCh37', 'GRCh38'))
        review = self.review()
        self.assertTrue(review['ready'], review['issues'])
        self.assertEqual(review['reference_compatibility']['reference_annotation_build'], 'consistent')
        self.assertEqual(review['reference_compatibility']['study_genome_build'], 'unverified')
        self.assertTrue(any('does not declare a genome build' in warning for warning in review['warnings']))

    def test_unprepared_legacy_example_points_to_data_before_submitting(self):
        self.assertFalse((self.f.hpc / 'ws' / hpc.PREPARED).exists())
        with self.assertRaises(jobs.StepError) as caught:
            workspace.review_example()
        self.assertEqual(caught.exception.code, 'not_ready')
        self.assertIn('Choose your genotype and reference files in Data', str(caught.exception))
        self.assertFalse((self.f.fake / 'sbatch_args').exists())

    def test_builtin_aliases_with_custom_references_use_guarded_dataset_pipeline(self):
        self.assertFalse((self.f.hpc / 'ws' / hpc.PREPARED).exists())
        initial = self.f.project / 'data/datasets/example-chr1.json'
        initial.parent.mkdir(parents=True, exist_ok=True)
        initial.write_text(json.dumps({'id': 'example-chr1', 'name': ['範例', 'Example'],
                                     'inputs': workspace_inputs.LEGACY_INPUTS}))
        source = Path(self.f.config['source'])
        for name, original in (('geno/example.ped', 'study.ped'), ('geno/example.map', 'study.map'),
                               ('gexp/example_gexp', 'expression.txt')):
            target = source / 'example' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(self.paths[original].read_bytes())
        clinical = self.f.hpc / 'ws/refdata/clinical.tsv'
        clinical.write_bytes(self.paths['clinical.tsv'].read_bytes())
        workspace_datasets.update_dataset('example-chr1', references=self.custom_references())
        saved_inputs = workspace_inputs.LEGACY_INPUTS
        report = workspace_validation.validate('example-chr1', saved_inputs)
        self.assertEqual(report['inputs'], saved_inputs)
        self.assertEqual(report['stage_readiness']['1']['status'], 'ready')
        self.assertTrue(all(Path(path).is_absolute() for paths in report['resolved_inputs'].values() for path in paths))
        review = workspace.review_dataset('example-chr1', saved_inputs)
        self.assertTrue(review['ready'], review['issues'])
        self.assertEqual(review['mode'], 'dataset')
        self.assertEqual(review['source_inputs'], saved_inputs)
        record = workspace.submit_dataset('example-chr1', 'custom-example', review['inputs'], review['settings'],
            review['resources'], review['review_token'], True)
        root = self.f.project / 'runs/custom-example'
        snapshot = json.loads((root / workspace.SNAPSHOT).read_text())
        self.assertEqual(snapshot['selected_inputs'], saved_inputs)
        self.assertEqual(snapshot['source_inputs'], review['resolved_inputs'])
        self.assertEqual(snapshot['reference_choices'], self.custom_references())
        with patch.object(stage_dataset, 'PREPARE_SOURCE', workspace_inputs._PREPARE_SOURCE, create=True):
            stage_dataset.stage(workspace_inputs.staging_plan(root, record['remote_dir']))
        self.assertTrue((Path(record['remote_dir']) / 'inputs/prepared/ref/chr2.gen').is_file())
        self.assertEqual(workspace.run_history(root)['reference_sources'], review['reference_sources'])

    def test_stage1_review_defers_clinical_choices_and_keeps_freezing_guards(self):
        clinical = self.paths['clinical.tsv']
        clinical.write_text(clinical.read_text().replace('asian', 'Unknown'))
        original = clinical.read_bytes()
        review = self.review()
        self.assertTrue(review['ready'], review['issues'])
        self.assertEqual(review['validation']['stage_readiness']['3']['status'], 'needs_review')
        self.assertTrue(any('Stage 3:' in warning for warning in review['warnings']))
        with self.assertRaises(jobs.StepError):
            self.submit(review, acknowledge_warnings=False)
        self.assertFalse((self.f.fake / 'sbatch_args').exists())
        self.assertEqual(clinical.read_bytes(), original)
        clinical.write_text('submitter_id\trace\nTCGA-AA-A001\twhite\n')
        review = self.review()
        self.assertTrue(review['ready'], review['issues'])
        self.assertEqual(review['validation']['stage_readiness']['3']['status'], 'blocked')
        self.assertTrue(any('Stage 3:' in warning for warning in review['warnings']))
        clinical.unlink()
        review = self.review()
        self.assertFalse(review['ready'])
        self.assertTrue(any('freeze' in issue for issue in review['issues']))
        self.assertIn('validation', review)
        self.assertFalse((self.f.fake / 'sbatch_args').exists())

    def test_stale_tokens_acknowledgement_chromosome_and_reference_mismatch_submit_nothing(self):
        review = self.review()
        for changes in ({'review_token': 'stale'}, {'acknowledge_warnings': False},
                        {'acknowledge_warnings': 'yes'}, {'settings': {**review['settings'], 'restrict.tcga.geno': 1}}):
            with self.subTest(changes=changes), self.assertRaises(jobs.StepError):
                self.submit(review, **changes)
        self.assertFalse((self.f.project / 'runs/custom-study').exists())
        self.assertFalse((self.f.fake / 'sbatch_args').exists())
        broken = self.f.project / 'runs/broken-link'
        broken.symlink_to(self.f.project / 'missing-target')
        with patch.object(workspace_inputs, 'review', side_effect=AssertionError('Reject names before remote review')):
            for run_id in ('cis', 'network', 'runs', 'broken-link'):
                with self.subTest(run_id=run_id), self.assertRaises(jobs.StepError):
                    self.submit(review, run_id=run_id)
        self.paths['reference.vcf'].write_text(self.paths['reference.vcf'].read_text().replace('2\t101', '1\t101'))
        mismatch = self.review()
        self.assertFalse(mismatch['ready'])
        self.assertIn('matching', ' '.join(mismatch['issues']))
        self.paths['reference.vcf'].write_text('snp rs1 101 A G 0 1 0\n')
        self.assertIn('raw VCF', ' '.join(self.review()['issues']))

    def test_later_stage_reviews_and_snapshots_bind_custom_initial_dataset(self):
        self.f.visualize_ready()
        root = self.f.root
        snapshots = (workspace.SNAPSHOT, workspace.EXPRESSION_SNAPSHOT, workspace.ADJUST_SNAPSHOT,
                     workspace.CIS_SNAPSHOT, workspace.NETWORK_SNAPSHOT)
        for filename in snapshots:
            path = root / filename
            value = json.loads(path.read_text())
            value['dataset_id'] = self.dataset['id']
            path.write_text(json.dumps(value))
        self.assertEqual(workspace.run_history(root)['dataset_id'], self.dataset['id'])
        self.assertTrue(workspace.review_cis('step_test')['ready'])
        self.assertTrue(workspace.review_network('step_test')['ready'])
        self.assertTrue(workspace.review_visualize('step_test', .45, 1)['ready'])
        prior = {path: path.read_bytes() for path in (root / name for name in snapshots)}
        record = workspace.submit_visualize('step_test', {}, {'freq': .45, 'ntop': 1}, jobs.STEPS['visualize'].resources)
        saved = json.loads((root / workspace.VISUALIZE_SNAPSHOT).read_text())
        self.assertEqual(saved['dataset_id'], self.dataset['id'])
        self.assertEqual(record['run_id'], 'step_test')
        for path, content in prior.items():
            self.assertEqual(path.read_bytes(), content)
        saved['dataset_id'] = 'another-dataset'
        (root / workspace.VISUALIZE_SNAPSHOT).write_text(json.dumps(saved))
        with self.assertRaises(ValueError):
            workspace.run_history(root)

    def test_preparation_failure_explains_no_marker_overlap_without_exposing_paths(self):
        source = self.paths['reference.vcf'].read_text()
        self.paths['reference.vcf'].write_text(source.replace('\t101\t', '\t901\t').replace('\t202\t', '\t902\t').replace('\t303\t', '\t903\t'))
        review = self.review()
        self.assertTrue(review['ready'], review['issues'])
        record = self.submit(review)
        root = self.f.project / 'runs/custom-study'
        plan = workspace_inputs.staging_plan(root, record['remote_dir'])
        result = subprocess.run(['bash', '-s'], input=workspace_inputs.stage_command(plan).encode(), capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('No study marker matches the reference by position and alleles', result.stderr.decode())
        self.assertNotIn(str(self.files), result.stderr.decode())
        self.assertNotIn('Traceback', result.stderr.decode())


if __name__ == '__main__':
    unittest.main()
