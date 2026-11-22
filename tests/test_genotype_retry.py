"""Same-run Stage 1 retries retain provenance and prepare fresh custom inputs."""
import http.client
import json
from pathlib import Path
import subprocess
import threading
import unittest
from unittest.mock import Mock
from urllib.parse import urlencode

from agent.app.chat_ui import ChatServer
from agent.runtime import hpc, signet_jobs as jobs, workspace_datasets, workspace_genotype as workspace, workspace_inputs
import test_dataset_runs as dataset_fixtures
import test_signet_jobs as step_fixtures


class GenotypeRetryTest(unittest.TestCase):
    def setUp(self):
        self.f = step_fixtures.StepsTest()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.run_id = 'retry-study'

    def seed(self, state='FAILED'):
        record = workspace.submit_example(self.run_id, self.f.genotype_inputs(), workspace.DEFAULT_SETTINGS,
                                          jobs.STEPS['genotype'].resources)
        self.root = self.f.project / 'runs' / self.run_id
        self.remote = Path(record['remote_dir'])
        self.f.remote_dir = self.remote
        for base in (self.root, self.remote):
            folder = base / 'work/res/resg'
            folder.mkdir(parents=True, exist_ok=True)
            (folder / 'partial-old-result').write_text('first attempt result\n')
            (base / 'steps/genotype.out').write_text('first attempt stdout\n')
            (base / 'steps/genotype.err').write_text('first attempt stderr\n')
            (base / 'steps/genotype.job').write_text(record['job_id'] + '\n')
        self.f.slurm(squeue='', sacct=state)
        return jobs.status(self.run_id, 'genotype', refresh=True)

    def review(self, attempt=1, job_id='12345'):
        return workspace.review_genotype_retry(self.run_id, job_id, attempt)

    def submit(self, review, **changes):
        body = {key: review[key] for key in ('inputs', 'settings', 'resources', 'review_token', 'expected_attempt')}
        body.update(expected_job_id=review['expected_job_id'] or 'none', acknowledge_warnings=True)
        body.update(changes)
        return workspace.submit_genotype_retry(self.run_id, **body)

    def test_failed_stage1_retries_same_id_and_preserves_original_attempt_files(self):
        previous = self.seed()
        snapshot = (self.root / workspace.SNAPSHOT).read_bytes()
        raw_previous = (self.root / 'steps/genotype.json').read_bytes()
        review = self.review()
        self.assertTrue(review['ready'], review['issues'])
        self.assertEqual(set(review['resources']), {'cpus', 'mem_gb', 'hours'})
        self.assertEqual(review['inputs'], previous['inputs'])
        self.f.slurm(sbatch_reply='222')
        current = self.submit(review, settings={**review['settings'], 'mind': .2},
                              resources={**review['resources'], 'cpus': 2})
        self.assertEqual((current['run_id'], current['attempt'], current['job_id']), (self.run_id, 2, '222'))
        self.assertEqual((current['settings']['mind'], current['resources']['cpus']), ('0.2', 2))
        self.assertEqual((self.root / workspace.SNAPSHOT).read_bytes(), snapshot)
        self.assertEqual((self.root / 'steps/genotype.attempt1.json').read_bytes(), raw_previous)
        for base in (self.root, self.remote):
            self.assertEqual((base / 'steps/genotype.attempt1.out').read_text(), 'first attempt stdout\n')
            self.assertEqual((base / 'steps/genotype.attempt1.err').read_text(), 'first attempt stderr\n')
            self.assertEqual((base / 'steps/genotype.attempt1.results/partial-old-result').read_text(), 'first attempt result\n')
        review_snapshot = json.loads((self.root / 'workspace-genotype.review2.json').read_text())
        self.assertEqual(review_snapshot['settings'], current['settings'])
        self.assertFalse((self.root / workspace.EXPRESSION_SNAPSHOT).exists())

    def test_cancelled_stage1_can_retry_but_stale_active_completed_and_unknown_cannot(self):
        previous = self.seed('CANCELLED')
        review = self.review()
        self.assertTrue(review['ready'])
        for change in ({'expected_job_id': '999'}, {'expected_attempt': 2}):
            args = {'run_id': self.run_id, 'expected_job_id': '12345', 'expected_attempt': 1, **change}
            calls = len(self.f.calls)
            with self.assertRaises(jobs.StepError):
                workspace.review_genotype_retry(**args)
            self.assertEqual(len(self.f.calls), calls)
        for state in ('running', 'completed', 'unknown'):
            jobs._save(self.root, {**previous, 'state': state})
            calls = len(self.f.calls)
            with self.assertRaises(jobs.StepError):
                self.review()
            self.assertEqual(len(self.f.calls), calls)
        jobs._save(self.root, previous)
        self.f.slurm(sbatch_reply='222')
        self.assertEqual(self.submit(review)['attempt'], 2)

    def test_downstream_evidence_stale_review_and_missing_ack_leave_inputs_and_settings_unchanged(self):
        self.seed()
        review = self.review()
        original = {name: (self.root / name).read_bytes() for name in (workspace.SNAPSHOT, 'work/config.ini', 'steps/genotype.json')}
        for name in (workspace.EXPRESSION_SNAPSHOT, 'workspace-adjust.review1.json', 'pca.json', 'plot_pca.plan.json'):
            path = self.root / name
            path.write_text('{}')
            calls = len(self.f.calls)
            with self.assertRaises(jobs.StepError):
                self.submit(review)
            self.assertEqual(len(self.f.calls), calls)
            path.unlink()
        for changes in ({'review_token': 'stale'}, {'acknowledge_warnings': False},
                        {'settings': {**review['settings'], 'restrict.tcga.geno': 2}}):
            with self.assertRaises(jobs.StepError):
                self.submit(review, **changes)
        self.assertEqual(original, {name: (self.root / name).read_bytes() for name in original})
        self.assertFalse((self.root / 'workspace-genotype.review2.json').exists())

    def test_still_running_parent_and_changed_container_block_retry_before_writes(self):
        self.seed()
        original = (self.root / 'work/config.ini').read_bytes()
        self.f.slurm(squeue='RUNNING', name='signet-genotype-' + self.run_id)
        review = self.review()
        self.assertFalse(review['ready'])
        self.assertIn('stopped', ' '.join(review['issues']))
        self.assertEqual((self.root / 'work/config.ini').read_bytes(), original)
        self.f.slurm(squeue='', sacct='FAILED')
        self.f.config['image'] = str(self.f.hpc / 'different.sif')
        with self.assertRaises(jobs.StepError):
            self.review()
        self.assertEqual((self.root / 'work/config.ini').read_bytes(), original)

    def test_generic_step_route_cannot_bypass_original_files_chromosome_or_downstream_guards(self):
        previous = self.seed()
        saved = (self.root / 'steps/genotype.json').read_bytes()
        inputs = previous['inputs']
        jobs.update_settings(self.run_id, {'restrict.tcga.geno': 2})
        calls = len(self.f.calls)
        with self.assertRaisesRegex(jobs.StepError, 'original chromosome'):
            jobs.submit(self.run_id, 'genotype', inputs)
        self.assertEqual(len(self.f.calls), calls)
        jobs.update_settings(self.run_id, {'restrict.tcga.geno': 1})
        with self.assertRaisesRegex(jobs.StepError, 'original genotype input'):
            jobs.submit(self.run_id, 'genotype', {**inputs, 'ped.file': inputs['ped.file'] + '-different'})
        (self.root / workspace.EXPRESSION_SNAPSHOT).write_text('{}')
        with self.assertRaisesRegex(jobs.StepError, 'later stage'):
            jobs.submit(self.run_id, 'genotype', inputs)
        self.assertEqual((self.root / 'steps/genotype.json').read_bytes(), saved)
        self.assertFalse((self.root / 'steps/genotype.attempt1.json').exists())

    def test_retry_http_contract_is_guarded_and_requires_manual_acknowledgement(self):
        self.seed()
        server = ChatServer(('127.0.0.1', 0), Mock())
        self.addCleanup(server.server_close)
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 3)
        self.addCleanup(server.shutdown)
        path = '/signet/runs/' + self.run_id + '/genotype/retry'
        def request(method, suffix='', body=None, token=True):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
            headers = {'Origin': f'http://127.0.0.1:{server.server_port}', 'Content-Type': 'application/json'}
            if token:
                headers['X-Chat-Token'] = server.token
            try:
                connection.request(method, path + suffix, json.dumps(body) if body is not None else None, headers)
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()
        query = '?' + urlencode({'expected_job_id': '12345', 'expected_attempt': 1})
        self.assertEqual(request('GET', query, token=False)[0], 403)
        self.assertEqual(request('GET')[0], 400)
        self.assertEqual(request('GET', '?expected_job_id=12345&expected_attempt=' + '9' * 5000)[0], 400)
        status, review = request('GET', query)
        self.assertEqual((status, review['run_id'], review['next_attempt']), (200, self.run_id, 2))
        body = {key: review[key] for key in ('inputs', 'settings', 'resources', 'review_token', 'expected_attempt')}
        body['expected_job_id'] = '12345'
        self.assertEqual(request('POST', body=body)[0], 400)
        self.f.slurm(sbatch_reply='222')
        status, current = request('POST', body={**body, 'acknowledge_warnings': True})
        self.assertEqual((status, current['run_id'], current['attempt']), (202, self.run_id, 2))


