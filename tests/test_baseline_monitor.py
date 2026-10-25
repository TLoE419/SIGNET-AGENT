"""HPC3 baseline observers (Spec 01) against scripted Slurm output; no scheduler or SIGNET needed."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import datetime

BASELINE = Path(__file__).resolve().parents[1] / 'hpc/baseline'
sys.path.insert(0, str(BASELINE / 'scripts'))
import fixture_io  # noqa: E402
import observe  # noqa: E402
import observe_network  # noqa: E402
import outputs  # noqa: E402
import sanitize_fixture  # noqa: E402
import slurm_parse as sp  # noqa: E402

SQUEUE_PENDING = '4242|signet_t|PENDING|Priority|0:00|2:00:00|4|16G|(Priority)|free|lab_acct\n'
SQUEUE_RUNNING = '4242|signet_t|RUNNING|None|1:02|2:00:00|4|16G|hpc3-14-07|free|lab_acct\n'
SSTAT = '4242.batch|812344K|00:00:58\n'


def sacct(state, exit_code='0:0'):
    return ('4242|signet_t|free|lab_acct|%s|%s|2026-10-25T14:00:00|2026-10-25T14:00:30|'
            '2026-10-25T14:05:00|00:04:30|02:00:00|4|4|16G||hpc3-14-07\n'
            '4242.batch|batch||lab_acct|%s|%s|2026-10-25T14:00:30|2026-10-25T14:00:30|'
            '2026-10-25T14:05:00|00:04:30||4|4||903212K|hpc3-14-07\n') % (state, exit_code, state, exit_code)


class FakeSlurm:
    """Answers each Slurm binary from its own queue of (returncode, stdout, stderr)."""

    def __init__(self, **answers):
        self.answers = {name: list(values) for name, values in answers.items()}
        self.calls = []

    def __call__(self, argv, timeout=60):
        self.calls.append(argv)
        queue = self.answers.get(argv[0], [])
        return queue.pop(0) if len(queue) > 1 else (queue[0] if queue else (0, '', ''))


class ParseTest(unittest.TestCase):
    def test_squeue_and_sacct_rows_keep_every_field_and_reject_wrong_counts(self):
        row = sp.parse_squeue(SQUEUE_RUNNING)[0]
        self.assertEqual((row['job_id'], row['state'], row['nodes'], row['account']),
                         ('4242', 'RUNNING', 'hpc3-14-07', 'lab_acct'))
        rows = sp.parse_sacct(sacct('COMPLETED'))
        self.assertEqual([r['JobID'] for r in rows], ['4242', '4242.batch'])
        self.assertEqual(sp.primary_row(rows, 4242)['State'], 'COMPLETED')
        with self.assertRaises(ValueError):
            sp.parse_squeue('4242|signet_t|RUNNING\n')

    def test_state_suffixes_reduce_to_terminal_names(self):
        self.assertEqual(sp.base_state('CANCELLED by 31337'), 'CANCELLED')
        self.assertTrue(sp.is_terminal('CANCELLED by 31337'))
        self.assertTrue(sp.is_terminal('OUT_OF_MEMORY'))
        self.assertFalse(sp.is_terminal('RUNNING+'))
        self.assertFalse(sp.is_terminal(''))

    def test_commands_use_parsable_explicit_formats(self):
        self.assertEqual(sp.squeue_command(job_id=1)[:3], ['squeue', '-j', '1'])
        self.assertIn('--parsable2', sp.sacct_command(job_id=1))
        self.assertEqual(sp.sstat_command(7)[2], '7.batch')
        self.assertEqual(sp.sacct_command(user='u', start='2026-10-25T00:00:00')[1:5],
                         ['-S', '2026-10-25T00:00:00', '-u', 'u'])


class ObserveTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.fixture = Path(self.temp.name)
        (self.fixture / 'stdout.log').write_text(''.join('line %d\n' % i for i in range(30)))

    def tearDown(self):
        self.temp.cleanup()

    def run_observer(self, slurm, **kwargs):
        sleeps = []
        with patch.object(fixture_io, 'run_command', slurm):
            status = observe.observe('4242', self.fixture, interval=30, collect=False,
                                     sleep=sleeps.append, **kwargs)
        lines = (self.fixture / 'snapshots.jsonl').read_text().splitlines()
        return status, [json.loads(line) for line in lines], sleeps

    def test_lifecycle_switches_to_sacct_and_waits_for_a_stable_terminal_state(self):
        slurm = FakeSlurm(
            squeue=[(0, SQUEUE_PENDING, ''), (0, SQUEUE_RUNNING, ''),
                    (1, '', 'slurm_load_jobs error: Invalid job id specified')],
            sstat=[(0, SSTAT, '')],
            sacct=[(0, '', ''), (0, sacct('RUNNING'), ''), (0, sacct('COMPLETED'), '')])
        status, records, sleeps = self.run_observer(slurm)
        self.assertEqual(status['status'], 'terminal')
        self.assertEqual(status['final_state'], 'COMPLETED')
        self.assertEqual([r['state'] for r in records],
                         ['PENDING', 'RUNNING', '', 'RUNNING', 'COMPLETED', 'COMPLETED'])
        self.assertEqual([r['source'] for r in records[:2]], ['squeue', 'squeue'])
        self.assertEqual(records[0]['raw'], SQUEUE_PENDING)
        self.assertEqual(records[1]['sstat']['parsed'][0]['MaxRSS'], '812344K')
        self.assertNotIn('sstat', records[0])
        self.assertEqual(records[0]['log_tail'][-1], 'line 29')
        self.assertEqual(len(records[0]['log_tail']), 20)
        self.assertTrue(all(seconds == 30 for seconds in sleeps))
        self.assertEqual(len(sleeps), len(records) - 1)
        self.assertEqual((self.fixture / 'sacct_final.txt').read_text(), sacct('COMPLETED'))
        final = json.loads((self.fixture / 'sacct_final.json').read_text())
        self.assertEqual([r['JobID'] for r in final], ['4242', '4242.batch'])

    def test_sstat_and_parse_failures_are_recorded_instead_of_crashing(self):
        slurm = FakeSlurm(
            squeue=[(0, SQUEUE_RUNNING, ''), (0, '4242|garbled\n', ''), (0, '', '')],
            sstat=[(1, '', 'sstat: error: no steps running')],
            sacct=[(0, sacct('FAILED', '1:0'), '')])
        status, records, _ = self.run_observer(slurm)
        self.assertEqual(status['final_state'], 'FAILED')
        self.assertIn('no steps running', records[0]['sstat']['error'])
        self.assertIn('Expected 11 fields', records[1]['error'])
        self.assertEqual(records[1]['raw'], '4242|garbled\n')

    def test_missing_scheduler_binary_and_deadline_end_the_observer_cleanly(self):
        clock = iter([0, 10, 99999]).__next__
        slurm = FakeSlurm(squeue=[(None, '', 'FileNotFoundError: squeue')],
                          sacct=[(None, '', 'FileNotFoundError: sacct')])
        status, records, _ = self.run_observer(slurm, max_hours=1, clock=clock)
        self.assertEqual(status['status'], 'observer_deadline')
        self.assertIn('FileNotFoundError', records[0]['error'])
        self.assertTrue((self.fixture / 'observer_status.json').is_file())

    def test_polling_faster_than_fifteen_seconds_is_refused(self):
        with self.assertRaises(ValueError):
            observe.observe('4242', self.fixture, interval=14, sleep=lambda _: None)
        with self.assertRaises(SystemExit), patch('sys.stderr'):
            observe.main(['--job-id', '4242', '--fixture-dir', str(self.fixture), '--interval', '5'])
        with self.assertRaises(SystemExit), patch('sys.stderr'):
            observe.main(['--job-id', '42;rm', '--fixture-dir', str(self.fixture)])

    def test_missing_log_is_reported_as_empty(self):
        self.assertEqual(fixture_io.log_state(self.fixture / 'absent.log'),
                         {'log_tail': [], 'log_mtime': None, 'log_size': None})


class NetworkObserverTest(unittest.TestCase):
    START = datetime.datetime(2026, 10, 25, 14, 0, 0)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.fixture, self.signet = root / 'fixture', root / 'SIGNET'
        self.fixture.mkdir()
        for stage, jobs in ((1, ('501', '502')), (2, ('601',))):
            folder = self.signet / 'tmp/tmpn' / ('stage%d' % stage)
            folder.mkdir(parents=True)
            (folder / ('job%d_command' % stage)).write_text(
                ''.join('sbatch -W sub%d.sh &\n' % i for i in range(1, len(jobs) + 1)))
            (folder / ('submit%d_log' % stage)).write_text(
                ''.join('Submitted batch job %s\n' % job for job in jobs))
            for i in range(1, len(jobs) + 1):
                (folder / ('sub%d.sh' % i)).write_text('#!/bin/bash\n')

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def row(job, name, state, submit='2026-10-25T14:10:00', rss=''):
        return '|'.join([job, name, 'free', 'personal', state, '0:0', submit, submit, submit,
                         '00:01:00', '00:30:00', '4', '4', '', rss, 'hpc3-1-1'])

    def test_children_are_tagged_by_stage_from_submit_logs_and_filtered_by_start(self):
        rows = sp.parse_sacct('\n'.join([
            self.row('400', 'earlier', 'COMPLETED', submit='2026-10-25T13:00:00'),
            self.row('501', 'sub1.sh', 'COMPLETED'), self.row('501.batch', 'batch', 'COMPLETED', rss='2G'),
            self.row('502', 'sub2.sh', 'RUNNING'), self.row('601', 'sub1.sh', 'PENDING'),
            self.row('700', 'parent', 'RUNNING')]))
        stages = observe_network.stage_files(self.signet)
        self.assertEqual(stages['1']['command_lines'], 2)
        self.assertEqual(stages['2']['sub_scripts'], ['sub1.sh'])
        found = observe_network.children(rows, self.START, stages, parent_job_id='700')
        self.assertEqual([(c['JobID'], c['JobName'], c['stage']) for c in found],
                         [('501', 'sub1.sh', 1), ('502', 'sub2.sh', 1), ('601', 'sub1.sh', 2)])
        self.assertEqual(found[0]['step_max_rss'], ['2G'])
        self.assertEqual(found[0]['Account'], 'personal')

    def test_observer_stops_after_parent_exits_and_two_quiet_polls(self):
        busy = '\n'.join([self.row('501', 'sub1.sh', 'RUNNING')])
        done = '\n'.join([self.row('501', 'sub1.sh', 'COMPLETED'), self.row('601', 'sub1.sh', 'COMPLETED')])
        slurm = FakeSlurm(squeue=[(0, '', '')], sacct=[(0, busy, ''), (0, done, ''), (0, done, '')])
        alive = iter([True, False, False]).__next__
        with patch.object(fixture_io, 'run_command', slurm):
            status = observe_network.observe(self.fixture, self.signet, self.START, parent_pid=99,
                                             user='u', sleep=lambda _: None, is_alive=lambda _: alive())
        self.assertEqual((status['status'], status['children']), ('terminal', 2))
        records = [json.loads(l) for l in (self.fixture / 'snapshots.jsonl').read_text().splitlines()]
        self.assertEqual([r['active_children'] for r in records], [['501'], [], []])
        children = json.loads((self.fixture / 'children.json').read_text())
        self.assertEqual({c['stage'] for c in children}, {1, 2})
        self.assertEqual((self.fixture / 'sacct_final.txt').read_text(), done)

    def test_observer_needs_a_way_to_know_the_parent_ended(self):
        with self.assertRaises(ValueError):
            observe_network.observe(self.fixture, self.signet, self.START, user='u')


class OutputsTest(unittest.TestCase):
    def test_snapshot_lists_res_and_tmp_only_and_diff_classifies_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'res/rest').mkdir(parents=True)
            (root / 'tmp/tmpt').mkdir(parents=True)
            (root / 'example').mkdir()
            (root / 'res/rest/old').write_text('a')
            (root / 'res/rest/gone').write_text('a')
            (root / 'example/data').write_text('ignored')
            before = outputs.snapshot(root)
            (root / 'res/rest/old').write_text('changed')
            (root / 'res/rest/gone').unlink()
            (root / 'tmp/tmpt/new').write_text('b')
            os.symlink(str(root / 'example/data'), str(root / 'res/link'))
            after = outputs.snapshot(root)
            self.assertEqual(sorted(after), ['res/rest/old', 'tmp/tmpt/new'])
            self.assertEqual(after['res/rest/old']['size'], 7)
            change = outputs.diff(before, after)
            self.assertEqual((change['new'], change['changed'], change['removed']),
                             (['tmp/tmpt/new'], ['res/rest/old'], ['res/rest/gone']))


class SanitizeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.raw = self.root / 'raw'
        self.raw.mkdir()
        (self.raw / 'meta.json').write_text(json.dumps({
            'sbatch_command': ['sbatch', '--account=zhanglab', '--output=/pub/pchen/signet-monitor/x'],
            'hostname': 'login-i15', 'signet': '/pub/pchen/SIGNET'}))
        (self.raw / 'snapshots.jsonl').write_text(
            '{"raw": "4242|signet_t|CANCELLED by 31337|hpc3-14-07,hpc3-15-[01-02]|zhanglab"}\n')
        (self.raw / 'stdout.log').write_text('pchen ran; pchenx and epchen are other words\n')
        (self.raw / 'plot.png').write_bytes(b'\x89PNG')
        self.paths = {'SIGNET_DIR': '/pub/pchen/SIGNET', 'BASELINE_DIR': '/pub/pchen/signet-monitor',
                      'HOME': '/data/homezvol0/pchen'}

    def tearDown(self):
        self.temp.cleanup()

    def test_private_values_are_replaced_and_structure_is_kept(self):
        result = sanitize_fixture.sanitize(self.raw, self.root / 'clean', 'pchen', 'zhanglab', self.paths)
        clean = self.root / 'clean'
        meta = json.loads((clean / 'meta.json').read_text())
        self.assertEqual(meta['sbatch_command'][1:], ['--account=<ACCOUNT>', '--output=<BASELINE_DIR>/x'])
        self.assertEqual((meta['hostname'], meta['signet']), ('login-node', '<SIGNET_DIR>'))
        snapshot = json.loads((clean / 'snapshots.jsonl').read_text())
        self.assertEqual(snapshot['raw'], '4242|signet_t|CANCELLED by <UID>|hpc3-node-01|<ACCOUNT>')
        self.assertEqual((clean / 'stdout.log').read_text(),
                         '<USER> ran; pchenx and epchen are other words\n')
        self.assertEqual(result['skipped_non_text'], ['plot.png'])
        self.assertFalse((clean / 'plot.png').exists())

    def test_existing_destination_is_never_overwritten(self):
        (self.root / 'clean').mkdir()
        with self.assertRaises(FileExistsError):
            sanitize_fixture.sanitize(self.raw, self.root / 'clean', 'pchen', 'zhanglab', self.paths)


class ShellTest(unittest.TestCase):
    """Run the shell entry points with fake sbatch/squeue/git/signet on PATH."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.baseline = root / 'baseline'
        shutil.copytree(str(BASELINE), str(self.baseline),
                        ignore=shutil.ignore_patterns('fixtures', 'env.sh', '__pycache__'))
        self.signet, self.bin = root / 'SIGNET', root / 'bin'
        (self.signet / 'res').mkdir(parents=True)
        self.bin.mkdir()
        (self.signet / 'config.ini').write_text('forcerm = F\n')
        self.script(self.signet / 'signet', '''
            [[ $1 == -s ]] || exit 3
            key=${2#--}
            if [[ $# -ge 3 ]]; then echo "$key=$3" >> "$(dirname "$0")/state"
            else grep "^$key=" "$(dirname "$0")/state" | tail -1 | cut -d= -f2-; fi''')
        self.script(self.bin / 'sbatch', 'echo "$@" > "$FAKE_LOG"; echo "777;hpc3"')
        self.script(self.bin / 'squeue', 'echo "${FAKE_SQUEUE:-}"')
        self.script(self.bin / 'git', 'echo bed55b3e121de0edf5fd43da683dc59850ff82d3')
        (self.baseline / 'env.sh').write_text(
            'export SIGNET_DIR=%s\nexport LAB_ACCOUNT=lab\nexport SIGNET_SIF=signet.sif\n'
            'export SIGNET_GTF=gencode.v22.gene.gtf\n' % self.signet)
        self.env = dict(os.environ, PATH='%s:%s' % (self.bin, os.environ['PATH']), USER='tester',
                        BASELINE_NO_OBSERVER='1', FAKE_LOG=str(root / 'sbatch_args'))

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def script(path, body):
        path.write_text('#!/bin/bash\n' + '\n'.join(l.strip() for l in body.strip().splitlines()) + '\n')
        path.chmod(0o755)

    def run_script(self, *argv, **env):
        return subprocess.run(['bash', str(self.baseline / 'scripts' / argv[0])] + list(argv[1:]),
                              env=dict(self.env, **env), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True, timeout=60)

    def test_submit_records_meta_snapshot_and_exact_sbatch_command(self):
        result = self.run_script('submit_step.sh', 't', 'B2', '--partition=free', '--mem=16G',
                                 SLEEP_SECONDS='5')
        self.assertEqual(result.returncode, 0, result.stderr)
        run_id = re.search(r'run_id=(\S+) job_id=777', result.stdout).group(1)
        self.assertRegex(run_id, r'^\d{8}-\d{6}_t_B2$')
        fixture = self.baseline / 'fixtures' / run_id
        meta = json.loads((fixture / 'meta.json').read_text())
        self.assertEqual((meta['job_id'], meta['step'], meta['experiment_env']), ('777', 't', {'SLEEP_SECONDS': '5'}))
        self.assertEqual(meta['signet_commit'], 'bed55b3e121de0edf5fd43da683dc59850ff82d3')
        self.assertEqual(meta['sbatch_command'][:2], ['sbatch', '--parsable'])
        self.assertEqual(meta['sbatch_command'][-1], str(self.baseline / 'templates/signet_t.sub'))
        self.assertIn('--output=%s/stdout.log' % fixture, meta['sbatch_command'])
        self.assertTrue((fixture / 'outputs_before.json').is_file())
        self.assertTrue((fixture / 'config_overrides.txt').is_file())
        self.assertIn('--mem=16G', Path(self.env['FAKE_LOG']).read_text())

    def test_submit_refuses_unsafe_options_labels_and_concurrent_signet_steps(self):
        for argv, message in ((('t', 'x', '--output=/tmp/o'), 'set by submit_step'),
                              (('t', '../x'), 'attempt_label'), (('rm', 'x'), 'unknown step')):
            result = self.run_script('submit_step.sh', *argv)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(message, result.stderr)
        busy = self.run_script('submit_step.sh', 'c', 'B4', FAKE_SQUEUE='12 signet_t')
        self.assertIn('another SIGNET step', busy.stderr)
        sleep = self.run_script('submit_step.sh', 'sleep', 'E1', FAKE_SQUEUE='12 signet_t')
        self.assertEqual(sleep.returncode, 0, sleep.stderr)
        self.assertFalse(Path(self.env['FAKE_LOG']).read_text().count('signet_t.sub'))

    def test_apply_config_sets_and_verifies_values_and_skips_missing_inputs(self):
        result = self.run_script('apply_config.sh')
        self.assertEqual(result.returncode, 0, result.stderr)
        state = (self.signet / 'state').read_text()
        self.assertIn('forcerm=T\n', state)
        self.assertIn('ped.file=example/geno/example.ped\n', state)
        self.assertIn('pmap.file=gencode.v22.gene.gtf\n', state)
        self.assertIn('interactive=F\n', state)
        self.assertIn('SKIPPED cli.file: SIGNET_CLINICAL is empty', result.stdout)
        self.assertTrue((self.signet / 'config.ini.pre-baseline').is_file())

    def test_all_shell_files_parse(self):
        for path in sorted((BASELINE / 'scripts').glob('*.sh')) + sorted((BASELINE / 'templates').iterdir()):
            with self.subTest(path=path.name):
                result = subprocess.run(['bash', '-n', str(path)], stderr=subprocess.PIPE)
                self.assertEqual(result.returncode, 0, result.stderr)


class TemplateTest(unittest.TestCase):
    def test_templates_carry_only_a_job_name_and_print_markers(self):
        for path in sorted((BASELINE / 'templates').glob('*.sub')):
            with self.subTest(path=path.name):
                text = path.read_text()
                directives = re.findall(r'^#SBATCH\s+(\S+)', text, re.M)
                self.assertEqual(len(directives), 1)
                self.assertTrue(directives[0].startswith('--job-name=signet_'))
                self.assertIn('source "$BASELINE_DIR/templates/common.sh"', text)
                self.assertIn('baseline_start', text)
                self.assertIn('baseline_end $?', text)

    def test_shell_polling_never_drops_below_fifteen_seconds(self):
        runner = (BASELINE / 'scripts/run_experiments.sh').read_text()
        self.assertIn('(( POLL >= 15 ))', runner)
        self.assertEqual(re.findall(r'sleep [0-9]', runner), [])
        self.assertEqual(fixture_io.MIN_INTERVAL, 15)


if __name__ == '__main__':
    unittest.main()
