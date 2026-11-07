import json
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import agent.runtime.hpc as hpc
from agent.tools.hpc import REVISION, check_hpc_environment, download_reference_file, prepare_imputation_reference
from agent.tools.signet import dispatch_tool
from test_hpc_environment import READY, Remote, markers

KEYS = ('ref', 'gmap', 'gtf', 'clinical')

FAKE_CURL = '''#!/bin/bash
[ -z "${FAKE_FAIL:-}" ] || { echo "curl: (6) Could not resolve host" >&2; exit 6; }
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; --retry) shift;; -*) ;; *) url="$1";; esac; shift; done
case "$url" in *collapse_annotation*) src=collapse.py;; *genetic_maps*) src=maps.tar.gz;; *gencode*) src=gtf.gz;; *api.gdc*) src=clinical.tsv;; *) src=kg.vcf.gz;; esac
if [ -n "$out" ]; then cp "$FIXTURES/$src" "$out"; else cat "$FIXTURES/$src"; fi
'''
# Stands in for the container: reports its modules, records pip, and "collapses" the GTF.
FAKE_RUNTIME = r'''#!/bin/bash
echo "$*" >> "$FAKE/runtime.calls"
case "$*" in
  *"import numpy"*) [ -z "${FAKE_NO_BX:-}" ]; exit;;
  *"pip install"*) exit 0;;
  *collapse_annotation.py*)
    for last in "$@"; do full="$output"; output="$last"; done
    [ "$(wc -l < "$full")" -gt 0 ] || exit 1
    if [ -n "${FAKE_NOT_COLLAPSED:-}" ]; then cp "$full" "$output"; else
      printf 'chr1\tHAVANA\tgene\t1\t2\t.\t+\t.\tgene_id "A"; transcript_type "protein_coding";\n' > "$output"; fi;;
esac
'''
# Runs the submitted job right away, like a job that finished before the next check.
FAKE_SBATCH = '''#!/bin/bash
for arg in "$@"; do case "$arg" in --output=*) log="${arg#--output=}";; esac; script="$arg"; done
echo "$@" >> "$FAKE/sbatch.calls"
bash "$script" > "$log" 2>&1 || true
echo "777;hpc3"
'''
FIXTURES = r'''
mkdir maps
printf 'pos\tchr\tcM\n55550\t1\t0\n' | gzip > maps/chr1.b38.gmap.gz
printf 'x' | gzip > maps/chr2.b38.gmap.gz
tar -czf maps.tar.gz -C maps chr1.b38.gmap.gz chr2.b38.gmap.gz
printf 'chr1\tHAVANA\tgene\t1\t2\t.\t+\t.\tgene_id "A"; gene_type "protein_coding";\n' | gzip > gtf.gz
printf 'print("official tool")\n' > collapse.py
printf '##fileformat=VCFv4.2\n' | gzip > kg.vcf.gz
printf 'demographic.race\tid\tsubmitter_id\r\nwhite\tabc\tTCGA-44-3918\r\n' > clinical.tsv
'''


class ReferenceToolTest(unittest.TestCase):
    def test_each_reference_file_is_its_own_slurm_job(self):
        for key in KEYS:
            with self.subTest(key=key), Remote(markers(workspace_path='/w', **{key: 'started', f'{key}_job': '31'})) as remote:
                result = download_reference_file(key)
                script = remote.call_args.kwargs['input'].decode()
            self.assertEqual((result['status'], result['step'], result['job_id'], result['executed']), ('ok', key, '31', True))
            self.assertIn(f'--job-name=signet-{key}', script)
            self.assertIn(hpc.REFERENCES[key]['url'], script)
            for other in set(KEYS) - {key}:
                self.assertNotIn(f'--job-name=signet-{other}', script)
            self.assertNotIn('git clone', script)

    def test_only_the_four_known_files_are_accepted(self):
        with patch.object(hpc.ssh_transport, 'remote') as remote:
            for bad in ('../etc/passwd', 'container', 'REF', ''):
                self.assertEqual(download_reference_file(bad)['status'], 'invalid')
        remote.assert_not_called()
        with patch.object(hpc.ssh_transport, 'available', return_value=False):
            self.assertEqual(dispatch_tool('download_reference_file', {'file': 'gtf'})['status'], 'unavailable')
            self.assertEqual(dispatch_tool('read_hpc_setup_log', {'step': 'clinical'})['status'], 'unavailable')

    def test_reference_downloads_show_progress_and_failures(self):
        reply = markers(**{**READY, 'file_gtf': 'no', 'file_clinical': 'no'}, job_gtf='8', job_gtf_state='RUNNING',
                        job_clinical='9', job_clinical_state='')
        with Remote(reply):
            result = check_hpc_environment()
        status = {c['item']: c for c in result['checks']}
        self.assertEqual(status['reference_gtf']['status'], 'in_progress')
        self.assertEqual(status['reference_clinical']['status'], 'problem')
        self.assertIn('read_hpc_setup_log("clinical")', status['reference_clinical']['detail'])


