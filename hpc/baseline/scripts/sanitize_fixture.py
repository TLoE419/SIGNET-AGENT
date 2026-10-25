#!/usr/bin/env python3
"""Copy a raw fixture into the repo with account, user, path, node and UID values replaced.

The repository is public. Raw fixtures stay on HPC3; only the sanitized copy is committed.
Replacements are plain text substitutions with fixed placeholders, so the structure and
format that parsers depend on are preserved.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import sys

TEXT_SUFFIXES = {'.json', '.jsonl', '.txt', '.log', '.md'}
NODE = re.compile(r'\bhpc3-[A-Za-z0-9\[\]-]+(?:,[A-Za-z0-9\[\]-]+)*')
LOGIN = re.compile(r'\blogin-i\d+\b')
UID = re.compile(r'\b(CANCELLED by )\d+')


def literal_pairs(user, account, paths):
    """(pattern, placeholder), longest value first so a path goes before the user inside it.

    Values only match as whole tokens, so a short user name does not rewrite ordinary words.
    """
    pairs = [(value.rstrip('/'), '<%s>' % name) for name, value in paths.items() if value]
    pairs += [(account, '<ACCOUNT>'), (user, '<USER>')]
    pairs = sorted([pair for pair in pairs if pair[0]], key=lambda pair: -len(pair[0]))
    return [(re.compile(r'(?<![A-Za-z0-9_])' + re.escape(old) + r'(?![A-Za-z0-9_])'), new)
            for old, new in pairs]


def node_map(texts):
    names = sorted({m.group(0) for text in texts for m in NODE.finditer(text)})
    return {name: 'hpc3-node-%02d' % index for index, name in enumerate(names, 1)}


def sanitize_text(text, pairs, nodes):
    for pattern, new in pairs:
        text = pattern.sub(new, text)
    text = NODE.sub(lambda m: nodes[m.group(0)], text)
    text = LOGIN.sub('login-node', text)
    return UID.sub(r'\1<UID>', text)


def sanitize(source, destination, user, account, paths):
    source, destination = Path(source), Path(destination)
    if destination.exists():
        raise FileExistsError('%s already exists; fixtures are never overwritten.' % destination)
    files = sorted(p for p in source.rglob('*') if p.is_file() and not p.is_symlink())
    skipped = [str(p.relative_to(source)) for p in files if p.suffix not in TEXT_SUFFIXES]
    texts = {p: p.read_text(errors='replace') for p in files if p.suffix in TEXT_SUFFIXES}
    pairs, nodes = literal_pairs(user, account, paths), node_map(texts.values())
    clean = {p: sanitize_text(t, pairs, nodes) for p, t in texts.items()}
    leftovers = sorted(str(p.relative_to(source)) for p, t in clean.items()
                       if any(pattern.search(t) for pattern, _ in pairs))
    if leftovers:
        raise ValueError('Sensitive values remain after replacement in: ' + ', '.join(leftovers))
    temporary = destination.with_name(destination.name + '.partial')
    if temporary.exists():
        shutil.rmtree(str(temporary))
    for path, text in clean.items():
        target = temporary / path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
    os.replace(str(temporary), str(destination))
    return {'files': len(clean), 'skipped_non_text': skipped, 'nodes': len(nodes)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('source', help='Raw fixture directory, e.g. fixtures/<run_id>')
    parser.add_argument('destination', help='New directory, e.g. tests/fixtures/slurm/<run_id>')
    parser.add_argument('--user', default=os.environ.get('USER'))
    parser.add_argument('--account', default=os.environ.get('LAB_ACCOUNT'))
    args = parser.parse_args(argv)
    if not args.user or not args.account:
        parser.error('--user and --account (or USER / LAB_ACCOUNT) are required')
    baseline = os.environ.get('BASELINE_DIR') or str(Path(__file__).resolve().parents[1])
    paths = {'SIGNET_DIR': os.environ.get('SIGNET_DIR'), 'BASELINE_DIR': baseline,
             'HOME': os.environ.get('HOME')}
    try:
        print(json.dumps(sanitize(args.source, args.destination, args.user, args.account, paths)))
    except (FileExistsError, ValueError) as error:
        sys.exit(str(error))


if __name__ == '__main__':
    main()
