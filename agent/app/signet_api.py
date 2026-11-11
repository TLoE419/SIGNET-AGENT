"""HTTP routes under /signet/ for running SIGNET steps on HPC3 by hand from the app.

Full specification for clients (routes, bodies, states, errors, examples):
docs/SIGNET_STEP_API.md. Keep it in step with this file and signet_jobs.py.

These routes only translate HTTP into calls to agent.runtime.signet_jobs (and,
for creating runs, agent.tools.signet.configure_signet). They hold no business
rules: every check on run names, paths, settings and resources happens in the
service, so the app's buttons and any future AI tool share one code path.

Security comes from ChatHandler before a request reaches this module: the Host
must be 127.0.0.1:<port>, and requests must carry X-Chat-Token except for ZIP
retrieval with a single-use ticket. POST/PATCH must come from the app's
Origin. Bodies are JSON objects of at most 32 KB.

Every error reply is {"error": "<message for the user>", "code": "<machine code>"}:
  400 invalid_request   bad JSON, unknown field, value out of range, path not allowed
  403 forbidden         Host, Origin or token check failed (sent by ChatHandler)
  404 not_found         unknown route, run or step
  405 method_not_allowed the route exists but not for this method
  409 conflict          run exists, step already completed or still active, another step active
  412 not_ready         HPC3 not connected or not prepared
  500 internal_error    an unexpected error in this app (details go to the backend log only)
  502 remote_failed     an SSH or Slurm command on HPC3 failed
"""
import json
import re
import secrets
import shutil
import tempfile
import time
from pathlib import Path
from zipfile import ZipFile
import sys
import traceback
from urllib.parse import parse_qs

from agent.runtime import analysis_rerun, step_proposal
from agent.runtime import signet_jobs as jobs
from agent.runtime.visualization import read_graph
import agent.tools.signet as signet

MAX_BODY = 32768
STATUS = {'invalid_request': 400, 'not_found': 404, 'conflict': 409, 'not_ready': 412, 'remote_failed': 502}
_RUN_NAME = r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}'  # same rule as agent.tools.signet._name
_RUN = rf'(?P<run_id>{_RUN_NAME})'
_STEP = r'(?P<step>[a-z_]{1,32})'
_SESSION = re.compile(r'[a-f0-9-]{36}')  # same session IDs accepted by ChatHandler


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


# ---------- request helpers ----------

def _body(handler, allowed, required=()):
    """Read the JSON object body; reject unknown or missing top-level fields."""
    try:
        size = int(handler.headers.get('Content-Length', '0') or 0)
    except ValueError:
        size = -1
    if not 0 <= size <= MAX_BODY:
        raise ApiError(400, 'invalid_request', f'The request body must be at most {MAX_BODY} bytes.')
    handler.connection.settimeout(10)
    raw = handler.rfile.read(size) if size else b'{}'
    try:
        value = json.loads(raw)
    except ValueError as error:
        raise ApiError(400, 'invalid_request', 'The request body is not valid JSON.') from error
    if not isinstance(value, dict):
        raise ApiError(400, 'invalid_request', 'The request body must be a JSON object.')
    unknown = set(value) - set(allowed)
    missing = set(required) - set(value)
    if unknown or missing:
        raise ApiError(400, 'invalid_request', 'Unknown fields: ' + ', '.join(sorted(unknown)) if unknown
                       else 'Missing fields: ' + ', '.join(sorted(missing)))
    return value


def _query(url, allowed):
    """Single-valued query parameters; unknown or repeated ones are rejected."""
    values = parse_qs(url.query, keep_blank_values=True)
    if set(values) - set(allowed) or any(len(v) != 1 for v in values.values()):
        raise ApiError(400, 'invalid_request', 'Allowed query parameters: ' + (', '.join(allowed) or 'none') + '.')
    return {key: value[0] for key, value in values.items()}


def _run_root(run_id):
    try:
        return signet._run(run_id)
    except ValueError as error:
        raise ApiError(404, 'not_found', f'No run named {run_id}.') from error


# ---------- catalog ----------

def get_catalog(handler, url):
    """GET /signet/catalog

    What the app may offer: each step's name, signet flag, cohort, required
    input keys (HPC3 file paths), settings it may change, default resources and
    their limits, and the outputs that must exist for success. The workflow
    panel builds its forms from this instead of hard-coding them.
    Response 200: {"steps": [...], "input_roots": [...], "states": [...]}
    """
    _query(url, ())
    return 200, jobs.catalog()


