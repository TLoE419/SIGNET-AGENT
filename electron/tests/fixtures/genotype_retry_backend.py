"""Same-run retry fixture using trusted staging and an explicitly fake container."""

import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(REPO), str(REPO / 'tests'), str(Path(__file__).parent)]
from custom_dataset_backend import dataset, install_tools
from test_signet_jobs import StepsTest
from agent.runtime import signet_jobs as jobs, ssh_transport, workspace_genotype
import agent.tools.signet as signet


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def seed(fixture, root):
    fixture.config['revision'] = signet.INVENTORY['revision']
    first, patients = dataset(fixture.hpc / 'cohorts/a', 'retry-cohort-a', 'AA', 2)
    second, _ = dataset(fixture.hpc / 'cohorts/b', 'retry-cohort-b', 'BB', 2)
    for record in (first, second):
        write(fixture.project / 'data/datasets' / (record['id'] + '.json'), record)
    reference, genetic_map, annotation = [fixture.hpc / 'ws/refdata' / name for name in ('retry-reference.vcf', 'retry-map.txt', 'retry-annotation.gtf')]
    reference.write_text('##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tR1\tR2\n' + ''.join(
        '2\t{}\trs{}\t{}\t{}\t.\tPASS\t.\tGT\t0/0\t0/1\n'.format(index*101,index,*alleles)
        for index,alleles in enumerate((('A','G'),('C','T'),('G','T')),1)))
    genetic_map.write_text('pos chr cM\n0 2 0\n1000 2 1\n')
    annotation.write_text(''.join('chr2\tGENCODE\tgene\t{}\t{}\t.\t+\t.\tgene_id "ENSG0000010000{}.1"; gene_name "GENE{}"; transcript_type "protein_coding";\n'.format(index*100,index*100+50,index,index) for index in range(1,5)))
    (fixture.hpc / 'ws/refdata/selected.tsv').write_text('ref\t{}\ngmap\t{}\ngtf\t{}\n'.format(reference, genetic_map, annotation))
    install_tools(fixture)
    executable = fixture.fake / 'bin/apptainer'
    success = executable.with_name('apptainer-fixture-success')
    executable.rename(success)
    executable.write_text('#!' + sys.executable + '\n' + '''import os,pathlib,sys
root=pathlib.Path.cwd().resolve()
if not root.is_relative_to(pathlib.Path(os.environ['SIGNET_CUSTOM_REMOTE']).resolve()):raise SystemExit('Outside retry fixture')
phase=(pathlib.Path(os.environ['FAKE'])/'science_phase').read_text().strip()
if phase=='fail':
    target=root/'res/resg/signet_Geno';target.parent.mkdir(parents=True,exist_ok=True);target.write_text('FIRST-ATTEMPT-PARTIAL\\n')
    print('Controlled genotype failure after trusted input staging',file=sys.stderr)
    raise SystemExit(23)
os.execv(str(pathlib.Path(__file__).with_name('apptainer-fixture-success')),[str(pathlib.Path(__file__).with_name('apptainer-fixture-success')),*sys.argv[1:]])
''')
    executable.chmod(0o700)
    (fixture.fake / 'science_phase').write_text('fail\n')
    batch = fixture.fake / 'bin/sbatch'
    batch.write_text('#!/bin/bash\nprintf "submitted\\n" >> "$FAKE/sbatch_calls"\nprintf "PENDING\\n" > "$FAKE/squeue"\n: > "$FAKE/sacct"\n' + batch.read_text().split('\n', 1)[1])
    fixture.slurm(squeue='PENDING', name='signet-genotype-retry-chr2')
    review = workspace_genotype.review_dataset(first['id'], first['inputs'])
    if not review['ready']:
        raise ValueError(review)
    run_id = 'retry-chr2'
    record = workspace_genotype.submit_dataset(first['id'], run_id, review['inputs'], review['settings'],
        {'cpus': 2, 'mem_gb': 8, 'hours': 1}, review['review_token'], True)
    remote = Path(fixture.config['workRoot']) / run_id
    script = remote / 'steps/genotype.sbatch'
    result = subprocess.run(['bash', str(script)], cwd=remote / 'work', capture_output=True, timeout=30,
        env={**os.environ, 'PATH': str(fixture.fake / 'bin') + ':' + os.environ['PATH'], 'FAKE': str(fixture.fake),
             'SIGNET_CUSTOM_REMOTE': fixture.config['workRoot'], 'SLURM_JOB_ID': record['job_id'], 'SLURM_CPUS_PER_TASK': '2'})
    (remote / 'steps/genotype.out').write_bytes(result.stdout)
    (remote / 'steps/genotype.err').write_bytes(result.stderr)
    if not (remote / 'steps/genotype.done').read_text().startswith('23 '):
        raise AssertionError((result.returncode, result.stdout.decode(), result.stderr.decode()))
    fixture.slurm(squeue='', sacct='FAILED')
    record = jobs.status(run_id, 'genotype', refresh=True)
    if record['state'] != 'failed':
        raise AssertionError(record)
    local = fixture.project / 'runs' / run_id
    for suffix in ('out', 'err', 'job'):
        (local / 'steps' / ('genotype.' + suffix)).write_bytes((remote / 'steps' / ('genotype.' + suffix)).read_bytes())
    output = local / 'work/res/resg'
    output.mkdir(parents=True, exist_ok=True)
    (output / 'old-local-result.txt').write_text('OLD LOCAL ATTEMPT ONE\n')
    (remote / 'work/res/resg/old-remote-result.txt').write_text('OLD REMOTE ATTEMPT ONE\n')
    (remote / 'inputs/prepared/old-reference-sentinel.txt').write_text('OLD FIRST REFERENCE SENTINEL\n')
    return {'project': str(fixture.project), 'hpc': str(fixture.hpc), 'slurm': str(fixture.fake),
            'config': fixture.config, 'remote': fixture.config['workRoot'], 'run_id': run_id,
            'datasets': [first, second], 'patients': patients, 'reference': str(reference),
            'genetic_map': str(genetic_map), 'annotation': str(annotation), 'python': sys.executable}


