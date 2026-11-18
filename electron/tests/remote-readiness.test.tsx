import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {JSDOM} from 'jsdom';
import type {EnvironmentSnapshot} from '../shared/environment/types';

const dom = new JSDOM('<!doctype html><html><head><meta name="chat-token" content="test-page-token"></head><body></body></html>', {url: 'http://localhost'});
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'MutationObserver', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, {value: (dom.window as any)[key], configurable: true});
}
Object.defineProperty(globalThis, 'navigator', {value: dom.window.navigator, configurable: true});
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const require = createRequire(import.meta.url);
const {render, screen, fireEvent, waitFor, cleanup, act} = require('@testing-library/react') as typeof import('@testing-library/react');
import {RemoteReadiness} from '../renderer/features/workspace/RemoteReadiness';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
const ids = ['connection', 'workspace', 'slurm', 'apptainer', 'signet_source', 'container',
  'reference_ref', 'reference_gmap', 'reference_gtf', 'reference_clinical', 'imputation_reference'];
const environment: EnvironmentSnapshot = {phase: 'ready', message: 'Verified runtime', config: {
  root: '/work/researcher', source: '/work/researcher/software/signet', image: '/work/researcher/signet.sif',
  executor: '/usr/bin/apptainer', workRoot: '/work/researcher/runs', revision: 'verified', partition: 'shared',
}};
const props = {english: true, active: true, connected: true, environment,
  connectionIdentity: 'researcher@cluster:22', onEnvironment() {}};