# ---------- runs (local; includes signet -s) ----------

def _runs(session):
    """Yield valid local run roots, optionally limited to one saved conversation."""
    folder = signet.PROJECT / 'runs'
    for path in sorted(folder.iterdir() if folder.is_dir() else (), key=lambda p: p.name):
        manifest = path / 'manifest.json'
        if not re.fullmatch(_RUN_NAME, path.name) or path.is_symlink() or not manifest.is_file():
            continue
        try:
            root = _run_root(path.name)
        except ApiError as error:
            if error.status == 404:
                continue
            raise
        linked = jobs.analysis_session(root)
        if session is None or linked == session:
            yield root, manifest, linked


def list_runs(handler, url):
    """List local runs with their last saved step states."""
    session = _query(url, ('session',)).get('session')
    if session is not None and not _SESSION.fullmatch(session):
        raise ApiError(400, 'invalid_request', 'Invalid conversation session.')
    runs = [{'run_id': root.name, 'cohort': json.loads(manifest.read_text()).get('cohort'),
             'created_at': int(manifest.stat().st_mtime), 'session': linked,
             'steps': {name: record['state'] for name, record in jobs.run_records(root).items()}}
            for root, manifest, linked in _runs(session)]
    runs.sort(key=lambda item: item['created_at'], reverse=True)
    return 200, {'runs': runs}


def get_progress(handler, url):
    """Read compact progress for one conversation, even during an HPC3 transfer."""
    session = _query(url, ('session',)).get('session', '')
    if not _SESSION.fullmatch(session):
        raise ApiError(400, 'invalid_request', 'A valid conversation session is required.')
    analyses = []
    for root, manifest, _ in _runs(session):
        cohort = json.loads(manifest.read_text()).get('cohort')
        if cohort == 'TCGA':
            records = jobs.run_records(root)
            upcoming = step_proposal.next_step(records)
            analyses.append({'run_id': root.name, 'next_step': upcoming,
                             'proposal': step_proposal.view(root, upcoming) if upcoming else None,
                             'resource_limits': jobs.STEPS[upcoming].limits if upcoming else None,
                             'genotype_proposal': step_proposal.view(root),
                             **jobs.analysis_view(root, cohort, records, include_attempts=False)})
    return 200, {'analyses': analyses}


def create_run(handler, url):
    """POST /signet/runs   body {"run_id": "luad_t1", "cohort": "TCGA" | "GTEx"}

    Create a new isolated local run: copies the audited SIGNET scripts and a
    fresh config.ini into runs/<run_id>. Never overwrites an existing run.
    Response 201: {"run_id", "cohort", "settings"}
    Errors: 400 bad name or cohort; 409 a run with this name already exists.
    """
    _query(url, ())
    body = _body(handler, ('run_id', 'cohort'), required=('run_id',))
    run_id, cohort = body['run_id'], body.get('cohort', 'TCGA')
    if isinstance(run_id, str) and (signet.PROJECT / 'runs' / run_id).exists():
        raise ApiError(409, 'conflict', f'A run named {run_id} already exists; choose another name.')
    result = signet.configure_signet(run_id, cohort)
    if result['status'] != 'created':
        raise ApiError(400, 'invalid_request', result.get('error', 'Could not create the run.'))
    return 201, {'run_id': run_id, 'cohort': cohort, 'settings': result['settings']}


def get_run(handler, url, run_id):
    """GET /signet/runs/{run_id}

    One run's current config.ini settings and the full record of each step
    submitted to HPC3 (state, job ID, timestamps, validation). Local files only.
    Response 200: {"run_id", "cohort", "settings": {...}, "steps": {"expression": {...}}, "analysis": {...}}
    Errors: 404 unknown run.
    """
    _query(url, ())
    root = _run_root(run_id)
    settings = signet._settings(root)
    records = jobs.run_records(root)
    cohort = settings.get('cohort')
    return 200, {'run_id': run_id, 'cohort': cohort, 'settings': settings, 'steps': records,
                 'analysis': jobs.analysis_view(root, cohort, records)}


