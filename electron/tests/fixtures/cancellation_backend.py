"""Production cancel/status scripts against owned, persistent fake scheduler jobs."""

import json
import os
from pathlib import Path
import runpy
import subprocess
import sys

REPO = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(REPO), str(REPO / 'tests')]
from test_signet_jobs import FAKE_SLURM
from agent.runtime import signet_jobs as jobs, ssh_transport
import agent.tools.signet as signet


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def seed(root, project):
    inputs = root / 'inputs'
    inputs.mkdir()
    paths = {}
    for name in ('study.ped', 'study.map', 'expression.txt', 'annotation.gtf', 'clinical.tsv'):
        path = inputs / name
        path.write_text('Immutable original ' + name + '\n')
        paths[name] = str(path)
    datasets = []
    for name in ('cancel-a', 'cancel-b'):
        record = {'id': name, 'name': [name, name], 'folder': str(inputs), 'inputs': {
            'genotype': [paths['study.ped'], paths['study.map']],
            'expression': [paths['expression.txt']], 'clinical': [paths['clinical.tsv']]}}
        write(project / 'data/datasets' / (name + '.json'), record)
        datasets.append(record)
    resource = {'cpus': 2, 'mem_gb': 8, 'hours': 1, 'time': '01:00:00'}
    submitted = '2026-11-17T10:00:00-0800'
    genotype_inputs = {'ped.file': paths['study.ped'], 'map.file': paths['study.map'],
                       'ref': str(inputs / 'ref/chr'), 'gmap': str(inputs / 'gmap/chr')}
    expression_inputs = {'gexp.file': paths['expression.txt'], 'pmap.file': paths['annotation.gtf']}
    genotype_settings = {'restrict.tcga.geno': '1', 'mind': '0.1', 'geno': '0.1', 'hwe': '0.0001', 'int': '5000000'}
    expression_settings = {'restrict.tcga': '1'}
    network_settings = {'nboots': '2', 'ncis': '3', 'cor': '0.5', 'ncores': '2', 'memory': '8', 'walltime': '01:00:00'}
    scheduler = {}
    specs = [('cancel-pending-a', datasets[0], 'expression', '12345', 2, 'PENDING'),
             ('cancel-running-b', datasets[1], 'network', '23456', 3, 'RUNNING'),
             ('cancel-unknown-b', datasets[1], 'expression', None, 1, ''),
             ('cancel-genotype-a', datasets[0], 'genotype', '34567', 1, 'PENDING'),
             ('cancel-error-b', datasets[1], 'expression', '45678', 1, 'RUNNING')]
    for identifier, dataset, active, job_id, attempt, state in specs:
        result = signet.configure_signet(identifier)
        if result['status'] != 'created':
            raise ValueError(result)
        run = project / 'runs' / identifier
        remote = root / 'remote/work' / identifier
        (remote / 'steps').mkdir(parents=True)
        (remote / 'work').mkdir()
        snapshot = {'run_id': identifier, 'dataset_id': dataset['id'], 'submitted_at': submitted,
                    'inputs': genotype_inputs, 'settings': genotype_settings, 'resources': resource}
        write(run / 'workspace-genotype.json', snapshot)
        write(run / 'steps/genotype.json', {**snapshot, 'step': 'genotype', 'state': 'completed',
            'job_id': '10001', 'finished_at': submitted, 'history': [{'state': 'completed', 'at': submitted}]})
        if active != 'genotype':
            snapshot = {'run_id': identifier, 'dataset_id': dataset['id'], 'submitted_at': submitted,
                        'inputs': expression_inputs, 'settings': expression_settings, 'resources': resource}
            write(run / 'workspace-expression.json', snapshot)
            write(run / 'steps/expression.json', {**snapshot, 'step': 'expression', 'state': 'completed',
                'job_id': '10002', 'finished_at': submitted, 'history': [{'state': 'completed', 'at': submitted}]})
        if active == 'network':
            snapshot = {'run_id': identifier, 'dataset_id': dataset['id'], 'submitted_at': submitted,
                        'inputs': {'cli.file': paths['clinical.tsv']}, 'options': {'npc': 2}, 'resources': resource}
            write(run / 'workspace-adjust.json', snapshot)
            write(run / 'steps/adjust.json', {**snapshot, 'step': 'adjust', 'state': 'completed', 'job_id': '10003', 'finished_at': submitted})
            snapshot = {'run_id': identifier, 'dataset_id': dataset['id'], 'submitted_at': submitted,
                        'inputs': {}, 'settings': {'alpha.cis': '0.05', 'nperms': '2', 'upstream': '100000', 'downstream': '100000'},
                        'resources': resource, 'input_sources': {}}
            write(run / 'workspace-cis.json', snapshot)
            write(run / 'steps/cis.json', {**snapshot, 'step': 'cis', 'state': 'completed', 'job_id': '10004', 'finished_at': submitted})
            snapshot = {'run_id': identifier, 'dataset_id': dataset['id'], 'submitted_at': submitted,
                        'inputs': {}, 'settings': network_settings, 'resources': resource,
                        'input_sources': {}, 'source_cis_alpha': '0.05'}
            write(run / 'workspace-network.json', snapshot)
        elif active != 'genotype':
            snapshot = json.loads((run / 'workspace-expression.json').read_text())
        record = {**snapshot, 'step': active, 'flag': {'network': '-n', 'expression': '-t', 'genotype': '-g'}[active],
                  'attempt': attempt, 'state': state.lower() if job_id else 'unknown',
                  'remote_dir': str(remote), 'job_id': job_id, 'checked_at': 0,
                  'history': [{'state': state.lower() if job_id else 'unknown', 'at': submitted}]}
        write(run / 'steps' / (active + '.json'), record)
        for number in range(1, attempt):
            write(run / 'steps' / f'{active}.attempt{number}.json', {**record, 'attempt': number,
                'state': 'failed', 'job_id': str(9000 + number), 'reason': 'Immutable earlier attempt',
                'finished_at': submitted, 'history': [{'state': 'failed', 'at': submitted}]})
        if job_id:
            scheduler[job_id] = {'name': f'signet-{active}-{identifier}', 'state': state,
                                 'accounted': state, 'workdir': str(remote / 'work')}
    owned = root / 'remote/work/cancel-running-b/work/tmp/tmpn/stage1'
    owned.mkdir(parents=True)
    (owned / 'submit1_log').write_text('Submitted batch job 777\nSubmitted batch job 888\n')
    scheduler['777'] = {'name': 'owned-child', 'state': 'RUNNING', 'accounted': 'RUNNING', 'workdir': str(owned)}
    scheduler['888'] = {'name': 'unrelated-child', 'state': 'RUNNING', 'accounted': 'RUNNING', 'workdir': str(root / 'unrelated/work')}
    write(root / 'scheduler.json', scheduler)
    write(root / 'control.json', {'connected': True, 'fail_cancel': False})
    return {'datasets': datasets, 'pending': specs[0][0], 'running': specs[1][0], 'unknown': specs[2][0],
            'genotype': specs[3][0], 'error': specs[4][0],
            'project': str(project), 'inputs': str(inputs), 'root': str(root)}


