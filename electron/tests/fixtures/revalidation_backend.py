"""Owned saved job outputs with a read-only local scheduler/download transport."""

import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(REPO), str(Path(__file__).parent)]
from cancellation_backend import install_scheduler
from history_backend import write
from agent.runtime import signet_jobs as jobs, ssh_transport
import agent.tools.signet as signet

STAGES = ('genotype', 'expression', 'adjust', 'cis', 'network', 'visualize')


def outputs():
    ids = [f'TCGA-AA-A00{number}-01' for number in range(1, 5)]
    expression_ids = ids + ['TCGA-AA-A006-01', 'TCGA-AA-A007-01']
    clinical = ('submitter_id\trace\tgender\nTCGA-AA-A001\tasian\tfemale\n'
                'TCGA-AA-A002\tblack or african american\tmale\n'
                'TCGA-AA-A003\tamerican indian or alaska native\tmale\nTCGA-AA-A004\twhite\tfemale\n')
    return {
        'genotype': {'signet_Geno': '0 1 2\n' * 5, 'signet_Genotype.sampleID': '\n'.join(ids + ['TCGA-AA-A005-01']) + '\n'},
        'expression': {'signet_gexp': '1 2\n3 4\n5 6\n7 8\n9 10\n11 12\n',
            'signet_gexpID': '\n'.join(expression_ids) + '\n', 'signet_gene_name': 'MEGF6\nGENE2\n',
            'signet_gene_pos': 'MEGF6 chr1 100 200\nGENE2 chr1 300 400\n'},
        'adjust': {'signet_matched.gexp': '1 3\n3 5\n9 9\n10 10\n', 'signet_gexp.data': '0.5 0.8\n-0.5 -0.8\n',
            'signet_gexp_rmpc.data': '0.25 0.4\n-0.25 -0.4\n', 'signet_new.Geno': '0 1 2\n2 1 0\n1 0 1\n0 0 2\n',
            'signet_geno.data': '0 1 2\n2 1 0\n', 'signet_new.Geno.map': '1 1 0 100\n1 2 0 200\n1 3 0 300\n',
            'signet_new.Geno.maf': '.1\n.2\n.3\n', 'workspace-genotype-ids.txt': '\n'.join(ids) + '\n',
            'workspace-clinical.tsv': clinical, 'workspace-pca.eval': '6\n3\n1\n',
            'workspace-pca.evec': '#eigvals: 6 3 1\nTCGA-AA-A002 0.2 0.4 pop\nTCGA-AA-A003 0.3 0.5 pop\nTCGA-AA-A001 0.1 0.3 pop\n'},
        'cis': {'signet_all.sig.pValue_0.01': '1 1 0.001\n2 1 0.002\n1 2 0.003\n2 3 0.004\n1 4 0.005\n2 5 0.006\n',
            'signet_common.eQTL.data': '0 1 2\n1 2 0\n2 0 1\n', 'signet_low.eQTL.data': '0.1\n0.2\n0.3\n',
            'signet_rare.eQTL.data': '-0.1\n0.2\n-0.3\n', 'signet_all.eQTL.data': '0 1 2 0.1 -0.1\n1 2 0 0.2 0.2\n2 0 1 0.3 -0.3\n',
            'signet_net.gexp.data': '1 2\n3 4\n5 6\n', 'signet_net.genename': 'MEGF6\nGENE2\n',
            'signet_net.genepos': 'MEGF6 chr1 100 200\nGENE2 chr1 300 400\n'},
        'network': {'signet_Afreq': '0,0.5,1\n1,0,0.5\n0.5,1,0\n',
            'signet_CoeffMat0': '0,-0.2,0.3\n0.4,0,-0.5\n-0.6,0.7,0\n',
            'signet_net.genepos': 'MEGF6 chr1 100 200\nGENE2 chr1 300 400\nGENE3 chr1 500 600\n'},
        'visualize': {'signet_edgelist_0.45.txt': 'source_gene_symbol,target_gene_symbol,frequency,coefficient\nMEGF6,B,0.5,0.2\nB,MEGF6,1,-0.4\nB,C,0.8,0.1\nD,E,0.6,0.3\n',
            'signet_count_vs_freq.pdf': 'Saved export\n', 'signet_count_vs_freq.eps': 'Saved export\n',
            'signet_top1_freq0.45.html': 'Saved export\n', 'signet_top1_freq0.45_name.txt': 'MEGF6\nB\nC\n',
            'signet_circular_top1_freq0.45.pdf': 'Saved export\n'},
    }


