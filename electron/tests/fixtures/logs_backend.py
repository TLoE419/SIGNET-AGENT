"""Read-only local and remote-log fixtures, isolated from actual SSH and science."""

import copy
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys

REPO = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(REPO), str(Path(__file__).parent)]
from attempts_backend import seed as seed_attempts
from history_backend import write
from agent.runtime import signet_jobs as jobs, ssh_transport
import agent.tools.signet as signet


def seed(root, project):
    saved = seed_attempts(project)
    shared = project / 'runs' / saved['shared']
    remote = root / 'remote' / saved['shared']
    (remote / 'steps').mkdir(parents=True)
    owner_token = '0123456789abcdef0123456789abcdef'
    write(shared / 'steps/remote.owner', {'remote_dir': str(remote), 'token': owner_token})
    (remote / '.owner').write_text(owner_token + '\n')
    inputs = {'gexp.file': saved['datasets'][0]['inputs']['expression'][0], 'pmap.file': str(root / 'annotation.gtf')}
    resources = {'cpus': 2, 'mem_gb': 8, 'hours': 1}
    snapshot = {'run_id': shared.name, 'dataset_id': saved['datasets'][0]['id'],
                'submitted_at': '2026-11-17T10:03:00-0800', 'inputs': inputs,
                'settings': {'restrict.tcga': '2'}, 'resources': resources}
    write(shared / 'workspace-expression.json', snapshot)
    for number in (1, 2, 3):
        record = copy.deepcopy(snapshot)
        record.update(step='expression', attempt=number, job_id=str(1000 + number),
                      state='cancelled' if number == 2 else 'failed', remote_dir=str(remote),
                      submitted_at=f'2026-11-17T10:0{number}:00-0800',
                      finished_at=f'2026-11-17T10:1{number}:00-0800',
                      reason='Controlled expression preprocessing failed' if number != 2 else 'Recorded cancellation',
                      exit_code='2' if number != 2 else None,
                      missing_outputs=['res/rest/signet_gexp'] if number != 2 else [],
                      failure_hints=['Expression output file was not produced'] if number != 2 else [],
                      history=[{'state': 'failed' if number != 2 else 'cancelled', 'at': f'2026-11-17T10:1{number}:00-0800'}])
        name = 'expression.json' if number == 3 else f'expression.attempt{number}.json'
        write(shared / 'steps' / name, record)
        marker = 'expression.job' if number == 3 else f'expression.attempt{number}.job'
        (remote / 'steps' / marker).write_text(str(1000 + number) + '\n')
    (remote / 'steps/expression.out').write_text(''.join(f'CURRENT attempt3 stdout line {index} ' + 'x' * 400 + '\n' for index in range(250)))
    (remote / 'steps/expression.err').write_text(
        'Error: controlled expression preprocessing failed\n'
        'Missing output: res/rest/signet_gexp\n'
        '<img src=x onerror="window.__signetLogExecuted=true">\n')
    (remote / 'steps/expression.attempt1.err').write_text('OLD attempt1 stderr: original expression failure\n')
    unreadable = remote / 'steps/expression.attempt1.out'
    unreadable.write_text('This unreadable file is never an empty log\n')
    unreadable.chmod(0)
    (remote / 'steps/expression.attempt2.out').touch()
    # No attempt2 stderr exists: it must not fall back to the current error log.
    (shared / 'steps/expression.err').write_text('STALE local current stderr: belongs to an earlier job\n')
    (shared / 'steps/expression.job').write_text('1001\n')

    archived = project / 'data/stage6-results' / shared.name
    report = json.loads((archived / 'verification.json').read_text())
    report['jobs']['expression'].update(attempt=3, job_id='2003')
    write(archived / 'verification.json', report)
    write(archived / 'steps/expression.attempt1.json', {'run_id': shared.name, 'step': 'expression',
        'attempt': 1, 'job_id': '2001', 'state': 'failed', 'settings': {'restrict.tcga': '1'},
        'reason': 'Archived original expression failure', 'missing_outputs': ['res/rest/archive-gexp']})
    (archived / 'steps/expression.err').write_text('ARCHIVE attempt3 stderr: preserved archive warning\n')
    (archived / 'steps/expression.job').write_text('2003\n')
    (archived / 'steps/expression.attempt1.err').write_text('ARCHIVE attempt1 stderr: separate saved failure\n')
    (archived / 'steps/expression.attempt1.job').write_text('2001\n')

    recorded = project / 'runs' / saved['generic']
    (recorded / 'steps/expression.err').write_text('RECORDED attempt4 stderr: local legacy result\n')
    (recorded / 'steps/expression.job').write_text('804\n')
    agent = project / 'runs' / saved['agent']
    operation = json.loads((agent / 'genotype_tcga.json').read_text())
    hostile = root / 'outside-operation.stdout'
    hostile.write_text('OUTSIDE operation pointer must never be read\n')
    operation.update(stdout_log=str(hostile), stderr_log=str(hostile))
    write(agent / 'genotype_tcga.json', operation)
    (agent / 'logs/genotype_tcga.stdout').write_text('AGENT operation stdout: saved controlled result\n')
    (agent / 'logs/genotype_tcga.stderr').write_text('AGENT operation stderr: saved warning\n')
    write(root / 'control.json', {'connected': True, 'fail_remote': False})
    return {**saved, 'project': str(project), 'remote': str(remote), 'root': str(root)}


