import {useEffect, useRef, useState} from 'react';
import type {EnvironmentSnapshot} from '../../../shared/environment/types';

const items = [
  ['connection', 'Remote connection'],
  ['workspace', 'Workspace directory'],
  ['slurm', 'Job scheduler'],
  ['apptainer', 'Container runtime'],
  ['signet_source', 'SIGNET source code'],
  ['container', 'SIGNET container'],
] as const;

const statuses = {
  ok: 'Ready',
  missing: 'Missing',
  problem: 'Problem',
  in_progress: 'In progress',
  unknown: 'Not checked',
} as const;

type Check = {item: string; status: keyof typeof statuses; detail: string; valid?: boolean};
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;

function checkFailure(result: RecordValue | null) {
  switch (result?.code) {
    case 'local_runtime_missing':
      return {title: 'SIGNET could not load a required file.', action: 'Restart SIGNET, then check again.'};
    case 'remote_timeout':
      return {title: 'The remote check timed out.', action: 'Check again in a moment.'};
    case 'remote_disconnected':
      return {title: 'The remote connection was interrupted.', action: 'Reconnect in Settings, then check again.'};
  }
  if (result?.status === 'not_ready') {
    return {title: 'Remote settings need attention.', action: 'Review the remote settings, then check again.'};
  }
  return {title: 'Environment check failed.', action: 'Select Check environment to try again.'};
}

/** A green service summary must agree with every required, uniquely identified check. */
export function normalizeReadiness(value: unknown) {
  const result = record(value);
  if (result?.status !== 'ok') return {
    checks: items.map(([item]): Check => ({item, status: 'unknown', detail: ''})),
    issues: ['The remote environment check did not complete successfully.'],
    ready: false,
  };
  const issues: string[] = [];
  const known = new Set<string>(items.map(([id]) => id));
  const received = new Map<string, RecordValue[]>();
  if (!Array.isArray(result?.checks)) issues.push('The service did not return a valid check list.');
  else for (const raw of result.checks) {
    const check = record(raw);
    if (!check || typeof check.item !== 'string' || !known.has(check.item)) {
      issues.push('Invalid or unrecognized check item: ' +
        (typeof check?.item === 'string' ? check.item : 'unidentified'));
      continue;
    }
    const matches = received.get(check.item) ?? [];
    matches.push(check);
    received.set(check.item, matches);
  }
  const checks: Check[] = items.map(([item]) => {
    const matches = received.get(item) ?? [];
    if (!matches.length) return {item, status: 'unknown', detail: 'No result was returned for this required check.'};
    if (matches.length > 1) return {item, status: 'problem', detail: [
      'The service returned duplicate check results.',
      ...matches.map(check => typeof check.detail === 'string' ? check.detail : '').filter(Boolean),
    ].join(' ')};
    const check = matches[0];
    if (typeof check.status !== 'string' || !Object.hasOwn(statuses, check.status) ||
        check.detail !== undefined && typeof check.detail !== 'string') {
      return {item, status: 'problem', detail: 'The service returned an invalid status or detail.' +
        (typeof check.detail === 'string' ? ' ' + check.detail : '')};
    }
    const status = check.status as Check['status'];
    return {item, status, valid: true, detail: typeof check.detail === 'string' && check.detail.trim() ? check.detail :
      status === 'ok' ? '' : 'The service did not provide an additional reason.'};
  });
  const blocked = checks.filter(check => check.status !== 'ok').map(check => check.item);
  const notReady = result?.not_ready;
  if (!Array.isArray(notReady) || notReady.some(id => typeof id !== 'string' || !known.has(id)) ||
      new Set(notReady).size !== notReady.length) {
    issues.push('The service returned an invalid list of checks needing attention.');
  } else if (blocked.length !== notReady.length || blocked.some(id => !notReady.includes(id))) {
    issues.push('The service summary disagrees with the individual check results.');
  }
  if (result?.ready === false) {
    if (!blocked.length) issues.push('The service reports that the environment is not ready.');
  } else if (result?.ready !== true) issues.push('The service has not confirmed that the environment is ready.');
  else if (blocked.length) issues.push('The service reports ready while required checks still need attention.');
  if (typeof result?.error === 'string' && result.error) issues.push(result.error);
  return {checks, issues, ready: !issues.length && !blocked.length};
}