class ReferenceScriptTest(unittest.TestCase):
    """Run the real jobs: fake curl serves local files, fake sbatch runs each job at once."""

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        base = Path(self.folder.name).resolve()
        self.base, self.root, self.home = base, base / 'signet-agent', base / 'home'
        self.home.mkdir()
        fixtures = base / 'fixtures'
        fixtures.mkdir()
        subprocess.run(['bash', '-c', FIXTURES], cwd=fixtures, check=True)
        bin_dir = base / 'bin'
        bin_dir.mkdir()
        for name, text in (('curl', FAKE_CURL), ('sbatch', FAKE_SBATCH), ('squeue', '#!/bin/bash\n'), ('apptainer', FAKE_RUNTIME)):
            (bin_dir / name).write_text(text)
            (bin_dir / name).chmod(0o755)
        self.env = {**os.environ, 'PATH': f'{bin_dir}:{os.environ["PATH"]}', 'FAKE': str(base),
                    'FIXTURES': str(fixtures), 'HOME': str(self.home)}
        image = self.root / hpc.CONTAINER
        image.parent.mkdir(parents=True)
        image.write_text('image')
        digest = hashlib.sha256((fixtures / 'collapse.py').read_bytes()).hexdigest()
        pinned = patch.dict(hpc._FETCH, {'gtf': hpc._FETCH['gtf'].replace(hpc.COLLAPSE_SHA256, digest)})
        pinned.start()
        self.addCleanup(pinned.stop)

    def tearDown(self):
        self.folder.cleanup()

    def run_script(self, build, **env):
        with patch.dict(os.environ, {'SIGNET_HPC_WORKSPACE': str(self.root)}):
            script = build(str(self.root))
        done = subprocess.run(['bash', '-s'], input=script.encode(), capture_output=True, check=True, env={**self.env, **env})
        return hpc._parse(done.stdout)

    def download(self, key, **env):
        return self.run_script(lambda root: hpc._reference_script(root, key), **env)

    def test_each_file_is_downloaded_recorded_and_never_redone(self):
        for key in KEYS:
            with self.subTest(key=key):
                started = self.download(key)
                self.assertEqual((started[key], started[f'{key}_job']), ('started', '777'))
                target = self.root / hpc.REFERENCES[key]['path']
                self.assertTrue(target.is_file(), (self.home / f'.signet-agent/steps/{key}.log').read_text())
                self.assertFalse(Path(f'{target}.partial').exists())
                self.assertEqual(self.download(key)[key], 'existing')
        self.assertEqual((self.root / 'refdata').stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.root / 'refdata/clinical.tsv').read_bytes(),
                         b'race\tid\tsubmitter_id\nwhite\tabc\tTCGA-44-3918\n', 'CRLF removed and race column renamed')
        self.assertIn('transcript_type', (self.root / hpc.REFERENCES['gtf']['path']).read_text())
        self.assertIn('gene_type', (self.root / hpc.FULL_GTF).read_text(), 'the full GTF is kept')
        gmap = subprocess.run(['gunzip', '-c', str(self.root / 'refdata/gmap/chr1.b38.gmap.gz')],
                              capture_output=True, text=True).stdout
        self.assertEqual(gmap, 'pos\tchr\tcM\n55550\t1\t0\n', 'only chromosome 1 is taken from the archive')
        self.assertFalse(list((self.root / 'refdata/gmap').glob('*.tar.gz*')))
        sources = [line.split('\t') for line in (self.root / 'refdata/SOURCES.tsv').read_text().splitlines()]
        self.assertEqual([row[0] for row in sources], list(KEYS))
        self.assertTrue(all(len(row[3]) == 64 and row[4].startswith('https://') for row in sources))
        self.assertEqual(len((self.base / 'sbatch.calls').read_text().splitlines()), 4, 'existing files are not downloaded again')
        checks = hpc._checks(self.run_script(hpc._check_script), REVISION)
        self.assertEqual({c['item']: c['status'] for c in checks if c['item'].startswith('reference_')},
                         dict.fromkeys(('reference_ref', 'reference_gmap', 'reference_gtf', 'reference_clinical'), 'ok'))

    def test_gtf_job_uses_the_official_tool_in_the_container_and_reuses_the_full_file(self):
        full = self.root / hpc.FULL_GTF
        full.parent.mkdir(parents=True)
        full.write_text('chr1\tHAVANA\tgene\t1\t2\t.\t+\t.\tgene_id "A"; gene_type "x";\n')
        before = full.stat().st_mtime_ns
        self.assertEqual(self.download('gtf')['gtf'], 'started')
        self.assertEqual(full.stat().st_mtime_ns, before, 'an existing full GTF is not downloaded again')
        calls = (self.base / 'runtime.calls').read_text()
        self.assertIn('collapse_annotation.py', calls)
        self.assertIn(f'--bind {self.root}:{self.root}', calls)
        self.assertNotIn('pip install', calls, 'the image already has the tool dependencies')
        self.assertIn('--mem=16G', (self.base / 'sbatch.calls').read_text())

    def test_gtf_job_adds_the_missing_dependency_beside_the_workspace(self):
        self.download('gtf', FAKE_NO_BX='1')
        calls = (self.base / 'runtime.calls').read_text()
        self.assertIn(f'pip install --quiet --no-deps --target {self.root}/refdata/.tools/python bx-python', calls)
        self.assertTrue((self.root / hpc.REFERENCES['gtf']['path']).is_file())

    def test_gtf_is_never_published_if_gene_rows_lack_transcript_type(self):
        self.download('gtf', FAKE_NOT_COLLAPSED='1')
        self.assertFalse((self.root / hpc.REFERENCES['gtf']['path']).exists())
        self.assertFalse(Path(f"{self.root / hpc.REFERENCES['gtf']['path']}.partial").exists())
        log = self.run_script(lambda _root: hpc._log_script('gtf'))
        self.assertTrue(any('no gene rows with transcript_type' in line for line in log['lines']))

    def test_gtf_refuses_a_tampered_tool(self):
        with patch.dict(hpc._FETCH, {'gtf': hpc._FETCH['gtf'].replace('digest" != "', 'digest" != "0')}):
            self.download('gtf')
        self.assertFalse((self.root / hpc.REFERENCES['gtf']['path']).exists())
        self.assertFalse((self.root / 'refdata/.tools/collapse_annotation.py').exists())
        self.assertFalse((self.base / 'runtime.calls').exists(), 'an unverified tool never runs')

    def test_gtf_waits_for_the_container(self):
        (self.root / hpc.CONTAINER).unlink()
        result = self.download('gtf')
        self.assertEqual(result['gtf'], 'needs_container')
        self.assertFalse((self.base / 'sbatch.calls').exists())

    def test_failed_download_leaves_no_file_and_explains_itself(self):
        self.assertEqual(self.download('gtf', FAKE_FAIL='1')['gtf'], 'started')
        self.assertFalse((self.root / hpc.REFERENCES['gtf']['path']).exists())
        self.assertFalse((self.root / 'refdata/SOURCES.tsv').exists())
        gtf = next(c for c in hpc._checks(self.run_script(hpc._check_script), REVISION) if c['item'] == 'reference_gtf')
        self.assertEqual(gtf['status'], 'problem')
        log = self.run_script(lambda _root: hpc._log_script('gtf'))
        self.assertTrue(any('Could not resolve host' in line for line in log['lines']))
        # Retrying submits a new job once the failed one is gone.
        self.assertEqual(self.download('gtf')['gtf'], 'started')
        self.assertTrue((self.root / hpc.REFERENCES['gtf']['path']).is_file())



