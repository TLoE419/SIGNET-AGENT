import base64
import json
import math
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zlib

from agent.runtime import signet_jobs as jobs, ssh_transport, workspace_projection as projection
import agent.tools.signet as signet
from agent.runtime.jobs.project_workspace import _pca_png


class WorkspaceProjectionTest(unittest.TestCase):
    """Execute the real guarded remote scripts on isolated fixture files, never SSH."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.project = self.base / 'desktop'
        self.run_id = 'projection-fixture'
        self.root = self.project / 'runs' / self.run_id
        self.remote = self.base / 'hpc/runs' / self.run_id
        for folder in ('work/script', 'work/tmp', 'work/data', 'work/res', 'logs', 'home', 'steps'):
            (self.root / folder).mkdir(parents=True, exist_ok=True)
        (self.root / 'manifest.json').write_text('{}')
        (self.remote / 'steps').mkdir(parents=True)
        (self.remote / 'work').mkdir()
        (self.remote / '.owner').write_text('fixture-owner')
        (self.root / 'steps/remote.owner').write_text(json.dumps({'remote_dir': str(self.remote), 'token': 'fixture-owner'}))
        self.config = {'root': str(self.base / 'hpc'), 'workRoot': str(self.remote.parent),
                       'image': str(self.base / 'hpc/image.sif'), 'source': str(self.base / 'hpc/source'),
                       'executor': '/bin/echo', 'partition': 'fixture'}
        self.calls = []
        for mocked in (patch.object(signet, 'PROJECT', self.project),
                       patch.object(jobs, '_environment', return_value=self.config),
                       patch.object(ssh_transport, 'remote', side_effect=self.execute)):
            mocked.start()
            self.addCleanup(mocked.stop)

    def execute(self, command, **kwargs):
        self.assertEqual(command, 'bash -s')
        self.calls.append(kwargs['input'].decode())
        return subprocess.run(['bash', '-s'], input=kwargs['input'], capture_output=True, timeout=10)

    def place(self, relative, text):
        path = self.remote / 'work' / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def record(self, stage, **changes):
        step = projection.STEPS[stage]
        value = {'step': step, 'run_id': self.run_id, 'state': 'completed', 'job_id': '12345', 'attempt': 1,
                 'remote_dir': str(self.remote), 'image': self.config['image'], 'partition': 'fixture',
                 'settings': {'alpha.cis': '0.05'}, 'options': {'npc': 2}, **changes}
        path = self.root / 'steps' / (step + '.json')
        path.write_text(json.dumps(value))
        (self.remote / 'steps' / (step + '.job')).write_text(value['job_id'])
        (self.remote / 'steps' / (step + '.done')).write_text('0 2026-11-18T01:02:03Z\n')
        return path

    def genotype(self):
        self.place('res/resg/signet_Genotype.sampleID', 'PRIVATE-SAMPLE-1\nPRIVATE-SAMPLE-2\n')
        self.place('res/resg/signet_Geno', '0 1 2\n2 1 0\n')
        self.record(1)

    def expression(self):
        self.place('res/rest/signet_gexpID', 'PRIVATE-SAMPLE-1\nPRIVATE-SAMPLE-2\n')
        self.place('res/rest/signet_gene_name', 'GENE1\nGENE2\n')
        self.place('res/rest/signet_gene_pos', '100\n200\n')
        self.place('res/rest/signet_gexp', '1 2\n3 4\n')
        self.record(2)

    def adjustment(self):
        ids = ['TCGA-AA-A001-01', 'TCGA-AA-A002-01', 'TCGA-AA-A003-01', 'TCGA-AA-A004-01']
        self.place('res/resa/workspace-genotype-ids.txt', '\n'.join(ids) + '\n')
        self.place('res/resa/workspace-clinical.tsv', 'submitter_id\trace\tgender\n'
                   'TCGA-AA-A001\tasian\tfemale\nTCGA-AA-A002\tblack or african american\tmale\n'
                   'TCGA-AA-A003\tamerican indian or alaska native\tmale\nTCGA-AA-A004\twhite\tfemale\n')
        self.place('res/resa/workspace-pca.evec', '#eigvals: 6 3 1\nTCGA-AA-A002 0.2 0.4 pop\n'
                   'TCGA-AA-A003 0.3 0.5 pop\nTCGA-AA-A001 0.1 0.3 pop\n')
        self.place('res/resa/workspace-pca.eval', '6\n3\n1\n')
        for name, text in {
                'signet_matched.gexp': '1 3\n3 5\n9 9\n10 10\n',
                'signet_gexp.data': '0.5 0.8\n-0.5 -0.8\n',
                'signet_gexp_rmpc.data': '0.25 0.4\n-0.25 -0.4\n',
                'signet_new.Geno': '0 1 2\n2 1 0\n1 0 1\n0 0 2\n',
                'signet_geno.data': '0 1 2\n2 1 0\n',
                'signet_new.Geno.map': '1 1 0 100\n1 2 0 200\n1 3 0 300\n'}.items():
            self.place('res/resa/' + name, text)
        self.place('res/resg/signet_Genotype.sampleID', '\n'.join(ids + ['TCGA-AA-A005-01']) + '\n')
        self.place('res/rest/signet_gexpID', '\n'.join(ids + ['TCGA-AA-A006-01', 'TCGA-AA-A007-01']) + '\n')
        self.place('res/rest/signet_gene_name', 'GENE1\nGENE2\n')
        self.record(3)

    def cis(self):
        self.place('res/resc/signet_net.genename', 'GENE1\nGENE2\n')
        self.place('res/resc/signet_net.gexp.data', '1 2\n3 4\n')
        self.place('res/resc/signet_common.eQTL.data', '0\n1\n')
        self.place('res/resc/signet_low.eQTL.data', '')
        self.place('res/resc/signet_rare.eQTL.data', '2\n0\n')
        self.place('res/resc/signet_all.eQTL.data', '0 2\n1 0\n')
        self.place('res/resc/signet_all.sig.pValue_0.05', '1 1 0.01\n2 2 0.02\n')
        self.record(4, required_outputs=['res/resc/signet_all.sig.pValue_0.05'])

    def fork(self, source_id, child_id, stage=1):
        source = self.project / 'runs' / source_id
        snapshot = source / 'workspace-genotype.json'
        if not snapshot.exists():
            snapshot.write_text(json.dumps({'run_id': source_id, 'dataset_id': 'fixture-dataset'}))
        child = self.project / 'runs' / child_id
        for folder in ('work/script', 'work/tmp', 'work/data', 'work/res', 'logs', 'home', 'steps'):
            (child / folder).mkdir(parents=True, exist_ok=True)
        (child / 'manifest.json').write_text('{}')
        step = projection.STEPS[stage]
        record = json.loads((source / 'steps' / (step + '.json')).read_text())
        record.update(run_id=child_id, remote_dir=str(self.remote.parent / child_id), reused_from={
            'run_id': source_id, 'step': step, 'job_id': record['job_id'], 'attempt': record.get('attempt', 1)})
        (child / 'steps' / (step + '.json')).write_text(json.dumps(record))
        (child / 'workspace-genotype.json').write_text(json.dumps({**json.loads(snapshot.read_text()), 'run_id': child_id}))
        (child / 'rerun.json').write_text(json.dumps({'source_run_id': source_id, 'new_run_id': child_id,
                                                     'step': 'network', 'reuse': [step]}))
        return child

    def test_first_two_stages_return_only_real_aggregates_and_cache_them(self):
        self.genotype()
        self.expression()
        first = projection.completed_result(self.run_id, '1')
        self.assertEqual(first['summary'], {'samples': 2, 'variants': 3, 'nonzero_bins': [0, 0, 0, 0, 0, 3],
                                            'genotype_codes': [2, 2, 2]})
        second = projection.completed_result(self.run_id, '2')
        self.assertEqual(sum(bin['count'] for bin in second['summary']['histogram']), 4)
        self.assertEqual(second['summary']['gene_summary'], [{'gene': 'GENE1', 'min': 1, 'median': 2, 'max': 3},
                                                            {'gene': 'GENE2', 'min': 2, 'median': 3, 'max': 4}])
        self.assertNotIn('PRIVATE-SAMPLE', json.dumps([first, second]))
        with patch.object(ssh_transport, 'remote', side_effect=AssertionError('cache must work disconnected')), \
                patch.object(jobs, '_environment', side_effect=AssertionError('cache needs no live connection')):
            self.assertEqual(projection.completed_result(self.run_id, '2'), second)
        self.assertFalse(list((self.root / 'work').rglob('*.*')), 'no raw result files are copied to the desktop')
        self.assertEqual(len(self.calls), 2)
        self.assertFalse(any(command in script for script in self.calls for command in ('sbatch ', 'scancel ', 'tar cz')))

    def test_adjustment_png_comes_from_actual_scores_without_points_or_ids(self):
        self.adjustment()
        result = projection.completed_result(self.run_id, '3')
        self.assertEqual(result['matching'], {'genotype': 5, 'expression': 6, 'matched': 4,
                                              'retained': 2, 'excluded': 2, 'variants': 3, 'genes': 2})
        self.assertEqual(result['pca']['variance_explained'], [60, 30])
        self.assertEqual(result['pca']['point_count'], 2)
        picture = base64.b64decode(result['pca']['png_base64'])
        self.assertEqual(struct.unpack('>II', picture[16:24]), (640, 420))
        offset, compressed, chunks = 8, b'', []
        while offset < len(picture):
            size = struct.unpack('>I', picture[offset:offset + 4])[0]
            kind, data = picture[offset + 4:offset + 8], picture[offset + 8:offset + 8 + size]
            chunks.append(kind)
            if kind == b'IDAT':
                compressed += data
            offset += 12 + size
        self.assertEqual(chunks, [b'IHDR', b'IDAT', b'IEND'], 'no sample metadata is embedded in the PNG')
        self.assertIn(bytes((43, 109, 190)), zlib.decompress(compressed), 'the saved scores produce visible blue points')
        for text in [json.dumps(result), *(p.read_text() for p in (self.root / 'workspace-projections').glob('*.json'))]:
            self.assertNotIn('TCGA-', text)
            self.assertNotIn('"points"', text)
            self.assertNotIn('workspace-pca.evec', text)

    def test_cis_preserves_all_category_local_associations_without_sample_matrices(self):
        self.cis()
        result = projection.completed_result(self.run_id, '4')
        self.assertEqual(result['summary'], {'genes': 2, 'counts': {'common': 1, 'low': 0, 'rare': 1},
            'pairs': [{'gene': 'GENE1', 'variant': '1', 'category': 'common', 'p_value': 0.01},
                      {'gene': 'GENE2', 'variant': '1', 'category': 'rare', 'p_value': 0.02}]})
        self.assertNotIn('matrix', json.dumps(result['summary']))
        self.assertFalse(list((self.root / 'work').rglob('*.*')))

    def test_owner_job_environment_and_completion_must_match_before_projection(self):
        self.genotype()
        for target, text in ((self.remote / '.owner', 'foreign-owner'),
                             (self.remote / 'steps/genotype.job', '99999'),
                             (self.remote / 'steps/genotype.done', '1 2026-11-18T01:02:03Z')):
            original = target.read_text()
            target.write_text(text)
            with self.subTest(target=target), self.assertRaises(jobs.StepError):
                projection.completed_result(self.run_id)
            target.write_text(original)
        with patch.object(jobs, '_environment', return_value={**self.config, 'image': '/foreign/image.sif'}):
            with self.assertRaises(jobs.StepError):
                projection.completed_result(self.run_id)
        self.assertFalse((self.root / 'workspace-projections').exists())

    def test_symlink_and_private_parse_errors_are_refused_without_leaking_input(self):
        self.genotype()
        matrix = self.remote / 'work/res/resg/signet_Geno'
        matrix.unlink()
        outside = self.base / 'private.txt'
        outside.write_text('PRIVATE-SAMPLE-SECRET\n')
        matrix.symlink_to(outside)
        with self.assertRaises(jobs.StepError):
            projection.completed_result(self.run_id)
        matrix.unlink()
        matrix.write_text('PRIVATE-SAMPLE-SECRET\n')
        with self.assertRaises(jobs.StepError) as caught:
            projection.completed_result(self.run_id)
        self.assertNotIn('PRIVATE-SAMPLE', str(caught.exception))
        self.assertFalse((self.root / 'workspace-projections').exists())

    def test_job_attempt_and_clinical_source_choices_cannot_reuse_another_cache(self):
        self.adjustment()
        snapshot = self.root / 'workspace-adjust.json'
        snapshot.write_text(json.dumps({'run_id': self.run_id, 'clinical_choices': {'Unknown': 'exclude'}}))
        projection.completed_result(self.run_id, '3')
        snapshot.write_text(json.dumps({'run_id': self.run_id, 'clinical_choices': {'Unknown': 'not_reported'}}))
        projection.completed_result(self.run_id, '3')
        self.record(3, attempt=2, job_id='54321')
        projection.completed_result(self.run_id, '3')
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(len(list((self.root / 'workspace-projections').glob('*.json'))), 3)

    def test_job_change_during_read_does_not_publish_a_cache(self):
        self.genotype()
        path = self.root / 'steps/genotype.json'

        def changed(command, **kwargs):
            result = self.execute(command, **kwargs)
            record = json.loads(path.read_text())
            record['attempt'] = 2
            path.write_text(json.dumps(record))
            return result

        with patch.object(ssh_transport, 'remote', side_effect=changed), self.assertRaises(jobs.StepError):
            projection.completed_result(self.run_id)
        self.assertFalse((self.root / 'workspace-projections').exists())

    def test_refresh_rebinds_output_fingerprint_and_reader_changes_invalidate_cache(self):
        self.genotype()
        first = projection.completed_result(self.run_id)
        cache = next((self.root / 'workspace-projections').glob('*.json'))
        original = json.loads(cache.read_text())
        self.place('res/resg/signet_Geno', '0 0 0\n0 0 0\n')
        refreshed = projection.completed_result(self.run_id, refresh=True)
        updated = json.loads(cache.read_text())
        self.assertNotEqual(first['summary'], refreshed['summary'])
        self.assertNotEqual(original['projection']['source_fingerprint'], updated['projection']['source_fingerprint'])
        self.assertNotEqual(original['cache_key'], updated['cache_key'])
        reader = projection._reader
        with patch.object(projection, '_reader', side_effect=lambda stage: (reader(stage)[0] + '\n', reader(stage)[1])):
            self.assertEqual(projection.completed_result(self.run_id), refreshed)
        self.assertEqual(len(self.calls), 3, 'a different trusted reader version cannot reuse the old cache')

    def test_cached_raw_pca_points_are_refused_without_a_different_source_fallback(self):
        self.adjustment()
        projection.completed_result(self.run_id, '3')
        cache = next((self.root / 'workspace-projections').glob('*.json'))
        saved = json.loads(cache.read_text())
        saved['projection']['pca']['points'] = [[0.1, 0.3]]
        cache.write_text(json.dumps(saved))
        with self.assertRaises(ValueError):
            projection.completed_result(self.run_id, '3')
        self.assertEqual(len(self.calls), 1, 'a malformed cache must fail instead of selecting another source')

    def test_inherited_results_display_before_child_remote_staging_and_follow_a_chain(self):
        self.genotype()
        child = self.fork(self.run_id, 'child')
        grandchild = self.fork('child', 'grandchild')
        result = projection.completed_result('grandchild', '1')
        self.assertEqual(result['run_id'], 'grandchild')
        self.assertEqual(result['job']['run_id'], 'grandchild')
        self.assertEqual(result['job']['reused_from']['run_id'], 'child')
        self.assertEqual(result['summary']['samples'], 2)
        self.assertEqual(len(self.calls), 1)
        self.assertFalse((child / 'steps/remote.owner').exists())
        self.assertFalse((grandchild / 'steps/remote.owner').exists())
        self.assertFalse((self.remote.parent / 'child').exists())
        self.assertFalse((self.remote.parent / 'grandchild').exists(), 'viewing inherited results never stages a child')
        with patch.object(ssh_transport, 'remote', side_effect=AssertionError('original aggregate is cached')):
            self.assertEqual(projection.completed_result('grandchild', '1'), result)

    def test_changed_source_attempt_dataset_plan_and_cycles_refuse_inherited_results(self):
        self.genotype()
        child = self.fork(self.run_id, 'child')
        original = self.root / 'steps/genotype.json'
        record = json.loads(original.read_text())
        original.write_text(json.dumps({**record, 'attempt': 2, 'job_id': '99999'}))
        with self.assertRaises(jobs.StepError):
            projection.completed_result('child')
        original.write_text(json.dumps(record))
        snapshot = child / 'workspace-genotype.json'
        snapshot.write_text(json.dumps({'run_id': 'child', 'dataset_id': 'different'}))
        with self.assertRaises(jobs.StepError):
            projection.completed_result('child')
        snapshot.write_text(json.dumps({'run_id': 'child', 'dataset_id': 'fixture-dataset'}))
        plan = child / 'rerun.json'
        plan.write_text(json.dumps({'source_run_id': 'different', 'new_run_id': 'child', 'reuse': ['genotype']}))
        with self.assertRaises(jobs.StepError):
            projection.completed_result('child')
        plan.write_text(json.dumps({'source_run_id': self.run_id, 'new_run_id': 'child', 'reuse': ['genotype']}))
        original.write_text(json.dumps({**record, 'reused_from': {'run_id': 'child', 'step': 'genotype',
                                      'job_id': record['job_id'], 'attempt': 1}}))
        (self.root / 'rerun.json').write_text(json.dumps({'source_run_id': 'child', 'new_run_id': self.run_id,
                                                        'reuse': ['genotype']}))
        with self.assertRaises(jobs.StepError):
            projection.completed_result('child')
        self.assertEqual(self.calls, [], 'bad relations are refused before remote reads')

    def test_changed_child_relation_during_source_projection_refuses_publication(self):
        self.genotype()
        child = self.fork(self.run_id, 'child')
        def changed(command, **kwargs):
            result = self.execute(command, **kwargs)
            path = child / 'steps/genotype.json'
            value = json.loads(path.read_text())
            value['reused_from']['job_id'] = '99999'
            path.write_text(json.dumps(value))
            return result
        with patch.object(ssh_transport, 'remote', side_effect=changed), self.assertRaises(jobs.StepError):
            projection.completed_result('child')


class PcaRasterTest(unittest.TestCase):
    def pixels(self, points):
        picture = _pca_png(points)
        self.assertEqual(struct.unpack('>II', picture[16:24]), (640, 420))
        offset, compressed = 8, b''
        while offset < len(picture):
            size = struct.unpack('>I', picture[offset:offset + 4])[0]
            if picture[offset + 4:offset + 8] == b'IDAT':
                compressed += picture[offset + 8:offset + 8 + size]
            offset += 12 + size
        rows = zlib.decompress(compressed)
        self.assertEqual(len(rows), 420 * (640 * 3 + 1))
        return [rows[y * (640 * 3 + 1) + 1:(y + 1) * (640 * 3 + 1)] for y in range(420)]

    def test_axis_names_and_numeric_ticks_are_inside_png_with_unchanged_point_mapping(self):
        rows = self.pixels([[-1, -1], [1, 1]])
        color = bytes((55, 65, 75))
        self.assertTrue(any(color in row[4 * 3:28 * 3] for row in rows[1:15]), 'PC2 label is rasterized')
        self.assertTrue(any(color in row[310 * 3:350 * 3] for row in rows[405:420]), 'PC1 label is rasterized')
        self.assertTrue(any(color in row for row in rows[393:400]), 'numeric x ticks are rasterized below the axis')
        self.assertTrue(any(color in row[:37 * 3] for row in rows[17:389]), 'numeric y ticks are rasterized left of the axis')
        for x, y in ((82, 360), (580, 45)):
            self.assertEqual(rows[y][x * 3:x * 3 + 3], bytes((43, 109, 190)), 'real bounds retain the original eight-percent padding')

    def test_finite_extreme_tiny_constant_and_adjacent_scores_render_without_overflow(self):
        maximum = float.fromhex('0x1.fffffffffffffp+1023')
        for points in ([[-maximum, maximum], [maximum, -maximum]],
                       [[5e-324, -5e-324], [1e-323, 1e-323]],
                       [[maximum, -maximum], [maximum, -maximum]],
                       [[1e308, 1e308], [math.nextafter(1e308, math.inf), math.nextafter(1e308, -math.inf)]]):
            with self.subTest(points=points):
                rows = self.pixels(points)
                self.assertTrue(any(bytes((43, 109, 190)) in row for row in rows[20:386]))
        for value in (math.inf, -math.inf, math.nan):
            with self.assertRaises(ValueError):
                _pca_png([[value, 0]])


if __name__ == '__main__':
    unittest.main()
