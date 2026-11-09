"""Offline tests for agent/runtime/signet_jobs.py (SIGNET steps as Slurm jobs on HPC3).

The SSH transport is replaced by a local bash, so the real login-node scripts
run against a temporary folder that plays HPC3. Small stand-ins for sbatch,
squeue, sacct and scancel read and write files in that folder; no network,
Slurm or container is needed.

Most tests use the expression step (signet -t). The genotype tests (signet -g) at
the end cover what is new there: per-chromosome prefix inputs (ref, gmap),
the PLINK/IMPUTE2 settings, and failure lines specific to -g.
"""
import json
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

import agent.runtime.ssh_transport as ssh_transport
import agent.runtime.signet_jobs as steps
import agent.tools.signet as st

FAKE_SLURM = {
    'sbatch': 'printf "%s\\n" "$@" > "$FAKE/sbatch_args"; cat "$FAKE/sbatch_reply" 2>/dev/null || echo 12345',
    'squeue': ('case "$*" in *%j*) cat "$FAKE/name";; *%i*) cat "$FAKE/queued_id";; *) cat "$FAKE/squeue";; '
               'esac 2>/dev/null; true'),
    'sacct': 'case "$*" in *--name=*) cat "$FAKE/sacct_id";; *) cat "$FAKE/sacct";; esac 2>/dev/null; true',
    'scancel': 'printf "%s\\n" "$@" > "$FAKE/scancel"',
}
OUTPUTS = steps.STEPS['expression'].required


class StepsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name).resolve()
        self.project, self.hpc, self.fake = base / 'project', base / 'hpc', base / 'fake'
        for folder in (self.project / 'data', self.hpc / 'ws/refdata', self.hpc / 'ws/signet/example', self.fake / 'bin'):
            folder.mkdir(parents=True)
        for name, body in FAKE_SLURM.items():
            path = self.fake / 'bin' / name
            path.write_text('#!/bin/bash\n' + body + '\n')
            path.chmod(path.stat().st_mode | stat.S_IEXEC)
        (self.hpc / 'signet.sif').write_text('image')
        self.gexp = self.hpc / 'ws/signet/example/example_gexp'
        self.gtf = self.hpc / 'ws/refdata/gencode.v22.annotation.gtf'
        self.gexp.write_text('counts')
        self.gtf.write_text('genes')
        self.config = {'root': str(self.hpc / 'ws'), 'source': str(self.hpc / 'ws/signet'),
                       'image': str(self.hpc / 'signet.sif'), 'executor': 'apptainer',
                       'workRoot': str(self.hpc / 'ws/work'), 'partition': 'standard'}
        self.remote_dir = self.hpc / 'ws/work/step_test'
        self.calls = []
        self.lose_connection_on = None
        patches = [patch.object(st, 'PROJECT', self.project),
                   patch.object(ssh_transport, 'available', return_value=True),
                   patch.object(ssh_transport, 'environment', side_effect=lambda: dict(self.config)),
                   patch.object(ssh_transport, 'remote', side_effect=self.remote)]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        self.addCleanup(self.temp.cleanup)
        st.configure_signet('step_test')
        self.root = self.project / 'runs/step_test'
        self.inputs = {'gexp.file': str(self.gexp), 'pmap.file': str(self.gtf)}

    def remote(self, command, input=None, capture_output=False, timeout=None):
        """Plays the Electron SSH broker: runs the command in a local bash with fake Slurm on PATH."""
        self.calls.append(command if command != 'bash -s' else input.decode())
        if self.lose_connection_on and self.lose_connection_on in self.calls[-1]:
            raise OSError('Electron SSH transport is unavailable.')
        env = {'PATH': f'{self.fake}/bin:/usr/bin:/bin', 'FAKE': str(self.fake), 'LANG': 'C'}
        return subprocess.run(['bash', '-c', command], input=input or b'', capture_output=True,
                              timeout=timeout, env=env)

    def slurm(self, **values):
        for name, value in values.items():
            (self.fake / name).write_text(value + '\n' if value else '')

    def finish_job(self, exit_code='0', outputs=OUTPUTS, err=''):
        """Write what a finished `signet -t` job leaves behind on HPC3."""
        for relative in outputs:
            path = self.remote_dir / 'work' / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('data\n')
        (self.remote_dir / 'steps/expression.err').write_text(err)
        (self.remote_dir / 'steps/expression.done').write_text(f'{exit_code} 2026-11-01T10:00:00\n')
        self.slurm(squeue='', sacct='COMPLETED')

    def code_of(self, call, *args, **kwargs):
        with self.assertRaises(steps.StepError) as caught:
            call(*args, **kwargs)
        return caught.exception.code

    def test_catalog_lists_expression_with_inputs_and_limits(self):
        step = steps.catalog()['steps'][0]
        self.assertEqual((step['name'], step['flag'], step['cohort']), ('expression', '-t', 'TCGA'))
        self.assertEqual(step['inputs'], ['gexp.file', 'pmap.file'])
        self.assertEqual(step['limits']['cpus'], [1, 16])

    def test_submit_uploads_run_writes_valid_job_script_and_queues_it(self):
        record = steps.submit('step_test', 'expression', self.inputs, {'cpus': 2, 'hours': 1.5})
        self.assertEqual((record['state'], record['job_id']), ('submitted', '12345'))
        args = (self.fake / 'sbatch_args').read_text().split()
        self.assertEqual(args[:5], ['--parsable', '--partition=standard', '--cpus-per-task=2', '--mem=16G', '--time=01:30:00'])
        job = self.remote_dir / 'steps/expression.sbatch'
        self.assertEqual(subprocess.run(['bash', '-n', str(job)]).returncode, 0)
        text = job.read_text()
        self.assertIn('#SBATCH --job-name=signet-expression-step_test', text)
        self.assertIn('bash ./signet -t < /dev/null', text)
        self.assertIn(f'{self.hpc}/ws/refdata:{self.hpc}/ws/refdata:ro', text)
        self.assertIn(f'{self.hpc}/ws/signet/example:{self.hpc}/ws/signet/example:ro', text)
        config = (self.remote_dir / 'work/config.ini').read_text()
        self.assertIn(f'gexp.file = {self.gexp}', config)
        self.assertIn(f'rest.tcga = {self.remote_dir}/work/res/rest/signet', config)
        self.assertNotIn(str(self.project), config)
        self.assertTrue((self.remote_dir / 'work/signet').is_file())
        self.assertFalse((self.root / '.active').exists())
        self.assertEqual(steps.run_steps('step_test'), {'expression': 'submitted'})

    def test_submit_refuses_paths_outside_allowed_roots_before_touching_hpc3(self):
        for bad in ('/etc/passwd', str(self.hpc / 'ws/refdata/../../signet.sif'), str(self.hpc / 'ws/refdata'),
                    'relative/path', str(self.gtf) + ';rm'):
            inputs = {**self.inputs, 'pmap.file': bad}
            self.assertEqual(self.code_of(steps.submit, 'step_test', 'expression', inputs), 'invalid_request', bad)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.code_of(steps.submit, 'step_test', 'expression', {'gexp.file': str(self.gexp)}), 'invalid_request')
        self.assertEqual(self.code_of(steps.submit, 'step_test', 'expression', self.inputs, {'cpus': 99}), 'invalid_request')
        self.assertEqual(self.code_of(steps.submit, 'step_test', 'expression', self.inputs, {'queue': 'x'}), 'invalid_request')

    def test_missing_or_linked_input_on_hpc3_submits_nothing_and_can_be_retried(self):
        self.gtf.unlink()
        self.assertEqual(self.code_of(steps.submit, 'step_test', 'expression', self.inputs), 'invalid_request')
        self.gtf.symlink_to(self.gexp)
        self.assertEqual(self.code_of(steps.submit, 'step_test', 'expression', self.inputs), 'invalid_request')
        self.assertFalse((self.fake / 'sbatch_args').exists())
        self.assertEqual(steps.run_steps('step_test'), {})
        self.gtf.unlink()
        self.gtf.write_text('genes')
        self.assertEqual(steps.submit('step_test', 'expression', self.inputs)['state'], 'submitted')

    def test_one_attempt_per_step_and_wrong_cohort_or_unknown_step(self):
        steps.submit('step_test', 'expression', self.inputs)
        self.assertEqual(self.code_of(steps.submit, 'step_test', 'expression', self.inputs), 'conflict')
        st.configure_signet('gtex_run', cohort='GTEx')
        self.assertEqual(self.code_of(steps.submit, 'gtex_run', 'expression', self.inputs), 'invalid_request')
        self.assertEqual(self.code_of(steps.submit, 'step_test', 'network', self.inputs), 'not_found')
        self.assertEqual(self.code_of(steps.status, 'missing_run', 'expression'), 'not_found')

    def test_hpc3_folder_of_another_run_is_never_reused(self):
        self.remote_dir.mkdir(parents=True)
        (self.remote_dir / '.owner').write_text('someone-else\n')
        self.assertEqual(self.code_of(steps.submit, 'step_test', 'expression', self.inputs), 'conflict')
        self.assertFalse((self.remote_dir / 'work').exists())

    def test_run_folder_is_workroot_slash_run_id_and_old_runs_keep_their_folder(self):
        self.assertEqual(steps.submit('step_test', 'expression', self.inputs)['remote_dir'], str(self.remote_dir))
        legacy = self.hpc / 'ws/work/runs/old_run'
        st.configure_signet('old_run', cohort='TCGA')
        (self.project / 'runs/old_run/steps').mkdir()
        (self.project / 'runs/old_run/steps/remote.owner').write_text(json.dumps({'remote_dir': str(legacy), 'token': 'tok'}))
        legacy.mkdir(parents=True)
        (legacy / '.owner').write_text('tok\n')
        self.assertEqual(steps.submit('old_run', 'expression', self.inputs)['remote_dir'], str(legacy))
        self.assertTrue((legacy / 'steps/expression.sbatch').is_file())
        self.assertFalse((self.hpc / 'ws/work/old_run').exists())

    def test_run_ids_used_by_other_hpc3_folders_are_refused(self):
        for run_id in ('cis', 'network', 'runs'):
            st.configure_signet(run_id, cohort='TCGA')
            self.assertEqual(self.code_of(steps.submit, run_id, 'expression', self.inputs), 'invalid_request', run_id)
        self.assertEqual(self.calls, [])

    def test_not_connected_is_not_ready(self):
        with patch.object(ssh_transport, 'available', return_value=False):
            self.assertEqual(self.code_of(steps.submit, 'step_test', 'expression', self.inputs), 'not_ready')

    def test_status_follows_slurm_and_caches_for_15_seconds(self):
        steps.submit('step_test', 'expression', self.inputs)
        self.slurm(squeue='PENDING')
        self.assertEqual(steps.status('step_test', 'expression')['state'], 'pending')
        count = len(self.calls)
        self.slurm(squeue='RUNNING')
        self.assertEqual(steps.status('step_test', 'expression')['state'], 'pending')
        self.assertEqual(len(self.calls), count)
        self.assertEqual(steps.status('step_test', 'expression', refresh=True)['state'], 'running')

    def test_completed_job_with_outputs_is_validated_and_downloaded(self):
        steps.submit('step_test', 'expression', self.inputs)
        self.finish_job()
        record = steps.status('step_test', 'expression', refresh=True)
        self.assertEqual(record['state'], 'completed')
        self.assertEqual([h['state'] for h in record['history']], ['submitting', 'submitted', 'validating', 'completed'])
        for relative in OUTPUTS:
            self.assertEqual((self.root / 'work' / relative).read_text(), 'data\n')
        count = len(self.calls)
        self.assertEqual(steps.status('step_test', 'expression', refresh=True)['state'], 'completed')
        self.assertEqual(len(self.calls), count)

    def test_exit_zero_is_not_enough(self):
        cases = [({'outputs': OUTPUTS[:2]}, 'missing_outputs', list(OUTPUTS[2:])),
                 ({'err': 'Error in fread(x): oops\nExecution halted\n'}, 'failure_hints',
                  ['Error in fread(x): oops', 'Execution halted']),
                 ({'exit_code': '1'}, 'exit_code', '1')]
        for index, (job, key, expected) in enumerate(cases):
            run_id = f'fail_{index}'
            st.configure_signet(run_id)
            self.remote_dir = self.hpc / 'ws/work' / run_id
            steps.submit(run_id, 'expression', self.inputs)
            self.finish_job(**job)
            record = steps.status(run_id, 'expression', refresh=True)
            self.assertEqual(record['state'], 'failed', job)
            self.assertEqual(record[key], expected)
            self.assertFalse((self.project / 'runs' / run_id / 'work/res/rest/signet_gexp').exists())

    def test_slurm_failure_and_cancellation_states(self):
        steps.submit('step_test', 'expression', self.inputs)
        self.slurm(squeue='', sacct='OUT_OF_MEMORY')
        record = steps.status('step_test', 'expression', refresh=True)
        self.assertEqual((record['state'], record['slurm_state']), ('failed', 'OUT_OF_MEMORY'))
        st.configure_signet('cancel_run')
        steps.submit('cancel_run', 'expression', self.inputs)
        self.slurm(sacct='CANCELLED by 1000')
        self.assertEqual(steps.status('cancel_run', 'expression', refresh=True)['state'], 'cancelled')

    def test_cancel_checks_job_name_and_finished_steps_cannot_be_cancelled(self):
        steps.submit('step_test', 'expression', self.inputs)
        self.slurm(squeue='RUNNING', name='signet-expression-step_test')
        self.assertEqual(steps.cancel('step_test', 'expression')['state'], 'cancelled')
        self.assertEqual((self.fake / 'scancel').read_text().split(), ['12345'])
        self.assertEqual(self.code_of(steps.cancel, 'step_test', 'expression'), 'conflict')
        st.configure_signet('other_job')
        self.remote_dir = self.hpc / 'ws/work/other_job'
        steps.submit('other_job', 'expression', self.inputs)
        (self.fake / 'scancel').unlink()
        self.slurm(name='someone-elses-job', squeue='', sacct='RUNNING')
        self.assertEqual(steps.cancel('other_job', 'expression')['state'], 'running')
        self.assertFalse((self.fake / 'scancel').exists())

    def test_lost_connection_during_sbatch_becomes_unknown_then_recovers_job(self):
        self.lose_connection_on = 'sbatch --parsable'
        record = steps.submit('step_test', 'expression', self.inputs)
        self.assertEqual(record['state'], 'unknown')
        self.assertNotIn('job_id', record)
        self.assertEqual(self.code_of(steps.submit, 'step_test', 'expression', self.inputs), 'conflict')
        # The job did reach Slurm before the connection dropped.
        (self.remote_dir / 'steps/expression.job').write_text('777\n')
        self.lose_connection_on = None
        self.slurm(squeue='RUNNING')
        record = steps.status('step_test', 'expression', refresh=True)
        self.assertEqual((record['state'], record['job_id']), ('running', '777'))

    def test_simultaneous_status_checks_download_results_once(self):
        steps.submit('step_test', 'expression', self.inputs)
        self.finish_job()
        states = []
        threads = [threading.Thread(target=lambda: states.append(
            steps.status('step_test', 'expression', refresh=True)['state'])) for _ in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(states, ['completed'] * 3)
        self.assertEqual(sum('tar czf' in call for call in self.calls), 1)
        self.assertEqual(steps.run_steps('step_test'), {'expression': 'completed'})

    def test_unknown_submission_survives_scheduler_outage_and_recovers(self):
        for commands in (('squeue',), ('sacct',), ('squeue', 'sacct')):
            with self.subTest(commands=commands):
                run_id = 'outage_' + '_'.join(commands)
                st.configure_signet(run_id)
                self.remote_dir = self.hpc / 'ws/work' / run_id
                self.lose_connection_on = 'sbatch --parsable'
                steps.submit(run_id, 'expression', self.inputs)
                self.lose_connection_on = None
                self.slurm(queued_id='', sacct_id='', squeue='', sacct='')
                for name in commands:
                    (self.fake / 'bin' / name).write_text('#!/bin/bash\nexit 1\n')
                try:
                    record = steps.status(run_id, 'expression', refresh=True)
                    self.assertEqual(record['state'], 'unknown')
                    self.assertEqual(self.code_of(steps.submit, run_id, 'expression', self.inputs), 'conflict')
                    self.assertEqual(self.code_of(steps.update_settings, run_id, {'restrict.tcga': 1}), 'conflict')
                finally:
                    for name in commands:
                        (self.fake / 'bin' / name).write_text('#!/bin/bash\n' + FAKE_SLURM[name] + '\n')
                self.slurm(queued_id='888', squeue='RUNNING')
                record = steps.status(run_id, 'expression', refresh=True)
                self.assertEqual((record['state'], record['job_id']), ('running', '888'))
                self.finish_job()
                self.assertEqual(steps.status(run_id, 'expression', refresh=True)['state'], 'completed')

    def test_results_already_downloaded_complete_instead_of_staying_validating(self):
        steps.submit('step_test', 'expression', self.inputs)
        self.finish_job()
        for relative in OUTPUTS:   # as if an earlier check had already copied them here
            (self.root / 'work' / relative).write_text('data\n')
        record = steps.status('step_test', 'expression', refresh=True)
        self.assertEqual(record['state'], 'completed')
        self.assertEqual(sorted(record['outputs']), sorted('work/' + path for path in OUTPUTS))

    def test_sbatch_reply_with_cluster_name_keeps_only_the_job_id(self):
        (self.fake / 'sbatch_reply').write_text('4242;hpc3\n')
        record = steps.submit('step_test', 'expression', self.inputs)
        self.assertEqual((record['state'], record['job_id']), ('submitted', '4242'))
        self.assertEqual((self.remote_dir / 'steps/expression.job').read_text(), '4242\n')

    def test_unknown_submit_waits_for_delayed_scheduler_records(self):
        self.lose_connection_on = 'sbatch --parsable'
        steps.submit('step_test', 'expression', self.inputs)
        self.lose_connection_on = None
        self.slurm(queued_id='888', squeue='PENDING')
        record = steps.status('step_test', 'expression', refresh=True)
        self.assertEqual((record['state'], record['job_id']), ('pending', '888'))
        st.configure_signet('never_queued')
        self.remote_dir = self.hpc / 'ws/work/never_queued'
        self.lose_connection_on = 'sbatch --parsable'
        steps.submit('never_queued', 'expression', self.inputs)
        self.lose_connection_on = None
        self.slurm(queued_id='', squeue='', sacct='', sacct_id='')
        record = steps.status('never_queued', 'expression', refresh=True)
        self.assertEqual(record['state'], 'unknown')
        self.assertNotIn('finished_at', record)
        self.assertEqual(self.code_of(steps.update_settings, 'never_queued', {'restrict.tcga': 3}), 'conflict')
        self.slurm(sacct_id='999', sacct='RUNNING')
        record = steps.status('never_queued', 'expression', refresh=True)
        self.assertEqual((record['state'], record['job_id']), ('running', '999'))

    def test_settings_whitelist_and_lock_while_active(self):
        self.assertEqual(steps.update_settings('step_test', {'restrict.tcga': 1})['restrict.tcga'], '1')
        self.assertEqual(steps.update_settings('step_test', {'restrict.tcga': 'no'})['restrict.tcga'], 'no')
        for bad in ({'restrict.tcga': 23}, {'restrict.tcga': '1; rm'}, {'gexp.file': '/x'}, {'forcerm': 'T'}, {}):
            self.assertEqual(self.code_of(steps.update_settings, 'step_test', bad), 'invalid_request', bad)
        steps.submit('step_test', 'expression', self.inputs)
        self.assertEqual(self.code_of(steps.update_settings, 'step_test', {'restrict.tcga': 2}), 'conflict')

    def test_submission_waits_for_settings_write_and_uploads_the_accepted_settings(self):
        config = self.root / 'work/config.ini'
        writing, release, submitting, submitted = (threading.Event() for _ in range(4))
        write_text = Path.write_text

        def blocked_write(path, data, *args, **kwargs):
            if path == config and 'restrict.tcga = 1\n' in data and not release.is_set():
                writing.set()
                if not release.wait(10):
                    raise TimeoutError('Settings write was not released.')
            return write_text(path, data, *args, **kwargs)

        def submit():
            submitting.set()
            try:
                return steps.submit('step_test', 'expression', self.inputs)
            finally:
                submitted.set()

        with patch.object(Path, 'write_text', new=blocked_write), ThreadPoolExecutor(max_workers=2) as pool:
            settings = pool.submit(steps.update_settings, 'step_test', {'restrict.tcga': 1})
            try:
                self.assertTrue(writing.wait(5))
                submission = pool.submit(submit)
                self.assertTrue(submitting.wait(5))
                self.assertFalse(submitted.wait(0.5), 'Submission raced ahead of the accepted settings write.')
            finally:
                release.set()
            self.assertEqual(settings.result(timeout=5)['restrict.tcga'], '1')
            self.assertEqual(submission.result(timeout=5)['state'], 'submitted')
        remote = (self.remote_dir / 'work/config.ini').read_text()
        self.assertIn('restrict.tcga = 1\n', remote)
        self.assertEqual(st.get_signet_settings('step_test')['settings']['restrict.tcga'], '1')

    def test_settings_update_during_submission_is_rejected_without_changing_the_job(self):
        uploading, release = threading.Event(), threading.Event()

        def blocked_remote(command, **kwargs):
            if 'tar xzf' in command:
                uploading.set()
                if not release.wait(10):
                    raise TimeoutError('Upload was not released.')
            return self.remote(command, **kwargs)

        with patch.object(ssh_transport, 'remote', side_effect=blocked_remote), ThreadPoolExecutor(max_workers=2) as pool:
            submission = pool.submit(steps.submit, 'step_test', 'expression', self.inputs)
            try:
                self.assertTrue(uploading.wait(5))
                settings = pool.submit(steps.update_settings, 'step_test', {'restrict.tcga': 1})
            finally:
                release.set()
            self.assertEqual(submission.result(timeout=5)['state'], 'submitted')
            with self.assertRaises(steps.StepError) as caught:
                settings.result(timeout=5)
            self.assertEqual(caught.exception.code, 'conflict')
        self.assertEqual(st.get_signet_settings('step_test')['settings']['restrict.tcga'], 'no')
        self.assertIn('restrict.tcga = no\n', (self.remote_dir / 'work/config.ini').read_text())

    # ---------- genotype (signet -g) ----------

    def genotype_inputs(self, chromosomes=(1,)):
        """Files laid out like refdata/prepared/example after the imputation-reference conversion."""
        prepared = self.hpc / 'ws/refdata/prepared/example'
        for folder in ('ref', 'gmap'):
            (prepared / folder).mkdir(parents=True, exist_ok=True)
        for n in chromosomes:
            (prepared / f'ref/chr{n}.gen').write_text('1 rs1 100 A G 1 0 0\n')
            (prepared / f'gmap/chr{n}.map').write_text('position COMBINED_rate(cM/Mb) Genetic_Map(cM)\n')
        (prepared / 'study.ped').write_text('S1 S1 0 0 0 -9 A G\n')
        (prepared / 'study.map').write_text('1\trs1\t0\t100\n')
        return {'ped.file': str(prepared / 'study.ped'), 'map.file': str(prepared / 'study.map'),
                'ref': str(prepared / 'ref/chr'), 'gmap': str(prepared / 'gmap/chr')}

    def test_catalog_describes_genotype_prefix_inputs_and_settings(self):
        step = next(s for s in steps.catalog()['steps'] if s['name'] == 'genotype')
        self.assertEqual((step['flag'], step['cohort']), ('-g', 'TCGA'))
        self.assertEqual(step['inputs'], ['ped.file', 'map.file', 'ref', 'gmap'])
        self.assertEqual(step['prefix_inputs'], {'ref': '.gen', 'gmap': '.map'})
        self.assertEqual(step['required_outputs'], ['res/resg/signet_Geno', 'res/resg/signet_Genotype.sampleID'])

    def test_genotype_on_one_chromosome_checks_its_files_and_queues_signet_g(self):
        inputs = self.genotype_inputs()
        steps.update_settings('step_test', {'restrict.tcga.geno': 1})
        record = steps.submit('step_test', 'genotype', inputs)
        self.assertEqual(record['state'], 'submitted')
        args = (self.fake / 'sbatch_args').read_text().split()
        self.assertEqual(args[2:5], ['--cpus-per-task=8', '--mem=32G', '--time=04:00:00'])
        text = (self.remote_dir / 'steps/genotype.sbatch').read_text()
        self.assertIn('bash ./signet -g < /dev/null', text)
        self.assertIn(f'{self.hpc}/ws/refdata:{self.hpc}/ws/refdata:ro', text)
        config = (self.remote_dir / 'work/config.ini').read_text()
        self.assertIn(f'ref = {inputs["ref"]}', config)       # the prefix, as SIGNET expects it
        self.assertIn(f'gmap = {inputs["gmap"]}', config)
        self.assertIn('restrict.tcga.geno = 1', config)
        self.assertIn(f'resg.tcga = {self.remote_dir}/work/res/resg/signet', config)

    def test_genotype_on_all_chromosomes_needs_every_chromosome_file(self):
        inputs = self.genotype_inputs(chromosomes=(1,))
        with self.assertRaises(steps.StepError) as caught:
            steps.submit('step_test', 'genotype', inputs)
        self.assertEqual(caught.exception.code, 'invalid_request')
        self.assertIn('chr2.gen', str(caught.exception))
        self.assertIn('restrict.tcga.geno', str(caught.exception))
        self.assertFalse((self.fake / 'sbatch_args').exists())
        self.genotype_inputs(chromosomes=range(1, 23))
        self.assertEqual(steps.submit('step_test', 'genotype', inputs)['state'], 'submitted')

    def test_genotype_prefix_reached_through_a_link_is_refused(self):
        inputs = self.genotype_inputs()
        steps.update_settings('step_test', {'restrict.tcga.geno': 1})
        gen = Path(inputs['ref'] + '1.gen')
        gen.unlink()
        gen.symlink_to(self.hpc / 'signet.sif')
        self.assertEqual(self.code_of(steps.submit, 'step_test', 'genotype', inputs), 'invalid_request')
        self.assertFalse((self.fake / 'sbatch_args').exists())

    def test_genotype_log_lines_from_signet_scripts_mean_failure(self):
        inputs = self.genotype_inputs()
        steps.update_settings('step_test', {'restrict.tcga.geno': 1})
        steps.submit('step_test', 'genotype', inputs)
        for relative in steps.STEPS['genotype'].required:
            path = self.remote_dir / 'work' / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('data\n')
        (self.remote_dir / 'steps/genotype.out').write_text(
            'Warning: Some of the jobs are incomplete! There could be a memeory allocation issue.\n')
        (self.remote_dir / 'steps/genotype.done').write_text('0 2026-11-08T10:00:00\n')
        self.slurm(squeue='', sacct='COMPLETED')
        record = steps.status('step_test', 'genotype', refresh=True)
        self.assertEqual(record['state'], 'failed')
        self.assertIn('Some of the jobs are incomplete', record['failure_hints'][0])

    def test_genotype_completed_downloads_resg(self):
        steps.update_settings('step_test', {'restrict.tcga.geno': 1})
        steps.submit('step_test', 'genotype', self.genotype_inputs())
        for relative in steps.STEPS['genotype'].required:
            path = self.remote_dir / 'work' / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('data\n')
        (self.remote_dir / 'steps/genotype.done').write_text('0 2026-11-08T10:00:00\n')
        self.slurm(squeue='', sacct='COMPLETED')
        self.assertEqual(steps.status('step_test', 'genotype', refresh=True)['state'], 'completed')
        self.assertEqual((self.root / 'work/res/resg/signet_Geno').read_text(), 'data\n')

    def test_genotype_settings_rules(self):
        values = {'restrict.tcga.geno': 1, 'mind': 0.05, 'geno': 0, 'hwe': 0.0001, 'int': 3000000}
        settings = steps.update_settings('step_test', values)
        self.assertEqual([settings[k] for k in values], ['1', '0.05', '0', '0.0001', '3000000'])
        for bad in ({'mind': 1.5}, {'hwe': '0.01'}, {'geno': True}, {'int': 0}, {'int': 2.5},
                    {'restrict.tcga.geno': 23}):
            self.assertEqual(self.code_of(steps.update_settings, 'step_test', bad), 'invalid_request', bad)

    def test_read_log_returns_last_lines_with_limits(self):
        steps.submit('step_test', 'expression', self.inputs)
        (self.remote_dir / 'steps/expression.out').write_text(''.join(f'line {i}\n' for i in range(300)))
        log = steps.read_log('step_test', 'expression', 'out', 3)
        self.assertEqual(log, {'lines': ['line 297', 'line 298', 'line 299'], 'truncated': True})
        self.assertEqual(steps.read_log('step_test', 'expression', 'err', 5), {'lines': [], 'truncated': False})
        for stream, lines in (('both', 5), ('out', 0), ('out', 201), ('out', True)):
            self.assertEqual(self.code_of(steps.read_log, 'step_test', 'expression', stream, lines), 'invalid_request')


if __name__ == '__main__':
    unittest.main()
