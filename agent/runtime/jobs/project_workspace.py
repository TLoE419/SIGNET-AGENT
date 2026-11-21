"""Read saved SIGNET results on HPC3; return aggregates and a raster PCA only.

Standalone standard-library code: no scientific command, output copy, or remote write.
The trusted desktop supplies only the existing reader functions needed by one stage.
"""

import base64
from bisect import bisect_right
from collections import Counter
import csv
import hashlib
import json
import math
from pathlib import Path
import re
from statistics import median, stdev
import struct
import sys
from types import SimpleNamespace
import zlib


def _pca_png(points, width=640, height=420):
    """Rasterize the saved scores here, so sample coordinates never leave HPC3."""
    pixels = bytearray(b'\xff' * (width * height * 3))

    def pixel(x, y, color):
        if 0 <= x < width and 0 <= y < height:
            offset = (y * width + x) * 3
            pixels[offset:offset + 3] = bytes(color)

    left, right, top, bottom = 42, width - 20, 20, height - 35
    for index in range(5):
        y = top + round(index * (bottom - top) / 4)
        for x in range(left, right + 1):
            pixel(x, y, (230, 234, 238))
    for x in range(left, right + 1):
        pixel(x, bottom, (80, 90, 100))
    for y in range(top, bottom + 1):
        pixel(left, y, (80, 90, 100))
    if points:
        xs, ys = zip(*points)
        min_x, max_x, min_y, max_y = min(xs), max(xs), min(ys), max(ys)
        spread_x, spread_y = max_x - min_x, max_y - min_y
        pad_x, pad_y = (spread_x or 1) * 0.08, (spread_y or 1) * 0.08
        min_x, max_x = min_x - pad_x, max_x + pad_x
        min_y, max_y = min_y - pad_y, max_y + pad_y
        for x, y in points:
            px = left + round((x - min_x) / (max_x - min_x) * (right - left))
            py = bottom - round((y - min_y) / (max_y - min_y) * (bottom - top))
            for dy in range(-3, 4):
                for dx in range(-3, 4):
                    if dx * dx + dy * dy <= 9:
                        pixel(px + dx, py + dy, (43, 109, 190))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

    raw = b''.join(b'\x00' + pixels[y * width * 3:(y + 1) * width * 3] for y in range(height))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def project(request):
    selected = Path(request['remote_dir'])
    base = Path(request['work_root'])
    relative = selected.relative_to(base)
    if (not selected.is_absolute() or not base.is_absolute()
            or relative.parts not in ((request['run_id'],), ('runs', request['run_id']))):
        raise ValueError('The recorded run is outside the configured workspace.')
    # A configured mount alias is allowed; redirects within its run folder are not.
    root = base.resolve() / relative
    if selected.resolve() != root:
        raise ValueError('The recorded remote run was redirected.')
    identities = {}

    def regular(path, control=False):
        path = Path(path)
        relative = path.relative_to(root)
        if (not relative.parts or not control and relative.parts[0] != 'work'
                or str(path.resolve()) != str(path) or not path.is_file()):
            raise ValueError('The saved artifact is not a canonical regular file.')
        info = path.stat()
        identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        previous = identities.setdefault(str(relative), identity)
        if previous != identity:
            raise ValueError('A saved artifact changed while being read.')
        return path

    step = request['job']['step']
    owner = regular(root / '.owner', control=True).read_text().strip()
    marker = regular(root / 'steps' / (step + '.job'), control=True).read_text().strip()
    done = regular(root / 'steps' / (step + '.done'), control=True).read_text().strip()
    if (owner != request['owner_token'] or marker != request['job']['job_id']
            or not re.fullmatch(r'0 \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?', done)):
        raise ValueError('The original completed job could not be verified.')

    namespace = {'csv': csv, 'math': math, 'median': median, 'stdev': stdev,
                 'Counter': Counter, 'bisect_right': bisect_right,
                 'signet': SimpleNamespace(_no_links=regular, _run=lambda run_id: root),
                 'workspace_genotype': SimpleNamespace(run_history=lambda path: {'jobs': {'adjust': request['job']}})}
    exec(compile(request['reader_source'], '<saved-workspace-reader>', 'exec'), namespace)
    stage = request['stage']
    if stage == 3:
        result = namespace[request['reader_entry']](request['run_id'])
        saved_pca = result['pca']
        points = saved_pca['points']
        result = {key: result[key] for key in ('npc', 'matching', 'comparison')}
        result['pca'] = {'png_base64': base64.b64encode(_pca_png(points)).decode('ascii'),
                         'width': 640, 'height': 420, 'point_count': len(points),
                         'variance_explained': saved_pca['variance_explained'],
                         'source': 'signet_smartpca'}
    else:
        result = {'summary': namespace[request['reader_entry']](root)}
    for relative, original in identities.items():
        current = regular(root / relative, control=not relative.startswith('work/'))
        if not current.is_file():
            raise ValueError('A saved artifact became unavailable.')
    fingerprint = hashlib.sha256(json.dumps(identities, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return {'version': 1, 'run_id': request['run_id'], 'stage': stage, 'job_id': request['job']['job_id'],
            'attempt': request['job'].get('attempt', 1), 'source_fingerprint': fingerprint, **result}


def main():
    try:
        result = project(json.loads(sys.argv[1]))
        print('@@workspace_projection\t' + json.dumps(result, separators=(',', ':'), allow_nan=False))
    except (OSError, ValueError, KeyError, TypeError, OverflowError, ZeroDivisionError):
        # Reader exceptions can include an input value; never serialize them to the client.
        print('@@workspace_projection_error\tThe completed remote results could not be projected safely.')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
