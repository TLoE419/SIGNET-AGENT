"""Install only hash-audited official code; never import upstream study/example data."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile

PROJECT = Path(__file__).resolve().parents[1]
INVENTORY = json.loads((PROJECT / 'signet_inventory.json').read_text())
DEFAULT_DESTINATION = PROJECT / '.dependencies/official-signet'
LICENSES = ('LICENSE.txt', 'LICENSE_THIRD_PARTY.md')


def install(destination=DEFAULT_DESTINATION, checkout=None):
    destination = destination.expanduser().absolute()
    if destination.exists() or destination.is_symlink():
        raise ValueError('Destination already exists; use a new destination. Existing files are never replaced.')
    items = INVENTORY['scripts'] + INVENTORY['support_files']
    expected = {item['path']: item['sha256'] for item in items}
    selected = sorted(set(expected) | set(LICENSES))
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='signet-source-') as fetch_dir, \
            tempfile.TemporaryDirectory(prefix='.source-', dir=destination.parent) as stage_dir:
        repository = Path(checkout).resolve() if checkout else Path(fetch_dir)
        if not checkout:
            subprocess.run(['git', 'init', '--quiet', str(repository)], check=True)
            subprocess.run(['git', '-C', str(repository), 'fetch', '--quiet', '--depth=1',
                            INVENTORY['repository'], INVENTORY['revision']], check=True, timeout=300)
        # Archive the exact commit, never the checkout's uncommitted content.
        result = subprocess.run(['git', '-C', str(repository), 'archive', INVENTORY['revision'], '--',
                                 *selected], check=True, capture_output=True, timeout=120)
        stage = Path(stage_dir) / 'source'
        stage.mkdir()
        found = set()
        with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
            for member in archive:
                if member.isdir():
                    continue
                if not member.isfile() or member.name not in selected or member.name in found:
                    raise ValueError('Unexpected source archive member.')
                data = archive.extractfile(member).read()
                if member.name in expected and hashlib.sha256(data).hexdigest() != expected[member.name]:
                    raise ValueError('Source hash mismatch: ' + member.name)
                target = stage / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                target.chmod(member.mode & 0o755)
                found.add(member.name)
        if found != set(selected):
            raise ValueError('Pinned source is incomplete: ' + ', '.join(sorted(set(selected) - found)))
        if destination.exists() or destination.is_symlink():
            raise ValueError('Destination changed during preparation; nothing installed.')
        # The stage is on the destination filesystem, so successful installation is atomic.
        stage.rename(destination)
    return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, default=DEFAULT_DESTINATION)
    parser.add_argument('--from-checkout', type=Path, help='Read the pinned commit from an existing local Git checkout.')
    args = parser.parse_args()
    try:
        installed = install(args.destination, args.from_checkout)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise SystemExit(f'Source setup failed ({type(exc).__name__}): {exc}')
    print(f'Installed audited code at {installed}; no example/reference data was installed.')
