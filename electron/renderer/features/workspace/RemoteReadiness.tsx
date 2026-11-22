import {useEffect, useRef, useState} from 'react';
import type {EnvironmentSnapshot} from '../../../shared/environment/types';

const items = [
  ['connection', '遠端連線', 'Remote connection'],
  ['workspace', '工作目錄', 'Workspace directory'],
  ['slurm', '工作排程器', 'Job scheduler'],
  ['apptainer', '容器執行環境', 'Container runtime'],
  ['signet_source', 'SIGNET 程式碼', 'SIGNET source code'],
  ['container', 'SIGNET 容器', 'SIGNET container'],
  ['reference_ref', '參考面板', 'Reference panel'],
  ['reference_gmap', '遺傳圖譜', 'Genetic map'],
  ['reference_gtf', '基因註解', 'Gene annotation'],
  ['reference_clinical', '臨床資料', 'Clinical data'],
  ['imputation_reference', '補值參考檔', 'Imputation reference'],
] as const;

const statuses = {
  ok: ['已就緒', 'Ready'],
  missing: ['缺少', 'Missing'],
  problem: ['有問題', 'Problem'],
  in_progress: ['進行中', 'In progress'],
  unknown: ['未檢查', 'Not checked'],
} as const;

type Check = {item: string; status: keyof typeof statuses; detail: string; valid?: boolean};
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;

/** A green service summary must agree with every required, uniquely identified check. */
export function normalizeReadiness(value: unknown, english = false) {
  const label = (zh: string, en: string) => english ? en : zh;
  const result = record(value);
  if (result?.status !== 'ok') return {
    checks: items.map(([item]): Check => ({item, status: 'unknown', detail: ''})),
    issues: [label('遠端環境檢查尚未成功完成。', 'The remote environment check did not complete successfully.')],
    detail: [result?.reason, result?.error, result?.detail]
      .filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).join(' '),
    ready: false,
  };
  const issues: string[] = [];
  const known = new Set<string>(items.map(([id]) => id));
  const received = new Map<string, RecordValue[]>();
  if (!Array.isArray(result?.checks)) issues.push(label('服務未回傳有效的檢查清單。', 'The service did not return a valid check list.'));
  else for (const raw of result.checks) {
    const check = record(raw);
    if (!check || typeof check.item !== 'string' || !known.has(check.item)) {
      issues.push(label('檢查清單包含無效或未識別的項目：', 'Invalid or unrecognized check item: ') +
        (typeof check?.item === 'string' ? check.item : label('無法識別', 'unidentified')));
      continue;
    }
    const matches = received.get(check.item) ?? [];
    matches.push(check);
    received.set(check.item, matches);
  }
  const checks: Check[] = items.map(([item]) => {
    const matches = received.get(item) ?? [];
    if (!matches.length) return {item, status: 'unknown', detail: label('服務未回傳這項必要檢查的結果。', 'No result was returned for this required check.')};
    if (matches.length > 1) return {item, status: 'problem', detail: [
      label('服務回傳了重複的檢查結果。', 'The service returned duplicate check results.'),
      ...matches.map(check => typeof check.detail === 'string' ? check.detail : '').filter(Boolean),
    ].join(' ')};
    const check = matches[0];
    if (typeof check.status !== 'string' || !Object.hasOwn(statuses, check.status) ||
        check.detail !== undefined && typeof check.detail !== 'string') {
      return {item, status: 'problem', detail: label('服務回傳的狀態或說明格式無效。', 'The service returned an invalid status or detail.') +
        (typeof check.detail === 'string' ? ' ' + check.detail : '')};
    }
    const status = check.status as Check['status'];
    return {item, status, valid: true, detail: typeof check.detail === 'string' && check.detail.trim() ? check.detail :
      status === 'ok' ? '' : label('服務未提供其他原因。', 'The service did not provide an additional reason.')};
  });
  const blocked = checks.filter(check => check.status !== 'ok').map(check => check.item);
  const notReady = result?.not_ready;
  if (!Array.isArray(notReady) || notReady.some(id => typeof id !== 'string' || !known.has(id)) ||
      new Set(notReady).size !== notReady.length) {
    issues.push(label('服務的未就緒項目清單無效。', 'The service returned an invalid list of checks needing attention.'));
  } else if (blocked.length !== notReady.length || blocked.some(id => !notReady.includes(id))) {
    issues.push(label('服務摘要與各項檢查結果不一致。', 'The service summary disagrees with the individual check results.'));
  }
  if (result?.ready !== true) issues.push(result?.ready === false
    ? label('服務回報環境尚未就緒。', 'The service reports that the environment is not ready.')
    : label('服務尚未確認環境已就緒。', 'The service has not confirmed that the environment is ready.'));
  else if (blocked.length) issues.push(label('服務回報已就緒，但仍有必要項目未通過檢查。', 'The service reports ready while required checks still need attention.'));
  if (typeof result?.error === 'string' && result.error) issues.push(result.error);
  const detail = [result?.reason, result?.detail].filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).join(' ');
  return {checks, issues: [...new Set(issues)], detail, ready: !issues.length && !blocked.length};
}

