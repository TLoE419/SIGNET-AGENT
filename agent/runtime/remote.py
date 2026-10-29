"""Stage 4 transport to the existing local SIGNET VM and official image."""
import io
import json
import os
from pathlib import Path
import shlex
import re
import subprocess
import tarfile

from agent.paths import PROJECT_ROOT

PROJECT = PROJECT_ROOT
HOST_PROJECT = PROJECT / '.dependencies/scientific-runtime'
IMAGE = '/work/evidence/signet-0.0.6.sif'
INPUT_KEYS = ('matched.gexp', 'matched.gexp.withpc', 'matched.geno',
              'snps.map', 'snps.maf', 'gene.pos')


def host_project():
    value = os.environ.get('SIGNET_RUNTIME_PROJECT')
    return (PROJECT / Path(value).expanduser()).resolve() if value else HOST_PROJECT


def image_path():
    value = os.environ.get('SIGNET_CONTAINER_IMAGE') or IMAGE
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', value) or '..' in Path(value).parts:
        raise ValueError('SIGNET_CONTAINER_IMAGE must be an absolute VM path using letters, digits, _, ., / or -.')
    return value


def ssh_args():
    port = os.environ.get('SIGNET_SSH_PORT') or '2226'
    if not port.isascii() or not port.isdigit() or not 1 <= int(port) <= 65535:
        raise ValueError('SIGNET_SSH_PORT must be between 1 and 65535.')
    project = host_project()
    return ['ssh', '-F', '/dev/null', '-i', str(project / 'vm/id_ed25519'),
            '-p', port, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes',
            '-o', 'UserKnownHostsFile=' + str(project / 'vm/known_hosts'),
            'root@127.0.0.1']


def remote(command, **kwargs):
    from agent.runtime.ssh_transport import available, remote as electron_remote
    if available():
        return electron_remote(command, **kwargs)
    return subprocess.run(ssh_args() + [command], env={
        'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(Path.home()),
        'LANG': 'C'}, **kwargs)


def preflight():
    command = (f'test -s {image_path()} && command -v timeout >/dev/null && '
               f'singularity exec --cleanenv --no-home {image_path()} sh -c ' + shlex.quote(
                   'test "$(uname -s)" = Linux && command -v Rscript && '
                   'command -v ParaFly && command -v getopt && '
                   'Rscript -e \'stopifnot(requireNamespace("data.table", quietly=TRUE))\''))
    try:
        result = remote(command, capture_output=True, timeout=30)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def bundle(root, settings, remote_root, input_keys=INPUT_KEYS, network=False):
    """Send audited scripts and six validated inputs, never the project or credentials."""
    buffer = io.BytesIO()
    work = root / 'work'
    config = (work / 'config.ini').read_text()
    replacements = {str(work): remote_root + '/work'}
    for index, key in enumerate(input_keys):
        replacements[settings[key]] = f'{remote_root}/inputs/{index}'
    for old in sorted(replacements, key=len, reverse=True):
        config = config.replace(old, replacements[old])
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        archive.add(work / 'signet', arcname='work/signet')
        if not network:
            archive.add(work / 'script', arcname='work/script')
        else:
            # Only deployment copies change: the official statistical scripts stay pinned.
            from agent.tools.signet import INVENTORY
            selected = [item['path'] for item in INVENTORY['scripts'] if item['path'].startswith('script/')]
            selected += [item['path'] for item in INVENTORY['support_files']
                         if item['path'].startswith('script/network/template.sub')]
            for relative in sorted(set(selected)):
                path = work / relative
                data = path.read_bytes()
                if path.name in ('bts1gensub.sh', 'bts2gensub.sh'):
                    data = data.replace(b'time sh qsub', b'time bash qsub')
                if path.name == 'template.sub.ori':
                    data = data.replace(b'#SBATCH -N 1', b'#SBATCH -N 1\n#SBATCH --mem=4G')
                info = tarfile.TarInfo('work/' + str(path.relative_to(work)))
                info.size, info.mode = len(data), path.stat().st_mode & 0o777
                archive.addfile(info, io.BytesIO(data))
            archive.add(Path(__file__).with_name('network_worker.py'), arcname='network_worker.py')
        data = config.encode()
        info = tarfile.TarInfo('work/config.ini')
        info.size = len(data)
        info.mode = 0o600
        archive.addfile(info, io.BytesIO(data))
        for index, key in enumerate(input_keys):
            archive.add(settings[key], arcname=f'inputs/{index}')
    return buffer.getvalue()


