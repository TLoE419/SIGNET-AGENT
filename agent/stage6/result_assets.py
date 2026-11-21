"""Optional original Stage 6 exports, bound to one saved history identity.

The graph API remains the authority for whether a result is readable. These
grants only expose a small export allowlist; they never accept a filesystem path
from a browser or contact the remote execution environment.
"""
from base64 import b64encode
from dataclasses import dataclass
import hashlib
import io
import math
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import stat
import threading
import time
from zipfile import ZipFile, ZIP_DEFLATED

from agent.runtime import signet_jobs as jobs, workspace_history
import agent.tools.signet as signet

PREVIEW_PATH = re.compile(r'/stage6/result-preview/(?P<ticket>[A-Za-z0-9_-]{32})/(?P<name>[A-Za-z0-9_.+/-]+)')
TICKET = re.compile(r'[A-Za-z0-9_-]{32}')
IDENTITY = re.compile(r'[a-f0-9]{64}')
MAX_FILE = 64 * 1024 * 1024
MAX_TOTAL = 256 * 1024 * 1024
MAX_FILES = 1024
PREVIEW_TTL = 300
DOWNLOAD_TTL = 60
TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
         '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.pdf': 'application/pdf'}
_STYLE = b'<style>html,body,#htmlwidget_container{height:100%;margin:0!important;padding:0!important}html,body{overflow:hidden}.visNetwork.html-widget{height:100%!important}</style>'
_SCRIPT = b'''window.addEventListener('load',()=>{
const widget=document.querySelector('.visNetwork.html-widget');
const network=widget&&document.getElementById('graph'+widget.id)?.chart;
if(!network)return;
let dragging=false,timer;
const freeze=()=>{clearTimeout(timer);network.off('stabilizationIterationsDone',freeze);network.setOptions({physics:{enabled:false}})};
timer=setTimeout(freeze,4000);network.once('stabilizationIterationsDone',freeze);
network.on('dragStart',({nodes})=>{if(nodes.length){dragging=true;clearTimeout(timer);network.off('stabilizationIterationsDone',freeze);network.setOptions({physics:{enabled:true}})}});
network.on('dragEnd',()=>{if(dragging){dragging=false;timer=setTimeout(freeze,350)}});
});'''
_SCRIPT_HASH = b64encode(hashlib.sha256(_SCRIPT).digest()).decode('ascii')
_MANAGER_LOCK = threading.Lock()


def _error(code, message):
    return jobs.StepError(code, message)


def _safe_name(name):
    if not isinstance(name, str):
        return False
    path = PurePosixPath(name)
    return (bool(re.fullmatch(r'[A-Za-z0-9_.+/-]+', name))
            and not path.is_absolute() and all(part not in ('.', '..') and not part.startswith('.') for part in path.parts))


def _read(path):
    """Reject links and changed file handles, and bound every artifact read."""
    signet._no_links(path)
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError('The saved export is not a regular file.')
    # O_NONBLOCK prevents a file-to-FIFO replacement from hanging the local
    # server before fstat can reject it. Each parent is opened without links.
    directory = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)
    with os.fdopen(descriptor, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= MAX_FILE:
            raise ValueError('The saved export is empty or exceeds the preview limit.')
        data = stream.read(MAX_FILE + 1)
        after = os.fstat(stream.fileno())
    signet._no_links(path)
    stamp = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)
    if len(data) != before.st_size or stamp(before) != stamp(after) or stamp(after) != stamp(path.stat()):
        raise ValueError('The saved export changed while it was being read.')
    return data, (*stamp(after), hashlib.sha256(data).digest())


@dataclass(frozen=True)
class Asset:
    path: Path
    stamp: tuple


def threshold_counts(path):
    """Count the original -v cutoffs from the saved -n matrix, without inventing lower-cutoff edges."""
    data, _ = _read(path)
    cutoffs = (0.8, 0.85, 0.9, 0.95, 1)
    counts = [0] * len(cutoffs)
    genes = [set() for _ in cutoffs]
    width = None
    rows = 0
    for line in data.decode('utf-8').splitlines():
        if not line.strip():
            continue
        values = [float(value) for value in line.replace(',', ' ').split()]
        if not values or (width is not None and len(values) != width):
            raise ValueError('The saved frequency matrix is not rectangular.')
        width = len(values)
        for column, value in enumerate(values):
            if not math.isfinite(value) or not 0 <= value <= 1:
                raise ValueError('Invalid saved bootstrap frequency.')
            for index, cutoff in enumerate(cutoffs):
                if value > cutoff - 2.220446049250313e-16:
                    counts[index] += 1
                    genes[index].update((rows, column))
        rows += 1
    if not rows or width > rows:
        raise ValueError('The saved frequency matrix has more cis-gene columns than target genes.')
    return [{'cutoff': cutoff, 'genes': len(genes[index]), 'connections': counts[index]}
            for index, cutoff in enumerate(cutoffs)]