def seed(root, project):
    inputs = root / 'inputs'; inputs.mkdir()
    (root / 'remote').mkdir()
    (root / 'remote/signet.sif').write_text('Existing controlled image\n')
    for name in ('study.ped', 'study.map', 'expression.txt', 'clinical.tsv', 'annotation.gtf'):
        (inputs / name).write_text('Immutable original ' + name + '\n')
    datasets = [{'id': identifier, 'name': [identifier, identifier], 'folder': str(inputs), 'inputs': {
        'genotype': [str(inputs / 'study.ped'), str(inputs / 'study.map')], 'expression': [str(inputs / 'expression.txt')],
        'clinical': [str(inputs / 'clinical.tsv')]}} for identifier in ('recover-a', 'recover-b')]
    for record in datasets: write(project / 'data/datasets' / (record['id'] + '.json'), record)
    resources = {'cpus': 2, 'mem_gb': 8, 'hours': 1}
    settings = {'genotype': {'restrict.tcga.geno': '1', 'mind': '0.1', 'geno': '0.1', 'hwe': '0.0001', 'int': '5000000'},
        'expression': {'restrict.tcga': '1'}, 'adjust': {},
        'cis': {'alpha.cis': '0.01', 'nperms': '2', 'upstream': '1000', 'downstream': '2000'},
        'network': {'nboots': '2', 'cor': '0.3', 'ncis': '3', 'ncores': '2', 'memory': '8', 'walltime': '01:00:00'},
        'visualize': {'freq': '0.45', 'ntop': '1'}}
    step_inputs = {'genotype': {'ped.file': str(inputs / 'study.ped'), 'map.file': str(inputs / 'study.map'),
        'ref': str(inputs / 'ref/chr'), 'gmap': str(inputs / 'gmap/chr')},
        'expression': {'gexp.file': str(inputs / 'expression.txt'), 'pmap.file': str(inputs / 'annotation.gtf')},
        'adjust': {'cli.file': str(inputs / 'clinical.tsv')}, 'cis': {}, 'network': {}, 'visualize': {}}
    groups = outputs(); scheduler = {}; records = []; missing = {}
    for number, target in enumerate(STAGES, 1):
        identifier = 'recover-stage' + str(number)
        created = signet.configure_signet(identifier)
        if created['status'] != 'created': raise ValueError(created)
        local = project / 'runs' / identifier; remote = root / 'remote/work' / identifier
        (remote / 'steps').mkdir(parents=True)
        token = '0123456789abcdef0123456789abcdef'
        write(local / 'steps/remote.owner', {'remote_dir': str(remote), 'token': token})
        (remote / '.owner').write_text(token + '\n')
        for offset, step in enumerate(STAGES[:number], 1):
            snapshot = {'run_id': identifier, 'dataset_id': datasets[0]['id'], 'submitted_at': '2026-11-17T12:00:00-0800',
                'inputs': step_inputs[step], 'settings': settings[step], 'resources': resources, 'input_sources': {}}
            if step == 'adjust': snapshot['options'] = {'npc': 2}
            if step == 'network': snapshot['source_cis_alpha'] = '0.01'
            write(local / ('workspace-' + step + '.json'), snapshot)
            job_id = str(6000 + number * 10 + offset)
            required = [jobs._resolve(path, settings[step]) for path in jobs.STEPS[step].required]
            if step == 'visualize':
                required += ['res/resv/signet_top1_freq0.45.html', 'res/resv/signet_top1_freq0.45_name.txt', 'res/resv/signet_circular_top1_freq0.45.pdf']
            record = {**snapshot, 'step': step, 'state': 'failed' if step == target else 'completed',
                'job_id': job_id, 'attempt': 2, 'remote_dir': str(remote), 'required_outputs': required,
                'image': str(root / 'remote/signet.sif'), 'partition': 'standard',
                'slurm_state': 'COMPLETED', 'exit_code': '0', 'finished_at': '2026-11-17T12:05:00-0800',
                'missing_outputs': [required[0]] if step == target else [], 'failure_hints': [],
                'reason': 'Required outputs are missing.' if step == target else 'Outputs present and logs clean.',
                'history': [{'state': 'running', 'at': '2026-11-17T12:01:00-0800'},
                            {'state': 'failed' if step == target else 'completed', 'at': '2026-11-17T12:05:00-0800'}]}
            write(local / 'steps' / (step + '.json'), record)
            if step == target:
                write(local / 'steps' / (step + '.attempt1.json'), {**record, 'attempt': 1, 'job_id': '5000',
                    'reason': 'Preserved previous actual failure', 'exit_code': '1', 'slurm_state': 'FAILED'})
                records.append({'run_id': identifier, 'step': step, 'stage': number, 'job_id': job_id, 'attempt': 2})
            (remote / 'steps' / (step + '.job')).write_text(job_id + '\n')
            (remote / 'steps' / (step + '.done')).write_text('0 2026-11-17T12:05:00\n')
            (remote / 'steps' / (step + '.out')).write_text('SIGNET_STAGE6_EXPORTS_COMPLETED\n' if step == 'visualize' else 'Recorded clean output\n')
            (remote / 'steps' / (step + '.err')).touch()
            scheduler[job_id] = {'name': f'signet-{step}-{identifier}', 'state': '', 'accounted': 'COMPLETED', 'workdir': str(remote / 'work')}
            folder = jobs.STEPS[step].download
            for name, content in groups[step].items():
                relative = str(Path(folder) / name)
                path = remote / relative; path.parent.mkdir(parents=True, exist_ok=True)
                if step == target and str(Path('work') / required[0]) == relative:
                    missing[identifier] = {'path': str(path), 'content': content}
                else: path.write_text(content)
                if step != target:
                    destination = local / relative; destination.parent.mkdir(parents=True, exist_ok=True); destination.write_text(content)
    # Ineligible failures remain available for read-only history without an action.
    ineligible = []
    original = records[0]
    template = project / 'runs' / original['run_id']
    variants = {'true-failed': {'slurm_state': 'FAILED'}, 'nonzero': {'exit_code': '2'},
        'log-hint': {'failure_hints': ['Recorded scientific error']}, 'cancelled': {'state': 'cancelled'},
        'unknown': {'state': 'unknown'}, 'active': {'state': 'running'}}
    for index, (name, changes) in enumerate(variants.items(), 1):
        identifier = 'ineligible-' + name
        created = signet.configure_signet(identifier)
        if created['status'] != 'created': raise ValueError(created)
        local = project / 'runs' / identifier; remote = root / 'remote/work' / identifier
        snapshot = json.loads((template / 'workspace-genotype.json').read_text()); snapshot['run_id'] = identifier
        write(local / 'workspace-genotype.json', snapshot)
        record = json.loads((template / 'steps/genotype.json').read_text())
        record.update(run_id=identifier, remote_dir=str(remote), job_id=str(7000 + index), **changes)
        write(local / 'steps/genotype.json', record)
        scheduler[record['job_id']] = {'name': f'signet-genotype-{identifier}', 'state': 'RUNNING' if name == 'active' else '',
            'accounted': 'FAILED' if name == 'true-failed' else '', 'workdir': str(remote / 'work')}
        ineligible.append({'run_id': identifier, 'step': 'genotype', 'stage': 1, 'job_id': record['job_id'], 'attempt': 2})
    write(root / 'scheduler.json', scheduler)
    write(root / 'control.json', {'connected': True, 'fail_remote': False, 'delay_run': ''})
    return {'project': str(project), 'root': str(root), 'inputs': str(inputs), 'datasets': datasets,
            'records': records, 'ineligible': ineligible, 'missing': missing}