class PrepareStepTest(unittest.TestCase):
    """The converter step: prerequisites in order, then the uploaded script really runs."""

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        base = Path(self.folder.name).resolve()
        self.base, self.root, self.home = base, base / 'signet-agent', base / 'home'
        self.home.mkdir()
        bin_dir = base / 'bin'
        bin_dir.mkdir()
        for name, text in (('sbatch', FAKE_SBATCH), ('squeue', '#!/bin/bash\n')):
            (bin_dir / name).write_text(text)
            (bin_dir / name).chmod(0o755)
        self.env = {**os.environ, 'PATH': f'{bin_dir}:{os.environ["PATH"]}', 'FAKE': str(base), 'HOME': str(self.home)}

    def tearDown(self):
        self.folder.cleanup()

    def run_script(self, build):
        with patch.dict(os.environ, {'SIGNET_HPC_WORKSPACE': str(self.root)}):
            script = build(str(self.root))
        done = subprocess.run(['bash', '-s'], input=script.encode(), capture_output=True, check=True, env=self.env)
        return hpc._parse(done.stdout)

    def place(self, relative, text, compress=False):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        data = text.encode()
        if compress:
            import gzip
            data = gzip.compress(data)
        path.write_bytes(data)

    def test_needs_signet_then_ref_then_gmap_before_running(self):
        self.root.mkdir()
        self.assertEqual(self.run_script(hpc._prepare_script)['prepare'], 'needs_signet')
        self.place(hpc.EXAMPLE_STUDY + '.map', '1\t.\t0\t100\n')
        self.place(hpc.EXAMPLE_STUDY + '.ped', 'F S1 0 0 1 -9 A G\n')
        self.assertEqual(self.run_script(hpc._prepare_script)['prepare'], 'needs_ref')
        self.place(hpc.REFERENCE_FILES['ref'], '##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tR1\n'
                   'chr1\t100\trs1\tA\tG\t.\tPASS\t.\tGT\t0|1\n', compress=True)
        self.assertEqual(self.run_script(hpc._prepare_script)['prepare'], 'needs_gmap')
        self.place(hpc.REFERENCE_FILES['gmap'], 'pos\tchr\tcM\n1\t1\t0\n1000001\t1\t2\n', compress=True)

        started = self.run_script(hpc._prepare_script)
        self.assertEqual((started['prepare'], started['prepare_job']), ('started', '777'))
        prepared = self.root / hpc.PREPARED
        self.assertEqual((prepared / 'ref/chr1.gen').read_text(), 'chr1_100 rs1 100 A G 0 1 0\n')
        self.assertTrue((prepared / 'gmap/chr1.map').is_file())
        self.assertEqual(json.loads((prepared / 'summary.json').read_text())['matched_markers'], 1)
        log = self.run_script(lambda _root: hpc._log_script('prepare'))
        summary = json.loads(log['lines'][-1])
        self.assertEqual((summary['status'], summary['match_rate'], summary['warning']), ('ok', 1.0, None))
        self.assertEqual(self.run_script(hpc._prepare_script)['prepare'], 'existing')
        checks = hpc._checks(self.run_script(hpc._check_script), REVISION)
        self.assertEqual(next(c for c in checks if c['item'] == 'imputation_reference')['status'], 'ok')

    def test_tool_reports_missing_prerequisites_in_plain_words(self):
        with Remote(markers(workspace_path='/w', prepare='needs_ref')):
            result = prepare_imputation_reference()
        self.assertEqual((result['status'], result['executed'], result['outcome']), ('ok', False, 'needs_ref'))
        self.assertIn('ref file first', result['detail'])
        with Remote(markers(workspace_path='/w', prepare='started', prepare_job='12')) as remote:
            result = prepare_imputation_reference()
        self.assertEqual((result['job_id'], result['executed']), ('12', True))
        self.assertIn('prepare_reference.py', remote.call_args.kwargs['input'].decode())


if __name__ == '__main__':
    unittest.main()