def link_conversation(handler, url, run_id):
    """Associate an existing run with a saved conversation without touching HPC3."""
    _query(url, ())
    session = _body(handler, ('session',), required=('session',))['session']
    if not isinstance(session, str) or not _SESSION.fullmatch(session):
        raise ApiError(400, 'invalid_request', 'Invalid conversation session.')
    server = handler.server
    if session not in server.histories and session not in server.stage6.sessions:
        raise ApiError(404, 'not_found', 'No such conversation.')
    return 200, jobs.link_conversation(run_id, session)


def step_action(handler, url, run_id, action, step='genotype', rerun=None):
    """Create, decline, or consume a conversation’s confirmation."""
    _query(url, ())
    required = {
        'prepare': ('session',),
        'decline': ('session', 'proposal_id'),
        'confirm': ('session', 'proposal_id', 'inputs', 'settings', 'resources'),
    }[action]
    optional = {'prepare': () if rerun else ('mode',), 'decline': (), 'confirm': ('options',)}[action]
    body = _body(handler, required + optional, required=required)
    session = body.pop('session')
    if not isinstance(session, str) or not _SESSION.fullmatch(session):
        raise ApiError(400, 'invalid_request', 'Invalid conversation session.')
    if rerun:
        if action == 'prepare':
            return 200, analysis_rerun.prepare(run_id, session, step)
        return 202, analysis_rerun.confirm(run_id, session, step, **body)
    if action == 'prepare':
        return 200, step_proposal.prepare(run_id, session, body.get('mode'), step_name=step)
    if action == 'decline':
        return 200, step_proposal.decline(run_id, session, body['proposal_id'], step_name=step)
    return 202, step_proposal.confirm(run_id, session, **body, step_name=step)


def _finished_analysis(run_id, session):
    if not isinstance(session, str) or not _SESSION.fullmatch(session):
        raise ApiError(400, 'invalid_request', 'Invalid conversation session.')
    root = _run_root(run_id)
    step_proposal.require_owner(root, session)
    records = jobs.run_records(root)
    if step_proposal.next_step(records) is not None:
        raise ApiError(409, 'conflict', 'Complete all six analysis stages first.')
    return root, records


def get_results(handler, url, run_id):
    session = _query(url, ('session',)).get('session')
    root, records = _finished_analysis(run_id, session)
    settings = records['visualize']['settings']
    graph = read_graph(root / jobs.STEPS['visualize'].download / 'signet-edges.csv', int(settings['ntop']))
    return 200, {'graph': graph}


def issue_download(handler, url, run_id):
    _query(url, ())
    session = _body(handler, ('session',), required=('session',))['session']
    _finished_analysis(run_id, session)
    ticket = secrets.token_urlsafe(24)
    server = handler.server
    with server.analysis_download_lock:
        now = time.monotonic()
        server.analysis_downloads = {
            key: value for key, value in server.analysis_downloads.items() if value[0] > now
        }
        if len(server.analysis_downloads) >= 32:
            raise ApiError(409, 'conflict', 'Too many pending downloads.')
        server.analysis_downloads[ticket] = (now + 60, run_id, session)
    return 200, {'url': '/signet/result-download?ticket=' + ticket}


def download_results(handler, url):
    """Stream a local ZIP using a single-use ticket from the authenticated chat."""
    try:
        ticket = _query(url, ('ticket',)).get('ticket')
        with handler.server.analysis_download_lock:
            grant = handler.server.analysis_downloads.pop(ticket, None)
        if grant is None or grant[0] <= time.monotonic():
            raise ApiError(403, 'forbidden', 'Request a new result download from the chat.')
        _, run_id, session = grant
        root, records = _finished_analysis(run_id, session)
        with tempfile.TemporaryFile() as archive:
            with ZipFile(archive, 'w') as zip_file:
                for stage in jobs.ANALYSIS_STEPS:
                    for name in records[stage].get('outputs', ()):
                        relative = Path(name)
                        if (relative.is_absolute() or '..' in relative.parts or chr(92) in name
                                or not relative.is_relative_to(jobs.STEPS[stage].download)):
                            raise ApiError(409, 'conflict', 'A recorded result path is invalid.')
                        path = signet._no_links(root / relative)
                        if not path.is_file():
                            raise ApiError(409, 'conflict', 'A recorded result file is missing.')
                        zip_file.write(path, relative.as_posix())
            size = archive.tell()
            archive.seek(0)
            handler.send_response(200)
            handler.send_header('Content-Type', 'application/zip')
            handler.send_header('Content-Disposition', f'attachment; filename="{run_id}-results.zip"')
            handler.send_header('Content-Length', str(size))
            handler.send_header('Cache-Control', 'no-store')
            handler.send_header('X-Content-Type-Options', 'nosniff')
            handler.end_headers()
            try:
                shutil.copyfileobj(archive, handler.wfile)
            except (BrokenPipeError, ConnectionResetError):
                return
    except jobs.StepError as error:
        return _reply(handler, STATUS[error.code], error.code, str(error))
    except ApiError as error:
        return _reply(handler, error.status, error.code, str(error))
    except (OSError, ValueError):
        return _reply(handler, 409, 'conflict', 'Could not read the recorded results.')