def main():
    server = REPO / 'electron/main/backend/server.py'
    if sys.argv[1:3] != ['-u', str(server)]:
        raise ValueError('Expected the desktop backend command.')
    root = Path(os.environ['SIGNET_RETRY_ROOT']).resolve()
    metadata = root / 'fixture.json'
    tempfile.tempdir = str(root)
    fixture = StepsTest()
    if not metadata.exists():
        fixture.setUp()
        # The enclosing native fixture owns cleanup, so a backend restart keeps
        # the exact same run, scheduler records, logs and frozen inputs.
        fixture._cleanups = [item for item in fixture._cleanups if getattr(item[0], '__self__', None) is not fixture.temp]
        fixture.temp._finalizer.detach()
    else:
        saved = json.loads(metadata.read_text())
        fixture.project, fixture.hpc, fixture.fake = (Path(saved[key]) for key in ('project', 'hpc', 'slurm'))
        fixture.config = saved['config']
        fixture.calls, fixture.lose_connection_on = [], None
        for item in (patch.object(signet, 'PROJECT', fixture.project), patch.object(ssh_transport, 'available', return_value=True),
                     patch.object(ssh_transport, 'environment', side_effect=lambda: dict(fixture.config)),
                     patch.object(ssh_transport, 'remote', side_effect=fixture.remote)):
            item.start(); fixture.addCleanup(item.stop)
    setup = patch.object(ssh_transport, 'setup_environment', side_effect=lambda: dict(fixture.config))
    setup.start(); fixture.addCleanup(setup.stop)
    os.environ['SIGNET_DATASETS_STATE_FILE'] = str(fixture.project / 'data/workspace-datasets.json')
    os.environ['SIGNET_HISTORY_STATE_FILE'] = str(fixture.project / 'data/workspace-history.json')
    os.environ['SIGNET_CUSTOM_REMOTE'] = fixture.config['workRoot']
    try:
        if not metadata.exists():
            write(metadata, {**seed(fixture, root), 'starts': []})
        original_submit = jobs.submit

        def submit(run_id, name, *args, **kwargs):
            if run_id != 'retry-chr2' or name != 'genotype':
                with (root / 'forbidden.ndjson').open('a') as stream:
                    stream.write(json.dumps([run_id, name]) + '\n')
                raise AssertionError('The retry fixture allows only Stage 1 in its original run.')
            return original_submit(run_id, name, *args, **kwargs)

        jobs.submit = submit
        from agent.app import chat_ui
        original_server = chat_ui.create_server
        original_post = chat_ui.ChatHandler.do_POST

        def post(self):
            with (root / 'posts.ndjson').open('a') as stream:
                stream.write(json.dumps(self.path) + '\n')
            return original_post(self)

        chat_ui.ChatHandler.do_POST = post

        def create_server(*args, **kwargs):
            saved = json.loads(metadata.read_text())
            kwargs['port'] = saved.get('port', 0)
            instance = original_server(*args, **kwargs)
            write(metadata, {**saved, 'port': instance.server_port, 'starts': [*saved['starts'], os.getpid()]})
            return instance

        chat_ui.create_server = create_server
        sys.argv = [str(server), *sys.argv[3:]]
        runpy.run_path(str(server), run_name='__main__')
    finally:
        fixture.doCleanups()


if __name__ == '__main__':
    main()
