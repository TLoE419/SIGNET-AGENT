"""Packing a run for HPC3 and unpacking its downloaded results (used by signet_jobs)."""
import io
import json
from pathlib import Path
import re
import shlex
import tarfile


def bundle(root, settings, remote_root):
    """The run folder sent to HPC3: the audited SIGNET scripts and its config.ini, never the
    project or credentials. Paths in config.ini are rewritten to the HPC3 run folder."""
    from agent.runtime.ssh_transport import available, environment, runtime_module_prelude
    runtime = environment() if available() else None
    buffer = io.BytesIO()
    work = root / 'work'
    config = (work / 'config.ini').read_text()
    if runtime:
        # SIGNET reads settings with sed '/^key[ ]*= /' (config_controller.sh get_param): the space
        # after "=" is required, or `signet -s --queue` answers "Please check the file name".
        config = re.sub(r'^queue\s*=.*$', 'queue = ' + runtime['partition'], config, flags=re.MULTILINE)
    config = config.replace(str(work), remote_root + '/work')
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        archive.add(work / 'signet', arcname='work/signet')
        archive.add(work / 'script', arcname='work/script')
        if runtime:
            runtime_data = json.dumps(runtime).encode()
            info = tarfile.TarInfo('runtime.json')
            info.size, info.mode = len(runtime_data), 0o600
            archive.addfile(info, io.BytesIO(runtime_data))
            wrapper = ('#!/bin/bash\n' + runtime_module_prelude(runtime) + '\nexec '
                       + shlex.quote(runtime['executor']) + ' "$@"\n').encode()
            info = tarfile.TarInfo('work/bin/singularity')
            info.size, info.mode = len(wrapper), 0o700
            archive.addfile(info, io.BytesIO(wrapper))
        data = config.encode()
        info = tarfile.TarInfo('work/config.ini')
        info.size = len(data)
        info.mode = 0o600
        archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def restore_outputs(root, data, *, required=()):
    # Validate the entire archive before writing anything received from HPC3.
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = archive.getmembers()
        nonempty = {item.name for item in members if item.isfile() and item.size > 0}
        if not nonempty.issuperset(required):
            raise ValueError('Download is missing required non-empty outputs.')
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
