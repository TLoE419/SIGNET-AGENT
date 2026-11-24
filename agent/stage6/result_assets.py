"""Optional original Stage 6 exports, bound to one saved history identity.

The graph API remains the authority for whether a result is readable. These
grants only expose a small export allowlist; they never accept a filesystem path
from a browser or contact the remote execution environment.
"""
from base64 import b64encode
from dataclasses import dataclass
import hashlib
import io
import json
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
# sub_summary.R draws the KEGG radar only with more than 3 terms (enrichment_radar.R)
# and the Process histogram only with at least 5 (enrichment_hist.R).
ENRICHMENT_PLOTS = {'enrichment_radar': 'KEGG', 'enrichment_hist': 'Process'}
PLOT_MINIMUM = {'enrichment_radar': 4, 'enrichment_hist': 5}
CRITERIA = ('enrichment', 'modularity')
# circular.R's info[[i]][, 1:8], shown by server.R output$table.
TABLE_COLUMNS = ('source gene', 'source chr', 'source start', 'source end',
                 'target gene', 'target chr', 'target start', 'target end')
MAX_ROWS = 20000
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
});
window.addEventListener('message',event=>{
if(event.source!==window.parent||!event.data||!Array.isArray(event.data.signetGenes))return;
const widget=document.querySelector('.visNetwork.html-widget'),el=widget&&document.getElementById('graph'+widget.id);
if(!el||!el.nodes||typeof resetAllNodes!=='function')return;
if(widget.selectActive===true||widget.highlightActive===true){
resetAllEdges(el.edges,el.highlightColor,el.byselectionColor,el.chart);resetAllNodes(el.nodes,true,el.options,el.chart);
if(widget.selectActive===true){widget.selectActive=false;resetList('selectedBy',widget.id,'selectedBy')}
if(widget.highlightActive===true){widget.highlightActive=false;resetList('nodeSelect',widget.id,'selected')}}
const ids=new Set(el.nodes.getIds());
el.nodes.update(event.data.signetGenes.filter(id=>typeof id==='string'&&ids.has(id)).map(id=>({id,color:'#FB7E81'})));
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


def _rows(value):
    if value is None or value == {}:
        return []
    if not isinstance(value, list) or len(value) > MAX_ROWS or not all(isinstance(row, dict) for row in value):
        raise ValueError('Unexpected dashboard table.')
    return value


def _value(value):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('Unexpected dashboard number.')
    return value


def _count(value):
    value = _value(value)
    if value is None or value < 0 or value != int(value):
        raise ValueError('Unexpected dashboard count.')
    return int(value)


def _label(value):
    if value is None:
        return ''
    if not isinstance(value, str):
        raise ValueError('Unexpected dashboard text.')
    return value[:2000]


def _cell(value):
    return _label(value) if not isinstance(value, (int, float)) or isinstance(value, bool) else _value(value)


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
            allowed.update(f'signet_enrich_{category}_info_top{number}_freq{label}.txt' for category in ENRICHMENT_PLOTS.values())
        dashboard = f'signet_dashboard_freq{label}'
        allowed.update((dashboard + '.json', dashboard + '.error.txt', f'signet_freq{label}_top_degree.txt'))
        allowed.update(f'{dashboard}_top{number}_{criterion}.html' for number in range(1, top + 1) for criterion in CRITERIA)
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
        pages = any(name.startswith(dashboard + '_top') and name.endswith('.html') for name in files)
        for stem in sorted(widgets) + [dashboard]:
            if stem + '.html' not in files and not (stem == dashboard and pages):
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
        dashboard = self._dashboard(files, label, int(result['top_networks']), base)
        matrix = root / 'work/res/resn/signet_Afreq' if row['source'] != 'archive' else root / 'signet_Afreq'
        try:
            thresholds = threshold_counts(matrix)
        except (OSError, ValueError, UnicodeError):
            thresholds = None
        return {'history_id': history_id, 'identity': identity, 'revision': row['revision'], 'source': row['source'], 'run_id': row['run_id'],
                'frequency': result['frequency'], 'top_networks': result['top_networks'], 'previews': previews,
                'plots': plots, 'thresholds': thresholds, 'dashboard': dashboard,
                'download_available': bool(files), 'expires_in': PREVIEW_TTL}

    def _text(self, files, name):
        return self._asset(files[name]).decode('utf-8', 'replace') if name in files else None

    def _terms(self, files, name):
        """Rows of an enrich_*_info file; sub_summary.R writes one NA row when STRING found none."""
        text = self._text(files, name)
        if text is None:
            return None
        return sum(1 for line in text.splitlines()[1:] if line.strip() and line.split('@', 1)[0] != 'NA')

    def _dashboard(self, files, label, top, base):
        """The Shiny dashboard's data as exported on HPC3, plus why each optional figure is absent."""
        stem = f'signet_dashboard_freq{label}'
        subnetworks = []
        for number in range(1, top + 1):
            names = {criterion: f'{stem}_top{number}_{criterion}.html' for criterion in CRITERIA}
            pages = {criterion: base + name if name in files else None for criterion, name in names.items()}
            missing = {}
            for kind, category in ENRICHMENT_PLOTS.items():
                plot = f'signet_{kind}_top{number}_freq{label}'
                if plot + '.pdf' in files or plot + '.png' in files:
                    continue
                count = self._terms(files, f'signet_enrich_{category}_info_top{number}_freq{label}.txt')
                missing[kind] = ({'code': 'not_recorded', 'category': category} if count is None
                                 else {'code': 'too_few', 'category': category, 'count': count, 'minimum': PLOT_MINIMUM[kind]}
                                 if count < PLOT_MINIMUM[kind] else {'code': 'missing', 'category': category, 'count': count})
            circular = f'signet_circular_top{number}_freq{label}'
            if circular + '.pdf' not in files and circular + '.png' not in files:
                missing['circular'] = {'code': 'missing'}
            subnetworks.append({'number': number, 'networks': pages, 'missing': missing})
        report = {'available': False, 'reason': None, 'summary': None, 'top_nodes': [], 'ppi': [], 'subnetworks': subnetworks}
        try:
            text = self._text(files, stem + '.json')
            if text is None:
                failure = self._text(files, stem + '.error.txt')
                report['reason'] = ({'code': 'export_failed', 'detail': ' '.join(failure.split())[:500]} if failure is not None
                                    else {'code': 'not_exported'})
                return report
            data = json.loads(text)
            summary = data['summary']
            report['summary'] = {key: _count(summary[key]) for key in ('subnetworks', 'genes', 'edges')}
            report['top_nodes'] = [{'gene': _label(row['gene']), 'degree': _count(row['degree']),
                                    'subnetwork': _count(row['subnetwork']) if row.get('subnetwork') is not None else None}
                                   for row in _rows(data['top_nodes'])[:50]]
            report['ppi'] = [{'protein1': _label(row.get('Protein 1')), 'protein2': _label(row.get('Protein 2')),
                              'score': _value(row.get('Combined Score'))} for row in _rows(data['ppi'])]
            exported = {_count(item['number']): item for item in _rows(data['subnetworks'])}
            for entry in subnetworks:
                item = exported.get(entry['number'])
                if item is None:
                    raise ValueError('A subnetwork is missing from the dashboard export.')
                entry.update({
                    'genes': _count(item['genes']), 'edges': _count(item['edges']),
                    'enrichment_terms': item.get('enrichment_terms') is True,
                    'modularity_groups': _count(item['modularity_groups']),
                    'pathway': [{'description': _label(row['description']), 'p_value': _value(row['p_value']),
                                 'text': _label(row.get('text'))} for row in _rows(item.get('pathway'))],
                    'table': {'columns': list(TABLE_COLUMNS),
                              'rows': [[_cell(row.get(column)) for column in TABLE_COLUMNS] for row in _rows(item.get('table'))]},
                })
            report['available'] = True
        except (KeyError, TypeError, ValueError, AttributeError):
            report.update(available=False, reason={'code': 'invalid'}, summary=None, top_nodes=[], ppi=[])
            for entry in subnetworks:
                for key in ('genes', 'edges', 'enrichment_terms', 'modularity_groups', 'pathway', 'table'):
                    entry.pop(key, None)
        return report

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