class CustomGenotypeRetryTest(unittest.TestCase):
    def setUp(self):
        self.c = dataset_fixtures.DatasetRunTest()
        self.c.setUp()
        self.addCleanup(self.c.doCleanups)
        self.f = self.c.f

    def seed(self, prepare=True):
        first = self.c.submit(self.c.review())
        self.root = self.f.project / 'runs/custom-study'
        self.remote = Path(first['remote_dir'])
        plan = workspace_inputs.staging_plan(self.root, first['remote_dir'])
        if prepare:
            result = subprocess.run(['bash', '-s'], input=workspace_inputs.stage_command(plan).encode(), capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
        else:
            (self.remote / 'inputs/frozen').mkdir(parents=True)
            (self.remote / 'inputs/frozen/partial-first').write_text('preserve partial freeze')
        self.f.slurm(squeue='', sacct='FAILED')
        jobs.status('custom-study', 'genotype', refresh=True)
        return first

    def retry(self, number=1, job_id='12345'):
        review = workspace.review_genotype_retry('custom-study', job_id, number)
        self.assertTrue(review['ready'], review['issues'])
        self.f.slurm(sbatch_reply=str(220 + number))
        current = workspace.submit_genotype_retry('custom-study', review['inputs'],
            {**review['settings'], 'mind': .2}, review['resources'], review['review_token'], job_id, number, True)
        return review, current

    def test_custom_completed_freeze_is_preserved_and_retry_freezes_original_catalog_sources_again(self):
        workspace_datasets.update_dataset(self.c.dataset['id'], references=self.c.custom_references())
        self.seed()
        references = workspace.run_history(self.root)['reference_sources']
        initial = (self.root / workspace.SNAPSHOT).read_bytes()
        originals = {path: path.read_bytes() for path in (self.remote / 'inputs').rglob('*') if path.is_file()}
        workspace_datasets.update_dataset(self.c.dataset['id'], {'expression': ['/different/expression'], 'clinical': ['/different/clinical']},
                                          references={'ref': '/different/reference', 'gtf': '/different/annotation'})
        (self.f.hpc / 'ws/refdata/selected.tsv').write_text('ref\t/different/reference\n')
        review, current = self.retry()
        self.assertEqual(review['source_inputs'], self.c.inputs)
        self.assertIn('/inputs/attempt2/prepared/', current['inputs']['ped.file'])
        self.assertEqual((self.root / workspace.SNAPSHOT).read_bytes(), initial)
        plan = workspace_inputs.staging_plan(self.root, current['remote_dir'])
        result = subprocess.run(['bash', '-s'], input=workspace_inputs.stage_command(plan).encode(), capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(originals, {path: path.read_bytes() for path in originals})
        self.assertEqual((self.remote / 'inputs/attempt2/frozen/expression').read_bytes(), self.c.paths['expression.txt'].read_bytes())
        output = self.remote / 'work/res/resg'
        (output / 'signet_Geno').write_text('0 1 2\n' * 6)
        (output / 'signet_Genotype.sampleID').write_text('\n'.join('TCGA-AA-A00' + str(n) + '-NT' for n in range(1, 7)) + '\n')
        (self.remote / 'steps/genotype.done').write_text('0 2026-11-17T10:00:00-08:00\n')
        self.f.slurm(squeue='', sacct='COMPLETED')
        self.assertEqual(jobs.status('custom-study', 'genotype', refresh=True)['state'], 'completed')
        expression = workspace.review_expression('custom-study')
        self.assertIn('/inputs/attempt2/frozen/', expression['inputs']['gexp.file'])
        self.assertEqual(workspace.run_history(self.root)['frozen_inputs'], workspace_inputs.frozen_paths(current['remote_dir'], 2))
        self.assertEqual(workspace.run_history(self.root)['reference_sources'], references)
        self.assertEqual(Path(expression['inputs']['pmap.file']).read_bytes(), self.c.paths['annotation.gtf'].read_bytes())
        # Recorded Stage 2 fixtures let us check Stage 3's clinical selection
        # without submitting or running any later analysis.
        ids = ['TCGA-AA-A00' + str(n) for n in range(1, 7)]
        for base in (self.root, self.remote):
            for relative in jobs.STEPS['adjust'].needs:
                path = base / 'work' / relative
                if not path.exists():
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text('fixture prerequisite\n')
            (base / 'work/res/rest/signet_gexpID').write_text('\n'.join(value + '-01A' for value in ids) + '\n')
        expression_job = {'run_id': 'custom-study', 'step': 'expression', 'state': 'completed', 'job_id': '333',
                          'remote_dir': current['remote_dir'], 'submitted_at': jobs._now(), 'inputs': expression['inputs'],
                          'settings': {'restrict.tcga': '2'}, 'resources': jobs._resources(jobs.STEPS['expression'], None)}
        (self.root / 'steps/expression.json').write_text(json.dumps(expression_job))
        (self.root / workspace.EXPRESSION_SNAPSHOT).write_text(json.dumps({
            **expression_job, 'dataset_id': self.c.dataset['id'], 'review_attempt': 1}))
        adjustment = workspace.review_adjust('custom-study')
        self.assertTrue(adjustment['ready'], adjustment['issues'])
        self.assertIn('/inputs/attempt2/frozen/clinical', adjustment['inputs']['cli.file'])

    def test_retry_accepts_cross_node_devices_without_overwriting_partial_freeze(self):
        self.seed(prepare=False)
        old = self.remote / 'inputs/frozen/partial-first'
        snapshot = self.root / workspace.SNAPSHOT
        saved = json.loads(snapshot.read_text())
        for item in saved['source_files']:
            item['identity'][0] += 1  # The earlier login node mounted the same files under a different device ID.
        snapshot.write_text(json.dumps(saved))
        original = snapshot.read_bytes()
        _, current = self.retry()
        result = subprocess.run(['bash', '-s'], input=workspace_inputs.stage_command(workspace_inputs.staging_plan(self.root, current['remote_dir'])).encode(), capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(snapshot.read_bytes(), original)
        self.assertEqual(old.read_text(), 'preserve partial freeze')
        self.assertTrue((self.remote / 'inputs/attempt2/prepared/ref/chr2.gen').is_file())

    def test_changed_original_source_blocks_retry_instead_of_using_mutable_selections(self):
        self.seed()
        initial = (self.root / workspace.SNAPSHOT).read_bytes()
        self.c.paths['expression.txt'].write_text('changed study')
        review = workspace.review_genotype_retry('custom-study', '12345', 1)
        self.assertFalse(review['ready'])
        self.assertIn('source changed', ' '.join(review['issues']))
        self.assertEqual((self.root / workspace.SNAPSHOT).read_bytes(), initial)
        self.assertFalse((self.root / 'workspace-genotype.review2.json').exists())


if __name__ == '__main__':
    unittest.main()
