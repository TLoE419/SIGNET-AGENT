#!/usr/bin/env python3
"""List SIGNET res*/tmp* files (path, size, mtime only) and diff against a submit-time snapshot."""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fixture_io as io  # noqa: E402


def snapshot(signet_dir):
    """Map relative path -> {size, mtime}; never reads file contents, never follows symlinks."""
    root = Path(signet_dir)
    paths = []
    for top in sorted(root.glob('res*')) + sorted(root.glob('tmp*')):
        if top.is_dir() and not top.is_symlink():
            paths.extend(Path(folder) / name for folder, _, names in os.walk(str(top)) for name in names)
        else:
            paths.append(top)
    files = {}
    for path in paths:
        if path.is_file() and not path.is_symlink():
            info = path.stat()
            files[str(path.relative_to(root))] = {'size': info.st_size,
                                                  'mtime': io.iso_from_timestamp(info.st_mtime)}
    return files


def diff(before, after):
    return {
        'new': sorted(p for p in after if p not in before),
        'changed': sorted(p for p in after if p in before and after[p] != before[p]),
        'removed': sorted(p for p in before if p not in after),
        'files': {p: after[p] for p in after if before.get(p) != after[p]},
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('before', 'after'))
    parser.add_argument('--signet-dir', required=True)
    parser.add_argument('--fixture-dir', required=True)
    args = parser.parse_args(argv)
    fixture = Path(args.fixture_dir)
    files = snapshot(args.signet_dir)
    if args.mode == 'before':
        io.write_json(fixture / 'outputs_before.json', files)
        return
    io.write_json(fixture / 'outputs.json', files)
    before_path = fixture / 'outputs_before.json'
    if not before_path.is_file():
        sys.exit('outputs_before.json is missing; diff not written.')
    io.write_json(fixture / 'outputs_diff.json', diff(json.loads(before_path.read_text()), files))


if __name__ == '__main__':
    main()