interface Props {
  english: boolean;
  active: boolean;
  connected: boolean;
  connectionIdentity?: string;
  environment: EnvironmentSnapshot;
  onEnvironment: () => void;
  onVerify?: () => Promise<{ok: boolean; error?: string}>;
}

type Inspection = {scope: string; value: unknown; error: string; busy: boolean};
const setupActions = [
  {item: 'signet_source', step: 'signet', path: '/hpc/signet', label: ['安裝 SIGNET', 'Install SIGNET'], requires: ['connection']},
  {item: 'container', step: 'container', path: '/hpc/container', label: ['下載容器', 'Download container'], requires: ['connection', 'slurm']},
  {item: 'reference_ref', step: 'ref', path: '/hpc/reference/ref', label: ['下載參考面板', 'Download reference panel'], requires: ['connection', 'slurm']},
  {item: 'reference_gmap', step: 'gmap', path: '/hpc/reference/gmap', label: ['下載遺傳圖譜', 'Download genetic map'], requires: ['connection', 'slurm']},
  {item: 'reference_gtf', step: 'gtf', path: '/hpc/reference/gtf', label: ['下載基因註解', 'Download gene annotation'], requires: ['connection', 'slurm', 'apptainer', 'container']},
  {item: 'reference_clinical', step: 'clinical', path: '/hpc/reference/clinical', label: ['下載臨床資料', 'Download clinical data'], requires: ['connection', 'slurm']},
  {item: 'imputation_reference', step: 'prepare', path: '/hpc/prepare', label: ['準備補值參考檔', 'Prepare imputation reference'], requires: ['connection', 'slurm', 'apptainer', 'container', 'signet_source', 'reference_ref', 'reference_gmap']},
];
const setupStates = {
  submitting: ['正在送出', 'Submitting'], accepted: ['已接受，等待核對', 'Accepted, awaiting check'],
  in_progress: ['執行中', 'In progress'], completed: ['已完成', 'Completed'],
  failed: ['未完成', 'Not completed'], unconfirmed: ['結果待確認', 'Outcome unconfirmed'],
} as const;
type SetupState = {state: keyof typeof setupStates; detail: string; grace?: number; job?: string};
type SetupRequest = {target: string; step: string; controller: AbortController};

