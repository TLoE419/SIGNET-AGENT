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
const ids = ['connection', 'workspace', 'slurm', 'apptainer', 'signet_source', 'container'];
const environment: EnvironmentSnapshot = {phase: 'ready', message: 'Verified runtime', config: {
  root: '/work/researcher', source: '/work/researcher/software/signet', image: '/work/researcher/signet.sif',
  executor: '/usr/bin/apptainer', workRoot: '/work/researcher/runs', revision: 'verified', partition: 'shared',
}};
const props = {active: true, connected: true, environment,
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
const technicalDetails = () => [...section().querySelectorAll('details')]
  .find(details => details.querySelector('summary')?.textContent?.trim() === 'Technical details');

test('opening connected settings checks all six environment prerequisites automatically and supports manual refresh', async () => {
  const requests: {url: string; options?: RequestInit}[] = [];
  let verifies = 0;
  const onVerify = async () => { verifies++; return {ok: true}; };
  globalThis.fetch = async (url, options) => { requests.push({url: String(url), options}); return reply(readyResult()); };
  const {rerender} = render(<RemoteReadiness {...props} active={false} onVerify={onVerify}/>);
  assert.equal(requests.length, 0);
  rerender(<RemoteReadiness {...props} onVerify={onVerify}/>);
  await waitFor(() => assert.equal(section().getAttribute('data-ready'), 'true'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/hpc/check');
  assert.equal(requests[0].options?.method, 'POST');
  assert.equal((requests[0].options?.headers as Record<string, string>)['X-Chat-Token'], 'test-page-token');
  assert.deepEqual([...document.querySelectorAll<HTMLElement>('#ml-environment-checks li')].map(check => check.dataset.checkId), ids);
  assert.equal(screen.queryByRole('button', {name: 'View setup log'}), null);
  assert.equal(green(), ids.length);
  assert.match(summary(), /6\/6/);
  for (const id of ids) assert.equal(row(id).dataset.status, 'ok');
  assert.ok(screen.getByText('checked workspace'));
  fireEvent.click(screen.getByRole('button', {name: 'Check environment'}));
  await waitFor(() => assert.equal(requests.length, 2));
  await waitFor(() => assert.equal(section().getAttribute('data-ready'), 'true'));
  assert.ok(screen.getByRole('heading', {name: 'Environment readiness'}));
  assert.ok(screen.getByText('checked workspace'));
  assert.deepEqual(requests.map(({url}) => url), ['/hpc/check', '/hpc/check']);
  assert.equal(verifies, 0, 'a verified environment only refreshes the read-only report');
});

test('compute failures and a missing container show their individual reasons', async () => {
  const result = readyResult();
  const reasons: Record<string, string> = {workspace: '/work/researcher is not writable', slurm: 'sbatch is unavailable',
    apptainer: 'No container runtime was found', container: 'The SIGNET container is missing'};
  result.ready = false;
  result.not_ready = Object.keys(reasons);
  result.checks = result.checks.map(check => reasons[check.item]
    ? {...check, status: check.item === 'container' ? 'missing' : 'problem', detail: reasons[check.item]} : check);
  globalThis.fetch = async () => reply(result);
  render(<RemoteReadiness {...props}/>);
  await waitFor(() => assert.ok(screen.getByText(reasons.workspace)));
  assert.equal(section().getAttribute('data-ready'), 'false');
  assert.equal(green(), 2);
  for (const [id, reason] of Object.entries(reasons)) {
    assert.ok(screen.getByText(reason));
    assert.equal(row(id).dataset.status, id === 'container' ? 'missing' : 'problem');
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
    await waitFor(() => assert.equal((screen.getByRole('button', {name: 'Check environment'}) as HTMLButtonElement).disabled, false));
    assert.equal(section().getAttribute('data-ready'), 'false');
    assert.doesNotMatch(summary(), /Environment ready/i);
    if (result === missing) assert.equal(row('slurm').dataset.status, 'unknown');
    if (result === pending) assert.ok(screen.getByText('Download job is still queued'));
    cleanup();
  }
});

test('whole-check failures have actionable summaries and keep the raw reasons in a collapsed disclosure', async () => {
  let result: unknown = readyResult();
  let statusCode = 200;
  globalThis.fetch = async () => reply(result, statusCode);
  render(<RemoteReadiness {...props}/>);
  await waitFor(() => assert.equal(green(), ids.length));
  for (const failure of [
    {status: 'not_ready', reason: 'Remote settings did not supply an installation directory', statusCode: 200,
      headline: 'Remote settings need attention.', action: 'Review the remote settings, then check again.'},
    {status: 'unavailable', code: 'remote_timeout', reason: 'SSH read exceeded the connection deadline', statusCode: 200,
      headline: 'The remote check timed out.', action: 'Check again in a moment.'},
    {status: 'unavailable', code: 'remote_disconnected', reason: 'SSH channel closed before the report was read', statusCode: 200,
      headline: 'The remote connection was interrupted.', action: 'Reconnect in Settings, then check again.'},
    {status: 'failed', reason: 'The checker returned an unknown result', statusCode: 200,
      headline: 'Environment check failed.', action: 'Select Check environment to try again.'},
    {status: 'failed', code: 'local_runtime_missing', reason: 'The bundled file /opt/signet/runtime/fixture.py was not found', statusCode: 500,
      headline: 'SIGNET could not load a required file.', action: 'Restart SIGNET, then check again.'},
  ]) {
    const {headline, action, statusCode: status, ...response} = failure;
    result = response;
    statusCode = status;
    fireEvent.click(screen.getByRole('button', {name: 'Check environment'}));
    await waitFor(() => assert.ok(screen.getByText(headline)));
    assert.ok(screen.getByText(action));
    const details = technicalDetails();
    assert.ok(details);
    assert.equal(details.open, false);
    assert.ok(details.textContent?.includes(response.reason));
    assert.ok(!summary().includes(response.reason));
    assert.doesNotMatch(summary(), /0\s*\/\s*6/);
    assert.equal(green(), 0);
    assert.equal(section().getAttribute('data-ready'), 'false');
  }
  fireEvent.click(screen.getByText('Technical details'));
  await waitFor(() => assert.equal(technicalDetails()?.open, true));
  result = readyResult();
  statusCode = 200;
  fireEvent.click(screen.getByRole('button', {name: 'Check environment'}));
  await waitFor(() => assert.equal(section().getAttribute('data-ready'), 'true'));
  assert.match(summary(), /6\/6/);
  assert.equal(technicalDetails(), undefined);
});

test('verification blockers keep their next step visible with technical details collapsed', async () => {
  globalThis.fetch = async () => reply(readyResult());
  for (const phase of ['blocked', 'error', 'needs-install'] as const) {
    const message = `Runtime verification is ${phase}`;
    render(<RemoteReadiness {...props} environment={{...environment, phase, message}}/>);
    await waitFor(() => assert.equal((screen.getByRole('button', {name: 'Check environment'}) as HTMLButtonElement).disabled, false));
    assert.equal(section().getAttribute('data-ready'), 'false');
    assert.equal(technicalDetails()?.open, false);
    assert.ok(technicalDetails()?.textContent?.includes(message));
    assert.ok(!summary().includes(message));
    if (phase === 'needs-install') {
      assert.ok(screen.getByText('6/6 checks passed.'));
      assert.ok(screen.getByText('Select Check environment to confirm readiness.'));
    } else {
      assert.ok(screen.getByText('Remote settings need attention.'));
      assert.ok(screen.getByText('Review the remote settings, then check again.'));
    }
    cleanup();
  }
});

test('a transport failure permits a manual retry without an automatic request loop', async () => {
  let calls = 0;
  globalThis.fetch = async () => { if (++calls === 1) throw new TypeError('Connection failed'); return reply(readyResult()); };
  render(<RemoteReadiness {...props}/>);
  await waitFor(() => assert.equal((screen.getByRole('button', {name: 'Check environment'}) as HTMLButtonElement).disabled, false));
  assert.equal(calls, 1);
  assert.equal(section().getAttribute('data-ready'), 'false');
  assert.equal(green(), 0);
  assert.ok(summary().trim());
  assert.doesNotMatch(summary(), /0\s*\/\s*6/);
  fireEvent.click(screen.getByRole('button', {name: 'Check environment'}));
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
  fireEvent.click(screen.getByRole('button', {name: 'Check environment'}));
  assert.equal(requests.length, 1, 'an in-flight check must not be duplicated');
  rerender(<RemoteReadiness {...props} connected={false} environment={{phase: 'disconnected', message: 'Disconnected'}}/>);
  assert.equal(requests[0].signal.aborted, true);
  await act(async () => { requests[0].resolve(readyResult()); });
  assert.equal(green(), 0);
  assert.equal(section().getAttribute('data-ready'), 'false');
  assert.equal((screen.getByRole('button', {name: 'Check environment'}) as HTMLButtonElement).disabled, true);
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
  await waitFor(() => assert.equal(green(), ids.length));
  rerender(<RemoteReadiness {...props} environment={nextEnvironment} connectionIdentity="other@other-cluster:22"/>);
  await waitFor(() => assert.equal(requests.length, 3));
  assert.equal(green(), 0);
  await act(async () => { requests[2].resolve(readyResult()); });
  await waitFor(() => assert.equal(green(), ids.length));
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
  await waitFor(() => assert.equal(green(), ids.length));
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
  globalThis.fetch = async (url, options) => {
    requests.push(String(url));
    if (String(url) === '/hpc/signet') {
      installCalls++;
      assert.equal(options?.method, 'POST');
      assert.equal((options?.headers as Record<string, string>)['X-Chat-Token'], 'test-page-token');
      return new Promise(resolve => { finish = () => { installed = true; resolve(reply({status: 'ok', outcome: 'started', executed: true})); }; });
    }
    assert.equal(String(url), '/hpc/check');
    return reply(setupResult({signet_source: installed ? 'ok' : 'missing', container: 'missing'}));
  };
  render(<RemoteReadiness {...props} environment={{...environment, phase: 'needs-install', missing: ['SIGNET source', 'SIGNET container']}}
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
  assert.equal(verifyCalls, 1, 'the completed explicit installation refreshes read-only verification');
  assert.ok(requests.every(url => url === '/hpc/check' || url === '/hpc/signet'));
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
  globalThis.fetch = async url => {
    if (String(url) === '/hpc/signet') { installs++; return reply({status: 'failed', outcome: 'failed', error: 'The source download failed: checksum mismatch'}); }
    return reply(setupResult({signet_source: 'missing', container: 'missing'}));
  };
  render(<RemoteReadiness {...props} environment={{...environment, phase: 'needs-install', missing: ['SIGNET source']}}/>);
  await waitFor(() => assert.equal(setupButton('signet')?.disabled, false));
  fireEvent.click(setupButton('signet'));
  await waitFor(() => assert.equal(row('signet_source').textContent?.includes('The source download failed: checksum mismatch'), true));
  assert.equal(row('signet_source').querySelector('[data-setup-status]')?.getAttribute('data-state'), 'failed');
  assert.equal(installs, 1);
});

test('the container download sends its fixed action once', async () => {
  const actions: string[] = [];
  let started = false;
  let finish!: () => void;
  globalThis.fetch = async (url, options) => {
    if (String(url) === '/hpc/check') return reply(setupResult({container: started ? 'in_progress' : 'missing'}));
    actions.push(String(url));
    assert.equal(String(url), '/hpc/container');
    assert.equal(options?.method, 'POST');
    assert.equal(options?.body, '{}');
    return new Promise(resolve => { finish = () => {
      started = true;
      resolve(reply({status: 'ok', step: 'container', outcome: 'started', job_id: '123', executed: true, detail: 'Queued on the scheduler'}));
    }; });
  };
  render(<RemoteReadiness {...props}/>);
  await waitFor(() => assert.equal(setupButton('container')?.disabled, false));
  assert.match(summary(), /5\/6/);
  assert.ok(screen.getByText('Review the checks below.'));
  assert.equal(technicalDetails(), undefined);
  assert.ok(row('container').contains(screen.getByRole('button', {name: 'Download container'})));
  assert.deepEqual(actions, []);
  fireEvent.click(setupButton('container'));
  fireEvent.click(setupButton('container'));
  assert.deepEqual(actions, ['/hpc/container']);
  await act(async () => { finish(); });
  await waitFor(() => assert.equal(row('container').dataset.status, 'in_progress'));
  assert.equal(setupButton('container')?.disabled ?? true, true);
  assert.deepEqual(actions, ['/hpc/container'], 'progress checks must never resubmit setup');
});

test('a prerequisite refusal is shown as a failure instead of reporting a started download', async () => {
  let submissions = 0;
  globalThis.fetch = async url => {
    if (String(url) === '/hpc/check') return reply(setupResult({container: 'missing'}));
    assert.equal(String(url), '/hpc/container');
    submissions++;
    return reply({status: 'ok', outcome: 'needs_slurm', executed: false, detail: 'The job scheduler became unavailable.'});
  };
  render(<RemoteReadiness {...props}/>);
  await waitFor(() => assert.equal(setupButton('container')?.disabled, false));
  fireEvent.click(setupButton('container'));
  await waitFor(() => assert.equal(row('container').textContent?.includes('The job scheduler became unavailable.'), true));
  assert.equal(row('container').querySelector('[data-setup-status]')?.getAttribute('data-state'), 'failed');
  assert.equal(submissions, 1);
});

test('source and container setup each offer only their manual action', async () => {
  const requests: string[] = [];
  globalThis.fetch = async url => {
    requests.push(String(url));
    return reply(setupResult({signet_source: 'missing', container: 'problem'}));
  };
  render(<RemoteReadiness {...props} environment={{...environment, phase: 'needs-install', missing: ['SIGNET source']}}/>);
  await waitFor(() => assert.ok(screen.getByRole('button', {name: 'Install SIGNET'})));
  assert.ok(screen.getByRole('button', {name: 'Download container'}));
  assert.deepEqual([...row('signet_source').querySelectorAll('button')].map(button => button.textContent), ['Install SIGNET']);
  assert.deepEqual([...row('container').querySelectorAll('button')].map(button => button.textContent), ['Download container']);
  assert.deepEqual(requests, ['/hpc/check']);
});

test('remote settings are separate from the single environment check', async () => {
  const requests: string[] = [];
  let verified = 0, openedSettings = 0;
  globalThis.fetch = async url => { requests.push(String(url)); return reply(readyResult()); };
  render(<RemoteReadiness {...props} environment={{...environment, phase: 'needs-install', missing: ['SIGNET container']}}
    onEnvironment={() => { openedSettings++; }}
    onVerify={async () => { verified++; return {ok: true}; }}/>);
  const refresh = screen.getByRole('button', {name: 'Check environment'});
  const settings = screen.getByRole('button', {name: 'Remote environment settings'});
  const configuration = screen.getByRole('region', {name: 'Remote configuration'});
  assert.equal(refresh.getAttribute('aria-controls'), 'ml-environment-checks');
  assert.deepEqual([...configuration.querySelectorAll('button')], [settings]);
  assert.equal(configuration.nextElementSibling?.id, 'ml-environment-checks');
  assert.equal(screen.queryByRole('button', {name: 'Verify configuration'}), null);
  assert.equal(screen.queryByRole('button', {name: 'Refresh checks'}), null);
  await waitFor(() => assert.equal((refresh as HTMLButtonElement).disabled, false));
  assert.equal(verified, 0);
  fireEvent.click(settings);
  assert.equal(openedSettings, 1);
  assert.equal(verified, 0);
  assert.deepEqual(requests, ['/hpc/check']);
});

test('manual checks verify configuration only after prerequisites become available', async () => {
  const requests: string[] = [];
  let report = setupResult({container: 'missing'});
  let finishVerification!: (result: {ok: boolean}) => void;
  let verified = false;
  const onVerify = () => {
    requests.push('verify');
    return new Promise<{ok: boolean}>(resolve => { finishVerification = resolve; });
  };
  globalThis.fetch = async url => {
    requests.push(String(url));
    if (!verified) return reply(report);
    return reply({...report, checks: report.checks.map(check => ({...check, detail: 'verified ' + check.item}))});
  };
  const checking = {...environment, phase: 'needs-install' as const, missing: ['SIGNET container']};
  const {rerender} = render(<RemoteReadiness {...props} environment={checking} onVerify={onVerify}/>);
  const check = screen.getByRole('button', {name: 'Check environment'}) as HTMLButtonElement;
  await waitFor(() => assert.equal(row('container').dataset.status, 'missing'));
  fireEvent.click(check);
  await waitFor(() => assert.equal(check.disabled, false));
  assert.deepEqual(requests, ['/hpc/check', '/hpc/check']);
  assert.equal(row('container').dataset.status, 'missing');

  report = readyResult();
  fireEvent.click(check);
  await waitFor(() => assert.deepEqual(requests, ['/hpc/check', '/hpc/check', '/hpc/check', 'verify']));
  assert.equal(check.disabled, true);
  fireEvent.click(check);
  rerender(<RemoteReadiness {...props} environment={{phase: 'checking', message: 'Checking the saved remote settings'}} onVerify={onVerify}/>);
  assert.equal(check.disabled, true);
  assert.deepEqual(requests, ['/hpc/check', '/hpc/check', '/hpc/check', 'verify']);
  rerender(<RemoteReadiness {...props} environment={{...environment, checkedAt: '2026-11-21T00:00:00Z'}} onVerify={onVerify}/>);
  assert.equal(check.disabled, true);
  assert.deepEqual(requests, ['/hpc/check', '/hpc/check', '/hpc/check', 'verify']);
  await act(async () => { verified = true; finishVerification({ok: true}); });
  await waitFor(() => assert.ok(screen.getByText('verified container')));
  assert.equal(green(), ids.length);
  assert.equal(section().getAttribute('data-ready'), 'true');
  assert.equal(check.disabled, false);
  assert.deepEqual(requests, ['/hpc/check', '/hpc/check', '/hpc/check', 'verify', '/hpc/check']);
});

test('manual checks retry configuration when the runtime still needs verification', async () => {
  for (const phase of ['needs-install', 'error', 'blocked'] as const) {
    const requests: string[] = [];
    let verified = false;
    globalThis.fetch = async url => {
      requests.push(String(url));
      const result = readyResult();
      if (verified) result.checks[0].detail = 'Connection rechecked after verification';
      return reply(result);
    };
    render(<RemoteReadiness {...props} environment={{...environment, phase}}
      onVerify={async () => { requests.push('verify'); verified = true; return {ok: true}; }}/>);
    await waitFor(() => assert.equal(green(), ids.length));
    assert.deepEqual(requests, ['/hpc/check'], phase);
    fireEvent.click(screen.getByRole('button', {name: 'Check environment'}));
    await waitFor(() => assert.ok(screen.getByText('Connection rechecked after verification')));
    assert.deepEqual(requests, ['/hpc/check', 'verify', '/hpc/check'], phase);
    cleanup();
  }
});

test('a manual check that finds missing source makes the existing installation action available', async () => {
  const requests: string[] = [];
  let report = readyResult();
  let finishVerification!: (result: {ok: boolean}) => void;
  const onVerify = () => {
    requests.push('verify');
    return new Promise<{ok: boolean}>(resolve => { finishVerification = resolve; });
  };
  globalThis.fetch = async url => { requests.push(String(url)); return reply(report); };
  const {rerender} = render(<RemoteReadiness {...props} onVerify={onVerify}/>);
  await waitFor(() => assert.equal(section().getAttribute('data-ready'), 'true'));

  report = setupResult({signet_source: 'missing'});
  fireEvent.click(screen.getByRole('button', {name: 'Check environment'}));
  await waitFor(() => assert.deepEqual(requests, ['/hpc/check', '/hpc/check', 'verify']));
  rerender(<RemoteReadiness {...props} environment={{...environment, phase: 'needs-install', missing: ['SIGNET source']}}
    onVerify={onVerify}/>);
  await act(async () => { finishVerification({ok: true}); });
  await waitFor(() => assert.equal(setupButton('signet')?.disabled, false));
  assert.equal(row('signet_source').dataset.status, 'missing');
  assert.deepEqual(requests, ['/hpc/check', '/hpc/check', 'verify', '/hpc/check']);
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

const cursorA = 'a'.repeat(64), cursorB = 'b'.repeat(64);
function setupEvents() {
  const checks: {resolve: (body: unknown) => void; signal: AbortSignal}[] = [];
  const watches: {resolve: (body: unknown) => void; signal: AbortSignal; cursor: string}[] = [];
  globalThis.fetch = (url, options) => new Promise<Response>((resolve, reject) => {
    const pending = {resolve: (body: unknown) => resolve(reply(body)), signal: options!.signal!};
    if (String(url) === '/hpc/watch') watches.push({...pending, cursor: JSON.parse(String(options!.body)).cursor});
    else { assert.equal(String(url), '/hpc/check'); checks.push(pending); }
    pending.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true});
  });
  return {checks, watches};
}
const downloading = () => ({...setupResult({container: 'in_progress'}), setup_cursor: cursorA});

test('automatic refresh retains existing rows and summary until new results arrive', async () => {
  const {checks} = setupEvents();
  render(<RemoteReadiness {...props}/>);
  await act(async () => checks[0].resolve(readyResult()));
  const before = summary(), workspace = row('workspace');
  act(() => window.dispatchEvent(new Event('workspace-setup-refresh')));
  assert.equal(checks.length, 2);
  assert.equal(row('workspace'), workspace);
  assert.equal(green(), ids.length, 'background checking must not blank already displayed readiness rows');
  assert.equal(summary(), before, 'background refresh must not flash the global checking message');
  await act(async () => checks[1].resolve(setupResult({container: 'missing'})));
  assert.equal(row('container').dataset.status, 'missing');
});

test('setup wait timeouts rearm without full checks; completion causes one quiet validation', async () => {
  const {checks, watches} = setupEvents();
  let verifies = 0;
  render(<RemoteReadiness {...props} environment={{...environment, phase: 'needs-install', missing: ['SIGNET container']}}
    onVerify={async () => { verifies++; return {ok: true}; }}/>);
  await act(async () => checks[0].resolve(downloading()));
  await waitFor(() => assert.equal(watches.length, 1));
  assert.equal(watches[0].cursor, cursorA);
  const before = summary();
  await act(async () => watches[0].resolve({status: 'ok', changed: false, setup_cursor: cursorA}));
  assert.equal(checks.length, 1);
  await waitFor(() => assert.equal(watches.length, 2), {timeout: 2500});
  assert.equal(checks.length, 1, 'normal wait expiry is not a readiness refresh');
  await act(async () => watches[1].resolve({status: 'ok', changed: true, setup_cursor: cursorB}));
  await waitFor(() => assert.equal(checks.length, 2));
  assert.equal(summary(), before);
  assert.equal(row('container').dataset.status, 'in_progress');
  await act(async () => checks[1].resolve({...readyResult(), setup_cursor: cursorB}));
  assert.equal(green(), ids.length);
  assert.equal(watches[1].signal.aborted, true);
  assert.equal(verifies, 0, 'a container completion notification must not verify the runtime');
  assert.equal(section().getAttribute('data-ready'), 'false');
});

test('leaving or disconnecting aborts setup notifications and ignores late changes', async () => {
  for (const change of [{active: false}, {connected: false}, {connectionIdentity: 'other@host:22'}]) {
    const {checks, watches} = setupEvents();
    const {rerender} = render(<RemoteReadiness {...props}/>);
    await act(async () => checks[0].resolve(downloading()));
    await waitFor(() => assert.equal(watches.length, 1));
    rerender(<RemoteReadiness {...props} {...change}/>);
    assert.equal(watches[0].signal.aborted, true);
    await act(async () => watches[0].resolve({status: 'ok', changed: true, setup_cursor: cursorB}));
    assert.equal(checks.length, change.connectionIdentity ? 2 : 1);
    assert.equal(green(), 0);
    cleanup();
  }
});

test('setup change during a manual check coalesces one followup validation', async () => {
  const {checks, watches} = setupEvents();
  render(<RemoteReadiness {...props}/>);
  await act(async () => checks[0].resolve(downloading()));
  await waitFor(() => assert.equal(watches.length, 1));
  fireEvent.click(screen.getByRole('button', {name: 'Check environment'}));
  assert.equal(checks.length, 2);
  await act(async () => watches[0].resolve({status: 'ok', changed: true, setup_cursor: cursorB}));
  assert.equal(checks.length, 2, 'events must not duplicate an in-flight check');
  await act(async () => checks[1].resolve(downloading()));
  await waitFor(() => assert.equal(checks.length, 3));
  await act(async () => checks[2].resolve({...readyResult(), setup_cursor: cursorB}));
  assert.equal(green(), ids.length);
});

test('a failed notification wait keeps rows stable and reconciles slowly without a retry loop', async context => {
  context.mock.timers.enable({apis: ['setInterval']});
  let checks = 0, watches = 0;
  let finish!: () => void;
  globalThis.fetch = async url => {
    if (String(url) === '/hpc/watch') { watches++; throw new TypeError('SSH wait lost'); }
    assert.equal(String(url), '/hpc/check');
    if (++checks === 1) return reply(downloading());
    return new Promise(resolve => { finish = () => resolve(reply({...readyResult(), setup_cursor: cursorB})); });
  };
  await act(async () => { render(<RemoteReadiness {...props}/>); });
  assert.equal(watches, 1);
  const before = summary();
  act(() => context.mock.timers.tick(4000));
  assert.equal(checks, 1, 'the old four-second full check must not occur');
  assert.equal(watches, 1, 'failed waits must not retry in a tight loop');
  act(() => context.mock.timers.tick(56000));
  assert.equal(checks, 2, 'legacy jobs and scheduler cancellation still get a slow reconciliation');
  assert.equal(summary(), before);
  assert.equal(row('container').dataset.status, 'in_progress');
  await act(async () => finish());
  assert.equal(green(), ids.length);
});

test('manual refresh during a quiet completion check queues one visible check instead of dropping the click', async () => {
  const {checks, watches} = setupEvents();
  render(<RemoteReadiness {...props}/>);
  await act(async () => checks[0].resolve(downloading()));
  await waitFor(() => assert.equal(watches.length, 1));
  await act(async () => watches[0].resolve({status: 'ok', changed: true, setup_cursor: cursorB}));
  await waitFor(() => assert.equal(checks.length, 2));
  fireEvent.click(screen.getByRole('button', {name: 'Check environment'}));
  assert.equal(checks.length, 2, 'manual and automatic checks must not execute concurrently');
  assert.match(summary(), /Checking the remote environment/);
  assert.equal(row('container').dataset.status, 'in_progress');
  fireEvent.click(screen.getByRole('button', {name: 'Check environment'}));
  await act(async () => checks[1].resolve({...downloading(), setup_cursor: cursorB}));
  await waitFor(() => assert.equal(checks.length, 3));
  assert.match(summary(), /Checking the remote environment/);
  assert.equal(row('container').dataset.status, 'in_progress');
  await act(async () => checks[2].resolve({...readyResult(), setup_cursor: cursorB}));
  assert.equal(green(), ids.length);
  assert.equal(checks.length, 3);
});

test('a manual check with unchanged setup metadata preserves the existing notification wait', async () => {
  const {checks, watches} = setupEvents();
  render(<RemoteReadiness {...props}/>);
  await act(async () => checks[0].resolve(downloading()));
  await waitFor(() => assert.equal(watches.length, 1));
  fireEvent.click(screen.getByRole('button', {name: 'Check environment'}));
  await act(async () => checks[1].resolve(downloading()));
  assert.equal(watches.length, 1, 'unchanged manual checks must not abandon and replace SSH waits');
  assert.equal(watches[0].signal.aborted, false);
  fireEvent.click(screen.getByRole('button', {name: 'Check environment'}));
  await act(async () => checks[2].resolve(downloading()));
  assert.equal(watches.length, 1);
  assert.equal(watches[0].signal.aborted, false);
});

test('a completed check rearms a failed wait even when the metadata cursor is unchanged', async () => {
  const {checks, watches} = setupEvents();
  render(<RemoteReadiness {...props}/>);
  await act(async () => checks[0].resolve(downloading()));
  await waitFor(() => assert.equal(watches.length, 1));
  await act(async () => watches[0].resolve({status: 'unavailable'}));
  assert.equal(checks.length, 1);
  fireEvent.click(screen.getByRole('button', {name: 'Check environment'}));
  await act(async () => checks[1].resolve(downloading()));
  await waitFor(() => assert.equal(watches.length, 2));
  assert.equal(watches[1].cursor, cursorA);
  assert.equal(checks.length, 2);
});

test('a notification received during the snapshot is not lost when validation returns the old cursor', async () => {
  const {checks, watches} = setupEvents();
  render(<RemoteReadiness {...props}/>);
  await act(async () => checks[0].resolve(downloading()));
  await waitFor(() => assert.equal(watches.length, 1));
  await act(async () => watches[0].resolve({status: 'ok', changed: true, setup_cursor: cursorB}));
  await waitFor(() => assert.equal(checks.length, 2));
  await act(async () => checks[1].resolve(downloading()));
  await waitFor(() => assert.equal(watches.length, 2));
  assert.equal(watches[1].cursor, cursorA);
  await act(async () => watches[1].resolve({status: 'ok', changed: true, setup_cursor: cursorB}));
  await waitFor(() => assert.equal(checks.length, 3));
  await act(async () => checks[2].resolve({...readyResult(), setup_cursor: cursorB}));
  assert.equal(green(), ids.length);
});