def update_settings(handler, url, run_id):
    """PATCH /signet/runs/{run_id}/settings   body {"values": {"restrict.tcga": 1}}

    The app's `signet -s`: change settings in the run's local config.ini. Only
    keys listed under "settings" in the catalog are accepted, each with its own
    rule (e.g. restrict.tcga is "no" or a chromosome 1-22). The new file is sent
    to HPC3 with the next step that is submitted.
    Response 200: {"settings": {...}}
    Errors: 400 key not allowed or bad value; 404 unknown run;
            409 a step of this run is still active.
    """
    _query(url, ())
    body = _body(handler, ('values',), required=('values',))
    return 200, {'settings': jobs.update_settings(run_id, body['values'])}


# ---------- steps (HPC3) ----------

def submit_step(handler, url, run_id, step):
    """POST /signet/runs/{run_id}/steps/{step}
       body {"inputs": {"gexp.file": "/pub/.../example_gexp", "pmap.file": "/pub/.../gencode.v22.annotation.gtf"},
             "resources": {"cpus": 4, "mem_gb": 16, "hours": 2},   (optional)
             "options": {"npc": 3}}                                (optional; only steps with prompts, e.g. adjust)

    Start one SIGNET step on HPC3 as a Slurm job. Inputs must be HPC3 files
    under the workspace refdata/, the SIGNET example/ folder or this run's own
    HPC3 folder. Options answer SIGNET's interactive questions (the catalog
    lists them with rules and defaults). Uploads the run, writes the job
    script, runs sbatch, and returns as soon as Slurm accepts the job; follow
    it with the status route.
    Response 202: the step record with "state": "submitted" and "job_id"
    (or "state": "unknown" if the connection dropped during sbatch; check
    status, never resubmit).
    Errors: 400 bad input path, resources or options, wrong cohort, input missing on HPC3,
            an earlier step this one needs has not completed in this run;
            404 unknown run or step; 409 step already completed or still active, or another step active;
            412 HPC3 not connected or container missing; 502 upload or sbatch failed.
    Retry: a failed or cancelled step may be submitted again in the same run. The earlier
    attempt is kept (steps/<step>.attempt<N>.json here, steps/<step>.attempt<N>.* on HPC3)
    and the new record carries "attempt" and "previous_job_id".
    """
    _query(url, ())
    body = _body(handler, ('inputs', 'resources', 'options'), required=('inputs',))
    return 202, jobs.submit(run_id, step, body['inputs'], body.get('resources'), body.get('options'))


def get_step(handler, url, run_id, step):
    """GET /signet/runs/{run_id}/steps/{step}?refresh=1

    The step's state: submitted, pending, running, validating, completed,
    failed, cancelled or unknown, plus slurm_state, job_id, timestamps and,
    when it ends, missing_outputs / failure_hints. Slurm is asked at most once
    every 15 s per step; refresh=1 asks now. When the job has ended, this call
    checks the outputs and logs and, on success, downloads the results into the
    local run (so it may take a little longer once).
    An absent or incomplete exit marker keeps the step validating. A successful
    visualization with missing outputs stays validating for up to two minutes
    from the first missing-file check. Normal polling also rechecks old
    visualization records that failed solely because outputs were missing.
    refresh=1 also rechecks failures caused by unconfirmed artifacts.
    Response 200: the step record. If HPC3 cannot be reached, the last known
    record with "connection": "interrupted".
    Errors: 404 unknown run, step, or a step never submitted; 412 not connected.
    """
    query = _query(url, ('refresh',))
    if query.get('refresh', '0') not in ('0', '1'):
        raise ApiError(400, 'invalid_request', 'refresh must be 0 or 1.')
    return 200, jobs.status(run_id, step, refresh=query.get('refresh') == '1')


