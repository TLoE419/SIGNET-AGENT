import base64
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zlib

from agent.runtime import signet_jobs as jobs, ssh_transport, workspace_projection as projection
import agent.tools.signet as signet


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


if __name__ == '__main__':
    unittest.main()