def install_scheduler(root):
    folder = root / 'bin'
    folder.mkdir(exist_ok=True)
    for name, body in FAKE_SLURM.items():
        target = folder / name
        target.write_text('#!/bin/bash\n' + body + '\n')
        target.chmod(0o700)
    script = '''import json,os,pathlib,sys
root=pathlib.Path(os.environ['SIGNET_CANCEL_ROOT'])
jobs=json.loads((root/'scheduler.json').read_text());args=sys.argv[1:];command=pathlib.Path(sys.argv[0]).name
def forbidden():
    with (root/'forbidden.ndjson').open('a') as stream:stream.write(json.dumps([command,args])+'\\n')
    raise SystemExit(92)
if command=='scancel':
    if len(args)!=1 or args[0] not in ('12345','23456','34567','45678','777'):forbidden()
    with (root/'cancelled.txt').open('a') as stream:stream.write(args[0]+'\\n')
elif command=='squeue':
    if '-o' not in args:forbidden()
    fmt=args[args.index('-o')+1];job=jobs.get(args[args.index('-j')+1],{}) if '-j' in args else {}
    if fmt=='%i %j %Z':
        for identifier,value in jobs.items():
            if value.get('state'):print(identifier,value['name'],value['workdir'])
    elif fmt in ('%j','%T','%Z'):
        if job.get('state'):print(job.get({'%j':'name','%T':'state','%Z':'workdir'}[fmt],''))
    elif fmt=='%i':
        name=args[args.index('-n')+1] if '-n' in args else ''
        for identifier,value in jobs.items():
            if value.get('state') and value.get('name')==name:print(identifier)
    else:forbidden()
elif command=='sacct':
    if '-j' in args:print(jobs.get(args[args.index('-j')+1],{}).get('accounted',''))
    elif any(arg.startswith('--name=') for arg in args):pass
    else:forbidden()
else:forbidden()
'''
    for name in ('squeue', 'sacct', 'scancel', 'sbatch', 'apptainer'):
        target = folder / name
        target.write_text('#!' + sys.executable + '\n' + script)
        target.chmod(0o700)


