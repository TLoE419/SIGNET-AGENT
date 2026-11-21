"""Read-only resource/provenance checks for a study-specific TCGA Stage 1."""
import gzip
import hashlib
import json
import math
import os
import re
import stat
import sys
import time

BLOCKED = ('/tmp', '/var/tmp', '/dev/shm', '/run')


def identity(info):
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


def text(path):
    with open(path, 'rb') as stream:
        compressed = stream.read(2) == b'\x1f\x8b'
    return gzip.open(path, 'rt') if compressed else open(path)


def chromosome(value):
    return value[3:] if value.lower().startswith('chr') else value


def lines(stream, deadline):
    scanned = 0
    while True:
        if time.monotonic() > deadline:
            raise ValueError()
        line = stream.readline(4 * 1024 * 1024 + 1)
        if not line:
            return
        scanned += len(line)
        if len(line) > 4 * 1024 * 1024 or scanned > 64 * 1024 * 1024:
            raise ValueError()
        yield line


def review(sources):
    deadline = time.monotonic() + 30
    result = {'files': [], 'issues': [], 'chromosome': None}
    before = {}
    for role, source in sources.items():
        path = os.path.realpath(source['path'])
        if (not re.fullmatch(r'/[A-Za-z0-9_./-]+', path) or len(path) > 2048
                or any(path == root or path.startswith(root + '/') for root in BLOCKED)):
            result['issues'].append('Choose supported shared-storage paths for all study and reference files.')
            continue
        try:
            info = os.stat(path)
            if not stat.S_ISREG(info.st_mode) or not os.access(path, os.R_OK) or not info.st_size:
                raise OSError()
            if source.get('size') is not None and (source['size'] != info.st_size or source['mtime_ns'] != info.st_mtime_ns):
                result['issues'].append('A study input changed after format validation. Review it again.')
            before[role] = identity(info)
            result['files'].append({'role': role, 'path': path, 'size': info.st_size,
                                    'mtime_ns': info.st_mtime_ns, 'identity': identity(info),
                                    'sha256': source.get('sha256')})
        except OSError:
            result['issues'].append('A study, reference or annotation file is missing, empty or unreadable.')
    if result['issues']:
        return result
    files = {entry['role']: entry for entry in result['files']}
    try:
        with open(files['map']['path']) as stream:
            rows = [line.split() for line in lines(stream, deadline) if line.strip()]
        chromosomes = {chromosome(row[0]) for row in rows}
        positions = [int(row[3]) for row in rows]
        if len(chromosomes) != 1 or not chromosomes <= {str(number) for number in range(1, 23)}:
            result['issues'].append('Study-specific preparation currently supports one autosome from 1 to 22.')
            return result
        study_chromosome = next(iter(chromosomes))
        result['chromosome'] = int(study_chromosome)
        if len(set(positions)) != len(positions):
            result['issues'].append('The study map has repeated positions; the reference preparer cannot safely match them.')
        with text(files['reference']['path']) as stream:
            source_lines = lines(stream, deadline)
            first = next(source_lines, '')
            if not (first.startswith('##fileformat=VCF') or first.startswith('#CHROM')):
                result['issues'].append('Choose a matching raw VCF reference; a GEN file does not establish chromosome provenance for this preparation path.')
            else:
                found = None
                scanned = len(first)
                for line in source_lines:
                    scanned += len(line)
                    if scanned > 8 * 1024 * 1024:
                        break
                    if line.strip() and not line.startswith('#'):
                        found = chromosome(line.split()[0])
                        break
                if found != study_chromosome:
                    result['issues'].append('Choose a single-chromosome raw VCF matching the study chromosome; no example-reference fallback is used.')
        with text(files['genetic_map']['path']) as stream:
            source_lines = lines(stream, deadline)
            header = next(source_lines, '').lower().split()
            points = []
            if header[:3] == ['pos', 'chr', 'cm']:
                kind = 'pos_chr_cm'
            elif len(header) == 3 and header[0] == 'position':
                kind = 'impute2'
            else:
                kind = None
                result['issues'].append('Choose a genetic map in pos/chr/cM or IMPUTE2 position/rate/cM format.')
            for line in source_lines:
                row = line.split()
                if not row:
                    continue
                if len(row) != 3 or (kind == 'pos_chr_cm' and chromosome(row[1]) != study_chromosome):
                    result['issues'].append('The selected genetic map does not match the study chromosome or expected columns.')
                    break
                points.append((int(row[0]), float(row[2])))
            if (not points or not points[0][0] <= min(positions) <= max(positions) <= points[-1][0]
                    or any(not math.isfinite(point[1]) for point in points)
                    or any(b[0] <= a[0] or b[1] < a[1] for a, b in zip(points, points[1:]))):
                result['issues'].append('The genetic map must increase across and cover all study marker positions.')
    except (OSError, ValueError, IndexError, UnicodeError, EOFError):
        result['issues'].append('The study or selected reference review was incomplete or unsupported. Use supported files within the 64 MiB scan and 30-second review limits.')
    for role, item in files.items():
        try:
            if identity(os.stat(item['path'])) != before[role]:
                result['issues'].append('A source file changed during resource review. Check again.')
        except OSError:
            result['issues'].append('A source file became unavailable during resource review.')
    result['issues'] = list(dict.fromkeys(result['issues']))
    return result


if __name__ == '__main__':
    print('@@sources\t' + json.dumps(review(json.loads(sys.argv[1]))))