class ResultAssets:
    def __init__(self, workspace, clock=time.monotonic):
        self.workspace, self.clock = workspace, clock
        self.lock = threading.Lock()
        self.previews, self.downloads = {}, {}

    def _row(self, history_id, identity, revision=None):
        if (not isinstance(history_id, str) or not re.fullmatch(workspace_history.HISTORY_ID, history_id)
                or not isinstance(identity, str) or not IDENTITY.fullmatch(identity)):
            raise _error('invalid_request', 'Select a saved result and its current record identity.')
        row = next((row for row in self.workspace.history().get('runs', ()) if row.get('history_id') == history_id), None)
        if row is None:
            raise _error('not_found', 'The saved result is no longer available.')
        if row.get('record_identity') != identity:
            raise _error('conflict', 'The saved result changed. Refresh the run before opening its exports.')
        if revision is not None and (not isinstance(revision, str) or row.get('revision') != revision):
            raise _error('conflict', 'The saved result revision changed. Refresh the run before opening its exports.')
        source, run_id = row.get('source'), row.get('run_id')
        prefix = {'live': 'workspace', 'archive': 'archive', 'recorded': 'recorded'}.get(source)
        if (prefix is None or history_id != f'{prefix}--{run_id}'
                or not row.get('capabilities', {}).get('stage6_graph')):
            raise _error('not_ready', 'A completed, verified Stage 6 result is required.')
        return row

    def _resolve(self, history_id, identity, revision=None):
        row = self._row(history_id, identity, revision)
        source, run_id = row['source'], row['run_id']
        try:
            result = self.workspace.completed_result(run_id, **{source + '_only': True})
            if result.get('source') != source or result.get('run_id') != run_id:
                raise ValueError('The saved source does not match.')
            root = signet._run(run_id) if source != 'archive' else signet.PROJECT / 'data/stage6-results' / run_id
            directory = root / 'work/res/resv' if source != 'archive' else root
            signet._no_links(directory)
            return row, result, root, directory
        except (OSError, KeyError, TypeError, ValueError) as error:
            raise _error('not_ready', 'The original Stage 6 exports cannot be verified for this saved result.') from error

    def _manifest(self, result, directory):
        label = format(float(result['frequency']), '.15g')
        top = int(result['top_networks'])
        allowed = {f'signet_edgelist_{label}.txt', 'signet_count_vs_freq.pdf',
                   'signet_count_vs_freq.eps', 'signet_count_vs_freq.png'}
        widgets = {f'signet_top{number}_freq{label}' for number in range(1, top + 1)}
        for stem in widgets:
            allowed.update((stem + '.html', stem + '_name.txt'))
        for number in range(1, top + 1):
            for kind in ('circular', 'enrichment_radar', 'enrichment_hist'):
                allowed.update(f'signet_{kind}_top{number}_freq{label}{suffix}' for suffix in ('.pdf', '.png'))
        files, total = {}, 0

        def add(relative):
            nonlocal total
            if not _safe_name(relative):
                raise ValueError('Invalid original export name.')
            path = directory / relative
            data, stamp = _read(path)
            total += len(data)
            if len(files) >= MAX_FILES or total > MAX_TOTAL:
                raise ValueError('The original exports exceed the download limit.')
            files[relative] = Asset(path, stamp)

        for name in sorted(allowed):
            if (directory / name).exists() or (directory / name).is_symlink():
                add(name)
        # A widget can load only its own known static dependency tree, never an
        # arbitrary run output, clinical file, sibling directory, or HTML page.
        for stem in sorted(widgets):
            if stem + '.html' not in files:
                continue
            folder = directory / (stem + '_files')
            if not folder.exists() and not folder.is_symlink():
                continue
            signet._no_links(folder)
            for path in sorted(folder.rglob('*')):
                signet._no_links(path)
                if path.is_file() and path.suffix.lower() in ('.js', '.css', '.png'):
                    add(path.relative_to(directory).as_posix())
        return files

    def _grant(self, store, history_id, identity, revision, files, ttl, asset=None):
        ticket, now = secrets.token_urlsafe(24), self.clock()
        grant = {'expires': now + ttl, 'history_id': history_id, 'identity': identity, 'revision': revision, 'files': files, 'asset': asset}
        with self.lock:
            for bucket in (self.previews, self.downloads):
                for key in list(bucket):
                    if bucket[key]['expires'] <= now:
                        del bucket[key]
                while len(bucket) >= 64:
                    del bucket[next(iter(bucket))]
            store[ticket] = grant
        return ticket

    def metadata(self, history_id, identity, revision=None):
        row, result, root, directory = self._resolve(history_id, identity, revision)
        try:
            files = self._manifest(result, directory)
        except (OSError, ValueError) as error:
            raise _error('not_ready', 'An original export is missing, unsafe, changed, or too large to open.') from error
        self._row(history_id, identity, row['revision'])
        ticket = self._grant(self.previews, history_id, identity, row['revision'], files, PREVIEW_TTL)
        base = f'/stage6/result-preview/{ticket}/'
        label = format(float(result['frequency']), '.15g')
        previews, plots = [], []
        for number in range(1, int(result['top_networks']) + 1):
            name = f'signet_top{number}_freq{label}.html'
            if name in files:
                previews.append({'subnetwork': number, 'url': base + name})
            for kind in ('circular', 'enrichment_hist', 'enrichment_radar'):
                stem = f'signet_{kind}_top{number}_freq{label}'
                if any(stem + suffix in files for suffix in ('.png', '.pdf')):
                    plots.append({'kind': kind, 'subnetwork': number,
                                  'url': base + stem + '.png' if stem + '.png' in files else None,
                                  'pdf': stem + '.pdf' if stem + '.pdf' in files else None})
        if any('signet_count_vs_freq' + suffix in files for suffix in ('.png', '.pdf')):
            plots.append({'kind': 'count_vs_freq', 'subnetwork': None,
                          'url': base + 'signet_count_vs_freq.png' if 'signet_count_vs_freq.png' in files else None,
                          'pdf': 'signet_count_vs_freq.pdf' if 'signet_count_vs_freq.pdf' in files else None})
        matrix = root / 'work/res/resn/signet_Afreq' if row['source'] != 'archive' else root / 'signet_Afreq'
        try:
            thresholds = threshold_counts(matrix)
        except (OSError, ValueError, UnicodeError):
            thresholds = None
        return {'history_id': history_id, 'identity': identity, 'revision': row['revision'], 'source': row['source'], 'run_id': row['run_id'],
                'frequency': result['frequency'], 'top_networks': result['top_networks'], 'previews': previews,
                'plots': plots, 'thresholds': thresholds, 'download_available': bool(files), 'expires_in': PREVIEW_TTL}

    def issue_download(self, history_id, identity, asset=None, revision=None):
        row, result, _, directory = self._resolve(history_id, identity, revision)
        try:
            files = self._manifest(result, directory)
        except (OSError, ValueError) as error:
            raise _error('not_ready', 'The original exports are unavailable or changed.') from error
        if asset is not None and (not _safe_name(asset) or not asset.endswith('.pdf') or asset not in files):
            raise _error('not_found', 'No such original PDF figure in this saved result.')
        if not files:
            raise _error('not_ready', 'No original Stage 6 exports are available for this result.')
        self._row(history_id, identity, row['revision'])
        ticket = self._grant(self.downloads, history_id, identity, row['revision'], files, DOWNLOAD_TTL, asset)
        return {'url': f'/stage6/result-download?ticket={ticket}', 'expires_in': DOWNLOAD_TTL}

    def _take(self, store, ticket, consume=False):
        with self.lock:
            grant = store.pop(ticket, None) if consume else store.get(ticket)
        if grant is None or grant['expires'] <= self.clock():
            raise _error('not_found', 'This result link expired or was already used. Open the saved result again.')
        self._row(grant['history_id'], grant['identity'], grant['revision'])
        return grant

    @staticmethod
    def _asset(asset):
        data, stamp = _read(asset.path)
        if stamp != asset.stamp:
            raise _error('conflict', 'The saved export changed. Open the result again.')
        return data

    def preview(self, ticket, name, origin):
        grant = self._take(self.previews, ticket)
        asset = grant['files'].get(name) if _safe_name(name) else None
        if asset is None or asset.path.suffix not in ('.html', '.js', '.css', '.png'):
            raise _error('not_found', 'No such original preview asset.')
        data = self._asset(asset)
        self._row(grant['history_id'], grant['identity'], grant['revision'])
        if asset.path.suffix == '.html':
            if b'</head>' not in data:
                raise _error('not_ready', 'The saved original widget is not a readable HTML document.')
            data = data.replace(b'</head>', _STYLE + b'<script>' + _SCRIPT + b'</script></head>', 1)
        source = f'{origin}/stage6/result-preview/{ticket}/'
        csp = (f"sandbox allow-scripts; default-src 'none'; script-src {source} 'unsafe-eval' 'sha256-{_SCRIPT_HASH}'; "
               f"style-src {source} 'unsafe-inline'; img-src {source} data:; frame-ancestors {origin}; "
               "base-uri 'none'; form-action 'none'; connect-src 'none'; object-src 'none'")
        return data, TYPES[asset.path.suffix], csp

    def download(self, ticket):
        grant = self._take(self.downloads, ticket, consume=True)
        if grant['asset']:
            name = grant['asset']
            data = self._asset(grant['files'][name])
            self._row(grant['history_id'], grant['identity'], grant['revision'])
            return data, name, TYPES['.pdf']
        buffer = io.BytesIO()
        with ZipFile(buffer, 'w', compression=ZIP_DEFLATED) as archive:
            for name, asset in sorted(grant['files'].items()):
                archive.writestr(name, self._asset(asset))
        self._row(grant['history_id'], grant['identity'], grant['revision'])
        prefix, run_id = grant['history_id'].split('--', 1)
        return buffer.getvalue(), f'SIGNET-{prefix}-{run_id}-stage6.zip', 'application/zip'


def manager(server):
    with _MANAGER_LOCK:
        if not hasattr(server, 'stage6_result_assets'):
            server.stage6_result_assets = ResultAssets(server.stage6)
        return server.stage6_result_assets
