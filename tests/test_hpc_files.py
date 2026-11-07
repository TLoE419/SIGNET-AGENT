"""Runs the real browse and select scripts in a local shell, with stand-ins for Slurm."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from agent.runtime import hpc, hpc_files, ssh_transport
from agent.tools.hpc import REVISION, check_hpc_environment

COLLAPSED = 'chr1\tHAVANA\tgene\t11869\t14409\t.\t+\t.\tgene_id "ENSG1"; transcript_type "protein_coding";\n'
FULL = '##description\nchr1\tHAVANA\tgene\t11869\t14409\t.\t+\t.\tgene_id "ENSG1"; gene_type "pseudogene";\n'


class HpcFilesTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(os.path.realpath(temporary.name))
        self.root = self.base / 'install'
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        self.sbatch_log = self.base / 'sbatch.log'
        self.tool('sbatch', f'#!/bin/sh\nprintf "%s %s\\n" "$SIGNET_SELECTED" "$*" >> "{self.sbatch_log}"\necho 99\n')
        self.tool('squeue', '#!/bin/sh\nexit 0\n')
        self.tool('runtime', '#!/bin/sh\nexit 0\n')
        self.config = {'root': str(self.root), 'source': f'{self.root}/software/{REVISION}', 'image': f'{self.root}/images/s.sif',
                       'workRoot': f'{self.root}/runs', 'executor': str(self.bin / 'runtime'), 'partition': 'lab_queue', 'revision': REVISION}
        image = Path(self.config['image'])
        image.parent.mkdir(parents=True)
        image.write_text('image')
        self.scripts = []
        # Treat the test directory as shared storage, even when CI creates it under /tmp.
        # The node-local rejection test supplies its own blocked directory.
        for patcher in (patch.object(ssh_transport, 'available', return_value=True),
                        patch.object(hpc_files, '_UNREADABLE_ON_COMPUTE', (str(self.base / 'node-local'),)),
                        patch.object(ssh_transport, 'setup_environment', side_effect=lambda: self.config),
                        patch.object(ssh_transport, 'remote', side_effect=self.run_remote)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def tool(self, name, text):
        path = self.bin / name
        path.write_text(text)
        path.chmod(0o700)

    def run_remote(self, command, input=b'', capture_output=True, timeout=None):
        self.scripts.append(input.decode())
        return subprocess.run(['bash', '-s'], input=input, capture_output=True, timeout=30,
                              env={**os.environ, 'PATH': f"{self.bin}:{os.environ['PATH']}"})

    def file(self, name, text='content\n'):
        path = self.base / 'data' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return str(path)

    def verification(self, key):
        state = self.root / '.signet-agent' / 'steps'
        identifier = (state / f'selected-{key}.check').read_text().split('\t', 1)[0]
        return state / f'selected-{key}-{identifier}'

    def finish_verification(self, path, check):
        subprocess.run(['bash', str(check.parent / 'selected.sbatch')], check=True, env={
            **os.environ, 'E': self.config['executor'], 'I': self.config['image'],
            'SIGNET_SELECTED_CHECK': str(check), 'SIGNET_SELECTED': path,
        })

    def test_listing_hides_dotfiles_and_marks_names_scripts_cannot_handle(self):
        self.file('good.gtf')
        self.file('has space.gtf')
        self.file('.hidden')
        (self.base / 'data' / 'folder').mkdir()
        result = hpc_files.list_folder(str(self.base / 'data'))
        self.assertEqual(result['status'], 'ok')
        entries = {entry['name']: entry for entry in result['entries']}
        self.assertEqual(set(entries), {'good.gtf', 'has space.gtf', 'folder'})
        self.assertEqual((entries['folder']['kind'], entries['good.gtf']['size']), ('folder', 8))
        self.assertTrue(entries['good.gtf']['supported'])
        self.assertFalse(entries['has space.gtf']['supported'])

    def test_listing_reads_no_file_contents(self):
        path = self.file('secret.txt', 'participant-1234\n')
        self.assertNotIn('participant-1234', json.dumps(hpc_files.list_folder(os.path.dirname(path))))

    def test_unsafe_paths_never_reach_hpc3(self):
        for path in ('relative/x', '/a/../b', '/a b', '/a;rm', '', None, 7):
            with self.subTest(path=path):
                self.assertEqual(hpc_files.list_folder(path)['status'], 'invalid')
                self.assertEqual(hpc_files.select('gtf', path)['status'], 'invalid')
        self.assertEqual(hpc_files.select('nonsense', '/a/b')['status'], 'invalid')
        self.assertEqual(self.scripts, [])

    def test_missing_and_folder_paths_are_explained(self):
        self.assertEqual(hpc_files.list_folder(str(self.base / 'nope'))['status'], 'failed')
        path = self.file('x.gtf', COLLAPSED)
        result = hpc_files.list_folder(path)
        self.assertEqual((result['status'], result['kind'], result['path']), ('ok', 'file', path))
        self.assertEqual(hpc_files.select('gtf', os.path.dirname(path))['status'], 'invalid')

    def test_shortcuts_list_only_lab_spaces_of_the_account(self):
        dfs = self.base / 'dfs7'
        crsp = self.base / 'crsp'
        for folder in (dfs / 'mylab', dfs / 'pub', crsp / 'lab' / 'pi', crsp / 'home'):
            folder.mkdir(parents=True)
        script = hpc._prelude('/x') + hpc_files._shortcuts_script(str(self.base / 'dfs[0-9]*'), str(crsp))
        output = self.run_remote('bash -s', script.encode()).stdout.decode()
        line = next(item for item in output.splitlines() if item.startswith('@@result'))
        labels = {place['label'] for place in json.loads(line.split('\t', 1)[1])['shortcuts']}
        self.assertIn('Home', labels)
        self.assertIn('Lab: mylab', labels)
        self.assertIn('CRSP lab: pi', labels)
        self.assertFalse(any('pub' in label and label.startswith('Lab') for label in labels))

    def test_format_checks_reject_the_wrong_file_and_record_nothing(self):
        cases = {'gtf': [FULL, 'not a table\n'], 'clinical': ['id\tname\n', 'submitter_id\trace\r\nA\tB\r\n'],
                 'ref': ['hello world\n'], 'gmap': ['a b c d\n']}
        for key, texts in cases.items():
            for text in texts:
                with self.subTest(key=key, text=text):
                    self.assertEqual(hpc_files.select(key, self.file(key + '.txt', text))['status'], 'invalid')
        self.assertFalse((self.root / 'refdata' / 'selected.tsv').exists())
        self.assertIn('not collapsed', hpc_files.select('gtf', self.file('full.gtf', FULL))['error'])

    def test_format_checks_accept_each_expected_format(self):
        valid = {'gtf': COLLAPSED, 'clinical': 'id\tsubmitter_id\trace\nx\tTCGA-1\twhite\n',
                 'ref': '##fileformat=VCFv4.2\n', 'gmap': 'pos chr cM\n1 1 0.1\n'}
        for key, text in valid.items():
            with self.subTest(key=key):
                self.assertEqual(hpc_files.select(key, self.file(key + '.txt', text))['status'], 'ok')
        self.assertEqual(set(hpc_files.selected()['selected']), set(valid))

    def test_gzip_vcf_is_accepted_and_gzip_gtf_is_refused(self):
        import gzip
        vcf = self.base / 'data' / 'r.vcf.gz'
        vcf.parent.mkdir(exist_ok=True)
        with gzip.open(vcf, 'wt') as stream:
            stream.write('##fileformat=VCFv4.2\n')
        self.assertEqual(hpc_files.select('ref', str(vcf))['status'], 'ok')
        gtf = self.base / 'data' / 'g.gtf.gz'
        with gzip.open(gtf, 'wt') as stream:
            stream.write(COLLAPSED)
        self.assertIn('uncompressed', hpc_files.select('gtf', str(gtf))['error'])

    def test_selection_stores_the_real_path_and_starts_a_compute_check(self):
        real = self.file('c.gtf', COLLAPSED)
        link = self.base / 'data' / 'link.gtf'
        link.symlink_to(real)
        result = hpc_files.select('gtf', str(link))
        self.assertEqual((result['status'], result['path'], result['access_check_started']), ('ok', real, True))
        self.assertEqual((self.root / 'refdata' / 'selected.tsv').read_text(), f'gtf\t{real}\n')
        submitted = self.sbatch_log.read_text()
        self.assertIn(real, submitted)
        self.assertIn(str(self.verification('gtf') / 'slurm.log'), submitted)
        self.assertIn('--partition=lab_queue', submitted)

    def test_a_link_into_an_unsupported_name_is_refused(self):
        real = self.file('has space.gtf', COLLAPSED)
        link = self.base / 'data' / 'ok.gtf'
        link.symlink_to(real)
        self.assertEqual(hpc_files.select('gtf', str(link))['status'], 'invalid')

    def test_locations_compute_nodes_cannot_read_are_refused(self):
        self.tool('realpath-unused', '')
        with patch.object(hpc_files, '_UNREADABLE_ON_COMPUTE', (str(self.base / 'data'),)):
            result = hpc_files.select('gtf', self.file('x.gtf', COLLAPSED))
        self.assertIn('Compute nodes', result['error'])

    def test_compute_check_reports_failure_for_an_unreadable_file(self):
        path = self.file('c.gtf', COLLAPSED)
        hpc_files.select('gtf', path)
        check = self.verification('gtf')
        self.finish_verification(path, check)
        self.assertEqual(self.check()['reference_gtf']['status'], 'ok')
        self.finish_verification(str(self.base / 'gone'), check)
        self.assertEqual(self.check()['reference_gtf']['status'], 'problem')

    def test_compute_check_reads_through_the_container_with_a_read_only_bind(self):
        path = self.file('c.gtf', COLLAPSED)
        hpc_files.select('gtf', path)
        record = self.base / 'exec.log'
        self.tool('runtime', f'#!/bin/sh\necho "$*" > "{record}"\nexit 0\n')
        self.finish_verification(path, self.verification('gtf'))
        folder = os.path.dirname(path)
        self.assertIn(f'--bind {folder}:{folder}:ro', record.read_text())
        self.assertEqual(self.check()['reference_gtf']['status'], 'ok')

    def check(self):
        result = check_hpc_environment()
        self.assertEqual(result['status'], 'ok')
        return {item['item']: item for item in result['checks']}

    def test_check_uses_the_selected_file_without_revealing_its_path(self):
        path = self.file('private-study-name.gtf', COLLAPSED)
        hpc_files.select('gtf', path)
        item = self.check()['reference_gtf']
        self.assertEqual(item['status'], 'problem')
        verification = self.verification('gtf')
        self.finish_verification(path, verification)
        item = self.check()['reference_gtf']
        self.assertEqual(item['status'], 'ok')
        self.assertIn('Selected file', item['detail'])
        self.assertNotIn('private-study-name', json.dumps(check_hpc_environment()))
        self.tool('runtime', '#!/bin/sh\nexit 1\n')
        self.finish_verification(path, verification)
        self.assertEqual(self.check()['reference_gtf']['status'], 'problem')
        Path(path).unlink()
        self.assertIn('missing', self.check()['reference_gtf']['detail'])

    def test_previous_job_cannot_verify_the_new_selection(self):
        first = self.file('first.gtf', COLLAPSED)
        second = self.file('second.gtf', COLLAPSED)
        hpc_files.select('gtf', first)
        previous = self.verification('gtf')
        hpc_files.select('gtf', second)
        current = self.verification('gtf')
        self.tool('squeue', '#!/bin/sh\necho PENDING\n')
        self.finish_verification(first, previous)
        self.assertEqual(self.check()['reference_gtf']['status'], 'in_progress')
        self.finish_verification(second, current)
        self.assertEqual(self.check()['reference_gtf']['status'], 'ok')

    def test_selection_requires_a_fresh_check_with_the_current_container(self):
        path = self.file('selected.gtf', COLLAPSED)
        image = Path(self.config['image'])
        image.unlink()
        self.assertFalse(hpc_files.select('gtf', path)['access_check_started'])
        self.assertIn('Install the container', self.check()['reference_gtf']['detail'])
        image.write_text('new image')
        self.assertIn('Select this file again', self.check()['reference_gtf']['detail'])
        self.assertTrue(hpc_files.select('gtf', path)['access_check_started'])
        self.finish_verification(path, self.verification('gtf'))
        self.assertEqual(self.check()['reference_gtf']['status'], 'ok')
        original = image.stat()
        image.write_text('bad image')
        os.utime(image, ns=(original.st_atime_ns, original.st_mtime_ns))
        self.assertEqual(image.stat().st_size, original.st_size)
        self.assertIn('Select this file again', self.check()['reference_gtf']['detail'])

    def test_running_compute_check_shows_in_progress(self):
        hpc_files.select('gtf', self.file('c.gtf', COLLAPSED))
        self.tool('squeue', '#!/bin/sh\necho RUNNING\n')
        self.assertEqual(self.check()['reference_gtf']['status'], 'in_progress')

    def test_selected_file_replaces_the_download_and_the_conversion_input(self):
        ref = self.file('r.vcf', '##fileformat=VCFv4.2\n')
        gmap = self.file('m.txt', 'pos chr cM\n')
        hpc_files.select('ref', ref)
        hpc_files.select('gmap', gmap)
        self.assertEqual(hpc.start_step('ref')['outcome'], 'existing')
        source = Path(self.config['source'])
        (source / 'example' / 'geno').mkdir(parents=True)
        (source / 'example' / 'geno' / 'example.ped').write_text('x')
        (source / 'example' / 'geno' / 'example.map').write_text('x')
        self.assertEqual(hpc.start_step('prepare')['outcome'], 'needs_verified_selection')
        self.finish_verification(ref, self.verification('ref'))
        self.finish_verification(gmap, self.verification('gmap'))
        self.tool('sbatch', f'#!/bin/sh\nprintf "%s %s\\n" "$SIGNET_REF" "$SIGNET_GMAP" > "{self.sbatch_log}"\necho 7\n')
        self.assertEqual(hpc.start_step('prepare')['outcome'], 'started')
        self.assertEqual(self.sbatch_log.read_text(), f'{ref} {gmap}\n')

    def test_preparation_log_does_not_expose_selected_path_from_an_old_failure(self):
        state = self.root / '.signet-agent' / 'steps'
        state.mkdir(parents=True)
        path = self.file('private-reference.vcf')
        log = state / 'prepare.log'
        summary = json.dumps({'status': 'ok', 'matched_markers': 12,
                              'scope': 'Counts only. The original study files were not changed.'})
        failure = json.dumps({'status': 'failed', 'error': f'File missing: {path}'})
        log.write_text(f'{summary}\n{failure}\n')
        result = hpc.read_log('prepare')
        self.assertNotIn(path, json.dumps(result))
        self.assertIn('did not report success', result['lines'][0])
        log.write_text(summary + '\n')
        self.assertEqual(hpc.read_log('prepare')['lines'], [summary])

    def test_changing_ref_retires_the_old_conversion_and_keeps_it(self):
        out = self.root / hpc.PREPARED
        out.mkdir(parents=True)
        (out / 'summary.json').write_text('{}')
        hpc_files.select('ref', self.file('r.vcf', '##fileformat=VCFv4.2\n'))
        self.assertFalse(out.exists())
        retired = [item for item in out.parent.iterdir() if item.name.startswith('example.replaced-')]
        self.assertEqual(len(retired), 1)
        self.assertTrue((retired[0] / 'summary.json').exists())

    def test_gtf_selection_leaves_the_conversion_alone(self):
        out = self.root / hpc.PREPARED
        out.mkdir(parents=True)
        hpc_files.select('gtf', self.file('c.gtf', COLLAPSED))
        self.assertTrue(out.exists())

    def test_files_cannot_change_during_a_conversion(self):
        state = self.root / '.signet-agent' / 'steps'
        state.mkdir(parents=True)
        (state / 'prepare.job').write_text('5\n')
        self.tool('squeue', '#!/bin/sh\necho RUNNING\n')
        self.assertEqual(hpc_files.select('ref', self.file('r.vcf', '##fileformat=VCFv4.2\n'))['status'], 'blocked')
        self.assertEqual(hpc_files.clear('ref')['status'], 'blocked')

    def test_clear_returns_to_the_default_and_never_touches_the_file(self):
        path = self.file('c.gtf', COLLAPSED)
        hpc_files.select('gtf', path)
        self.assertEqual(hpc_files.clear('gtf')['status'], 'ok')
        self.assertEqual(hpc_files.selected()['selected'], {})
        self.assertEqual(Path(path).read_text(), COLLAPSED)
        self.assertEqual(self.check()['reference_gtf']['status'], 'missing')

    def test_a_second_selection_waits_for_the_first(self):
        state = self.root / '.signet-agent' / 'steps'
        (state / 'selected.lock').mkdir(parents=True)
        self.assertEqual(hpc_files.select('gtf', self.file('c.gtf', COLLAPSED))['status'], 'blocked')

    def test_not_a_model_tool(self):
        from agent.tools.hpc import HPC_TOOLS
        self.assertFalse([tool.__name__ for tool in HPC_TOOLS if 'select' in tool.__name__ or 'list' in tool.__name__])


if __name__ == '__main__':
    unittest.main()