function readyResult() {
  return {status: 'ok', ready: true, not_ready: [] as string[],
    checks: ids.map(item => ({item, status: 'ok', detail: `checked ${item}`}))};
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
const summary = () => document.querySelector('#ml-check-summary')!.textContent!;
const section = () => document.querySelector('.ml-remote-readiness')!;
const row = (id: string) => document.querySelector(`[data-check-id="${id}"]`) as HTMLElement;
const green = () => document.querySelectorAll('#ml-environment-checks [data-ready="true"]').length;

test('opening connected settings checks all eleven prerequisites automatically and supports manual refresh', async () => {
  const requests: {url: string; options?: RequestInit}[] = [];
  globalThis.fetch = async (url, options) => { requests.push({url: String(url), options}); return reply(readyResult()); };
  const {rerender} = render(<RemoteReadiness {...props} active={false}/>);
  assert.equal(requests.length, 0);
  rerender(<RemoteReadiness {...props}/>);
  await waitFor(() => assert.equal(section().getAttribute('data-ready'), 'true'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/hpc/check');
  assert.equal(requests[0].options?.method, 'POST');
  assert.equal((requests[0].options?.headers as Record<string, string>)['X-Chat-Token'], 'test-page-token');
  assert.equal(document.querySelectorAll('#ml-environment-checks li').length, 11);
  assert.equal(green(), 11);
  assert.match(summary(), /11\/11/);
  for (const id of ids) assert.equal(row(id).dataset.status, 'ok');
  assert.ok(screen.getByText('checked workspace'));
  fireEvent.click(screen.getByRole('button', {name: 'Check again'}));
  await waitFor(() => assert.equal(requests.length, 2));
  await waitFor(() => assert.equal(section().getAttribute('data-ready'), 'true'));
  rerender(<RemoteReadiness {...props} english={false}/>);
  assert.ok(screen.getByText('環境就緒檢查'));
  assert.ok(screen.getByText('checked workspace'));
  assert.equal(requests.length, 2, 'changing language must not repeat remote work');
});

test('basic compute failures and missing files remain visible even when the old seven rows would pass', async () => {
  const result = readyResult();
  const reasons: Record<string, string> = {workspace: '/work/researcher is not writable', slurm: 'sbatch is unavailable',
    apptainer: 'No container runtime was found', reference_gtf: 'gene annotation is missing'};
  result.ready = false;
  result.not_ready = Object.keys(reasons);
  result.checks = result.checks.map(check => reasons[check.item]
    ? {...check, status: check.item === 'reference_gtf' ? 'missing' : 'problem', detail: reasons[check.item]} : check);
  globalThis.fetch = async () => reply(result);
  render(<RemoteReadiness {...props}/>);
  await waitFor(() => assert.ok(screen.getByText(reasons.workspace)));
  assert.equal(section().getAttribute('data-ready'), 'false');
  assert.equal(green(), 7);
  for (const [id, reason] of Object.entries(reasons)) {
    assert.ok(screen.getByText(reason));
    assert.equal(row(id).dataset.status, id === 'reference_gtf' ? 'missing' : 'problem');
    assert.equal(row(id).querySelector('.ml-settings-check-detail')?.textContent, reason);
  }
  assert.doesNotMatch(summary(), /Environment ready/i);
});

test('incomplete, duplicate and contradictory results cannot establish readiness', async () => {
  const missing = readyResult();
  missing.checks = missing.checks.filter(check => check.item !== 'slurm');
  const duplicate = readyResult();
  duplicate.checks.push({...duplicate.checks[0]});
  const inconsistent = {...readyResult(), ready: false};
  const unreported = {...readyResult(), not_ready: ['workspace']};
  const invalid = readyResult();
  invalid.checks[0].status = 'unexpected';
  const pending = readyResult();
  pending.ready = false;
  pending.not_ready = ['container'];
  pending.checks = pending.checks.map(check => check.item === 'container'
    ? {...check, status: 'in_progress', detail: 'Download job is still queued'} : check);
  for (const result of [missing, duplicate, inconsistent, unreported, invalid, pending]) {
    globalThis.fetch = async () => reply(result);
    render(<RemoteReadiness {...props}/>);
    await waitFor(() => assert.equal((screen.getByRole('button', {name: 'Check again'}) as HTMLButtonElement).disabled, false));
    assert.equal(section().getAttribute('data-ready'), 'false');
    assert.doesNotMatch(summary(), /Environment ready/i);
    if (result === missing) assert.equal(row('slurm').dataset.status, 'unknown');
    if (result === pending) assert.ok(screen.getByText('Download job is still queued'));
    cleanup();
  }
});

test('failed and unavailable checks replace earlier green results with visible reasons', async () => {
  let result: unknown = readyResult();
  globalThis.fetch = async () => reply(result);
  render(<RemoteReadiness {...props}/>);
  await waitFor(() => assert.equal(green(), 11));
  for (const failure of [
    {status: 'not_ready', reason: 'The configured workspace is unavailable'},
    {status: 'unavailable', reason: 'The remote check timed out'},
    {status: 'failed', reason: 'The check did not complete'},
  ]) {
    result = failure;
    fireEvent.click(screen.getByRole('button', {name: 'Check again'}));
    await waitFor(() => assert.ok(screen.getByText(failure.reason)));
    assert.equal(green(), 0);
    assert.equal(section().getAttribute('data-ready'), 'false');
  }
});

test('known environment verification blockers remain visible even if all file checks pass', async () => {
  globalThis.fetch = async () => reply(readyResult());
  for (const phase of ['blocked', 'error', 'needs-install'] as const) {
    const message = `Runtime verification is ${phase}`;
    render(<RemoteReadiness {...props} environment={{...environment, phase, message}}/>);
    await waitFor(() => assert.ok(screen.getByText(message)));
    await waitFor(() => assert.equal((screen.getByRole('button', {name: 'Check again'}) as HTMLButtonElement).disabled, false));
    assert.equal(section().getAttribute('data-ready'), 'false');
    assert.doesNotMatch(summary(), /Environment ready/i);
    cleanup();
  }
});

test('a transport failure permits a manual retry without an automatic request loop', async () => {
  let calls = 0;
  globalThis.fetch = async () => { if (++calls === 1) throw new TypeError('Connection failed'); return reply(readyResult()); };
  render(<RemoteReadiness {...props}/>);
  await waitFor(() => assert.equal((screen.getByRole('button', {name: 'Check again'}) as HTMLButtonElement).disabled, false));
  assert.equal(calls, 1);
  assert.equal(section().getAttribute('data-ready'), 'false');
  assert.equal(green(), 0);
  assert.ok(summary().trim());
  fireEvent.click(screen.getByRole('button', {name: 'Check again'}));
  await waitFor(() => assert.equal(section().getAttribute('data-ready'), 'true'));
  assert.equal(calls, 2);
});

function pendingRequests() {
  const requests: {signal: AbortSignal; resolve: (body: unknown) => void}[] = [];
  globalThis.fetch = (_url, options) => new Promise<Response>(resolve => {
    requests.push({signal: options!.signal!, resolve: body => resolve(reply(body))});
  });
  return requests;
}

test('disconnect aborts the check and ignores its late successful response', async () => {
  const requests = pendingRequests();
  const {rerender} = render(<RemoteReadiness {...props}/>);
  await waitFor(() => assert.equal(requests.length, 1));
  fireEvent.click(screen.getByRole('button', {name: 'Check again'}));
  assert.equal(requests.length, 1, 'an in-flight check must not be duplicated');
  rerender(<RemoteReadiness {...props} connected={false} environment={{phase: 'disconnected', message: 'Disconnected'}}/>);
  assert.equal(requests[0].signal.aborted, true);
  await act(async () => { requests[0].resolve(readyResult()); });
  assert.equal(green(), 0);
  assert.equal(section().getAttribute('data-ready'), 'false');
  assert.equal((screen.getByRole('button', {name: 'Check again'}) as HTMLButtonElement).disabled, true);
});

test('changing installation or connection identity discards the old environment response', async () => {
  const requests = pendingRequests();
  const {rerender} = render(<RemoteReadiness {...props}/>);
  await waitFor(() => assert.equal(requests.length, 1));
  const nextEnvironment: EnvironmentSnapshot = {...environment, config: {...environment.config!, root: '/other/workspace'}};
  rerender(<RemoteReadiness {...props} environment={nextEnvironment}/>);
  await waitFor(() => assert.equal(requests.length, 2));
  assert.equal(requests[0].signal.aborted, true);
  await act(async () => { requests[0].resolve(readyResult()); });
  assert.equal(green(), 0);
  await act(async () => { requests[1].resolve(readyResult()); });
  await waitFor(() => assert.equal(green(), 11));
  rerender(<RemoteReadiness {...props} environment={nextEnvironment} connectionIdentity="other@other-cluster:22"/>);
  await waitFor(() => assert.equal(requests.length, 3));
  assert.equal(green(), 0);
  await act(async () => { requests[2].resolve(readyResult()); });
  await waitFor(() => assert.equal(green(), 11));
});

test('leaving Settings aborts a check and entering again performs one fresh check', async () => {
  const requests = pendingRequests();
  const {rerender} = render(<RemoteReadiness {...props}/>);
  await waitFor(() => assert.equal(requests.length, 1));
  rerender(<RemoteReadiness {...props} active={false}/>);
  assert.equal(requests[0].signal.aborted, true);
  await act(async () => { requests[0].resolve(readyResult()); });
  assert.equal(green(), 0);
  rerender(<RemoteReadiness {...props}/>);
  await waitFor(() => assert.equal(requests.length, 2));
  await act(async () => { requests[1].resolve(readyResult()); });
  await waitFor(() => assert.equal(green(), 11));
});

function setupResult(states: Record<string, string> = {}) {
  const result = readyResult();
  result.checks = result.checks.map(check => ({...check, status: states[check.item] ?? 'ok'}));
  result.not_ready = result.checks.filter(check => check.status !== 'ok').map(check => check.item);
  result.ready = !result.not_ready.length;
  return result;
}

const setupButton = (step: string) => document.querySelector(`[data-setup-action="${step}"]`) as HTMLButtonElement;

test('missing resources never start setup automatically; source install requires one explicit click', async () => {
  const requests: string[] = [];
  let installed = false, installCalls = 0, verifyCalls = 0;
  let finish!: () => void;
  globalThis.fetch = async url => {
    requests.push(String(url));
    assert.equal(String(url), '/hpc/check');
    return reply(setupResult({signet_source: installed ? 'ok' : 'missing', container: 'missing'}));
  };
  render(<RemoteReadiness {...props} environment={{...environment, phase: 'needs-install', missing: ['SIGNET source', 'SIGNET container']}}
    onInstall={() => { installCalls++; return new Promise(resolve => { finish = () => { installed = true; resolve({ok: true}); }; }); }}
    onVerify={async () => { verifyCalls++; return {ok: true}; }}/>);
  await waitFor(() => assert.equal(setupButton('signet')?.disabled, false));
  assert.equal(installCalls, 0);
  assert.equal(verifyCalls, 0);
  fireEvent.click(setupButton('signet'));
  fireEvent.click(setupButton('signet'));
  assert.equal(installCalls, 1);
  assert.equal(setupButton('signet').disabled, true);
  await act(async () => { finish(); });
  await waitFor(() => assert.equal(row('signet_source').dataset.status, 'ok'));
  assert.equal(installCalls, 1);
  assert.equal(verifyCalls, 0, 'installation must not silently start another setup action');
  assert.ok(requests.every(url => url === '/hpc/check'));
});

test('reopening an ongoing source installation shows its original live progress without installing again', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return reply(readyResult()); };
  const message = 'Downloading and verifying the pinned SIGNET source and example data.';
  const {rerender} = render(<RemoteReadiness {...props} environment={{...environment, phase: 'installing-source', message}}/>);
  assert.equal(row('signet_source').dataset.status, 'in_progress');
  assert.ok(row('signet_source').textContent?.includes(message));
  assert.equal(row('signet_source').querySelector('[data-setup-status]')?.getAttribute('data-state'), 'in_progress');
  assert.equal(calls, 0);
  rerender(<RemoteReadiness {...props} connected={false} environment={{phase: 'disconnected', message: 'Disconnected'}}/>);
  assert.equal(row('signet_source').dataset.status, 'unknown');
  assert.ok(!row('signet_source').textContent?.includes(message));
});

test('source installation failure exposes the original failure cause without repeating installation', async () => {
  let installs = 0;
  globalThis.fetch = async () => reply(setupResult({signet_source: 'missing', container: 'missing'}));
  render(<RemoteReadiness {...props} environment={{...environment, phase: 'needs-install', missing: ['SIGNET source']}}
    onInstall={async () => { installs++; return {ok: false, error: 'The source download failed: checksum mismatch'}; }}/>);
  await waitFor(() => assert.equal(setupButton('signet')?.disabled, false));
  fireEvent.click(setupButton('signet'));
  await waitFor(() => assert.equal(row('signet_source').textContent?.includes('The source download failed: checksum mismatch'), true));
  assert.equal(row('signet_source').querySelector('[data-setup-status]')?.getAttribute('data-state'), 'failed');
  assert.equal(installs, 1);
});

test('each download and reference preparation sends only its own fixed action once', async () => {
  for (const [step, id, route] of [
    ['container', 'container', '/hpc/container'], ['ref', 'reference_ref', '/hpc/reference/ref'],
    ['gmap', 'reference_gmap', '/hpc/reference/gmap'], ['gtf', 'reference_gtf', '/hpc/reference/gtf'],
    ['clinical', 'reference_clinical', '/hpc/reference/clinical'], ['prepare', 'imputation_reference', '/hpc/prepare'],
  ]) {
    const actions: string[] = [];
    let started = false;
    let finish!: () => void;
    globalThis.fetch = async (url, options) => {
      if (String(url) === '/hpc/check') return reply(setupResult({[id]: started ? 'in_progress' : 'missing'}));
      actions.push(String(url));
      assert.equal(String(url), route);
      assert.equal(options?.method, 'POST');
      assert.equal(options?.body, '{}');
      return new Promise(resolve => { finish = () => { started = true; resolve(reply({status: 'ok', step, outcome: 'started', job_id: '123', executed: true, detail: 'Queued on the scheduler'})); }; });
    };
    render(<RemoteReadiness {...props}/>);
    await waitFor(() => assert.equal(setupButton(step)?.disabled, false));
    assert.deepEqual(actions, []);
    fireEvent.click(setupButton(step));
    fireEvent.click(setupButton(step));
    assert.deepEqual(actions, [route]);
    await act(async () => { finish(); });
    await waitFor(() => assert.equal(row(id).dataset.status, 'in_progress'));
    assert.equal(setupButton(step)?.disabled ?? true, true);
    assert.deepEqual(actions, [route], 'progress checks must never resubmit setup');
    cleanup();
  }
});

test('a prerequisite refusal is shown as a failure instead of reporting a started download', async () => {
  let submissions = 0;
  globalThis.fetch = async url => {
    if (String(url) === '/hpc/check') return reply(setupResult({reference_gtf: 'missing'}));
    assert.equal(String(url), '/hpc/reference/gtf');
    submissions++;
    return reply({status: 'ok', outcome: 'needs_container', executed: false, detail: 'Download the SIGNET container first.'});
  };
  render(<RemoteReadiness {...props}/>);
  await waitFor(() => assert.equal(setupButton('gtf')?.disabled, false));
  fireEvent.click(setupButton('gtf'));
  await waitFor(() => assert.equal(row('reference_gtf').textContent?.includes('Download the SIGNET container first.'), true));
  assert.equal(row('reference_gtf').querySelector('[data-setup-status]')?.getAttribute('data-state'), 'failed');
  assert.equal(submissions, 1);
});

test('setup log uses the fixed read-only route and renders output as text', async () => {
  const calls: string[] = [];
  const detail = '<img src=x onerror=alert(1)> download checksum mismatch';
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    if (String(url) === '/hpc/check') return reply(setupResult({container: 'problem'}));
    assert.equal(String(url), '/hpc/log/container');
    assert.equal(options?.body, '{}');
    return reply({status: 'ok', step: 'container', executed: false, lines: [detail]});
  };
  render(<RemoteReadiness {...props}/>);
  await waitFor(() => assert.ok(document.querySelector('[data-setup-log="container"]')));
  fireEvent.click(document.querySelector('[data-setup-log="container"]')!);
  await waitFor(() => assert.equal(document.querySelector('[data-setup-log-output="container"]')?.textContent, detail));
  assert.equal(document.querySelector('[data-setup-log-output="container"] img'), null);
  assert.ok(calls.every(url => url === '/hpc/check' || url === '/hpc/log/container'));
});