def restore_outputs(root, data):
    # Validate the entire archive before writing anything received from the VM.
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = archive.getmembers()
        for item in members:
            path = Path(item.name)
            if (path.is_absolute() or '..' in path.parts or
                    path.parts[:2] not in (('work', 'res'), ('work', 'tmp'), ('work', 'data')) or
                    not (item.isdir() or item.isfile())):
                raise ValueError('Unexpected runtime output path or file type.')
            target = root / path
            if any(p.is_symlink() for p in [target, *target.parents]):
                raise ValueError('Output path contains a symbolic link.')
            if item.isfile() and target.exists():
                raise ValueError('Refusing to overwrite an existing output.')
        for item in members:
            target = root / item.name
            if item.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as stream:
                    stream.write(archive.extractfile(item).read())
    return sorted(item.name for item in members if item.isfile())


def execute_cis(root, settings, seconds=1800):
    remote_root = '/tmp/signet-agent/' + root.name
    plan = {'operation': 'cis_eqtl', 'runtime': 'existing-docker-vm',
            'remote_directory': remote_root, 'container_image': image_path(),
            'settings_file': str(root / 'work/config.ini')}
    if not preflight():
        return {'status': 'unavailable', 'executed': False, **plan,
                'missing_dependencies': ['Existing SIGNET VM / official image runtime'],
                'reason': 'The configured local VM did not pass its runtime check. See docs/ADVANCED.md; no analysis started.'}
    if any((root / 'work' / name).exists() for name in ('tmp/tmpc', 'data/cis-eQTL')):
        raise ValueError('Stage 4 intermediate files already exist; use a new run.')
    record = root / 'cis_eqtl.json'
    outpath, errpath = root / 'logs/cis_eqtl.stdout', root / 'logs/cis_eqtl.stderr'
    try:
        upload = remote('umask 077; mkdir -p /tmp/signet-agent && mkdir ' + remote_root +
                        ' && tar xzf - -C ' + remote_root,
                        input=bundle(root, settings, remote_root), capture_output=True, timeout=60)
        if upload.returncode:
            return {'status': 'blocked', 'executed': False, **plan,
                    'reason': 'Could not create a fresh remote run; no analysis was started.'}
        # A VM-side timeout also stops workers if the local connection disappears.
        command = (f'cd {remote_root}/work && mkdir -p tmp data res/resc && '
                   f'timeout -k 5 {seconds}s singularity exec --cleanenv --no-home '
                   '--env OPENBLAS_NUM_THREADS=1,OMP_NUM_THREADS=1,MKL_NUM_THREADS=1 '
                   f'--bind {remote_root}:{remote_root} {image_path()} bash ./signet -c')
        record.write_text(json.dumps({'status': 'starting', 'executed': False, **plan}) + '\n')
        with outpath.open('xb') as stdout, errpath.open('xb') as stderr:
            result = remote(command, stdout=stdout, stderr=stderr, timeout=seconds + 30)
        status = 'timed_out' if result.returncode in (124, 137) else 'process_completed' if result.returncode == 0 else 'failed'
        fetched = remote(f'cd {remote_root} && tar czf - work/res work/tmp work/data',
                         capture_output=True, timeout=60)
        if fetched.returncode:
            raise OSError('Could not retrieve runtime output; inspect the recorded remote directory before retrying.')
        outputs = restore_outputs(root, fetched.stdout)
        required = ['_all.sig.pValue_' + settings['alpha.cis'], '_all.eQTL.data',
                    '_net.gexp.data', '_net.genepos', '_net.genename']
        prefix = root / 'work/res/resc/signet'
        missing = [suffix for suffix in required if not Path(str(prefix) + suffix).is_file()
                   or not Path(str(prefix) + suffix).stat().st_size]
        errors = errpath.read_text(errors='replace')
        if status == 'process_completed' and (missing or 'Execution halted' in errors or 'Error in ' in errors):
            status = 'failed'
        value = {'status': status, 'executed': True, **plan, 'returncode': result.returncode,
                 'output_files': outputs, 'stdout_log': str(outpath), 'stderr_log': str(errpath),
                 'missing_required_outputs': missing,
                 'summary': 'Outputs and logs require review; process completion is not scientific validation.'}
    except (OSError, ValueError, subprocess.TimeoutExpired, KeyboardInterrupt) as exc:
        value = {'status': 'unknown', 'executed': 'unknown', **plan,
                 'reason': 'Runtime connection or output transfer interrupted; do not replay this run. '
                           'The VM-side timeout bounds any started analysis.',
                 'error_type': type(exc).__name__}
    record.write_text(json.dumps(value, indent=2) + '\n')
    return value