def cancel_step(handler, url, run_id, step):
    """POST /signet/runs/{run_id}/steps/{step}/cancel   body {} (or empty)

    Cancel the step's own Slurm job. The job name is checked on HPC3 first
    (signet-<step>-<run_id>), so no other job can be cancelled. If the job has
    already left the queue, the reply reports how it actually ended instead.
    Response 200: the step record ("state": "cancelled", or its final state).
    Errors: 404 never submitted; 409 already finished, or no job ID yet;
            412 not connected; 502 scancel failed.
    """
    _query(url, ())
    _body(handler, ())
    return 200, jobs.cancel(run_id, step)


def get_log(handler, url, run_id, step):
    """GET /signet/runs/{run_id}/steps/{step}/log?stream=out|err&lines=50

    The last lines of the job's standard output (out, default) or standard
    error (err) on HPC3; lines is 1-200 (default 50). Read-only.
    Response 200: {"lines": ["..."], "truncated": true|false}
    Errors: 400 bad stream or lines; 404 never submitted; 412 not connected.
    """
    query = _query(url, ('stream', 'lines'))
    lines = query.get('lines', '50')
    if not lines.isdigit():
        raise ApiError(400, 'invalid_request', 'lines must be a whole number from 1 to 200.')
    return 200, jobs.read_log(run_id, step, query.get('stream', 'out'), int(lines))


# Each path pattern maps HTTP methods to the function above that serves it.
ROUTES = [
    (re.compile(r'/signet/progress'), {'GET': get_progress}),
    (re.compile(r'/signet/catalog'), {'GET': get_catalog}),
    (re.compile(r'/signet/runs'), {'GET': list_runs, 'POST': create_run}),
    (re.compile(rf'/signet/runs/{_RUN}'), {'GET': get_run}),
    (re.compile(rf'/signet/runs/{_RUN}/conversation'), {'PATCH': link_conversation}),
    (re.compile(rf'/signet/runs/{_RUN}/genotype-proposal/(?P<action>prepare|decline|confirm)'), {'POST': step_action}),
    (re.compile(rf'/signet/runs/{_RUN}/steps/{_STEP}/proposal/(?P<action>prepare|decline|confirm)'), {'POST': step_action}),
    (re.compile(rf'/signet/runs/{_RUN}/steps/{_STEP}/(?P<rerun>rerun)/(?P<action>prepare|confirm)'), {'POST': step_action}),
    (re.compile(rf'/signet/runs/{_RUN}/results'), {'GET': get_results}),
    (re.compile(rf'/signet/runs/{_RUN}/results/download'), {'POST': issue_download}),
    (re.compile(rf'/signet/runs/{_RUN}/settings'), {'PATCH': update_settings}),
    (re.compile(rf'/signet/runs/{_RUN}/steps/{_STEP}'), {'GET': get_step, 'POST': submit_step}),
    (re.compile(rf'/signet/runs/{_RUN}/steps/{_STEP}/cancel'), {'POST': cancel_step}),
    (re.compile(rf'/signet/runs/{_RUN}/steps/{_STEP}/log'), {'GET': get_log}),
]


def handle(handler, method, url):
    """Serve one /signet/ request that ChatHandler has already checked; always writes a JSON reply."""
    try:
        for pattern, methods in ROUTES:
            match = pattern.fullmatch(url.path)
            if match:
                if method not in methods:
                    raise ApiError(405, 'method_not_allowed', f'{method} is not supported here.')
                status, value = methods[method](handler, url, **match.groupdict())
                return handler.json_response(value, status)
        raise ApiError(404, 'not_found', 'No such SIGNET API.')
    except jobs.StepError as error:
        return _reply(handler, STATUS[error.code], error.code, str(error))
    except ApiError as error:
        return _reply(handler, error.status, error.code, str(error))
    except Exception:
        # Never drop the connection without a reply; keep internals out of the page.
        traceback.print_exc(file=sys.stderr)
        return _reply(handler, 500, 'internal_error',
                      'Unexpected error in the app; the request may not have finished. Check the run state before retrying.')


def _reply(handler, status, code, message):
    data = json.dumps({'error': message, 'code': code}, ensure_ascii=False).encode()
    handler._headers(status, 'application/json; charset=utf-8', len(data))
    handler.wfile.write(data)