test('environment verification is a separate manual action and never triggers setup automatically', async () => {
  const requests: string[] = [];
  let verified = 0;
  globalThis.fetch = async url => { requests.push(String(url)); return reply(readyResult()); };
  render(<RemoteReadiness {...props} environment={{...environment, phase: 'needs-install', missing: ['SIGNET container']}}
    onVerify={async () => { verified++; return {ok: true}; }}/>);
  await waitFor(() => assert.equal((document.querySelector('[data-setup-verify]') as HTMLButtonElement)?.disabled, false));
  assert.equal(verified, 0);
  fireEvent.click(document.querySelector('[data-setup-verify]')!);
  await waitFor(() => assert.equal(verified, 1));
  assert.ok(requests.every(url => url === '/hpc/check'));
});

test('disconnecting during submission ignores the late result and never repeats the action', async () => {
  let submissions = 0;
  let finish!: () => void;
  globalThis.fetch = async url => {
    if (String(url) === '/hpc/check') return reply(setupResult({container: 'missing'}));
    assert.equal(String(url), '/hpc/container');
    submissions++;
    return new Promise(resolve => { finish = () => resolve(reply({status: 'ok', outcome: 'started', job_id: '123'})); });
  };
  const {rerender} = render(<RemoteReadiness {...props}/>);
  await waitFor(() => assert.equal(setupButton('container')?.disabled, false));
  fireEvent.click(setupButton('container'));
  rerender(<RemoteReadiness {...props} connected={false} environment={{phase: 'disconnected', message: 'Disconnected'}}/>);
  await act(async () => { finish(); });
  assert.equal(green(), 0);
  assert.equal(section().getAttribute('data-ready'), 'false');
  assert.ok(!row('container').querySelector('[data-setup-status]'));
  assert.equal(submissions, 1);
});