interface Props {
  active: boolean;
  connected: boolean;
  connectionIdentity?: string;
  environment: EnvironmentSnapshot;
  onEnvironment: () => void;
  onVerify?: () => Promise<{ok: boolean; error?: string}>;
}

type Inspection = {scope: string; value: unknown; failed: boolean; busy: boolean};
type Refresh = {scope: string; background: boolean; verifyIfNeeded: boolean};
const setupActions = [
  {item: 'signet_source', step: 'signet', path: '/hpc/signet', label: 'Install SIGNET', requires: ['connection']},
  {item: 'container', step: 'container', path: '/hpc/container', label: 'Download container', requires: ['connection', 'slurm']},
];
const setupStates = {
  submitting: 'Submitting', accepted: 'Accepted, awaiting check',
  in_progress: 'In progress', completed: 'Completed',
  failed: 'Not completed', unconfirmed: 'Outcome unconfirmed',
} as const;
type SetupState = {state: keyof typeof setupStates; detail: string; grace?: number; job?: string};
type SetupRequest = {target: string; step: string; controller: AbortController};

export function RemoteReadiness({active, connected, connectionIdentity = '', environment, onEnvironment, onVerify}: Props) {
  const [inspection, setInspection] = useState<Inspection>({scope: '', value: undefined, failed: false, busy: false});
  const request = useRef<{scope: string; controller: AbortController} | null>(null);
  const refreshPending = useRef<Refresh | null>(null);
  const watchRequest = useRef<{scope: string; controller: AbortController; ended: boolean} | null>(null);
  const [watchRevision, setWatchRevision] = useState(0);
  const actionRequest = useRef<SetupRequest | null>(null);
  const verificationRequest = useRef<symbol | null>(null);
  const [verification, setVerification] = useState<{busy: boolean; error?: string} | null>(null);
  const verifiedSource = useRef('');
  const requestedSource = useRef('');
  const [setup, setSetup] = useState<{target: string; steps: Record<string, SetupState>}>({target: '', steps: {}});
  const phase = environment.phase;
  const sourceInstalling = connected && phase === 'installing-source';
  const preparing = ['checking', 'installing-source', 'verifying'].includes(phase);
  const environmentBlocked = ['blocked', 'error', 'needs-install', 'disconnected'].includes(phase);
  const config = environment.config;
  const target = JSON.stringify([connectionIdentity, config?.root, config?.source, config?.image,
    config?.executor, config?.runtimeModule, config?.workRoot, config?.revision, config?.partition]);
  const context = useRef({target, connected});
  context.current = {target, connected};
  const scope = JSON.stringify([active, connected, connectionIdentity, phase, environment.checkedAt,
    config?.root, config?.source, config?.image, config?.executor, config?.runtimeModule,
    config?.workRoot, config?.revision, config?.partition]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const available = active && connected && !preparing;
  const current = inspection.scope === scope ? inspection : null;
  const operations = connected && setup.target === target ? setup.steps : {};
  const verifying = verification?.busy === true;
  const submitting = verifying || actionRequest.current?.target === target;

  function updateSetup(step: string, value: SetupState) {
    setSetup(previous => ({target, steps: {...(previous.target === target ? previous.steps : {}), [step]: value}}));
  }

  function reconcileSetup(value: unknown) {
    const checked = normalizeReadiness(value).checks;
    if (checked.some(check => check.item === 'signet_source' && check.status === 'in_progress')) requestedSource.current = target;
    setSetup(previous => {
      if (previous.target !== target) return previous;
      const steps = {...previous.steps};
      for (const action of setupActions) {
        const operation = steps[action.step];
        const check = checked.find(check => check.item === action.item);
        if (!operation || operation.state === 'submitting' || !check?.valid) continue;
        if (check.status === 'ok') steps[action.step] = {state: 'completed', detail: '', job: operation.job};
        else if (check.status === 'in_progress') steps[action.step] = {state: 'in_progress', detail: '', job: operation.job};
        else if (['accepted', 'in_progress', 'unconfirmed'].includes(operation.state)) {
          steps[action.step] = operation.grace ? {...operation, grace: operation.grace - 1}
            : {state: 'failed', detail: check.detail};
        }
      }
      return {target, steps};
    });
  }

  function shouldVerifyReport(report: ReturnType<typeof normalizeReadiness> | null) {
    if (phase === 'needs-install') return report?.ready === true;
    return phase === 'ready' && report?.checks.some(check =>
      check.item === 'signet_source' && check.status === 'missing' && check.valid) === true;
  }

  async function inspect(background = false, verifyIfNeeded = false) {
    if (!available || verificationRequest.current) return;
    if (request.current) {
      const queued = refreshPending.current;
      refreshPending.current = {scope, background: background && !(queued?.scope === scope && !queued.background),
        verifyIfNeeded: verifyIfNeeded || (queued?.scope === scope && queued.verifyIfNeeded)};
      if (!background) setInspection(previous => ({...previous, busy: true}));
      return;
    }
    const pending = {scope, controller: new AbortController()};
    request.current = pending;
    setInspection(previous => ({scope, value: previous.scope === scope ? previous.value : undefined,
      failed: previous.scope === scope && previous.failed,
      busy: !background || previous.scope !== scope || previous.value === undefined}));
    let shouldVerify = false;
    try {
      const token = document.querySelector<HTMLMetaElement>('meta[name="chat-token"]')?.content;
      const reply = await fetch('/hpc/check', {
        method: 'POST', body: '{}', signal: pending.controller.signal,
        headers: {'Content-Type': 'application/json', 'X-Chat-Token': token ?? ''},
      });
      const value: unknown = await reply.json();
      if (pending.controller.signal.aborted || request.current !== pending) return;
      if (reply.ok) reconcileSetup(value);
      shouldVerify = verifyIfNeeded && reply.ok && shouldVerifyReport(normalizeReadiness(value));
      setInspection({scope, value, busy: false, failed: !reply.ok});
    } catch (error) {
      if (!pending.controller.signal.aborted && request.current === pending) {
        const value = error instanceof Error ? {detail: error.message} : undefined;
        setInspection({scope, value, failed: true, busy: false});
      }
    } finally {
      if (request.current === pending) {
        request.current = null;
        const queued = refreshPending.current;
        if (shouldVerify && latestScope.current === scope) {
          refreshPending.current = null;
          void verify();
        } else if (queued?.scope === scope && latestScope.current === scope) {
          refreshPending.current = null;
          void inspect(queued.background, queued.verifyIfNeeded);
        } else if (watchRequest.current?.scope === scope && watchRequest.current.ended) {
          setWatchRevision(previous => previous + 1);
        }
      }
    }
  }

  useEffect(() => {
    setVerification(null);
    return () => { verificationRequest.current = null; };
  }, [connectionIdentity, connected]);

  useEffect(() => {
    request.current?.controller.abort();
    request.current = null;
    refreshPending.current = null;
    setInspection({scope, value: undefined, failed: false, busy: false});
    if (available && !verifying) void inspect();
    return () => {
      if (request.current?.scope === scope) {
        request.current.controller.abort();
        request.current = null;
      }
    };
  }, [scope, available, verification]);

  useEffect(() => {
    const refresh = () => { requestedSource.current = target; if (available) void inspect(true); };
    window.addEventListener('workspace-setup-refresh', refresh);
    return () => window.removeEventListener('workspace-setup-refresh', refresh);
  }, [scope, available]);

  useEffect(() => {
    setSetup({target, steps: {}});
    return () => {
      actionRequest.current?.controller.abort();
      actionRequest.current = null;
    };
  }, [target, connected]);

  const report = current && !current.failed && current.value !== undefined ? normalizeReadiness(current.value) : null;
  const sourceReady = report?.checks.some(check => check.item === 'signet_source' && check.status === 'ok' && check.valid);
  useEffect(() => {
    const identity = target + ':' + environment.checkedAt;
    if (!available || verificationRequest.current || phase !== 'needs-install' || !sourceReady || !onVerify ||
        requestedSource.current !== target || verifiedSource.current === identity) return;
    verifiedSource.current = identity;
    void onVerify();
  }, [available, phase, sourceReady, target, environment.checkedAt, onVerify]);
  const tracking = available && report?.checks.every(check => check.valid) &&
    (Boolean(report?.checks.some(check => check.status === 'in_progress')) ||
      Object.values(operations).some(operation => ['accepted', 'in_progress', 'unconfirmed'].includes(operation.state)));
  const setupCursor = record(current?.value)?.setup_cursor;
  useEffect(() => {
    const initialCursor = setupCursor;
    if (!tracking || typeof initialCursor !== 'string' || !/^[a-f0-9]{64}$/.test(initialCursor)) return;
    const controller = new AbortController();
    const pending = {scope, controller, ended: false};
    watchRequest.current = pending;
    async function watch() {
      const cursor = initialCursor as string;
      while (!controller.signal.aborted && latestScope.current === scope) {
        try {
          const token = document.querySelector<HTMLMetaElement>('meta[name="chat-token"]')?.content ?? '';
          const reply = await fetch('/hpc/watch', {method: 'POST', body: JSON.stringify({cursor}), signal: controller.signal,
            headers: {'Content-Type': 'application/json', 'X-Chat-Token': token}});
          const result = record(await reply.json());
          if (controller.signal.aborted || latestScope.current !== scope) return;
          if (!reply.ok || result?.status !== 'ok' || typeof result.changed !== 'boolean' ||
              typeof result.setup_cursor !== 'string' || !/^[a-f0-9]{64}$/.test(result.setup_cursor)) { pending.ended = true; return; }
          if (result.changed) {
            pending.ended = true;
            if (result.setup_cursor === cursor) return;
            await inspect(true);
            return;
          } else {
            // A normal wait expiry re-arms the listener without redrawing readiness.
            await new Promise<void>(resolve => {
              const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
              const timer = setTimeout(done, 1000);
              controller.signal.addEventListener('abort', done, {once: true});
            });
          }
        } catch { if (!controller.signal.aborted) pending.ended = true; return; }
      }
    }
    void watch();
    return () => {
      controller.abort();
      if (watchRequest.current === pending) watchRequest.current = null;
    };
  }, [scope, tracking, setupCursor, watchRevision]);

  useEffect(() => {
    if (!tracking) return;
    // Scheduler cancellation and older jobs may not publish completion metadata.
    const timer = setInterval(() => void inspect(true), 60000);
    return () => clearInterval(timer);
  }, [scope, tracking]);

  function blocker(action: typeof setupActions[number]) {
    if (!config) return 'Select Check environment to verify the remote settings first.';
    if (['blocked', 'error'].includes(phase)) {
      return 'Select Check environment or correct the remote environment settings before retrying setup.';
    }
    const workspace = report?.checks.find(check => check.item === 'workspace');
    if (workspace?.status === 'problem') {
      return 'Resolve the workspace directory problem first.';
    }
    if (!workspace?.valid || !['ok', 'missing'].includes(workspace.status)) {
      return 'Confirm the workspace directory status or wait for its setup to finish first.';
    }
    const missing = action.requires.filter(id => !report?.checks.some(check => check.item === id && check.valid && check.status === 'ok'));
    if (missing.length) return 'First complete: ' + missing.map(id => {
      const item = items.find(([key]) => key === id);
      return item?.[1] ?? id;
    }).join(' · ');
    if (action.step === 'signet' && (phase !== 'needs-install' ||
        !environment.missing?.some(item => ['SIGNET source', 'SIGNET example data'].includes(item)))) {
      return 'Select Check environment to check the installation state before retrying.';
    }
    return '';
  }

  async function post(path: string, signal: AbortSignal) {
    const token = document.querySelector<HTMLMetaElement>('meta[name="chat-token"]')?.content ?? '';
    const reply = await fetch(path, {method: 'POST', body: '{}', signal,
      headers: {'Content-Type': 'application/json', 'X-Chat-Token': token}});
    const result = record(await reply.json());
    if (!reply.ok || !result) throw new Error(typeof result?.reason === 'string' ? result.reason
      : typeof result?.error === 'string' ? result.error : 'Could not read the remote operation result.');
    return result;
  }

  async function runSetup(step: string) {
    const action = setupActions.find(action => action.step === step);
    const check = report?.checks.find(check => check.item === action?.item);
    if (!action || !available || current?.busy || actionRequest.current || verificationRequest.current || !check?.valid ||
        !['missing', 'problem'].includes(check.status) || blocker(action) ||
        ['accepted', 'in_progress', 'submitting', 'unconfirmed'].includes(operations[step]?.state)) return;
    const pending = {target, step, controller: new AbortController()};
    actionRequest.current = pending;
    if (step === 'signet') requestedSource.current = target;
    updateSetup(step, {state: 'submitting', detail: ''});
    try {
      {
        const result = await post(action.path, pending.controller.signal);
        if (context.current.target !== target || !context.current.connected || actionRequest.current !== pending) return;
        const accepted = result.status === 'ok' && ['started', 'in_progress', 'existing'].includes(String(result.outcome));
        const detail = [result.reason, result.error, result.detail].filter(value => typeof value === 'string' && value).join(' ');
        updateSetup(step, {state: accepted ? result.outcome === 'in_progress' ? 'in_progress' : 'accepted' : 'failed',
          grace: accepted ? 1 : 0, detail: detail || 'The service did not confirm that this setup step started.',
          job: typeof result.job_id === 'string' || typeof result.job_id === 'number' ? String(result.job_id) : undefined});
      }
    } catch (error) {
      if (!pending.controller.signal.aborted && context.current.target === target && context.current.connected) {
        updateSetup(step, {state: 'unconfirmed', grace: 1, detail: (error as Error).message});
      }
    } finally {
      if (actionRequest.current === pending) {
        actionRequest.current = null;
        if (latestScope.current === scope && context.current.connected) void inspect(true);
      }
    }
  }

  async function verify() {
    if (!onVerify || !available || actionRequest.current || verificationRequest.current) return;
    const pending = Symbol();
    verificationRequest.current = pending;
    request.current?.controller.abort();
    request.current = null;
    refreshPending.current = null;
    setVerification({busy: true});
    let error = '';
    try {
      const result = await onVerify();
      if (!result.ok) error = result.error || 'Could not verify the remote configuration.';
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'Could not verify the remote configuration.';
    } finally {
      if (verificationRequest.current === pending) {
        verificationRequest.current = null;
        setVerification({busy: false, error});
      }
    }
  }

  function checkEnvironment() {
    if (!available || current?.busy || submitting) return;
    if (onVerify && (!config || phase === 'error' || phase === 'blocked' || shouldVerifyReport(report))) {
      void verify();
    } else void inspect(false, Boolean(onVerify));
  }

  const rows = items.map(([id, name]) => ({id, name,
    check: id === 'signet_source' && sourceInstalling
      ? {item: id, status: 'in_progress' as const, detail: environment.message || 'Installing SIGNET.', valid: true}
      : report?.checks.find(check => check.item === id)}));
  const ready = rows.filter(({check}) => check?.status === 'ok').length;
  const allReady = available && !verifying && !environmentBlocked && Boolean(report?.ready);
  const checking = connected && !sourceInstalling && (verifying || preparing || Boolean(current?.busy));
  const result = record(current?.value);
  let failure: ReturnType<typeof checkFailure> | undefined;
  let action = '';
  let summary = 'Checks run when Settings is open.';
  if (!connected) summary = 'Connect to check the remote environment.';
  else if (sourceInstalling) summary = 'Installing SIGNET…';
  else if (verifying || phase === 'verifying') summary = 'Verifying the remote configuration';
  else if (checking) summary = 'Checking the remote environment';
  else if (current?.failed || (report && result?.status !== 'ok')) failure = checkFailure(result);
  else if (phase === 'error' || phase === 'blocked' || (environmentBlocked && verification?.error)) {
    failure = {title: 'Remote settings need attention.', action: 'Review the remote settings, then check again.'};
  } else if (report) {
    summary = allReady ? `${ready}/${rows.length} ready. All environment checks passed.` : `${ready}/${rows.length} checks passed.`;
    if (!allReady) action = ready === rows.length ? 'Select Check environment to confirm readiness.' : 'Review the checks below.';
  }
  const environmentReason = connected && environmentBlocked ? environment.message ||
    'Remote environment settings have not passed verification.' : '';
  const details = [...new Set([...(report?.issues ?? []), result?.reason, result?.error, result?.detail, environmentReason,
    connected && environmentBlocked ? verification?.error : undefined]
    .filter((message): message is string => typeof message === 'string' && Boolean(message.trim())))];
  const showDetails = connected && !preparing && !verifying && !current?.busy && details.length > 0;

  return <section className="ml-settings-block ml-remote-readiness" data-phase={phase} data-ready={allReady} aria-labelledby="ml-readiness-title">
    <h4 id="ml-readiness-title">Environment readiness</h4>
    <div className="ml-readiness-overview" data-error={Boolean(failure)} data-checking={checking}>
      <p className="ml-settings-note" id="ml-check-summary" role="status">
        <strong>{failure?.title ?? summary}{checking && <span className="ml-readiness-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>}</strong>
        {(failure?.action || action) && <span className="ml-readiness-next-step">{failure?.action ?? action}</span>}
      </p>
      <button type="button" className="ml-settings-action" id="ml-check-environment"
        aria-controls="ml-environment-checks" disabled={!available || submitting || Boolean(current?.busy)} onClick={checkEnvironment}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 7v5h-5M4 17v-5h5M6 8a7 7 0 0 1 12-1l2 5M4 12l2 5a7 7 0 0 0 12-1"/>
        </svg>
        Check environment
      </button>
      {showDetails && <details className="ml-readiness-details" key={details.join('\n')}>
        <summary>Technical details</summary>
        <ul>{details.map(detail => <li key={detail}>{detail}</li>)}</ul>
      </details>}
    </div>
    {connected && <section className="ml-readiness-configuration" aria-labelledby="ml-readiness-configuration-title">
      <h5 id="ml-readiness-configuration-title">Remote configuration</h5>
      <div className="ml-readiness-configuration-actions">
        <button type="button" className="ml-settings-action" onClick={onEnvironment}>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 8h18M3 16h18M11 5v6M7 13v6"/>
          </svg>
          Remote environment settings
        </button>
      </div>
    </section>}
    <ul className="ml-settings-checks" id="ml-environment-checks">
      {rows.map(({id, name, check}) => {
        const action = setupActions.find(action => action.item === id);
        const operation = action && (id === 'signet_source' && sourceInstalling ? {state: 'in_progress' as const, detail: ''}
          : operations[action.step] ?? (check?.status === 'in_progress'
          ? {state: 'in_progress' as const, detail: ''} : undefined));
        const missing = check?.valid && ['missing', 'problem'].includes(check.status);
        const reason = action && missing ? blocker(action) : '';
        return <li key={id} data-check-id={id} data-status={check?.status ?? 'unknown'}>
          <span>{name}</span>
          <span className="ml-settings-status" data-ready={check?.status === 'ok'}>
            {statuses[check?.status ?? 'unknown']}
          </span>
          {check?.detail && <p className="ml-settings-check-detail">{check.detail}</p>}
          {operation && <p className="ml-settings-check-detail" data-setup-status data-state={operation.state} role="status">
            <strong>{setupStates[operation.state]}</strong>
            {operation.detail && operation.detail !== check?.detail && <span> {operation.detail}</span>}
            {operation.job && <span> Job ID: <code data-setup-job>{operation.job}</code></span>}
          </p>}
          {reason && <p className="ml-settings-check-detail" data-setup-prerequisite>{reason}</p>}
          {action && missing && <div className="ml-settings-check-actions">
            <button type="button" className="ml-settings-action" data-setup-action={action.step}
              disabled={!available || Boolean(current?.busy) || submitting || Boolean(reason) ||
                Boolean(operation && ['submitting', 'accepted', 'in_progress', 'unconfirmed'].includes(operation.state))}
              onClick={() => void runSetup(action.step)}>{action.label}</button>
          </div>}
        </li>;
      })}
    </ul>
  </section>;
}