export function RemoteReadiness({english, active, connected, connectionIdentity = '', environment, onEnvironment, onVerify}: Props) {
  const [inspection, setInspection] = useState<Inspection>({scope: '', value: undefined, error: '', busy: false});
  const request = useRef<{scope: string; controller: AbortController} | null>(null);
  const actionRequest = useRef<SetupRequest | null>(null);
  const logRequest = useRef<SetupRequest | null>(null);
  const verifiedSource = useRef('');
  const requestedSource = useRef('');
  const [setup, setSetup] = useState<{target: string; steps: Record<string, SetupState>}>({target: '', steps: {}});
  const [logs, setLogs] = useState<{target: string; steps: Record<string, {state: string; text: string}>}>({target: '', steps: {}});
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
  const label = (zh: string, en: string) => english ? en : zh;
  const operations = connected && setup.target === target ? setup.steps : {};
  const currentLogs = connected && logs.target === target ? logs.steps : {};
  const submitting = Boolean(actionRequest.current?.target === target);

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

  async function inspect() {
    if (!available || request.current) return;
    const pending = {scope, controller: new AbortController()};
    request.current = pending;
    setInspection({scope, value: undefined, error: '', busy: true});
    try {
      const token = document.querySelector<HTMLMetaElement>('meta[name="chat-token"]')?.content;
      const reply = await fetch('/hpc/check', {
        method: 'POST', body: '{}', signal: pending.controller.signal,
        headers: {'Content-Type': 'application/json', 'X-Chat-Token': token ?? ''},
      });
      const value: unknown = await reply.json();
      if (pending.controller.signal.aborted || request.current !== pending) return;
      const result = record(value);
      if (reply.ok) reconcileSetup(value);
      setInspection({scope, value: reply.ok ? value : undefined, busy: false,
        error: reply.ok ? '' : typeof result?.reason === 'string' ? result.reason
          : typeof result?.error === 'string' ? result.error : 'unavailable'});
    } catch {
      if (!pending.controller.signal.aborted && request.current === pending) {
        setInspection({scope, value: undefined, error: 'unavailable', busy: false});
      }
    } finally {
      if (request.current === pending) request.current = null;
    }
  }

  useEffect(() => {
    request.current?.controller.abort();
    request.current = null;
    setInspection({scope, value: undefined, error: '', busy: false});
    if (available) void inspect();
    return () => {
      if (request.current?.scope === scope) {
        request.current.controller.abort();
        request.current = null;
      }
    };
  }, [scope, available]);

  useEffect(() => {
    const refresh = () => { requestedSource.current = target; if (available) void inspect(); };
    window.addEventListener('workspace-setup-refresh', refresh);
    return () => window.removeEventListener('workspace-setup-refresh', refresh);
  }, [scope, available]);

  useEffect(() => {
    setSetup({target, steps: {}});
    setLogs({target, steps: {}});
    return () => {
      actionRequest.current?.controller.abort();
      actionRequest.current = null;
      logRequest.current?.controller.abort();
      logRequest.current = null;
    };
  }, [target, connected]);

  const report = current && current.value !== undefined ? normalizeReadiness(current.value, english) : null;
  const sourceReady = report?.checks.some(check => check.item === 'signet_source' && check.status === 'ok' && check.valid);
  useEffect(() => {
    const identity = target + ':' + environment.checkedAt;
    if (!available || phase !== 'needs-install' || !sourceReady || !onVerify ||
        requestedSource.current !== target || verifiedSource.current === identity) return;
    verifiedSource.current = identity;
    void onVerify();
  }, [available, phase, sourceReady, target, environment.checkedAt, onVerify]);
  const poll = available && report?.checks.every(check => check.valid) && !current?.busy && !current?.error &&
    (Boolean(report?.checks.some(check => check.status === 'in_progress')) ||
      Object.values(operations).some(operation => ['accepted', 'in_progress', 'unconfirmed'].includes(operation.state)));
  useEffect(() => {
    if (!poll) return;
    const timer = setTimeout(() => void inspect(), 4000);
    return () => clearTimeout(timer);
  }, [scope, poll]);

  function blocker(action: typeof setupActions[number]) {
    if (!config) return label('請先驗證遠端環境設定。', 'Verify the remote environment settings first.');
    if (['blocked', 'error'].includes(phase)) {
      return label('請先按「驗證環境」，或到遠端環境設定修正錯誤後再重試。', 'Select Verify environment, or correct the remote environment settings, before retrying setup.');
    }
    const workspace = report?.checks.find(check => check.item === 'workspace');
    if (workspace?.status === 'problem') {
      return label('請先修正工作目錄的問題。', 'Resolve the workspace directory problem first.');
    }
    if (!workspace?.valid || !['ok', 'missing'].includes(workspace.status)) {
      return label('請先確認工作目錄狀態，或等待目錄準備完成。', 'Confirm the workspace directory status or wait for its setup to finish first.');
    }
    const missing = action.requires.filter(id => !report?.checks.some(check => check.item === id && check.valid && check.status === 'ok'));
    if (missing.length) return label('請先完成：', 'First complete: ') + missing.map(id => {
      const item = items.find(([key]) => key === id);
      return item?.[english ? 2 : 1] ?? id;
    }).join(' · ');
    if (action.step === 'signet' && (phase !== 'needs-install' ||
        !environment.missing?.some(item => ['SIGNET source', 'SIGNET example data'].includes(item)))) {
      return label('請按「驗證環境」重新確認安裝狀態，再重試安裝。', 'Select Verify environment to check the installation state before retrying.');
    }
    return '';
  }

  async function post(path: string, signal: AbortSignal) {
    const token = document.querySelector<HTMLMetaElement>('meta[name="chat-token"]')?.content ?? '';
    const reply = await fetch(path, {method: 'POST', body: '{}', signal,
      headers: {'Content-Type': 'application/json', 'X-Chat-Token': token}});
    const result = record(await reply.json());
    if (!reply.ok || !result) throw new Error(typeof result?.reason === 'string' ? result.reason
      : typeof result?.error === 'string' ? result.error : label('無法讀取遠端操作結果。', 'Could not read the remote operation result.'));
    return result;
  }

  async function runSetup(step: string) {
    const action = setupActions.find(action => action.step === step);
    const check = report?.checks.find(check => check.item === action?.item);
    if (!action || !available || current?.busy || actionRequest.current || !check?.valid ||
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
          grace: accepted ? 1 : 0, detail: detail || label('服務未確認這項準備已開始。', 'The service did not confirm that this setup step started.'),
          job: typeof result.job_id === 'string' || typeof result.job_id === 'number' ? String(result.job_id) : undefined});
      }
    } catch (error) {
      if (!pending.controller.signal.aborted && context.current.target === target && context.current.connected) {
        updateSetup(step, {state: 'unconfirmed', grace: 1, detail: (error as Error).message});
      }
    } finally {
      if (actionRequest.current === pending) {
        actionRequest.current = null;
        if (latestScope.current === scope && context.current.connected) void inspect();
      }
    }
  }

  async function verify() {
    if (!onVerify || !available || current?.busy || actionRequest.current) return;
    const pending = {target, step: 'verify', controller: new AbortController()};
    actionRequest.current = pending;
    updateSetup('verify', {state: 'submitting', detail: ''});
    try {
      const result = await onVerify();
      if (context.current.target !== target || !context.current.connected || actionRequest.current !== pending) return;
      updateSetup('verify', {state: result.ok ? 'completed' : 'failed', detail: result.error || ''});
    } catch (error) {
      if (context.current.target === target && context.current.connected && actionRequest.current === pending) {
        updateSetup('verify', {state: 'failed', detail: (error as Error).message});
      }
    } finally {
      if (actionRequest.current === pending) actionRequest.current = null;
    }
  }

  async function readLog(step: string) {
    if (!available || logRequest.current) return;
    const pending = {target, step, controller: new AbortController()};
    logRequest.current = pending;
    const update = (state: string, text: string) => setLogs(previous => ({target,
      steps: {...(previous.target === target ? previous.steps : {}), [step]: {state, text}}}));
    update('loading', '');
    try {
      const result = await post(`/hpc/log/${step}`, pending.controller.signal);
      if (context.current.target !== target || !context.current.connected || logRequest.current !== pending) return;
      const lines = result.lines;
      const okay = result.status === 'ok' && Array.isArray(lines) && lines.every(line => typeof line === 'string');
      update(okay ? 'ready' : 'error', okay ? lines.join('\n') || String(result.detail || label('這項準備尚無紀錄。', 'There is no setup log for this step yet.'))
        : String(result.reason || result.error || label('無法讀取準備紀錄。', 'Could not read the setup log.')));
    } catch (error) {
      if (!pending.controller.signal.aborted && context.current.target === target && context.current.connected) update('error', (error as Error).message);
    } finally {
      if (logRequest.current === pending) logRequest.current = null;
    }
  }
  const rows = items.map(([id, zh, en]) => ({id, name: label(zh, en),
    check: id === 'signet_source' && sourceInstalling
      ? {item: id, status: 'in_progress' as const, detail: environment.message || label('正在安裝 SIGNET。', 'Installing SIGNET.'), valid: true}
      : report?.checks.find(check => check.item === id)}));
  const ready = rows.filter(({check}) => check?.status === 'ok').length;
  const allReady = available && !environmentBlocked && Boolean(report?.ready);
  let summary = label('開啟設定後會自動檢查，也可按「重新檢查」。', 'Checks run when Settings is open. You can also select Check again.');
  if (!connected) summary = label('連線後可檢查遠端環境。', 'Connect to check the remote environment.');
  else if (sourceInstalling) summary = label('正在安裝 SIGNET…', 'Installing SIGNET…');
  else if (current?.busy || preparing) summary = label('正在檢查遠端環境…', 'Checking the remote environment…');
  else if (current?.error) summary = current.error === 'unavailable'
    ? label('目前無法檢查遠端環境，請重新檢查。', 'The remote environment check is unavailable. Check again.') : current.error;
  else if (report) summary = allReady
    ? label(`${ready}/${rows.length} 項就緒，環境檢查已通過。`, `${ready}/${rows.length} ready. All environment checks passed.`)
    : label(`${ready}/${rows.length} 項通過檢查，環境尚未就緒。`, `${ready}/${rows.length} checks passed. The environment is not ready.`);
  const environmentReason = connected && environmentBlocked ? environment.message ||
    label('遠端環境設定尚未通過驗證。', 'Remote environment settings have not passed verification.') : '';
  const problems = [...new Set([...(report?.issues ?? []), report?.detail, environmentReason]
    .filter((message): message is string => Boolean(message) && message !== summary))];

  return <section className="ml-settings-block ml-remote-readiness" data-phase={phase} data-ready={allReady} aria-labelledby="ml-readiness-title">
    <div className="ml-settings-check-heading">
      <h4 id="ml-readiness-title">{label('環境就緒檢查', 'Environment readiness')}</h4>
      <button type="button" className="ml-settings-action" id="ml-check-environment" disabled={!available || submitting || Boolean(current?.busy)} onClick={() => void inspect()}>
        {label('重新檢查', 'Check again')}
      </button>
    </div>
    <p className="ml-settings-note" id="ml-check-summary" role="status">{summary}
      {problems.map(message => <span key={message}> {message}</span>)}
    </p>
    <ul className="ml-settings-checks" id="ml-environment-checks">
      {rows.map(({id, name, check}) => {
        const action = setupActions.find(action => action.item === id);
        const operation = action && (id === 'signet_source' && sourceInstalling ? {state: 'in_progress' as const, detail: ''}
          : operations[action.step] ?? (check?.status === 'in_progress'
          ? {state: 'in_progress' as const, detail: ''} : undefined));
        const missing = check?.valid && ['missing', 'problem'].includes(check.status);
        const reason = action && missing ? blocker(action) : '';
        const log = action && currentLogs[action.step];
        return <li key={id} data-check-id={id} data-status={check?.status ?? 'unknown'}>
          <span>{name}</span>
          <span className="ml-settings-status" data-ready={check?.status === 'ok'}>
            {statuses[check?.status ?? 'unknown'][english ? 1 : 0]}
          </span>
          {check?.detail && <p className="ml-settings-check-detail">{check.detail}</p>}
          {operation && <p className="ml-settings-check-detail" data-setup-status data-state={operation.state} role="status">
            <strong>{setupStates[operation.state][english ? 1 : 0]}</strong>
            {operation.detail && operation.detail !== check?.detail && <span> {operation.detail}</span>}
            {operation.job && <span> {label('工作編號：', 'Job ID: ')}<code data-setup-job>{operation.job}</code></span>}
          </p>}
          {reason && <p className="ml-settings-check-detail" data-setup-prerequisite>{reason}</p>}
          {action && <div className="ml-settings-check-actions">
            {missing && <button type="button" className="ml-settings-action" data-setup-action={action.step}
              disabled={!available || Boolean(current?.busy) || submitting || Boolean(reason) ||
                Boolean(operation && ['submitting', 'accepted', 'in_progress', 'unconfirmed'].includes(operation.state))}
              onClick={() => void runSetup(action.step)}>{action.label[english ? 1 : 0]}</button>}
            {check?.valid && <button type="button" className="ml-settings-action" data-setup-log={action.step}
              disabled={!available || Boolean(current?.busy) || Boolean(logRequest.current)} onClick={() => void readLog(action.step)}>
              {label('查看準備紀錄', 'View setup log')}
            </button>}
          </div>}
          {log && <div className="ml-settings-check-log" data-log-state={log.state}>
            {log.state === 'loading' ? <p role="status">{label('正在讀取準備紀錄…', 'Reading setup log…')}</p>
              : log.state === 'error' ? <p role="alert">{log.text}</p>
                : <pre data-setup-log-output={action?.step}>{log.text}</pre>}
          </div>}
        </li>;
      })}
    </ul>
    {onVerify && <button type="button" className="ml-settings-action" data-setup-verify
      disabled={!available || Boolean(current?.busy) || submitting} onClick={() => void verify()}>
      {label('驗證環境', 'Verify environment')}
    </button>}
    {operations.verify && <p className="ml-settings-note" data-setup-verify-status data-state={operations.verify.state} role="status">
      {setupStates[operations.verify.state][english ? 1 : 0]}{operations.verify.detail && <span> {operations.verify.detail}</span>}
    </p>}
    {connected && <button type="button" className="ml-settings-action" onClick={onEnvironment}>
      {label('遠端環境設定', 'Remote environment settings')}
    </button>}
  </section>;
}