def main():
    server = REPO / 'electron/main/backend/server.py'
    if sys.argv[1:3] != ['-u', str(server)]:
        raise ValueError('Expected the desktop backend command.')
    root = Path(os.environ['SIGNET_LOGS_ROOT']).resolve()
    metadata = root / 'fixture.json'
    signet.PROJECT = root / 'project'
    if not metadata.exists():
        write(metadata, {**seed(root, signet.PROJECT), 'starts': []})
    saved = json.loads(metadata.read_text())
    remote_root = Path(saved['remote'])
    allowed = {str(path) for path in (remote_root / 'steps').glob('*')}
    allowed.add(str(remote_root / 'steps/expression.attempt2.err'))
    os.environ['SIGNET_DATASETS_STATE_FILE'] = str(signet.PROJECT / 'data/workspace-datasets.json')
    os.environ['SIGNET_HISTORY_STATE_FILE'] = str(signet.PROJECT / 'data/workspace-history.json')
    ssh_transport.available = lambda: json.loads((root / 'control.json').read_text())['connected']
    ssh_transport.environment = lambda: {'root': str(root / 'remote'), 'source': str(root / 'remote/software'),
        'image': str(root / 'remote/signet.sif'), 'executor': 'apptainer', 'workRoot': str(root / 'remote'), 'partition': 'standard'}

    def forbidden(value):
        with (root / 'forbidden.ndjson').open('a') as stream:
            stream.write(json.dumps(value) + '\n')
        raise AssertionError('Unexpected read-only log fixture action: ' + str(value))

    def remote(command, input=None, capture_output=False, timeout=None):
        script = input.decode() if command == 'bash -s' and input else command
        if ('tail ' not in script or not any(filename in script for filename in allowed)
                or any(token in script for token in ('sbatch ', 'scancel ', 'apptainer ', 'tar ', 'mkdir ', 'rm ', 'mv ', 'cp '))):
            forbidden([command, script])
        with (root / 'remote-requests.ndjson').open('a') as stream:
            stream.write(json.dumps(script) + '\n')
        if json.loads((root / 'control.json').read_text())['fail_remote']:
            raise OSError('Controlled read-only log transport failure')
        env = {'PATH': '/usr/bin:/bin', 'LANG': 'C'}
        return subprocess.run(['bash', '-c', command], input=input or b'', capture_output=True, timeout=timeout, env=env)

    ssh_transport.remote = remote
    jobs.submit = lambda *args, **kwargs: forbidden(['submit', args, kwargs])
    jobs.cancel = lambda *args, **kwargs: forbidden(['cancel', args, kwargs])
    from agent.app import chat_ui
    original = chat_ui.create_server
    original_get = chat_ui.ChatHandler.do_GET

    def get(self):
        if self.path.startswith('/signet/history/') and '/log' in self.path:
            with (root / 'requests.ndjson').open('a') as stream:
                stream.write(json.dumps(self.path) + '\n')
        return original_get(self)

    chat_ui.ChatHandler.do_GET = get

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
