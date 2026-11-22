"""Persistent history-only desktop fixture; every remote operation is forbidden."""

import json
import os
from pathlib import Path
import runpy
import sys

REPO = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(REPO), str(Path(__file__).parent)]


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def seed(project):
    from custom_dataset_backend import archived_run
    from agent.tools import signet

    datasets = []
    for name in ('history-a', 'history-b'):
        folder = project / 'data' / name
        inputs = {'genotype': [str(folder / 'study.ped'), str(folder / 'study.map')],
                  'expression': [str(folder / 'expression.txt')], 'clinical': [str(folder / 'clinical.tsv')]}
        for paths in inputs.values():
            for filename in paths:
                path = Path(filename)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('Immutable original ' + path.name + '\n')
        record = {'id': name, 'name': [name, name], 'folder': str(folder), 'inputs': inputs}
        write(project / 'data/datasets' / (name + '.json'), record)
        datasets.append(record)

    def run(identifier):
        result = signet.configure_signet(identifier)
        if result['status'] != 'created':
            raise ValueError(result)
        root = project / 'runs' / identifier
        signet._update(root, {'mind': '0.98765', 'nboots': '9876'})
        return root

    saved_inputs = {'ped.file': datasets[0]['inputs']['genotype'][0],
                    'map.file': datasets[0]['inputs']['genotype'][1],
                    'ref': str(project / 'data/reference/chr'), 'gmap': str(project / 'data/gmap/chr')}
    settings = {'mind': '0.2', 'geno': '0.1', 'hwe': '0.0001', 'int': '5000000', 'restrict.tcga.geno': '2'}
    job = {'step': 'genotype', 'flag': '-g', 'state': 'completed', 'job_id': 'fixture-31',
           'submitted_at': '2026-11-10T01:00:00-0800', 'finished_at': '2026-11-10T01:01:00-0800',
           'inputs': saved_inputs, 'settings': settings, 'resources': {'cpus': 2, 'mem_gb': 8, 'hours': 1},
           'progress': {'percent': 100}}

    def genotype(root):
        write(root / 'steps/genotype.json', {**job, 'run_id': root.name})
        output = root / 'work/res/resg'
        output.mkdir(exist_ok=True)
        (output / 'signet_Geno').write_text('0 1 2\n1 2 0\n')
        (output / 'signet_Genotype.sampleID').write_text('TCGA-AA-A001-NT\nTCGA-AA-A002-NT\n')

    generic = run('old-slurm')
    genotype(generic)
    write(generic / 'steps/expression.json', {'run_id': generic.name, 'step': 'expression', 'flag': '-t',
        'state': 'failed', 'job_id': 'fixture-32', 'settings': {'restrict.tcga': '2'},
        'inputs': {'gexp.file': datasets[0]['inputs']['expression'][0], 'pmap.file': str(project / 'data/annotation.gtf')},
        'resources': {'cpus': 3, 'mem_gb': 16}, 'reason': 'Controlled historical failure',
        'submitted_at': '2026-11-10T01:02:00-0800', 'finished_at': '2026-11-10T01:03:00-0800'})
    write(generic / 'steps/expression.attempt1.json', {'run_id': generic.name, 'step': 'expression',
        'state': 'failed', 'job_id': 'fixture-30', 'settings': {'restrict.tcga': '1'},
        'inputs': {'gexp.file': 'old-expression.txt'}, 'resources': {'cpus': 1}, 'attempt': 1})

    agent = run('old-agent')
    write(agent / 'genotype_tcga.json', {'operation': 'genotype_tcga', 'status': 'process_completed',
        'executed': True, 'returncode': 0, 'settings_file': str(agent / 'work/config.ini'),
        'output_files': ['work/res/resg/signet_Geno'], 'stdout_log': str(agent / 'logs/genotype.stdout')})
    prepared = agent / 'network.config.ini'
    prepared.write_text('cohort = TCGA\nnboots = 7\ncor = 0.25\n')
    write(agent / 'network.plan.json', {'operation': 'network', 'argv': ['bash', str(agent / 'work/signet'), '-n'],
        'settings_file': str(agent / 'work/config.ini'), 'settings_snapshot': str(prepared),
        'manual_prerequisite': 'Preparation never executes this plan.'})
    run('configured-only')

    visualization = run('old-visualization')
    visual_inputs = {}
    for key, name, text in [('Afreq', 'frequencies', '0 .5\n1 0\n.5 0\n'),
                            ('coef', 'coefficients', '0 .2\n-.4 0\n.1 0\n'),
                            ('vis.genepos', 'positions', 'MEGF6 chr2 1 10\nGENE1 chr2 11 20\nOTHER chr2 21 30\n')]:
        filename = visualization / 'work/data' / name
        filename.write_text(text)
        visual_inputs[key] = str(filename)
    signet._update(visualization, {**visual_inputs, 'freq': '0.45', 'ntop': '1'})
    write(visualization / 'visualization.json', {'operation': 'visualization', 'status': 'verified_completed',
        'executed': True, 'returncode': 0, 'verification': {'completion_marker': True, 'exported_edges': 3,
            'pdf_and_html_assets_checked': True}, 'settings_file': str(visualization / 'work/config.ini'),
        'settings': {'freq': '0.45', 'ntop': '1', 'resv': str(visualization / 'work/res/resv/signet')}})
    (visualization / 'work/res/resv/signet_edgelist_0.45.txt').write_text(
        'source_gene_symbol,target_gene_symbol,frequency,coefficient\n'
        'MEGF6,GENE1,0.5,0.2\nGENE1,MEGF6,1,-0.4\nGENE1,OTHER,0.5,0.1\n')
    signet._update(visualization, {'freq': '0.9'})

    shared = run('shared-run')
    genotype(shared)
    write(shared / 'workspace-genotype.json', {'run_id': shared.name, 'dataset_id': datasets[0]['id'],
        'submitted_at': job['submitted_at'], 'inputs': saved_inputs, 'settings': settings, 'resources': job['resources']})

    for identifier, dataset in [('shared-run', datasets[1]), ('orphan-archive', {
            'id': 'retired-dataset', 'name': ['已移除的資料組', 'Retired dataset'],
            'inputs': {'genotype': ['retired.ped', 'retired.map'], 'expression': ['retired.txt'], 'clinical': ['retired.tsv']}})]:
        old = project / 'data/stage6-results' / archived_run(project, dataset)
        target = old.with_name(identifier)
        old.rename(target)
        for filename in ('history.json', 'verification.json', 'stage3.json', 'stages.json'):
            value = json.loads((target / filename).read_text())
            key = 'run' if filename == 'verification.json' else 'run_id'
            value[key] = identifier
            write(target / filename, value)
    return {'datasets': datasets, 'shared': shared.name, 'generic': generic.name, 'agent': agent.name,
            'configured': 'configured-only', 'orphan': 'orphan-archive', 'visualization': visualization.name}