def main():
    server = REPO / 'electron/main/backend/server.py'
    if sys.argv[1:3] != ['-u', str(server)]:
        raise ValueError('Expected the desktop backend command.')
    root = Path(os.environ['SIGNET_CANCEL_ROOT']).resolve()
    metadata = root / 'fixture.json'
    signet.PROJECT = root / 'project'
    if not metadata.exists():
        write(metadata, {**seed(root, signet.PROJECT), 'starts': []})
    install_scheduler(root)
    config = {'root': str(root / 'remote'), 'source': str(root / 'remote/software'),
              'image': str(root / 'remote/signet.sif'), 'executor': 'apptainer',
              'workRoot': str(root / 'remote/work'), 'partition': 'standard'}
    os.environ['SIGNET_DATASETS_STATE_FILE'] = str(signet.PROJECT / 'data/workspace-datasets.json')
    os.environ['SIGNET_HISTORY_STATE_FILE'] = str(signet.PROJECT / 'data/workspace-history.json')
    ssh_transport.available = lambda: json.loads((root / 'control.json').read_text())['connected']
    ssh_transport.environment = lambda: dict(config)

    def forbidden(label):
        with (root / 'forbidden.ndjson').open('a') as stream:
            stream.write(json.dumps(label) + '\n')
        raise AssertionError('Unexpected cancellation fixture action: ' + str(label))

    def remote(command, input=None, capture_output=False, timeout=None):
        script = input.decode() if input else ''
        if (command != 'bash -s' or not ('say squeue ' in script or 'say cancel ' in script)
                or any(value in script for value in ('sbatch ', 'apptainer ', 'tar ', 'rm '))
                or not any(str(root / 'remote/work' / run) in script for run in ('cancel-pending-a', 'cancel-running-b', 'cancel-unknown-b', 'cancel-genotype-a', 'cancel-error-b'))):
            forbidden([command, script])
        if 'say cancel ' in script and json.loads((root / 'control.json').read_text())['fail_cancel']:
            raise OSError('Controlled cancellation transport failure')
        with (root / 'commands.ndjson').open('a') as stream:
            stream.write(json.dumps(script) + '\n')
        env = {'PATH': str(root / 'bin') + ':/usr/bin:/bin', 'SIGNET_CANCEL_ROOT': str(root), 'LANG': 'C'}
        return subprocess.run(['bash', '-c', command], input=input or b'', capture_output=True, timeout=timeout, env=env)

    ssh_transport.remote = remote
    jobs.submit = lambda *args, **kwargs: forbidden(['submit', args, kwargs])
    original_cancel = jobs.cancel

    def cancel(run_id, name, *args, **kwargs):
        with (root / 'requests.ndjson').open('a') as stream:
            stream.write(json.dumps({'run_id': run_id, 'step': name, 'args': args, 'kwargs': kwargs}) + '\n')
        return original_cancel(run_id, name, *args, **kwargs)

    jobs.cancel = cancel
    from agent.app import chat_ui
    original_server = chat_ui.create_server

    def create_server(*args, **kwargs):
        saved = json.loads(metadata.read_text())
        kwargs['port'] = saved.get('port', 0)
        instance = original_server(*args, **kwargs)
        write(metadata, {**saved, 'port': instance.server_port, 'starts': [*saved['starts'], os.getpid()]})
        return instance

    chat_ui.create_server = create_server
    sys.argv = [str(server), *sys.argv[3:]]
    runpy.run_path(str(server), run_name='__main__')


if __name__ == '__main__':
    main()