def main():
    server = REPO / 'electron/main/backend/server.py'
    if sys.argv[1:3] != ['-u', str(server)]: raise ValueError('Expected the desktop backend command.')
    root = Path(os.environ['SIGNET_REVALIDATION_ROOT']).resolve(); metadata = root / 'fixture.json'
    signet.PROJECT = root / 'project'
    if not metadata.exists(): write(metadata, {**seed(root, signet.PROJECT), 'starts': []})
    install_scheduler(root)
    for name in ('sbatch', 'scancel', 'apptainer'):
        executable = root / 'bin' / name
        executable.write_text('#!/bin/sh\nprintf "forbidden mutation\\n" >> "$SIGNET_CANCEL_ROOT/forbidden.ndjson"\nexit 92\n')
        executable.chmod(0o700)
    os.environ['SIGNET_DATASETS_STATE_FILE'] = str(signet.PROJECT / 'data/workspace-datasets.json')
    os.environ['SIGNET_HISTORY_STATE_FILE'] = str(signet.PROJECT / 'data/workspace-history.json')
    ssh_transport.available = lambda: json.loads((root / 'control.json').read_text())['connected']
    ssh_transport.environment = lambda: {'root': str(root / 'remote'), 'source': str(root / 'remote/software'),
        'image': str(root / 'remote/signet.sif'), 'executor': 'apptainer', 'workRoot': str(root / 'remote/work'), 'partition': 'standard'}

    def forbidden(value):
        with (root / 'forbidden.ndjson').open('a') as stream: stream.write(json.dumps(value) + '\n')
        raise AssertionError('Output revalidation must be read-only: ' + str(value))

    def remote(command, input=None, capture_output=False, timeout=None):
        script = input.decode() if command == 'bash -s' and input else command
        if (not str(root / 'remote/work') in script or any(token in script for token in ('scancel ', 'sbatch ', 'apptainer ', 'mkdir ', 'rm ', 'mv ', 'sed -i'))
                or not (command == 'bash -s' or '&& tar czf - work/res/' in command)):
            forbidden([command, script])
        control = json.loads((root / 'control.json').read_text())
        with (root / 'reads.ndjson').open('a') as stream: stream.write(json.dumps(script) + '\n')
        if control['fail_remote']: raise OSError('Controlled output read connection loss')
        if control['delay_run'] and control['delay_run'] in script: time.sleep(0.2)
        return subprocess.run(['bash', '-c', command], input=input or b'', capture_output=True, timeout=timeout,
            env={'PATH': str(root / 'bin') + ':/usr/bin:/bin', 'SIGNET_CANCEL_ROOT': str(root), 'LANG': 'C', 'COPYFILE_DISABLE': '1'})

    ssh_transport.remote = remote
    jobs.submit = lambda *args, **kwargs: forbidden(['submit', args, kwargs])
    jobs.cancel = lambda *args, **kwargs: forbidden(['cancel', args, kwargs])
    jobs.update_settings = lambda *args, **kwargs: forbidden(['settings', args, kwargs])
    from agent.app import chat_ui
    original_server = chat_ui.create_server; original_post = chat_ui.ChatHandler.do_POST

    def post(self):
        with (root / 'posts.ndjson').open('a') as stream: stream.write(json.dumps(self.path) + '\n')
        return original_post(self)

    chat_ui.ChatHandler.do_POST = post

    def create_server(*args, **kwargs):
        saved = json.loads(metadata.read_text()); kwargs['port'] = saved.get('port', 0)
        instance = original_server(*args, **kwargs)
        write(metadata, {**saved, 'port': instance.server_port, 'starts': [*saved['starts'], os.getpid()]})
        return instance

    chat_ui.create_server = create_server
    sys.argv = [str(server), *sys.argv[3:]]
    runpy.run_path(str(server), run_name='__main__')


if __name__ == '__main__': main()