def main():
    server = REPO / 'electron/main/backend/server.py'
    if sys.argv[1:3] != ['-u', str(server)]:
        raise ValueError('Expected the desktop backend command.')
    from agent.app import chat_ui
    from agent.runtime import ssh_transport
    import agent.tools.signet as signet

    root = Path(os.environ['SIGNET_HISTORY_TEST_ROOT']).resolve()
    metadata = root / 'fixture.json'
    signet.PROJECT = root / 'project'
    os.environ['SIGNET_DATASETS_STATE_FILE'] = str(signet.PROJECT / 'data/workspace-datasets.json')
    os.environ['SIGNET_HISTORY_STATE_FILE'] = str(signet.PROJECT / 'data/workspace-history.json')
    ssh_transport.available = lambda: False

    def forbidden(*args, **kwargs):
        with (root / 'forbidden-remote.ndjson').open('a') as stream:
            stream.write(json.dumps({'args': str(args)}) + '\n')
        raise AssertionError('History browsing must not make any remote request.')

    ssh_transport.remote = forbidden
    if not metadata.exists():
        write(metadata, {'project': str(signet.PROJECT), 'starts': [], **seed(signet.PROJECT)})
    original = chat_ui.create_server

    def create_server(*args, **kwargs):
        saved = json.loads(metadata.read_text())
        kwargs['port'] = saved.get('port', 0)
        instance = original(*args, **kwargs)
        write(metadata, {**saved, 'port': instance.server_port, 'starts': [*saved['starts'], os.getpid()]})
        return instance

    chat_ui.create_server = create_server
    sys.argv = [str(server), *sys.argv[3:]]
    runpy.run_path(str(server), run_name='__main__')


if __name__ == '__main__':
    main()
